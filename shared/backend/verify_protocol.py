 
from __future__ import annotations
import asyncio
import hashlib
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
from PIL import Image
from desktop_backend.runtime import Runtime
from desktop_backend.gateway import GatewayError

ROOT=APP_ROOT

class ContractGateway:
    def __init__(self):
        self.created=[]
        self.cancelled=[]
        self.fork_failure=False
        self.block_submit=False
        self.submit_started=asyncio.Event()
        self.release_submit=asyncio.Event()
        self.download_count=0

    async def create_job(self,payload):
        self.created.append(payload)
        self.submit_started.set()
        if self.block_submit:
            await self.release_submit.wait()
        return "contract-job-id"

    async def events(self,identifier,after):
        events=[{"seq":1,"type":"text","text":"你"},
                {"seq":2,"type":"text","text":"你好"},
                {"seq":2,"type":"text","text":"重复事件不应覆盖"},
                {"seq":3,"type":"artifact","asset":{"id":"remote-image-id","filename":"result.png","mimeType":"image/png"}},
                {"seq":4,"type":"completed","text":"你好，完成","assets":[{"id":"remote-image-id","filename":"result.png","mimeType":"image/png"}],"threadId":"retained-thread"}]
        for event in events:
            if event["seq"]>after:
                yield event

    async def download(self,asset,storage,**kwargs):
        self.download_count+=1
        buffer=io.BytesIO()
        Image.new("RGB",(8,8),(20,30,40)).save(buffer,"PNG")
        return storage.save_bytes(buffer.getvalue(),asset["filename"],asset["mimeType"],remote_id=asset["id"])

    async def fork(self,source,target,retained,replaced):
        if self.fork_failure:
            raise GatewayError("controlled fork failure")
        return "forked-thread"

    async def cancel(self,request_id):
        self.cancelled.append(request_id)
        return "cancelled"

    async def title(self,remote_id):
        return None

    def close(self):
        pass

async def main():
    r=Runtime(tempfile.mkdtemp(prefix="shiyan-contract-check-"),ROOT)
    gateway=ContractGateway()
    r.gateway=gateway
    output={"kind":"controlled protocol regression; cloud not exercised"}
    cid=r.storage.setting("selectedConversationId")
    await r.send(cid,"首轮消息",[])
    task=r.tasks["conversation:"+cid]
    await task
    item=r.conversation(cid)
    output["cumulative_text_replaces"]=item["messages"][-1]["text"]=="你好，完成"
    output["sequence_deduplicates"]=item["lastEventId"]==4
    output["artifact_deduplicates"]=gateway.download_count==1 and len(item["messages"][-1]["assets"])==1
    output["completion_clears_pending"]=item["pendingJobId"] is None and item["pendingMessageId"] is None
    history_count=len(r.storage.list("history"))
    before=json.dumps(item,sort_keys=True)
    gateway.fork_failure=True
    try:
        await r.send(cid,"编辑失败保留原文",[],item["messages"][0]["id"])
    except GatewayError:
        pass
    output["fork_failure_preserves_history"]=json.dumps(r.conversation(cid),sort_keys=True)==before
    gateway.fork_failure=False
    await r.send(cid,"成功编辑",[],item["messages"][0]["id"])
    await r.tasks["conversation:"+cid]
    edited=r.conversation(cid)
    output["fork_success_replaces_branch"]=len(edited["messages"])==2 and edited["messages"][0]["text"]=="成功编辑" and edited["remoteConversationId"]!=cid
    await r.delete_conversation(cid)
    output["delete_conversation_preserves_works"]=len(r.storage.list("history"))>=history_count
    cid=r.storage.setting("selectedConversationId")
    gateway.block_submit=True
    gateway.submit_started.clear()
    await r.send(cid,"提交中取消",[])
    await gateway.submit_started.wait()
    request_id=r.conversation(cid)["messages"][-1]["requestId"]
    await r.stop_conversation(cid)
    item=r.conversation(cid)
    output["cancel_before_job_id"]=gateway.cancelled[-1]==request_id and item["messages"][-1]["state"]=="cancelled" and item["pendingJobId"] is None
    output["confirmed_stop_intent_removed"]=r.storage.list("stops")==[]
    gateway.block_submit=False
     
    await r.send(cid,"恢复提交",[])
    task=r.tasks["conversation:"+cid]
    await task
    latest=r.conversation(cid)
    reply=latest["messages"][-1]
    original_request=reply["requestId"]
    reply.update(state="submitting",text="",assets=[])
    latest.update(pendingMessageId=reply["id"],pendingJobId=None,lastEventId=0)
    r.storage.put("conversations",latest)
    await r.run_agent(cid)
    output["submission_resume_keeps_request_id"]=gateway.created[-1]["requestId"]==original_request
    await r.close()
    (ROOT/"desktop_backend"/"verification-protocol.json").write_text(json.dumps(output,ensure_ascii=False,indent=2))
    print(json.dumps(output,ensure_ascii=False,indent=2))
    if any(value is False for value in output.values()):
        raise AssertionError("protocol regression failed")

if __name__=="__main__":
    asyncio.run(main())
