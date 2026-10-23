 
from __future__ import annotations
import asyncio
import io
import json
from pathlib import Path
import sys
for _parent in Path(__file__).resolve().parents:
    if (_parent / "shared" / "paths.py").is_file():
        if str(_parent) not in sys.path:
            sys.path.insert(0, str(_parent))
        break
from shared.paths import APP_ROOT
import tempfile
import time
from PIL import Image
from desktop_backend.gateway import Gateway, GatewayError, FALLBACK_CAPABILITIES
from desktop_backend.runtime import Runtime

ROOT = APP_ROOT

class ControlledGateway(Gateway):
    def __init__(self):
        super().__init__(ROOT)
        self.calls = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.approved = False
        self.failures = []

    async def identity(self):
        return {"deviceID": "controlled-device", "publicKey": "controlled-public-key"}

    async def json(self, method, route, payload=None, timeout=40):
        self.calls.append(route)
        if route == "enroll":
            self.started.set()
            await self.release.wait()
            if self.failures:
                raise self.failures.pop(0)
            return {"approved": self.approved}
        if route == "capabilities":
            return dict(FALLBACK_CAPABILITIES)
        if route == "jobs":
            return {"jobId": "controlled-job"}
        if route.endswith("/cancel"):
            return {"ok": True, "status": "cancelled"}
        raise AssertionError("Unexpected controlled route: " + route)

async def rejection(coroutine, status=403):
    try:
        await coroutine
    except GatewayError as error:
        assert error.status == status, (error.status, status)
        return str(error)
    raise AssertionError("Expected authorization rejection")

class RejectedHTTPConnection:
    def __init__(self, status):
        self.status = status
    def request(self, *args, **kwargs):
        pass
    def getresponse(self):
        return self
    def read(self, *args):
        return b'{"error":"controlled access rejected"}'
    def getheaders(self):
        return []
    def close(self):
        pass

async def main():
    report = {"kind": "controlled enrollment/auth lifecycle; no real network"}
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()
    loop_errors = []
    loop.set_exception_handler(lambda loop, context: loop_errors.append(context.get("message", "")))
    runtimes = []
    gateways = []
    try:
         
        r = Runtime(tempfile.mkdtemp(prefix="shiyan-auth-contract-"), ROOT)
        runtimes.append(r)
        g = ControlledGateway()
        r.gateway = g
        startup = asyncio.create_task(r.start())
        await g.started.wait()
        cid = r.storage.setting("selectedConversationId")
        await r.send(cid, "启动登记期间发送", [])
        sending = r.tasks["conversation:" + cid]
        buffer = io.BytesIO()
        Image.new("RGB", (16, 16), "white").save(buffer, "PNG")
        asset = r.storage.save_bytes(buffer.getvalue(), "test.png", "image/png")
        photo = r.create_photo_job({"feature": "colorize", "assetId": asset["id"]})
        photo_task = r.tasks["photo:" + photo["id"]]
        g.release.set()
        await asyncio.gather(startup, sending, photo_task)
        report["startup_and_jobs_share_one_enrollment"] = g.calls == ["enroll"]
        item = r.conversation(cid)
        report["shared_refusal_clears_conversation_pending"] = item["messages"][-1]["state"] == "failed" and item["pendingJobId"] is None and item["pendingMessageId"] is None and not r.is_busy(item)
        done_photo = r.storage.get("photoJobs", photo["id"])
        report["shared_refusal_finishes_photo"] = done_photo["state"] == "failed" and done_photo["remoteJobId"] is None
        before = len(g.calls)
        started = time.perf_counter()
        errors = await asyncio.gather(
            rejection(g.create_job({})),
            rejection(g.fork("source", "target", [], "old")),
            rejection(g.cancel("request")),
            rejection(g.title("conversation")),
            rejection(anext(g.events("job"))),
        )
        report["known_refusal_no_new_network"] = len(g.calls) == before
        report["known_refusal_preserves_actual_error"] = len(set(errors)) == 1 and "尚未获得" in errors[0]
        report["cached_gate_ms"] = round((time.perf_counter() - started) * 1000, 3)
        request_id = item["messages"][-1]["requestId"]
        r.retry(cid)
        await r.tasks["conversation:" + cid]
        item = r.conversation(cid)
        report["cached_retry_clears_pending_and_keeps_request"] = item["pendingMessageId"] is None and item["pendingJobId"] is None and item["messages"][-1]["requestId"] == request_id and len(g.calls) == before
        original = json.dumps(item["messages"], sort_keys=True)
        await rejection(r.send(cid, "编辑仍保留", [], item["messages"][0]["id"]))
        report["cached_edit_keeps_original_branch"] = json.dumps(r.conversation(cid)["messages"], sort_keys=True) == original and len(g.calls) == before
        await r.send(cid, "失败之后继续发送", [])
        await r.tasks["conversation:" + cid]
        report["cached_failure_does_not_lock_new_send"] = r.conversation(cid)["pendingMessageId"] is None and len(g.calls) == before
        g.approved = True
        report["explicit_reconnect_performs_real_attempt"] = await r.connect(force=True) and g.calls.count("enroll") == 2 and g.calls[-1] == "capabilities" and r.connection["status"] == "ready"

         
        r2 = Runtime(tempfile.mkdtemp(prefix="shiyan-auth-stop-"), ROOT)
        runtimes.append(r2)
        g2 = ControlledGateway()
        r2.gateway = g2
        cid2 = r2.storage.setting("selectedConversationId")
        await r2.send(cid2, "连接时停止", [])
        submit = r2.tasks["conversation:" + cid2]
        await g2.started.wait()
        shared = g2.connection_task
        stopping = asyncio.create_task(r2.stop_conversation(cid2))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        report["cancelled_submit_preserves_shared_connection"] = not shared.cancelled() and not shared.done()
        g2.release.set()
        await asyncio.gather(submit, stopping, return_exceptions=True)
        item2 = r2.conversation(cid2)
        report["unconfirmed_stop_terminal_and_recoverable"] = item2["messages"][-1]["state"] == "cancelled" and item2["pendingMessageId"] is None and len(r2.storage.list("stops")) == 1 and g2.calls.count("enroll") == 1
        g2.approved = True
        await r2.connect(force=True)
        if r2.background:
            await asyncio.gather(*list(r2.background))
        report["explicit_reconnect_confirms_saved_stop"] = not r2.storage.list("stops") and any(x.endswith("/cancel") for x in g2.calls) and r2.conversation(cid2)["messages"][-1]["error"] is None

         
        g3 = ControlledGateway()
        gateways.append(g3)
        g3.approved = True
        first = asyncio.create_task(g3.connect())
        await g3.started.wait()
        cancelled = asyncio.create_task(g3.ensure_enrolled())
        manual = asyncio.create_task(g3.connect(force=True))
        await asyncio.sleep(0)
        cancelled.cancel()
        await asyncio.gather(cancelled, return_exceptions=True)
        g3.release.set()
        await asyncio.gather(first, manual)
        report["concurrent_manual_join_and_waiter_cancel"] = g3.calls.count("enroll") == 1 and g3.enrolled

         
        g4 = ControlledGateway()
        gateways.append(g4)
        g4.release.set()
        g4.approved = True
        g4.failures = [GatewayError("controlled transient", 503)]
        await rejection(g4.connect(), 503)
        job_id = await g4.create_job({})
        report["transient_failure_retries_normally"] = g4.calls.count("enroll") == 2 and job_id == "controlled-job" and g4.authorization_error is None

         
        for status in [401, 403]:
            g5 = Gateway(ROOT)
            gateways.append(g5)
            async def parts(*args, **kwargs):
                return "/controlled", b"", {}
            g5.request_parts = parts
            http_calls = []
            def http_connection(timeout=40, status=status):
                http_calls.append(status)
                return RejectedHTTPConnection(status)
            g5.make_connection = http_connection
            g5.enrolled = True
            await rejection(g5.raw("POST", "jobs", {}), status)
            cached = await rejection(g5.create_job({}), status)
            report["http_" + str(status) + "_cached_without_reenrollment"] = cached == "controlled access rejected" and not g5.enrolled and http_calls == [status]
        fresh = Gateway(ROOT)
        gateways.append(fresh)
        report["authorization_cache_is_process_local"] = fresh.authorization_error is None and not fresh.enrolled
    finally:
        for runtime in runtimes:
            await runtime.close()
        for gateway in gateways:
            gateway.close()
        await asyncio.sleep(0)
        report["cancelled_waiter_has_no_unhandled_exception"] = not loop_errors
        loop.set_exception_handler(previous_handler)
        path = ROOT / "desktop_backend" / "verification-connection.json"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    assert not any(value is False for value in report.values()), "Connection regression failed"

if __name__ == "__main__":
    asyncio.run(main())
