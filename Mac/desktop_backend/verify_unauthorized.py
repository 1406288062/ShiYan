 
from __future__ import annotations
import asyncio
import io
import json
from pathlib import Path
import tempfile
import time
from PIL import Image
from desktop_backend.runtime import Runtime
from desktop_backend.gateway import GatewayError

ROOT=Path(__file__).resolve().parents[1]

async def main():
    directory=tempfile.mkdtemp(prefix="shiyan-unauthorized-check-")
    r=Runtime(directory,ROOT)
    raw=r.gateway.raw
    remote_calls=[]
    async def prevent_paid_job(method,route,payload=None,timeout=40):
        remote_calls.append(route)
        if route=="jobs" or route=="conversations/fork":
            raise AssertionError("This test never creates a cloud job or branch")
        return await raw(method,route,payload,timeout)
    r.gateway.raw=prevent_paid_job
    report={"kind":"real pinned TLS enrollment refusal; cloud job writes guarded","testDataDir":directory}
    try:
        connect_started=time.perf_counter()
        connected=await r.connect()
        report["real_initial_connect_ms"]=round((time.perf_counter()-connect_started)*1000,3)
        report["real_unauthorized"]=not connected and r.connection["status"]=="unauthorized"
        if not report["real_unauthorized"]:
            raise AssertionError("Device is no longer unauthorized; stopped before any job")
        enrolled_calls=len(remote_calls)
        cid=r.storage.setting("selectedConversationId")
        cached_started=time.perf_counter()
        await r.send(cid,"授权状态回归一",[])
        await r.tasks["conversation:"+cid]
        report["real_cached_submission_ms"]=round((time.perf_counter()-cached_started)*1000,3)
        report["cached_submission_no_new_network"]=len(remote_calls)==enrolled_calls
        item=r.conversation(cid)
        last=item["messages"][-1]
        report["real_403_message_failed"]=last["state"]=="failed" and "尚未获得" in last["error"]
        report["terminal_clears_pending_ids"]=item["pendingJobId"] is None and item["pendingMessageId"] is None
        report["failed_conversation_not_busy"]=not next(c for c in r.snapshot()["conversations"] if c["id"]==cid)["isBusy"]
        request_id=last["requestId"]
        count=len(item["messages"])
        retry_started=time.perf_counter()
        r.retry(cid)
        await r.tasks["conversation:"+cid]
        report["real_cached_retry_ms"]=round((time.perf_counter()-retry_started)*1000,3)
        retried=r.conversation(cid)
        report["explicit_retry_reuses_request"]=retried["messages"][-1]["requestId"]==request_id and len(retried["messages"])==count
        report["retry_403_clears_pending_again"]=retried["pendingMessageId"] is None and retried["pendingJobId"] is None
        before=json.dumps(retried["messages"],sort_keys=True)
        try:
            await r.send(cid,"编辑但未获授权",[],retried["messages"][0]["id"])
        except GatewayError as exc:
            report["edit_returns_real_403"]=exc.status==403
        report["failed_edit_keeps_messages"]=json.dumps(r.conversation(cid)["messages"],sort_keys=True)==before
        r.patch_conversation(cid,{"draft":"仍可输入","isPinned":True})
        await r.send(cid,"未授权后仍可继续发送",[])
        await r.tasks["conversation:"+cid]
        item=r.conversation(cid)
        report["new_send_after_failure_allowed"]=len(item["messages"])==count+2 and item["pendingMessageId"] is None
        buffer=io.BytesIO()
        Image.new("RGB",(16,16),"white").save(buffer,"PNG")
        asset=r.storage.save_bytes(buffer.getvalue(),"test.png","image/png")
        for feature in ["colorize","remove"]:
            job=r.create_photo_job({"feature":feature,"assetId":asset["id"],"maskAssetId":asset["id"] if feature=="remove" else None})
            await r.tasks["photo:"+job["id"]]
            done=r.storage.get("photoJobs",job["id"])
            report[feature+"_403_terminal_without_remote_pending"]=done["state"]=="failed" and done["remoteJobId"] is None and done["outputAssetId"] is None
         
        item=r.conversation(cid)
        preserved=[(m["id"],m["text"],m.get("error")) for m in item["messages"]]
        item["pendingMessageId"]=item["messages"][-1]["id"]
        r.storage.put("conversations",item)
        await r.close()
        restored=Runtime(directory,ROOT)
        try:
            item=restored.conversation(cid)
            report["startup_repairs_legacy_terminal_reference"]=item["pendingMessageId"] is None and item["pendingJobId"] is None
            report["startup_repair_preserves_messages"]=[(m["id"],m["text"],m.get("error")) for m in item["messages"]]==preserved
        finally:
            await restored.close()
        report["all_cached_rejections_no_additional_enrollment"]=len(remote_calls)==enrolled_calls
        report["remote_routes_called"]=remote_calls
        report["no_cloud_jobs_or_forks_created"]="jobs" not in remote_calls and "conversations/fork" not in remote_calls
    finally:
        if not r.closing:
            await r.close()
        path=ROOT/"desktop_backend"/"verification-unauthorized.json"
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps(report,ensure_ascii=False,indent=2))
    if any(value is False for value in report.values()):
        raise AssertionError("unauthorized regression failed")

if __name__=="__main__":
    asyncio.run(main())
