"""Two complete browser sessions retain independent local resources and cookies."""
import asyncio
import os
from pathlib import Path
import secrets
import tempfile
from unittest.mock import patch
import httpx
from .api import create_app
from .account_sessions import COOKIE
from .verify_accounts import FakeGateway


def resource_root():
    for parent in Path(__file__).resolve().parents:
        if (parent / "Mac" / "web").is_dir():
            return parent / "Mac"
    return Path(__file__).resolve().parents[1]


class QRTestGateway(FakeGateway):
    async def json(self, method, route, payload=None, timeout=40):
        if route == "auth/qr/create":
            self.qr = {"id": secrets.token_urlsafe(16), "pollSecret": secrets.token_urlsafe(32)}
            return {"ok":True, **self.qr, "code":"123456", "expiresAt":9999999999999, "payload":"test-qr"}
        if route == "auth/qr/poll":
            assert payload == self.qr
            return {"ok":True,"state":"pending"}
        return await super().json(method,route,payload,timeout)
    async def helper_json(self, action, value=b""):
        assert action == "qr-code"
        return {"png":"data:image/png;base64,dGVzdA=="}


async def main():
    with tempfile.TemporaryDirectory(prefix="shiyan-web-accounts-") as directory, patch.dict(os.environ, {"SHIYAN_OFFLINE_TEST":"1", "SHIYAN_MULTIUSER_WEB":"1"}), patch("desktop_backend.account_sessions.Gateway", QRTestGateway), patch("desktop_backend.runtime.Gateway", QRTestGateway):
        app = create_app(directory, resource_root())
        async with app.router.lifespan_context(app):
            transport=httpx.ASGITransport(app=app)
            args={"transport":transport,"base_url":"http://127.0.0.1:7860","headers":{"X-Shiyan-Local":"1"}}
            async with httpx.AsyncClient(**args) as a, httpx.AsyncClient(**args) as b:
                qra,qrb=await asyncio.gather(a.post("/api/auth/qr/create",json={}),b.post("/api/auth/qr/create",json={}))
                assert qra.status_code == qrb.status_code == 200
                assert "HttpOnly" in qra.headers["set-cookie"] and "SameSite=strict" in qra.headers["set-cookie"]
                assert (await a.post("/api/auth/qr/poll",json={"id":qra.json()["id"]})).json()["state"] == "pending"
                assert (await b.post("/api/auth/qr/poll",json={"id":qrb.json()["id"]})).json()["state"] == "pending"
                assert (await a.post("/api/auth/qr/poll",json={"id":qrb.json()["id"]})).status_code == 409
                assert (await a.get("/api/state")).status_code == 401,"A QR pending cookie is never an authenticated session"
                first,second=await asyncio.gather(a.post("/api/auth/login",json={"email":"browser-a@test"}), b.post("/api/auth/login",json={"email":"browser-b@test"}))
                assert first.status_code==second.status_code==200
                cookie_a,cookie_b=a.cookies.get(COOKIE),b.cookies.get(COOKIE)
                assert cookie_a!=cookie_b
                state_a,state_b=await asyncio.gather(a.get("/api/state"),b.get("/api/state"))
                assert state_a.status_code==state_b.status_code==200,"A second browser login must not invalidate the first browser"
                ca=state_a.json()["state"]["conversations"][0]["id"]
                cb=state_b.json()["state"]["conversations"][0]["id"]
                assert ca!=cb
                await a.patch("/api/conversations/"+ca,json={"draft":"private-a"})
                await b.patch("/api/conversations/"+cb,json={"draft":"private-b"})
                managers=app.state.accounts.sessions
                ma=next(m for m in managers.values() if m.cookie==cookie_a)
                mb=next(m for m in managers.values() if m.cookie==cookie_b)
                assert ma.resources.runtime.storage.root!=mb.resources.runtime.storage.root
                qa,qb=asyncio.Queue(),asyncio.Queue()
                ma.resources.runtime.listeners.add(qa);mb.resources.runtime.listeners.add(qb)
                await a.patch("/api/conversations/"+ca,json={"draft":"private-a-updated"})
                assert not qa.empty() and qb.empty(),"A stream update must not wake B's listeners"
                wa=(await a.post("/api/workspace/bootstrap",json={})).json()
                wb=(await b.post("/api/workspace/bootstrap",json={})).json()
                assert wa["token"]!=wb["token"]
                ha={"X-Shiyan-Workspace":wa["token"]};hb={"X-Shiyan-Workspace":wb["token"]}
                assert (await a.post("/api/workspace/projects",headers=ha,json={"name":"private-project-a"})).status_code==200
                assert (await b.get("/api/workspace/projects",headers=hb)).json()["projects"]==[]
                assert (await b.get("/api/workspace/projects",headers=ha)).status_code==403,"Workspace CSRF tokens are browser/account bound"
                asset=ma.resources.runtime.storage.save_bytes(b"private-asset-a","private.txt","text/plain")
                assert (await a.get("/api/assets/"+asset["id"]+"/file")).status_code==200
                assert (await b.get("/api/assets/"+asset["id"]+"/file")).status_code==400
                pa,pb=await asyncio.gather(a.get("/api/dots/profile"),b.get("/api/dots/profile"))
                assert pa.json()["profile"]["name"]!=pb.json()["profile"]["name"]
                assert (await a.post("/api/auth/logout",json={})).status_code==200
                assert (await a.get("/api/state")).status_code==401
                assert (await b.get("/api/state")).status_code==200,"Logging A out must not close B's resources"
        # A service restart restores only the browser's exact durable cookie.
        restored=create_app(directory,resource_root())
        async with restored.router.lifespan_context(restored):
            transport=httpx.ASGITransport(app=restored)
            async with httpx.AsyncClient(transport=transport,base_url="http://127.0.0.1:7860",headers={"Cookie":COOKIE+"="+cookie_b}) as b:
                me=await b.get("/api/auth/me")
                assert me.status_code==200
                state=(await b.get("/api/state")).json()["state"]
                assert next(c for c in state["conversations"] if c["id"]==cb)["draft"]=="private-b"
            for cookie in [cookie_a,secrets.token_urlsafe(32)]:
                async with httpx.AsyncClient(transport=transport,base_url="http://127.0.0.1:7860",headers={"Cookie":COOKIE+"="+cookie}) as unknown:
                    assert (await unknown.get("/api/auth/me")).status_code==401,"Never fall back to the last signed-in browser"
    print("PASS: independent anonymous QR create/poll and no preauth access, simultaneous Web A/B login, own conversations/assets/projects/Dots/CSRF tokens and stream listeners, independent logout, durable exact-cookie restore and no default-account fallback")

if __name__=="__main__":asyncio.run(main())
