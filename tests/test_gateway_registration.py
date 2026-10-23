"""Anonymous registration must reach the gateway without weakening private routes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
_repository = Path(__file__).resolve().parents[1]
if str(_repository) not in sys.path:
    sys.path.insert(0, str(_repository))
from shared.paths import APP_ROOT
import unittest

source = Path(os.environ.get("SHIYAN_GATEWAY_TEST_SOURCE", APP_ROOT / "desktop_backend/gateway.py"))
spec = importlib.util.spec_from_file_location("registration_gateway_under_test", source)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)

class RegistrationGatewayTests(unittest.IsolatedAsyncioTestCase):
    def client(self):
        client = gateway.Gateway.__new__(gateway.Gateway)
        client.account_token = None
        client.prefix = "/shiyan/v1/"
        async def unexpected_identity():
            self.fail("Public registration must not need a paired device")
        client.identity = unexpected_identity
        return client

    async def test_anonymous_registration_requests_keep_payload_and_hash(self):
        client = self.client()
        for route, payload in [
            ("auth/register-code", {"email": "new@example.test"}),
            ("auth/register", {"email": "new@example.test", "password": "fixture-password", "verificationCode": "123456"}),
            ("auth/login", {"identifier": "new@example.test", "password": "fixture-password"}),
        ]:
            with self.subTest(route=route):
                path, body, headers = await client.request_parts("POST", route, payload)
                self.assertEqual(path, "/shiyan/v1/" + route)
                self.assertEqual(json.loads(body), payload)
                self.assertEqual(headers["X-Shiyan-Body-Sha"], hashlib.sha256(body).hexdigest())
                self.assertNotIn("Authorization", headers)
                self.assertNotIn("X-Shiyan-Device", headers)

    async def test_private_and_similarly_named_routes_still_require_login(self):
        client = self.client()
        for route in ["auth/me", "admin/users", "sync", "auth/register-code/extra", "auth/register-code?extra=1"]:
            with self.subTest(route=route):
                with self.assertRaises(gateway.GatewayError) as caught:
                    await client.request_parts("GET", route)
                self.assertEqual(caught.exception.status, 401)

    async def test_logged_in_requests_keep_the_account_bearer(self):
        client = self.client()
        client.account_token = "fixture-token"
        _, _, headers = await client.request_parts("POST", "auth/register-code", {"email": "new@example.test"})
        self.assertEqual(headers["Authorization"], "Bearer fixture-token")
        self.assertEqual(headers["X-Shiyan-Account-Required"], "1")
