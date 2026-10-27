"""Full account/session/HTTP/socket/helper integration in temporary fixtures."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[3]))
from apps.web.tests.integration_fixture import Harness

class WorkspaceIntegrationTests(unittest.TestCase):
    def test_real_auth_socket_device_roundtrip(self):
        with Harness() as h:
            a=h.client();b=h.client('fixture-b@example.test')
            self.assertEqual(a.get('/api/web-workspace/projects').status_code,200)
            create=a.post('/api/web-workspace/projects',json={'deviceId':'fixture-device','path':str(h.project),'name':'设备项目'})
            self.assertEqual(create.status_code,200,create.text)
            project=create.json()['project']['id']
            self.assertEqual(b.get('/api/web-workspace/projects').json()['projects'],[])
            def post(route,data):return a.post('/api/web-workspace/'+route,json={'projectId':project,**data})
            listing=a.get('/api/web-workspace/directory-details',params={'projectId':project})
            self.assertEqual(listing.status_code,200,listing.text)
            self.assertIn('src',[e['name'] for e in listing.json()['entries']])
            read=post('files/read',{'path':'src/main.py'})
            self.assertEqual(read.status_code,200,read.text)
            file=read.json()['file'];self.assertEqual(file['text'],"print('before')\n")
            change={'path':'src/main.py','text':"print('after')\n",'contentHash':file['contentHash'],'confirmed':True,'requestId':'fixture-save-request-001'}
            saved=post('files/save-text',change)
            self.assertEqual(saved.status_code,200,saved.text)
            self.assertEqual(h.source.read_text(),"print('after')\n")
            self.assertEqual(h.source.stat().st_mode&0o777,0o755)
            backup=Path(saved.json()['backupPath'])
            self.assertEqual(backup.read_text(),"print('before')\n")
            self.assertFalse((h.project/'.shiyan-web-state').exists())
            replay=post('files/save-text',change)
            self.assertEqual(replay.status_code,200,replay.text)
            mismatch=post('files/save-text',{**change,'text':'different payload'})
            self.assertEqual(mismatch.status_code,409,mismatch.text)
            conflict=post('files/save-text',{**change,'requestId':'fixture-save-request-002'})
            self.assertEqual(conflict.status_code,409,conflict.text)
            diff=post('files/changes',{'path':'src/main.py'})
            self.assertEqual(diff.status_code,200,diff.text)
            self.assertIn("+print('after')",diff.json()['changes']['diff'])
            self.assertEqual(b.post('/api/web-workspace/files/read',json={'projectId':project,'path':'src/main.py'}).status_code,404)
            escape=post('files/read',{'path':'../outside'})
            self.assertGreaterEqual(escape.status_code,400,escape.text)
            link=h.project/'escape';link.symlink_to(h.root)
            self.assertGreaterEqual(post('files/read',{'path':'escape/outside'}).status_code,400)
            search=a.get('/api/web-workspace/files/search',params={'projectId':project,'q':'main'})
            self.assertEqual(search.status_code,200,search.text)
            self.assertEqual(search.json()['entries'][0]['path'],'src/main.py')
            document=post('files/read',{'path':'report.docx'})
            self.assertEqual(document.status_code,200,document.text)
            url=document.json()['file']['previewUrl']
            self.assertEqual(b.get(url).status_code,403)
            preview=a.get(url);self.assertEqual(preview.status_code,200,preview.text[:100])
            self.assertIn('sandbox allow-scripts',preview.headers['content-security-policy'])
            self.assertEqual(a.get(url).status_code,200)
            h.device_online=False
            self.assertEqual(post('files/read',{'path':'src/main.py'}).status_code,503)
            h.device_online=True
            self.assertEqual(a.delete('/api/web-workspace/projects/'+project).status_code,200)
            self.assertTrue(h.source.exists())
            self.assertEqual(post('files/read',{'path':'src/main.py'}).status_code,404)

    def test_assets_public_scripts_desktop_and_auth_boundaries(self):
        with Harness() as h:
            a=h.client();b=h.client('fixture-b@example.test');seed=h.seed(a)
            for name in ['web-workspace.js','web-workspace.css','web-document-preview.js','web-docx-vendor/jszip.min.js']:
                r=a.get('/assets/'+name);self.assertEqual(r.status_code,200,(name,r.text[:100]))
            page=a.get('/').text
            self.assertLess(page.index('/assets/web-workspace.js'),page.index('/assets/workbench.js?'))
            for key in ['word','pdf']:
                url='/api/web-workspace/preview/'+seed[key]['id']
                r=a.get(url);self.assertEqual(r.status_code,200,r.text[:100])
                self.assertEqual(b.get(url).status_code,404)
            no_csrf=a.post('/api/web-workspace/projects',headers={'X-Shiyan-Local':''},json={})
            self.assertEqual(no_csrf.status_code,403)
            self.assertEqual(a.post('/api/web-workspace/projects',headers={'Origin':'https://evil.test'},json={}).status_code,403)
            from desktop_backend.api import create_app
            from shared.paths import APP_ROOT
            from apps.web.adapters.workspace import install
            desktop=create_app(h.root/'desktop-data',APP_ROOT,profile='desktop')
            before=tuple(desktop.routes);install(desktop,Path(__file__).resolve().parents[3])
            self.assertEqual(tuple(desktop.routes),before)

if __name__=='__main__':unittest.main()
