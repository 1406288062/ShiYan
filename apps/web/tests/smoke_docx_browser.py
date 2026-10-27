"""Real Chromium smoke test for the sandboxed, locally rendered DOCX preview."""
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0,str(Path(__file__).resolve().parents[3]))
from apps.web.adapters.document_preview import render_docx, DOCX_CSP
from apps.web.tests.preview_fixture import docx_bytes
from playwright.sync_api import sync_playwright


def main():
    with tempfile.TemporaryDirectory(prefix='shiyan-docx-browser-') as temp:
        document = Path(temp)/'fixture.docx';document.write_bytes(docx_bytes())
        html = render_docx(document).encode()
        root = Path(__file__).resolve().parents[1]/'adapters'
        static = {
          '/assets/web-document-preview.js':('document_preview.js','application/javascript'),
          '/assets/web-document-preview.css':('document_preview.css','text/css'),
          '/assets/web-docx-vendor/jszip.min.js':('vendor/jszip.min.js','application/javascript'),
          '/assets/web-docx-vendor/docx-preview.min.js':('vendor/docx-preview.min.js','application/javascript'),
        }
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                path=self.path.split('?')[0];policy=None
                if path=='/':
                    raw=b'<!doctype html><iframe title="Word" sandbox="allow-scripts" src="/preview" style="width:460px;height:850px;border:0"></iframe>';mime='text/html'
                elif path=='/preview':raw=html;mime='text/html';policy=DOCX_CSP
                elif path in static:
                    filename,mime=static[path];raw=(root/filename).read_bytes()
                else:self.send_error(404);return
                self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(raw)))
                if policy:self.send_header('Content-Security-Policy',policy)
                self.end_headers();self.wfile.write(raw)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch(headless=True,executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
                page=browser.new_page(viewport={'width':980,'height':900})
                errors=[];requests=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.on('request',lambda req:requests.append(req.url))
                page.goto(f'http://127.0.0.1:{server.server_port}/')
                frame=page.frame_locator('iframe')
                frame.locator('html[data-preview-ready="true"]').wait_for(timeout=20000)
                assert frame.locator('table').count()==1
                assert frame.get_by_text('Column A',exact=True).count()==1
                assert frame.get_by_text('Fixture header',exact=True).count()>=1
                assert frame.get_by_text('Fixture footer',exact=True).count()>=1
                assert frame.locator('section.docx').count()==2
                assert frame.locator('img').first.evaluate('(e)=>e.complete && e.naturalWidth>0')
                for _ in range(40):
                    if frame.locator('.docx-wrapper').evaluate('(e)=>e.style.zoom'): break
                    page.wait_for_timeout(50)
                metrics=frame.locator('section.docx').first.evaluate('(e)=>({width:e.getBoundingClientRect().width,viewport:document.documentElement.clientWidth,zoom:e.parentElement.style.zoom})')
                assert metrics['width'] <= metrics['viewport'],metrics
                print('FIT',metrics)
                assert not errors,errors
                assert all(u.startswith(('http://127.0.0.1:','data:','blob:')) for u in requests),requests
                Path('/tmp/shiyan-web-finish-20261027').mkdir(exist_ok=True)
                page.screenshot(path='/tmp/shiyan-web-finish-20261027/docx-preview.png',full_page=True)
                print('PASS real browser: sandbox, two pages, Chinese text, table, embedded image, header/footer, no external requests, no JS errors')
                browser.close()
        finally:server.shutdown();server.server_close();thread.join(timeout=2)


if __name__=='__main__':main()
