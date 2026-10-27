"""Bounded, account-private DOCX previews using locally vendored renderers."""
from __future__ import annotations
import base64
import hashlib
from html import escape
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile
from fastapi import HTTPException

MAX_DOCX = 32 * 1024 * 1024
MAX_EXPANDED = 80 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024
_ASSETS = Path(__file__).resolve().parent
# An opaque sandbox origin cannot fetch app assets through the existing strict
# cross-site middleware. Embed only our pinned scripts and authorize exact
# hashes, rather than relaxing app authentication or granting same-origin.
_SCRIPT_FILES = ('vendor/jszip.min.js', 'vendor/docx-preview.min.js', 'document_preview.js')
_SCRIPTS = tuple((_ASSETS / name).read_text(encoding='utf-8') for name in _SCRIPT_FILES)
if any('</script' in script.lower() for script in _SCRIPTS):
    raise RuntimeError('预览脚本含有不安全的 HTML 结束标记')
_SCRIPT_POLICY = ' '.join("'sha256-" + base64.b64encode(hashlib.sha256(script.encode('utf-8')).digest()).decode('ascii') + "'" for script in _SCRIPTS)
DOCX_CSP = ("sandbox allow-scripts; default-src 'none'; script-src " + _SCRIPT_POLICY + "; "
            "style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; "
            "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; "
            "form-action 'none'; frame-ancestors 'self'")



def checked_docx(path: Path) -> bytes:
    """Never extract a ZIP onto disk; cap entry count and expanded XML first."""
    if path.stat().st_size > MAX_DOCX:
        raise HTTPException(413, "Word 文件超过 32 MB 预览上限，请下载原文件")
    try:
        with ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 4096 or sum(x.file_size for x in entries) > MAX_EXPANDED:
                raise HTTPException(413, "Word 解压后内容过大，请下载原文件")
            names = set()
            for entry in entries:
                name = entry.filename
                if (name in names or name.startswith('/') or '\\' in name or
                        '..' in PurePosixPath(name).parts or entry.flag_bits & 1):
                    raise HTTPException(415, "Word 文件结构无效或已加密")
                names.add(name)
                if name.lower().endswith(('.xml', '.rels')):
                    if entry.file_size > MAX_XML:
                        raise HTTPException(413, "Word XML 超过预览上限")
                    value = archive.read(entry)
                    # Both ASCII and UTF-16 XML are checked without interpreting entities.
                    normalized = value.replace(b'\x00', b'').upper()
                    if b'<!DOCTYPE' in normalized or b'<!ENTITY' in normalized:
                        raise HTTPException(415, "Word 文件包含不支持的 XML 声明")
            if 'word/document.xml' not in names or '[Content_Types].xml' not in names:
                raise HTTPException(415, "不是有效的 DOCX 文档")
        return path.read_bytes()
    except (BadZipFile, KeyError, RuntimeError, OSError) as exc:
        raise HTTPException(415, "Word 文件损坏或无法读取") from exc


def render_docx(path: Path) -> str:
    data = base64.b64encode(checked_docx(Path(path))).decode('ascii')
    title = escape(Path(path).name)
    # Document bytes are inert base64, not inline JavaScript or HTML. The iframe
    # has an opaque sandbox origin and cannot access the application's cookies.
    styles = (_ASSETS / 'document_preview.css').read_text(encoding='utf-8')
    scripts = ''.join('<script>' + source + '</script>' for source in _SCRIPTS)
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title>
<style>{styles}</style></head><body><p id="documentStatus" role="status">正在加载 Word 文档…</p>
<div id="documentStyles"></div><main id="documentContent" aria-label="Word 文档"></main>
<template id="documentBytes">{data}</template>
<noscript>请启用 JavaScript 以预览 Word，或下载原文件查看。</noscript>
{scripts}</body></html>'''
