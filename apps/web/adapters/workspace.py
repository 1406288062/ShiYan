"""Web-only wiring; existing desktop sources and authentication are unchanged."""
from __future__ import annotations
import asyncio
from pathlib import Path
import re
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from starlette.routing import Route
from .document_preview import render_docx, DOCX_CSP


def install(app, repository_root: Path):
    if getattr(getattr(app.state, 'platform', None), 'mode', None) != 'web':
        return
    if getattr(app.state, 'web_workspace_installed', False):
        return
    app.state.web_workspace_installed = True
    existing = tuple(app.router.routes)
    assets = Path(__file__).resolve().parent
    page = (repository_root / 'shared/frontend/index.html').read_text(encoding='utf-8')
    tag = '<script type="text/plain" data-account-src="/assets/web-workspace.js?v=13" defer></script>'
    anchor = re.search(r'<script\b[^>]*data-account-src="/assets/workbench\.js\?[^\"]*"[^>]*></script>', page)
    if not anchor:
        raise RuntimeError('找不到现有工作区加载入口')
    # Install hooks after V2/V22 definitions, but before workbench initialization.
    page = page[:anchor.start()] + tag + '\n' + page[anchor.start():]
    page = page.replace('</head>', '<link rel="stylesheet" href="/assets/web-workspace.css?v=10"></head>', 1)
    home = next((r.endpoint for r in existing if getattr(r, 'path', None) == '/'
                 and 'GET' in getattr(r, 'methods', set())), None)
    if home is None:
        raise RuntimeError('找不到首页')

    async def web_home(request: Request):
        original = await home()
        headers = {k:v for k,v in original.headers.items()
                   if k.lower() not in {'content-length','etag','last-modified'}}
        return HTMLResponse(page, headers=headers)

    app.router.routes.insert(0, Route('/', web_home, methods=['GET']))
    static = {
        '/assets/web-workspace.js': ('workspace.js', 'application/javascript'),
        '/assets/web-workspace.css': ('workspace.css', 'text/css'),
        '/assets/web-document-preview.js': ('document_preview.js', 'application/javascript'),
        '/assets/web-document-preview.css': ('document_preview.css', 'text/css'),
        '/assets/web-docx-vendor/jszip.min.js': ('vendor/jszip.min.js', 'application/javascript'),
        '/assets/web-docx-vendor/docx-preview.min.js': ('vendor/docx-preview.min.js', 'application/javascript'),
    }
    def static_handler(filename, media_type):
        async def handler(request: Request):
            return FileResponse(assets / filename, media_type=media_type,
                                headers={'Cache-Control':'no-cache'})
        return handler
    for url, (filename, mime) in static.items():
        app.router.routes.append(Route(url, static_handler(filename, mime), methods=['GET']))

    def asset_file(request, identifier):
        storage = request.app.state.runtime.storage
        try:
            record = storage.asset(identifier)
            path = Path(storage.asset_path(identifier))
        except (KeyError, ValueError, OSError) as exc:
            raise HTTPException(404, '文件不存在或当前账号不可访问') from exc
        return record, path

    @app.get('/api/web-workspace/raw/{asset_id}')
    async def raw(asset_id: str, request: Request):
        record, path = asset_file(request, asset_id)
        return FileResponse(path, media_type=record.get('mimeType','application/octet-stream'),
                            filename=record.get('filename',path.name),
                            content_disposition_type='attachment',
                            headers={'Cache-Control':'no-store','Content-Security-Policy':"sandbox; default-src 'none'"})

    @app.get('/api/web-workspace/preview/{asset_id}')
    async def preview(asset_id: str, request: Request):
        record, path = asset_file(request, asset_id)
        name = str(record.get('filename') or path.name)
        extension = Path(name).suffix.lower()
        headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
                   'X-Frame-Options':'SAMEORIGIN'}
        if extension == '.pdf':
            if path.stat().st_size > 64 * 1024 * 1024:
                raise HTTPException(413, 'PDF 超过 64 MB 预览上限')
            with path.open('rb') as handle:
                if b'%PDF-' not in handle.read(1024):
                    raise HTTPException(415, 'PDF 文件格式无效')
            return FileResponse(path, media_type='application/pdf', filename=name,
                                content_disposition_type='inline', headers=headers)
        if extension == '.docx':
            document = await asyncio.to_thread(render_docx, path)
            headers['Content-Security-Policy'] = DOCX_CSP
            return HTMLResponse(document, headers=headers)
        raise HTTPException(415, '该格式暂无在线预览，请下载原文件')

    from .remote_workspace import install_remote
    install_remote(app)
    # Exact routes precede the shared /assets mount and optional catch-all.
    added = [r for r in app.router.routes if r not in existing]
    app.router.routes[:] = added + list(existing)
