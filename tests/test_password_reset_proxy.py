"""Password recovery remains public and never activates an account session."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

_repository = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(_repository), str(_repository / 'Mac')]
from desktop_backend.api import create_app
from desktop_backend.gateway import Gateway
from shared.paths import APP_ROOT
import httpx


class PasswordResetProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_desktop_and_web_forward_reset_without_creating_sessions(self):
        for mode in ['desktop', 'web']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                gateway = SimpleNamespace(json=AsyncMock(return_value={'ok': True, 'resendAfter': 60}))
                manager = SimpleNamespace(protect=AsyncMock(), gateway=gateway, activate=Mock(side_effect=AssertionError('must not log in')))
                with patch.dict(os.environ, {'SHIYAN_COS_CONFIG': ''}):
                    app = create_app(folder, APP_ROOT, profile=mode)
                app.state.accounts = manager
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:17861', headers={'X-Shiyan-Local':'1'}) as client:
                    for route in ['password-reset-code', 'password-reset']:
                        payload = {'email':'fixture@example.test', 'verificationCode':'123456'}
                        response = await client.post('/api/auth/' + route, json=payload)
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.json(), {'ok': True, 'resendAfter': 60})
                        self.assertNotIn('set-cookie', response.headers)
                        gateway.json.assert_awaited_with('POST', 'auth/' + route, payload, timeout=35)
                    response = await client.post('/api/auth/password-reset', content=b'x'*16385)
                    self.assertEqual(response.status_code, 413)
                manager.activate.assert_not_called()

    async def test_unauthenticated_gateway_does_not_require_a_device_key(self):
        gateway = Gateway.__new__(Gateway)
        gateway.prefix = '/shiyan/v1/'
        gateway.account_token = None
        gateway.identity = AsyncMock(side_effect=AssertionError('recovery must not require device enrollment'))
        for route in ['auth/password-reset-code', 'auth/password-reset']:
            path, body, headers = await gateway.request_parts('POST', route, {'email':'fixture@example.test'})
            self.assertEqual(path, '/shiyan/v1/' + route)
            self.assertEqual(json.loads(body), {'email':'fixture@example.test'})
            self.assertNotIn('Authorization', headers)
            self.assertNotIn('X-Shiyan-Device', headers)
        gateway.identity.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
