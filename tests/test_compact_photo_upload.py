"""Photo uploads/preferences must not return or broadcast complete chat state."""
import io
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,AsyncMock
import httpx
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from shared.paths import APP_ROOT
sys.path.insert(0,str(APP_ROOT))
from desktop_backend.api import create_app
from desktop_backend.storage import Storage

class CompactPhotoUploadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.storage=Storage(self.temp.name,APP_ROOT);self.addCleanup(self.storage.db.close)
        self.runtime=SimpleNamespace(storage=self.storage,server_access=True,notify=Mock(),snapshot=Mock(return_value={'conversations':[{'text':'x'*4_730_000}]}))
        self.app=create_app(self.temp.name,APP_ROOT,profile='web');self.app.state.runtime=self.runtime
        self.app.state.accounts=SimpleNamespace(protect=AsyncMock())
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://127.0.0.1:17861',headers={'X-Shiyan-Local':'1'})
        self.addAsyncCleanup(self.client.aclose)
        image=io.BytesIO();Image.new('RGB',(32,24),(12,34,56)).save(image,format='PNG');self.image=image.getvalue()
    async def upload(self,compact=True,kind='input'):
        return await self.client.post('/api/assets'+('?compact=1' if compact else ''),files={'files':('fixture.png',self.image,'image/png')},data={'kind':kind})
    async def test_photo_upload_returns_only_public_assets_without_chat_snapshot(self):
        r=await self.upload();self.assertEqual(r.status_code,200);data=r.json()
        self.assertLess(len(r.content),2048);self.assertNotIn('state',data)
        self.assertNotIn('storedName',data['assets'][0]);self.assertNotIn('sourcePath',data['assets'][0])
        self.runtime.snapshot.assert_not_called();self.runtime.notify.assert_not_called()
        self.assertEqual(self.storage.asset(data['assets'][0]['id'])['width'],32)
    async def test_compact_preferences_persist_without_snapshot_and_reject_foreign_assets(self):
        asset=(await self.upload()).json()['assets'][0]
        values={'homeInputAssetId':asset['id'],'homeFeature':'enhance','homeModel':'anime'}
        r=await self.client.patch('/api/settings?compact=1',json=values)
        self.assertEqual(r.status_code,200);self.assertLess(len(r.content),1024);self.assertNotIn('state',r.json())
        self.assertEqual(self.storage.setting('settings')['homeInputAssetId'],asset['id'])
        prior=self.storage.setting('settings')
        for invalid in [{'homeInputAssetId':'other-user-asset'},{'avatarAssetId':asset['id']},{'historyViewMode':'grid'}]:
            r=await self.client.patch('/api/settings?compact=1',json=invalid);self.assertEqual(r.status_code,400)
            self.assertEqual(self.storage.setting('settings'),prior)
        self.runtime.snapshot.assert_not_called();self.runtime.notify.assert_not_called()
    async def test_attachment_and_legacy_upload_keep_their_existing_state_contract(self):
        for compact,kind in [(False,'input'),(True,'attachment')]:
            r=await self.upload(compact,kind);self.assertEqual(r.status_code,200);self.assertIn('state',r.json())
        self.assertEqual(self.runtime.snapshot.call_count,2);self.assertEqual(self.runtime.notify.call_count,2)
    async def test_legacy_settings_keep_their_existing_state_contract(self):
        r=await self.client.patch('/api/settings',json={'historyViewMode':'grid'});self.assertEqual(r.status_code,200)
        self.assertIn('state',r.json());self.runtime.notify.assert_called_once();self.runtime.snapshot.assert_called_once()

if __name__=='__main__':unittest.main()
