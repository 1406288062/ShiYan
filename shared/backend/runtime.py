 
from __future__ import annotations
import math
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import shutil
import time
from datetime import datetime
from .message_view import conversation_view
from .file_changes import begin_changes,finish_changes
from .storage import Storage, new_id, now, anime_export_filename
from .gateway import Gateway, GatewayError, FALLBACK_CAPABILITIES
from .sync import SyncEngine
from .mac_codex import MacCodex
from .platforms import resolve_profile
from shared.compute.client import MacComputeClient, MacComputeError
from shared.compute.timing import emit_timing

WORKING = {"submitting","queued","running","reconnecting"}
TERMINAL = {"completed","failed","cancelled","interrupted"}
REMOVE_PROMPT = """Edit Image 1. Image 2 is a removal mask: white pixels mark the area to remove and black pixels mark content that must be preserved.
Remove only the masked subject/object/text and reconstruct the missing background naturally.
Preserve the rest of Image 1, including people, faces, composition, lighting, colors, and framing.
Do not crop, restyle, or add new unrelated objects."""
COLORIZE_PROMPT = """Colorize Image 1 as a faithful old-photo restoration.
Preserve the exact people, faces, identities, pose, objects, composition, geometry, texture, and framing.
Add natural, realistic, historically plausible colors only.
Do not beautify faces, change clothing design, invent objects, crop the image, or add text."""

def event_predates_snapshot(message, event):
    try:
        stamp = datetime.fromisoformat(str(message.get("updatedAt", "")).replace("Z", "+00:00")).timestamp() * 1000
        return isinstance(event.get("at"), (int, float)) and event["at"] <= stamp
    except (ValueError, TypeError, OverflowError):
        return False

class Runtime:
    def __init__(self, directory, root, account=None, account_token=None, platform=None):
        self.root = Path(root)
        self.platform = resolve_profile(platform,root)
        self.storage = Storage(directory, root)
        # Side chats belong to this app run; never restore them after quitting.
        for item in self.storage.list("temporaryConversations"):
            self.storage.remove("temporaryConversations", item["id"])
        self.account = dict(account or {})
        self.server_access = self.account.get("role") == "admin" and self.account.get("serverAccess") is True
        if self.account.get("owner") == "shiyan-private-owner":
            self.storage.import_legacy_outputs()
        self.gateway = Gateway(root,platform=self.platform)
        self.gateway.account_token = account_token
        self.capabilities = self.storage.setting("capabilities", dict(FALLBACK_CAPABILITIES))
        self.connection = {"status":"connecting","error":None,"deviceID":None}
        self.version = self.storage.setting("revision", 0)
        self.listeners = set()
        self.tasks = {}
        self.background = set()
        self.processes = {}
        self.enhancement_lock = asyncio.Lock()
        self.closing = False
        self.sync = SyncEngine(self)
        conversations = self.storage.list("conversations")
        self.repair_terminal_pending_references(conversations)
        self.mac_codex = MacCodex(self)
        self.mac_codex.interrupt_saved()
        self.backfill_agent_images(conversations)
        if not conversations:
            self.new_conversation()

    def record_agent_image(self, asset, job_id=None, created_at=None):
        if not str(asset.get("mimeType", "")).startswith("image/") or not self.storage.get("assets", asset.get("id")):
            return
        identifier = asset["id"]
        seen = set(self.storage.setting("spaceAgentImageSeen", []))
        if identifier in seen:
            return
        existing = next((h for h in self.storage.list("history") if h.get("assetId") == identifier), None)
        if existing is None:
            entry = self.storage.add_history(identifier, "AI Agent", job_id=job_id)
            if created_at:
                entry["createdAt"] = created_at
                self.storage.put("history", entry)
        seen.add(identifier)
        self.storage.set_setting("spaceAgentImageSeen", sorted(seen))

    def backfill_agent_images(self, conversations=None):
        for conversation in self.storage.list("conversations") if conversations is None else conversations:
            for message in conversation.get("messages", []):
                if message.get("role") == "assistant":
                    for asset in message.get("assets", []):
                        self.record_agent_image(asset, message.get("remoteJobId"), message.get("completedAt") or message.get("createdAt"))

    def repair_terminal_pending_references(self, conversations=None):
         
         
        for item in self.storage.list("conversations") if conversations is None else conversations:
            pending=item.get("pendingMessageId")
            message=next((m for m in item["messages"] if m["id"]==pending),None)
            if message and message.get("state") in TERMINAL:
                if item.get("pendingJobId"):
                    message.setdefault("remoteJobId",item["pendingJobId"])
                elif message.get("state")=="failed" and message.get("requestId"):
                    message["submissionFailed"]=True
                item.update(pendingJobId=None,pendingMessageId=None)
                self.storage.put("conversations",item)

    def launch(self, key, coroutine):
        old = self.tasks.get(key)
        if old and not old.done():
            coroutine.close()
            return old
        task = asyncio.create_task(coroutine)
        self.tasks[key] = task
        def done(value):
            if self.tasks.get(key) is value:
                self.tasks.pop(key,None)
            if not value.cancelled():
                value.exception()
                if key.startswith("conversation:") and not self.closing:
                    self.pump_queue(key.split(":",1)[1])
        task.add_done_callback(done)
        return task

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.background.add(task)
        task.add_done_callback(self.background.discard)
        return task

    def notify(self):
        self.version += 1
        self.storage.set_setting("revision", self.version)
        state = self.snapshot()
        for queue in tuple(self.listeners):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(state)
        return state

    def snapshot(self):
        conversations = sorted(self.storage.list("conversations"), key=lambda x:x["updatedAt"], reverse=True)
        for item in conversations:
            item["isBusy"] = self.is_busy(item)
        history = sorted(self.storage.list("history"),key=lambda x:x["createdAt"],reverse=True)
        for entry in history:
            asset = self.storage.get("assets",entry["assetId"])
            entry["asset"] = self.storage.public_asset(asset) if asset else None
        return {"version":self.version,"conversations":[conversation_view(c) for c in conversations],
                "selectedConversationId":self.storage.setting("selectedConversationId"),
                "temporaryConversations":[{**conversation_view(c),"isBusy":self.is_busy(c)} for c in self.storage.list("temporaryConversations") if not self.temporary_expired(c)],
                "projects":self.storage.list("projects"),"workspace":self.storage.setting("workspace",{}),
                "history":history,"settings":self.storage.setting("settings",{"historyViewMode":"list"}),
                "capabilities":self.capabilities,"connection":self.connection,
                "photoJobs":sorted(self.storage.list("photoJobs"),key=lambda x:x["createdAt"],reverse=True)[:100],
                "assets":[self.storage.public_asset(x) for x in self.storage.list("assets")]}

    def conversation(self, identifier):
        item = self.storage.get("conversations", identifier) or self.storage.get("temporaryConversations",identifier)
        if item is None:
            raise ValueError("会话不存在")
        if item.get("temporary") and self.temporary_expired(item):
            raise ValueError("临时聊天已过期")
        return item

    @staticmethod
    def temporary_expired(item, timestamp=None):
        sent=item.get("lastSentAt")
        return bool(sent and (time.time() if timestamp is None else timestamp)-datetime.fromisoformat(sent.replace("Z","+00:00")).timestamp()>=3600)

    async def expire_temporaries(self):
        while not self.closing:
            changed=False
            for item in self.storage.list("temporaryConversations"):
                if self.temporary_expired(item):
                    task=self.tasks.pop("conversation:"+item["id"],None)
                    if task:task.cancel()
                    if item.get("pendingMessageId"):
                        message=next((m for m in item["messages"] if m["id"]==item["pendingMessageId"]),None)
                        if message and message.get("requestId"):
                            intent={"id":message["requestId"],"requestId":message["requestId"],"kind":"conversation","entityId":item["id"],"messageId":message["id"]}
                            self.storage.put("stops",intent)
                            self.spawn(self.confirm_stop(intent))
                    self.storage.remove("temporaryConversations",item["id"])
                    changed=True
            if changed:self.notify()
            await asyncio.sleep(5)

    @staticmethod
    def is_busy(item):
        return bool(item.get("pendingJobId") or item.get("pendingMessageId")) or bool(item.get("messages") and item["messages"][-1].get("state") in WORKING)

    def save_conversation(self, item, notify=True):
        self.storage.put("temporaryConversations" if item.get("temporary") else "conversations",item)
        if notify:
            self.notify()

    def new_conversation(self, project_id=None, force_new=False):
        selected = self.storage.get("conversations",self.storage.setting("selectedConversationId",""))
        if not force_new and selected and selected.get("projectId")==project_id and not selected["messages"] and not selected["draft"] and not selected["draftAssets"] and not selected["isPinned"] and not selected["titleIsManual"]:
            return selected
        identifier = new_id()
        item = {"id":identifier,"projectId":project_id,"title":"新聊天","titleIsManual":False,"titleWasGenerated":False,
                "isPinned":False,"hasUnread":False,"createdAt":now(),"updatedAt":now(),"lastOpenedAt":None,
                "reasoning":self.capabilities.get("defaultReasoning","low"),"draft":"","draftAssets":[],
                "activeImageId":None,"messages":[],"pendingJobId":None,"pendingMessageId":None,
                "lastEventId":0,"threadId":None,"remoteConversationId":identifier}
        self.storage.put("conversations",item)
        self.storage.set_setting("selectedConversationId",identifier)
        self.notify()
        return item

    def patch_conversation(self, identifier, changes):
        item = self.conversation(identifier)
        if "projectId" in changes:
            project_id = changes["projectId"]
            if project_id is not None and (not isinstance(project_id, str) or not self.storage.get("projects", project_id)):
                raise ValueError("项目不存在")
            item["projectId"] = project_id
        if "title" in changes:
            title = str(changes["title"]).strip()
            if not title:
                raise ValueError("会话名称不能为空")
            item["title"],item["titleIsManual"]=title[:100],True
        for key in ["isPinned","hasUnread"]:
            if key in changes:
                item[key]=bool(changes[key])
        if "readingPosition" in changes:
            position=changes["readingPosition"]
            if not isinstance(position,dict):raise ValueError("阅读位置无效")
            top=position.get("scrollTop",0);offset=position.get("offset",0)
            if not isinstance(top,(int,float)) or not isinstance(offset,(int,float)) or not math.isfinite(top) or not math.isfinite(offset):raise ValueError("阅读位置无效")
            item["readingPosition"]={"scrollTop":max(0,min(top,100000000)),"offset":max(-1000000,min(offset,1000000)),"anchorMessageId":str(position.get("anchorMessageId") or "")[:120],"followLatest":position.get("followLatest") is True}
        if "draft" in changes:
            item["draft"]=str(changes["draft"])[:200000]
        if "draftAssets" in changes:
            ids = [x["id"] if isinstance(x,dict) else x for x in changes["draftAssets"]]
            item["draftAssets"]=self.validate_assets(ids)
        if "reasoning" in changes:
            model=changes.get("model",item.get("model",self.capabilities.get("model")))
            capability=self.conversation_model_capability(item,model)
            if changes["reasoning"] not in capability["reasoningEfforts"]:
                raise ValueError("当前模型不支持这个推理档位")
            item["reasoning"]=changes["reasoning"]
        if "model" in changes:
            capability=self.conversation_model_capability(item,changes["model"])
            item["model"]=capability["id"]
            if item["reasoning"] not in capability["reasoningEfforts"]:
                item["reasoning"]=capability["defaultReasoning"]
        if "fileChangeRoots" in changes:
            if not self.server_access: raise GatewayError("此账户没有本机文件访问权限", 403)
            roots=changes["fileChangeRoots"]
            if not isinstance(roots,list) or len(roots)>8:
                raise ValueError("修改记录目录无效")
            clean=[]
            for root in roots:
                if not isinstance(root,str) or not Path(root).is_absolute() or not Path(root).is_dir():
                    raise ValueError("修改记录目录不存在")
                clean.append(str(Path(root).resolve()))
            item["fileChangeRoots"]=list(dict.fromkeys(clean))
        self.save_conversation(item)
        return item

    def model_capability(self, model):
        choices=self.capabilities.get("models") or [{"id":self.capabilities.get("model"),"reasoningEfforts":self.capabilities.get("reasoningEfforts",[]),"defaultReasoning":self.capabilities.get("defaultReasoning")}]
        found=next((x for x in choices if x["id"]==model),None)
        if not found:raise ValueError("当前服务不支持所选模型")
        return found

    def conversation_model_capability(self, item, model):
        if self.server_access and item.get("executionTransport") == "mac":
            return self.mac_codex.capability(model)
        return self.model_capability(model)

    def select(self, identifier):
        item = self.conversation(identifier)
        item["lastOpenedAt"],item["hasUnread"]=now(),False
        self.storage.set_setting("selectedConversationId", identifier)
        self.save_conversation(item)

    def validate_assets(self, ids):
        if not isinstance(ids,list) or len(ids)>self.capabilities.get("maxUploadImages",8):
            raise ValueError(f"本次最多添加 {self.capabilities.get('maxUploadImages',8)} 个附件")
        result=[]
        for identifier in ids:
            asset = self.storage.asset(str(identifier))
            path = self.storage.asset_path(str(identifier))
            if not asset["mimeType"].startswith("image/") and path.stat().st_size > 10 * 1024 * 1024:
                raise ValueError("单个文档不能超过 10 MB")
            result.append(self.storage.public_asset(asset))
        if any(not a["mimeType"].startswith("image/") for a in result):
            if sum(self.storage.asset_path(a["id"]).stat().st_size for a in result) > 24 * 1024 * 1024:
                raise ValueError("图片与文档合计不能超过 24 MB")
        return result

    async def connect(self, force=False):
        self.connection.update(status="connecting",error=None)
        self.notify()
        try:
            self.connection["deviceID"]=self.account.get("id")
            self.capabilities=await self.gateway.connect(force=force)
            self.storage.set_setting("capabilities",self.capabilities)
            self.connection.update(status="ready",error=None)
            for item in self.storage.list("conversations")+self.storage.list("temporaryConversations"):
                if item.get("temporary") and self.temporary_expired(item):continue
                if item.get("executionTransport") == "mac":continue
                changed=False
                try:model=self.model_capability(item.get("model",self.capabilities.get("model")))
                except ValueError:
                    item["model"]=self.capabilities['model'];model=self.model_capability(item['model']);changed=True
                if item["reasoning"] not in model["reasoningEfforts"]:
                    item["reasoning"]=model["defaultReasoning"];changed=True
                if changed:self.save_conversation(item,notify=False)
            self.notify()
            for intent in self.storage.list("stops"):
                self.spawn(self.confirm_stop(intent))
            return True
        except Exception as exc:
            self.connection.update(status="unauthorized" if isinstance(exc,GatewayError) and exc.status in {401,403} else "unavailable",error=str(exc))
            self.notify()
            return False

    async def start(self):
        self.spawn(self.expire_temporaries())
        self.spawn(self.sync.run())
        for job in self.storage.list("photoJobs"):
            if job.get("macCancelPending") and job.get("remoteTaskId"):
                try:
                    await asyncio.to_thread(MacComputeClient().cancel,self.account.get("owner"),job["remoteTaskId"])
                    job.pop("macCancelPending",None)
                    self.storage.put("photoJobs",job)
                except MacComputeError:
                    pass
            if job["feature"]=="enhance" and job["state"] in WORKING:
                if job.get("macCompute"):
                    self.launch("photo:"+job["id"],self.run_enhancement(job["id"]))
                    continue
                job.update(state="interrupted",label="增强已中断",error="应用已退出，本地增强未完成，请重新开始")
                self.storage.put("photoJobs",job)
                shutil.rmtree(self.storage.transfers/("enhance-"+job["id"]),ignore_errors=True)
                (self.storage.transfers/(job["id"]+".png")).unlink(missing_ok=True)
        await self.connect()
        for item in self.storage.list("conversations")+self.storage.list("temporaryConversations"):
            if item.get("temporary") and self.temporary_expired(item):continue
            message = next((m for m in item["messages"] if m["id"]==item.get("pendingMessageId")),None)
            if message and message["state"] in WORKING:
                self.launch("conversation:"+item["id"],self.run_agent(item["id"]))
            else:
                self.pump_queue(item["id"])
        for job in self.storage.list("photoJobs"):
            if job["feature"]!="enhance" and job["state"] in WORKING:
                self.launch("photo:"+job["id"],self.run_remote_photo(job["id"]))
        self.notify()

    def payload_images(self, assets, mask_ids=()):
        result=[]
        for asset in assets:
            if not asset["mimeType"].startswith("image/"):
                continue
            data,suffix=self.storage.request_image(asset["id"],mask=asset["id"] in mask_ids)
            result.append({"suffix":suffix,"data":base64.b64encode(data).decode()})
        return result

    def payload_files(self, assets):
        # Use the same document contract as iOS; images retain their upload path.
        assets = self.validate_assets([a["id"] for a in assets])
        return [{"filename":a["filename"],
                 "data":base64.b64encode(self.storage.asset_path(a["id"]).read_bytes()).decode()}
                for a in assets if not a["mimeType"].startswith("image/")]

    async def send(self, identifier, text, ids, editing=None, urgent=False, urgent_confirmed=False, from_queue=False):
        item=self.conversation(identifier)
        if not self.server_access and item.get("executionTransport") == "mac":
            item["executionTransport"] = "cloud"
        if editing and item.get("executionTransport") == "mac":
            raise ValueError("本机任务对话请通过回复补充内容，或新建一次执行")
        if urgent and not urgent_confirmed:raise ValueError("请先确认紧急发送")
        stopping=any(x.get("entityId")==identifier for x in self.storage.list("stops"))
        if editing:
            if self.is_busy(item) or stopping:
                raise ValueError("请等待当前回复完成后再编辑消息")
        elif not from_queue and (self.is_busy(item) or stopping or item.get("messageQueue") or item.get("queuePaused")):
            return self.enqueue_message(identifier,text,ids,urgent)
        text=str(text)
        assets=self.validate_assets(ids)
        if not text.strip() and not assets:
            raise ValueError("请输入消息或添加附件")
        if len(text)>200000:
            raise ValueError("消息过长")
        remote=item.get("remoteConversationId") or identifier
        thread=item.get("threadId")
        edit_index=None
        if editing:
            edit_index=next((i for i,m in enumerate(item["messages"]) if m["id"]==editing and m["role"]=="user"),None)
            if edit_index is None:
                raise ValueError("待编辑的消息已不存在")
            original=json.dumps(item["messages"],sort_keys=True)
            if item.get("queuePaused"):
                failed=item["messages"][-1] if item["messages"] else None
                if not failed or not failed.get("submissionFailed") or not failed.get("requestId"):
                    raise ValueError(item.get("queueError") or "请先处理等待队列中的发送错误")
                 
                 
                try:
                    await self.gateway.cancel(failed["requestId"])
                except Exception as exc:
                    raise ValueError("旧请求状态尚未确认，修改内容已保留；恢复网络后可再次发送") from exc
            target=new_id()
            retained=[m["text"] for m in item["messages"][:edit_index] if m["role"]=="user"]
            thread=await self.gateway.fork(remote,target,retained,item["messages"][edit_index]["text"])
            latest=self.conversation(identifier)
            if self.is_busy(latest) or json.dumps(latest["messages"],sort_keys=True)!=original:
                raise ValueError("编辑期间对话发生变化，原消息已保留")
            item=latest
            remote=target
            item["messages"]=item["messages"][:edit_index]
            if edit_index==0 and not item["titleIsManual"]:
                item["title"]=text.replace("\n"," ").strip()[:20] or "附件对话"
                item["titleWasGenerated"]=False
        model=self.conversation_model_capability(item,item.get("model",self.capabilities.get("model")))
        if item["reasoning"] not in model["reasoningEfforts"]:raise ValueError("当前模型不支持所选推理档位")
        started=now()
        user={"id":new_id(),"role":"user","text":text,"assets":assets,"createdAt":started,"state":"completed","phase":"","error":None}
        reply={"id":new_id(),"role":"assistant","text":"","assets":[],"createdAt":now(),"state":"submitting","phase":"发送中","error":None,
               "requestId":new_id(),"reasoning":item["reasoning"],"model":model["id"],"requestStartedAt":started,"rawResult":None}
        if item.get("executionTransport") == "mac":reply["localExecution"]=True
        user["requestId"]=reply["requestId"]
        item["messages"].extend([user,reply])
        if editing:
            item.update(queuePaused=False,queueError=None)
        if from_queue:
            item["messageQueue"]=[x for x in item.get("messageQueue",[]) if x["id"]!=from_queue]
        if item.get("temporary"):item["lastSentAt"]=started
        item.update(draft=item.get("draft","") if from_queue else "",draftAssets=item.get("draftAssets",[]) if from_queue else [],updatedAt=now(),pendingJobId=None,pendingMessageId=reply["id"],lastEventId=0,
                    remoteConversationId=remote,threadId=thread)
        if item["title"]=="新聊天":
            item["title"]=text.replace("\n"," ").strip()[:20] or "附件对话"
        self.save_conversation(item)
        self.launch("conversation:"+identifier,self.run_agent(identifier))
        return reply

    def enqueue_message(self, identifier, text, ids, urgent=False):
        item=self.conversation(identifier)
        assets=self.validate_assets(ids)
        text=str(text)
        if not text.strip() and not assets:raise ValueError("请输入消息或添加附件")
        if len(text)>200000:raise ValueError("消息过长")
        queue=item.setdefault("messageQueue",[])
        if len(queue)>=30:raise ValueError("等待队列已满，请等待部分消息处理完成")
        entry={"id":new_id(),"text":text,"assetIds":[a["id"] for a in assets],
               "createdAt":now(),"model":item.get("model") or self.capabilities.get("model"),"reasoning":item["reasoning"],"urgent":bool(urgent)}
        queue.insert(0,entry) if urgent else queue.append(entry)
        item.update(draft="",draftAssets=[],updatedAt=now())
        self.save_conversation(item)
        self.pump_queue(identifier)
        return entry

    def pump_queue(self, identifier):
        if self.closing:return
        try:item=self.conversation(identifier)
        except ValueError:return
        if self.is_busy(item) or not item.get("messageQueue") or item.get("queuePaused"):return
        if any(x.get("entityId")==identifier for x in self.storage.list("stops")):return
        self.launch("queue:"+identifier,self.dispatch_queue(identifier))

    async def dispatch_queue(self, identifier):
        item=self.conversation(identifier)
        if self.is_busy(item) or not item.get("messageQueue"):return
        entry=item["messageQueue"][0]
         
         
        composer_model,composer_reasoning=item.get("model"),item["reasoning"]
        item["model"]=entry.get("model") or item.get("model") or self.capabilities.get("model")
        item["reasoning"]=entry["reasoning"]
        self.save_conversation(item,notify=False)
        try:
            await self.send(identifier,entry["text"],entry["assetIds"],from_queue=entry["id"])
        except Exception as error:
            item=self.conversation(identifier)
            item.update(queuePaused=True,queueError=str(error),reasoning=composer_reasoning)
            if composer_model is None:item.pop("model",None)
            else:item["model"]=composer_model
            self.save_conversation(item)
            return
        item=self.conversation(identifier)
        item.update(reasoning=composer_reasoning)
        if composer_model is None:item.pop("model",None)
        else:item["model"]=composer_model
        item["messageQueue"]=[x for x in item.get("messageQueue",[]) if x["id"]!=entry["id"]]
        self.save_conversation(item)

    def prioritize_queued_message(self, identifier, message_id, confirmed=False):
        if confirmed is not True:raise ValueError("请先确认优先处理")
        item=self.conversation(identifier)
        queue=item.get("messageQueue",[])
        entry=next((x for x in queue if x["id"]==message_id),None)
        if entry is None:raise ValueError("这条消息已开始处理或已移除")
        entry["urgent"]=True
        item["messageQueue"]=[entry]+[x for x in queue if x["id"]!=message_id]
        self.save_conversation(item)
        self.pump_queue(identifier)

    def remove_queued_message(self, identifier, message_id):
        item=self.conversation(identifier)
        item["messageQueue"]=[x for x in item.get("messageQueue",[]) if x["id"]!=message_id]
        if item.get("queueError")!="发送尚未确认，请先重试当前消息":
            item.update(queuePaused=False,queueError=None)
        self.save_conversation(item)
        self.pump_queue(identifier)

    def pending_message(self, identifier):
        item=self.conversation(identifier)
        message=next((m for m in item["messages"] if m["id"]==item.get("pendingMessageId")),None)
        return item,message

    async def run_agent(self, identifier):
        _, local_message=self.pending_message(identifier)
        if local_message and local_message.get("localExecution"):
            if self.server_access:
                return await self.mac_codex.run(identifier)
            item, local_message = self.pending_message(identifier)
            item["executionTransport"] = "cloud"
            local_message["localExecution"] = False
            self.save_conversation(item)
        try:
            item,message=self.pending_message(identifier)
            if not message:
                return
            if not item.get("pendingJobId"):
                try:
                    if self.server_access: await asyncio.to_thread(begin_changes,self.storage,item,message)
                except (OSError,ValueError):
                    pass
                index=item["messages"].index(message)
                user=item["messages"][index-1]
                job_id=await self.gateway.create_job({"prompt":user["text"],"images":await asyncio.to_thread(self.payload_images,user["assets"]),
                          "files":await asyncio.to_thread(self.payload_files,user["assets"]),
                          "conversationId":item["remoteConversationId"],"syncConversationId":identifier,"projectId":item.get("projectId"),"userMessageId":user["id"],"assistantMessageId":message["id"],
                          "requestId":message["requestId"],"reasoning":message["reasoning"],"model":message.get("model",self.capabilities.get("model"))})
                latest,current=self.pending_message(identifier)
                if current is None or current["id"]!=message["id"] or current["state"]=="cancelled":
                    await self.gateway.cancel(message["requestId"])
                    return
                latest["pendingJobId"]=job_id
                current.update(state="running",phase="请求已接收",error=None,remoteJobId=job_id,submissionFailed=False)
                self.save_conversation(latest)
            for attempt in range(3):
                item,message=self.pending_message(identifier)
                if not message or not item.get("pendingJobId"):
                    return
                try:
                    async for event in self.gateway.events(item["pendingJobId"],item["lastEventId"]):
                        latest,current=self.pending_message(identifier)
                        if current is None or latest.get("pendingJobId")!=item["pendingJobId"]:
                            return
                        if event.get("seq",0)<=latest["lastEventId"]:
                            continue
                         
                         
                         
                        if event_predates_snapshot(current, event):
                            latest["lastEventId"] = event["seq"]
                            self.storage.put("conversations", latest)
                            continue
                        for remote in ([event["asset"]] if event.get("asset") else [])+(event.get("assets") or []):
                            if any(a.get("remoteId")==remote["id"] for a in current["assets"]):
                                continue
                            last_notice=0.0
                            async def progress(received,total):
                                nonlocal last_notice
                                if time.monotonic()-last_notice<0.25 and received<total:
                                    return
                                last_notice=time.monotonic()
                                c,m=self.pending_message(identifier)
                                if m and c.get("pendingJobId")==item["pendingJobId"]:
                                    m["phase"]=f"接收图片 {received//1024} / {max(1,total//1024)} KB"
                                    self.save_conversation(c)
                            asset=await self.gateway.download(remote,self.storage,progress=progress,inline=event.get("data") if event.get("asset",{}).get("id")==remote["id"] else None)
                            latest,current=self.pending_message(identifier)
                            if current is None or current["state"]=="cancelled":
                                return
                            current["assets"].append(asset)
                            if asset["mimeType"].startswith("image/"):
                                self.record_agent_image(asset, job_id=item["pendingJobId"])
                            self.save_conversation(latest)
                        latest,current=self.pending_message(identifier)
                        if current is None:
                            return
                        if "text" in event:
                            current["text"]=event["text"]
                        current.update(phase=event.get("label",current["phase"]),error=None,
                                       reasoning=event.get("reasoning",current.get("reasoning")))
                        for field in ("displayItems", "usage"):
                            if field in event:
                                current[field]=event[field]
                        if "fileChanges" in event:
                            current["fileChanges"]=event["fileChanges"]
                        if "items" in event:
                            current["rawResult"]=json.dumps(event["items"],ensure_ascii=False,indent=2)
                        kind=event.get("type")
                        if kind in TERMINAL:
                             
                             
                            self.save_conversation(latest,notify=False)
                            try:
                                local_changes=await asyncio.to_thread(finish_changes,self.storage,current) if self.server_access else []
                            except (OSError,ValueError):
                                local_changes=[]
                            latest,current=self.pending_message(identifier)
                            if current is None:
                                return
                            if local_changes:
                                current["fileChanges"]=(current.get("fileChanges") or [])+local_changes
                            current["completedAt"]=now()
                            current.update(state="failed" if kind=="interrupted" else kind,phase="",
                                           error=event.get("error") if kind in {"failed","interrupted"} else None)
                            latest.update(pendingJobId=None,pendingMessageId=None,updatedAt=now())
                        else:
                            current["state"]="running"
                        latest["lastEventId"]=event["seq"]
                        if event.get("threadId"):
                            latest["threadId"]=event["threadId"]
                        if self.storage.setting("selectedConversationId")!=identifier:
                            latest["hasUnread"]=True
                        self.save_conversation(latest)
                        if kind in TERMINAL:
                            if kind=="completed":
                                self.spawn(self.refresh_title(identifier))
                            return
                    raise GatewayError("接收连接已结束")
                except asyncio.CancelledError:
                    raise
                except Exception:
                    latest,current=self.pending_message(identifier)
                    if not current:
                        return
                    current.update(state="reconnecting",phase="正在恢复连接")
                    self.save_conversation(latest)
                    if attempt<2:
                        await asyncio.sleep(2**attempt)
            latest,current=self.pending_message(identifier)
            if current:
                current.update(state="reconnecting",phase="接收中断",error="结果接收中断，点重新接收恢复；已生成的结果不会丢失")
                self.save_conversation(latest)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            item,message=self.pending_message(identifier)
            if message and message["state"]!="cancelled":
                message["completedAt"]=now()
                 
                 
                 
                message.update(state="failed",phase="",error=str(exc),submissionFailed=not bool(item.get("pendingJobId")))
                if item.get("pendingJobId"):
                    message["remoteJobId"]=item["pendingJobId"]
                item.update(pendingJobId=None,pendingMessageId=None,updatedAt=now())
                if message.get("submissionFailed"):
                    item.update(queuePaused=True,queueError="发送尚未确认，请先重试当前消息")
                self.save_conversation(item)
            if isinstance(exc,GatewayError) and exc.status in {401,403}:
                self.connection.update(status="unauthorized",error=str(exc))
                self.notify()

    async def refresh_title(self, identifier):
        try:
            item=self.conversation(identifier)
            if item["titleIsManual"] or item["titleWasGenerated"]:
                return
            remote=item["remoteConversationId"]
            title=await self.gateway.title(remote)
            latest=self.conversation(identifier)
            if title and not latest["titleIsManual"] and latest["remoteConversationId"]==remote:
                latest["title"],latest["titleWasGenerated"]=title,True
                self.save_conversation(latest)
        except Exception:
            return

    async def stop_conversation(self, identifier):
        item,message=self.pending_message(identifier)
        if not message or not message.get("requestId"):
            return
        if message.get("localExecution"):
            message.update(state="cancelled",phase="已停止",error=None,completedAt=now())
            item.update(pendingJobId=None,pendingMessageId=None,updatedAt=now())
            self.save_conversation(item)
            task=self.tasks.pop("conversation:"+identifier,None)
            if task:
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
            self.pump_queue(identifier)
            return
        intent={"id":message["requestId"],"requestId":message["requestId"],"kind":"conversation","entityId":identifier,"messageId":message["id"]}
        self.storage.put("stops",intent)
        task=self.tasks.pop("conversation:"+identifier,None)
        if task:
            task.cancel()
        message.update(state="cancelled",phase="正在确认停止…",error=None,completedAt=now())
        item.update(pendingJobId=None,pendingMessageId=None)
        self.save_conversation(item)
        await self.confirm_stop(intent)

    async def confirm_stop(self,intent):
        try:
            status=await self.gateway.cancel(intent["requestId"])
            self.storage.remove("stops",intent["id"])
            label="已停止接收" if status=="completed" else "已停止"
            error=None
        except asyncio.CancelledError:
            raise
        except Exception:
            label="已停止接收"
            error="服务器停止尚未确认，恢复连接后将重试"
        if intent["kind"]=="conversation":
            item=self.storage.get("conversations",intent["entityId"]) or self.storage.get("temporaryConversations",intent["entityId"])
            if item:
                message=next((m for m in item["messages"] if m["id"]==intent["messageId"]),None)
                if message:
                    message.update(state="cancelled",phase=label,error=error)
                    self.save_conversation(item)
                if error is None:self.pump_queue(intent["entityId"])
        else:
            job=self.storage.get("photoJobs",intent["entityId"])
            if job:
                job.update(state="cancelled",label=label,error=error)
                self.storage.put("photoJobs",job)
                self.notify()

    async def delete_conversation(self, identifier):
        item=self.conversation(identifier)
        if self.is_busy(item):
            await self.stop_conversation(identifier)
        if any(s["entityId"]==identifier for s in self.storage.list("stops")):
            raise ValueError("请先确认服务器已停止，再删除会话")
        self.storage.remove("conversations",identifier)
        if self.storage.setting("selectedConversationId")==identifier:
            remaining=sorted(self.storage.list("conversations"),key=lambda x:x["updatedAt"],reverse=True)
            self.storage.set_setting("selectedConversationId",remaining[0]["id"] if remaining else None)
        if not self.storage.list("conversations"):
            self.new_conversation()
        self.notify()

    def retry(self,identifier):
        item,message=self.pending_message(identifier)
        if message is None:
             
             
            candidate=item["messages"][-1] if item["messages"] else None
            error=str((candidate or {}).get("error") or "").lower()
            network_failure=any(word in error for word in ("连接中断","检查网络","网络连接","无法连接","接收中断","connection","network","timed out"))
            if candidate and candidate.get("role")=="assistant" and candidate.get("state")=="failed" and (candidate.get("submissionFailed") or network_failure) and candidate.get("requestId"):
                message=candidate
                item["pendingMessageId"]=message["id"]
                item["pendingJobId"]=message.get("remoteJobId")
                item["lastEventId"]=0
        if message and message["state"]!="cancelled":
            item.update(queuePaused=False,queueError=None)
            if not item.get("pendingJobId"):
                message.update(state="submitting",phase="重新发送中",error=None)
            else:
                message.update(state="reconnecting",phase="重新接收中",error=None)
            self.save_conversation(item)
            self.launch("conversation:"+identifier,self.run_agent(identifier))

    def web_cos_transfer(self):
        if self.platform.mode != "web":
            raise ValueError("此图片需要网页端的云端传输配置")
        transfer = getattr(self, "_web_cos_transfer", None)
        if transfer is None:
            from apps.web.adapters.cos_transfer import CosConfig, CosTransfer
            config = CosConfig.from_environment()
            if config is None:
                raise ValueError("图片云端传输未启用，请稍后重试")
            transfer = self._web_cos_transfer = CosTransfer(config)
        return transfer

    def create_photo_batch(self, payload):
        identifiers = payload.get("assetIds")
        if (payload.get("feature") != "enhance" or payload.get("model", "general") not in {"general", "anime"}
                or not isinstance(identifiers, list) or not 1 <= len(identifiers) <= 10
                or any(not isinstance(value, str) for value in identifiers)
                or len(set(identifiers)) != len(identifiers)):
            raise ValueError("请选择 1 到 10 张不同的图片")
        # Validate every member before creating or launching any of the jobs.
        for identifier in identifiers:
            asset = self.storage.asset(identifier)
            if not str(asset.get("mimeType", "")).startswith("image/"):
                raise ValueError("请选择图片")
            if asset.get("remoteOnly"):
                if not MacComputeClient.enabled_for(self.account.get("owner")):
                    raise ValueError("此账户的 Mac 计算授权不可用")
                self.web_cos_transfer().descriptor(self, asset)
            else:
                self.storage.asset_path(identifier)
        batch = {"id": new_id(), "assetIds": identifiers, "jobIds": [], "state": "queued",
                 "model": payload.get("model", "general"), "createdAt": now(), "updatedAt": now()}
        self.storage.put("photoBatches", batch)
        for identifier in identifiers:
            job = self.create_photo_job({"feature": "enhance", "model": batch["model"], "assetId": identifier})
            batch["jobIds"].append(job["id"])
            self.storage.put("photoBatches", batch)
        return self.photo_batch_status(batch["id"])

    def photo_batch_status(self, identifier):
        batch = self.storage.get("photoBatches", identifier)
        if not batch:
            raise ValueError("批量任务不存在")
        jobs, assets, history = [], {}, []
        for asset_id in batch["assetIds"]:
            item = self.storage.get("assets", asset_id)
            if item:
                assets[asset_id] = self.storage.public_asset(item)
        for job_id in batch["jobIds"]:
            status = self.photo_status(job_id)
            jobs.append(status["job"])
            assets.update({asset["id"]: asset for asset in status["assets"]})
            history.extend(status["history"])
        states = [job["state"] for job in jobs]
        active = any(state in WORKING for state in states)
        if active:
            state = "cancelling" if batch.get("cancelRequested") else "running" if "running" in states else "queued"
        else:
            state = "completed" if "completed" in states else "cancelled" if states and all(s == "cancelled" for s in states) else "failed"
        progress = sum(1 if job["state"] in TERMINAL else max(0, min(1, float(job.get("progress") or 0))) for job in jobs) / max(1, len(batch["assetIds"]))
        batch.update(state=state, progress=progress, total=len(batch["assetIds"]),
                     completedCount=states.count("completed"), failedCount=states.count("failed"),
                     cancelledCount=states.count("cancelled"), updatedAt=max([batch["updatedAt"]] + [job["updatedAt"] for job in jobs]))
        self.storage.put("photoBatches", batch)
        return {"batch": batch, "jobs": jobs, "assets": list(assets.values()), "history": history}

    async def stop_photo_batch(self, identifier):
        batch = self.storage.get("photoBatches", identifier)
        if not batch:
            raise ValueError("批量任务不存在")
        batch.update(cancelRequested=True, updatedAt=now())
        self.storage.put("photoBatches", batch)
        await asyncio.gather(*(self.stop_photo(job_id) for job_id in batch["jobIds"]))
        return self.photo_batch_status(identifier)

    async def run_cos_enhancement(self, identifier):
        """Only exchange task and COS object metadata; image bytes stay off this host."""
        owner = self.account.get("owner")
        remote_id = None
        try:
            if self.platform.mode != "web" or not MacComputeClient.enabled_for(owner):
                raise ValueError("此账户的 Mac 计算授权不可用")
            transfer, client = self.web_cos_transfer(), MacComputeClient()
            job = self.storage.get("photoJobs", identifier)
            if not job or job["state"] == "cancelled":
                return
            remote_id = job.get("remoteTaskId")
            if not remote_id:
                metadata = await asyncio.to_thread(transfer.ensure_input, self, job["inputAssetId"])
                def remember(task_id):
                    current = self.storage.get("photoJobs", identifier)
                    if current:
                        current["remoteTaskId"] = task_id
                        self.storage.put("photoJobs", current)
                while not self.closing:
                    submission = asyncio.create_task(asyncio.to_thread(client.submit_enhance_cos, owner,
                        job["requestId"], job["model"], metadata, remember))
                    try:
                        remote = await asyncio.shield(submission)
                        remote_id = remote["id"]
                        break
                    except asyncio.CancelledError:
                        try:
                            await submission
                        except Exception:
                            pass
                        remote_id = (self.storage.get("photoJobs", identifier) or {}).get("remoteTaskId")
                        raise
                    except MacComputeError as error:
                        if 400 <= error.status < 500 and error.status != 429 or error.code == "configuration":
                            raise
                        self.update_photo(identifier, state="reconnecting", label="等待恢复 Mac 连接")
                        await asyncio.sleep(3)
            if self.closing or not remote_id:
                return
            self.update_photo(identifier, remoteTaskId=remote_id)
            emit_timing("task_link", "linked", source="server", photoJobId=identifier,
                        requestId=job["requestId"], assetId=job["inputAssetId"], taskId=remote_id)
            while not self.closing:
                current = self.storage.get("photoJobs", identifier)
                if current["state"] == "cancelled":
                    return
                try:
                    remote = await asyncio.to_thread(client.status, owner, remote_id)
                except MacComputeError as error:
                    if 400 <= error.status < 500 and error.status != 429 or error.code == "configuration":
                        raise
                    self.update_photo(identifier, state="reconnecting", label="等待恢复 Mac 连接")
                    await asyncio.sleep(3)
                    continue
                if remote["state"] == "completed":
                    break
                if remote["state"] == "cancelled":
                    self.update_photo(identifier, state="cancelled", label="已停止", error=None)
                    return
                if remote["state"] == "failed":
                    raise ValueError(remote.get("error") or "Mac 增强未完成，请重试")
                self.update_photo(identifier, state="running" if remote["state"] == "running" else "queued",
                                  progress=remote.get("progress", 0), label=remote.get("label") or "等待 Mac 处理")
                await asyncio.sleep(2)
            if self.closing:
                return
            result = remote.get("result")
            if not isinstance(result, dict):
                result = await asyncio.to_thread(client.result_cos, owner, remote_id)
            current = self.storage.get("photoJobs", identifier)
            if current["state"] == "cancelled":
                return
            # Metadata-only registration is synchronous and small, so cancellation
            # cannot land between recording the asset and recording its job result.
            asset = transfer.register_result(self, current, result)
            self.storage.add_history(asset["id"], "动漫增强" if job["model"] == "anime" else "通用增强", job_id=identifier)
            self.update_photo(identifier, state="completed", progress=1, label="增强完成", device="mps",
                              outputAssetId=asset["id"], outputAssets=[asset], error=None)
            emit_timing("task_link", "linked", source="server", photoJobId=identifier, requestId=job["requestId"],
                        assetId=job["inputAssetId"], taskId=remote_id, outputAssetId=asset["id"])
        except asyncio.CancelledError:
            if not self.closing and remote_id:
                try:
                    await asyncio.to_thread(MacComputeClient().cancel, owner, remote_id)
                except MacComputeError:
                    self.update_photo(identifier, macCancelPending=True)
            raise
        except Exception as error:
            self.update_photo(identifier, state="failed", label="", error=str(error))

    def create_photo_job(self,payload):
        feature=payload.get("feature")
        if feature != "enhance":
            raise ValueError("此图片工具已下线")
        asset=self.storage.asset(payload.get("assetId"))
        if not asset["mimeType"].startswith("image/"):
            raise ValueError("请选择图片")
        if asset.get("remoteOnly"):
            if self.platform.mode != "web" or not MacComputeClient.enabled_for(self.account.get("owner")):
                raise ValueError("此账户的 Mac 计算授权不可用")
            self.web_cos_transfer().descriptor(self, asset)
        else:
            self.storage.asset_path(asset["id"])
        model=payload.get("model","general")
        if model not in {"general","anime"}:
            raise ValueError("未知增强模型")
        if feature=="remove":
            mask=self.storage.asset(payload.get("maskAssetId"))
            from .limits import normalized_size
            source_size=(asset.get("width"),asset.get("height"))
            if (mask.get("width"),mask.get("height")) not in {source_size, normalized_size(*source_size)}:
                raise ValueError("消除区域尺寸必须与原图一致")
        identifier=new_id()
        job={"id":identifier,"feature":feature,"model":model,"state":"queued","progress":0,"label":"等待处理",
             "inputAssetId":asset["id"],"maskAssetId":payload.get("maskAssetId"),"outputAssetId":None,
             "outputAssets":[],"error":None,"createdAt":now(),"updatedAt":now(),"photoRevision":1,"requestId":new_id(),
             "remoteConversationId":f"shiyan-{feature}-{new_id()}","remoteJobId":None,"lastEventId":0}
        if feature=="enhance" and self.platform.mode=="web" and MacComputeClient.enabled_for(self.account.get("owner")):
            job["macCompute"]=True
            if asset.get("remoteOnly") or os.environ.get("SHIYAN_COS_CONFIG"):
                job["cosCompute"] = True
        self.storage.put("photoJobs",job)
        if feature=="enhance":emit_timing("task_link","linked",source="server",photoJobId=identifier,requestId=job["requestId"],assetId=asset["id"])
        # Photo progress is consumed through the bounded per-task endpoint.
        self.launch("photo:"+identifier,self.run_enhancement(identifier) if feature=="enhance" else self.run_remote_photo(identifier))
        return job

    def photo_status(self,identifier):
        job=self.storage.get("photoJobs",identifier)
        if job is None:raise ValueError("任务不存在")
        assets=[]
        if job.get("outputAssetId"):
            item=self.storage.get("assets",job["outputAssetId"])
            if item:assets.append(self.storage.public_asset(item))
        history=[]
        if job.get("state")=="completed":
            for entry in self.storage.list("history"):
                if entry.get("jobId")==identifier:
                    asset=next((a for a in assets if a["id"]==entry.get("assetId")),None)
                    history.append({**entry,"asset":asset})
        return {"job":{**job,"outputAssets":assets},"assets":assets,"history":history}

    def update_photo(self,identifier,**changes):
        job=self.storage.get("photoJobs",identifier)
        if job:
            if all(job.get(key)==value for key,value in changes.items()):return job
            job.update(changes,updatedAt=now(),photoRevision=int(job.get("photoRevision",0))+1)
            self.storage.put("photoJobs",job)
        return job

    async def run_enhancement(self,identifier):
        if self.storage.get("photoJobs",identifier).get("cosCompute"):
            return await self.run_cos_enhancement(identifier)
        if self.storage.get("photoJobs",identifier).get("macCompute"):
            return await self.run_mac_enhancement(identifier)
        task_directory=self.storage.transfers/("enhance-"+identifier)
        temporary=task_directory/"result.jpg"
        process=None
        try:
            async with self.enhancement_lock:
                job=self.storage.get("photoJobs",identifier)
                if job["state"]=="cancelled":
                    return
                self.update_photo(identifier,state="running",label="加载增强模型")
                task_directory.mkdir(mode=0o700, exist_ok=True)
                process=await asyncio.create_subprocess_exec(sys.executable,"-m","desktop_backend.worker",
                            "--input",str(self.storage.asset_path(job["inputAssetId"])),"--output",str(temporary),
                            "--model",job["model"],cwd=str(self.root),
                            stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
                self.processes[identifier]=process
                stderr_task=asyncio.create_task(process.stderr.read())
                error=None
                async for line in process.stdout:
                    try:
                        event=json.loads(line)
                    except (ValueError,UnicodeDecodeError):
                        continue
                    if event.get("event")=="error":
                        error=event.get("error")
                    elif event.get("event")=="progress":
                        details={key:event[key] for key in ("device","peakRssBytes","inputWidth","inputHeight") if key in event}
                        self.update_photo(identifier,progress=event.get("progress",0),label=event.get("label","正在增强"),**details)
                code=await process.wait()
                await stderr_task
                current=self.storage.get("photoJobs",identifier)
                if current["state"]=="cancelled":
                    return
                if code!=0 or not temporary.exists():
                    raise ValueError(error or "增强失败，请重试")
                source=self.storage.asset(job["inputAssetId"])
                from .limits import normalized_size
                input_width,input_height=normalized_size(source["width"],source["height"])
                output_filename = Path(source["filename"]).stem + "_4x.jpg"
                if job["model"] == "anime":
                    output_filename = anime_export_filename(output_filename)
                async def import_result():
                    try:
                        asset=await asyncio.to_thread(self.storage.import_worker_output,temporary,
                                    output_filename,identifier,
                                    (input_width*4,input_height*4))
                        return asset,None
                    except Exception as error:
                        return None,error
                importing=asyncio.create_task(import_result())
                try:
                    asset,error=await asyncio.shield(importing)
                except asyncio.CancelledError:
                     
                     
                    asset,error=await importing
                    if asset:
                        saved_path=self.storage.asset_path(asset["id"])
                        self.storage.remove("assets",asset["id"])
                        saved_path.unlink(missing_ok=True)
                    raise
                if error:
                    raise error
                self.storage.add_history(asset["id"],"动漫增强" if job["model"]=="anime" else "通用增强",job_id=identifier)
                self.update_photo(identifier,state="completed",progress=1,label="增强完成",outputAssetId=asset["id"],outputAssets=[asset],error=None)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.update_photo(identifier,state="failed",label="",error=str(exc))
        finally:
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(),2)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            self.processes.pop(identifier,None)
            shutil.rmtree(task_directory,ignore_errors=True)

    async def run_mac_enhancement(self,identifier):
        """Resume durable owner-bound GPU tasks without executing on this host."""
        task_directory=self.storage.transfers/("enhance-"+identifier)
        task_directory.mkdir(mode=0o700,exist_ok=True)
        output=task_directory/"result.jpg"
        owner=self.account.get("owner")
        remote_id=None
        try:
            if self.platform.mode!="web" or not MacComputeClient.enabled_for(owner):
                raise ValueError("此账户的 Mac 计算授权不可用")
            client=MacComputeClient()
            job=self.storage.get("photoJobs",identifier)
            if job["state"]=="cancelled":return
            remote_id=job.get("remoteTaskId")
            if remote_id:
                while True:
                    try:
                        initial=await asyncio.to_thread(client.status,owner,remote_id)
                        if initial["state"]=="uploading":remote_id=None
                        break
                    except MacComputeError as error:
                        if (400 <= error.status < 500 and error.status != 429) or error.code=="configuration":raise
                        self.update_photo(identifier,state="reconnecting",label="等待恢复 Mac 连接")
                        await asyncio.sleep(3)
            if not remote_id:
                def prepare_input():
                    from PIL import Image
                    data,_=self.storage.request_image(job["inputAssetId"])
                    source=task_directory/"input.img"
                    source.write_bytes(data)
                    with Image.open(source) as opened:
                        return source,opened.width,opened.height
                source,width,height=await asyncio.to_thread(prepare_input)
                self.update_photo(identifier,state="queued",label="等待 Mac 处理",macInputWidth=width,macInputHeight=height)
                def remember_task(task_id):
                    # Persist the identifier before streaming the input. Storage
                    # serializes this callback with other thread-side writes.
                    current=self.storage.get("photoJobs",identifier)
                    if current:
                        current["remoteTaskId"]=task_id
                        self.storage.put("photoJobs",current)
                        emit_timing("task_link","linked",source="server",photoJobId=identifier,requestId=current["requestId"],assetId=current["inputAssetId"],taskId=task_id)
                async def submit():
                    while True:
                        attempt=asyncio.create_task(asyncio.to_thread(client.submit_enhance,owner,job["requestId"],job["model"],source,width,height,remember_task))
                        try:
                            return await asyncio.shield(attempt)
                        except asyncio.CancelledError:
                            try:await attempt
                            except Exception:pass
                            raise
                        except MacComputeError as error:
                            if (400 <= error.status < 500 and error.status != 429) or error.code=="configuration":raise
                            self.update_photo(identifier,state="reconnecting",label="等待恢复 Mac 连接")
                            await asyncio.sleep(3)
                pending=asyncio.create_task(submit())
                try:
                    remote=await asyncio.shield(pending)
                except asyncio.CancelledError:
                    # The HTTP request can finish after cancellation. Keep its id
                    # for restart, or cancel it if the user explicitly stopped.
                    pending.cancel()
                    await asyncio.gather(pending,return_exceptions=True)
                    current=self.storage.get("photoJobs",identifier)
                    remote_id=(current or {}).get("remoteTaskId")
                    if not self.closing and remote_id:
                        try:await asyncio.to_thread(client.cancel,owner,remote_id)
                        except MacComputeError:
                            self.update_photo(identifier,macCancelPending=True)
                    raise
                remote_id=remote["id"]
                self.update_photo(identifier,remoteTaskId=remote_id)
            emit_timing("task_link","linked",source="server",photoJobId=identifier,requestId=job["requestId"],assetId=job["inputAssetId"],taskId=remote_id)
            while not self.closing:
                current=self.storage.get("photoJobs",identifier)
                if current["state"]=="cancelled":return
                try:
                    remote=await asyncio.to_thread(client.status,owner,remote_id)
                except MacComputeError as error:
                    if (400 <= error.status < 500 and error.status != 429) or error.code=="configuration":raise
                    self.update_photo(identifier,state="reconnecting",label="等待恢复 Mac 连接")
                    await asyncio.sleep(3)
                    continue
                state=remote["state"]
                if state=="completed":break
                if state in {"failed","cancelled"}:
                    if state=="cancelled":
                        self.update_photo(identifier,state="cancelled",label="已停止",error=None)
                        return
                    raise ValueError(remote.get("error") or "Mac 增强未完成，请重试")
                self.update_photo(identifier,state="running" if state=="running" else "queued",
                                  progress=remote.get("progress",0),label=remote.get("label") or "等待 Mac 处理",
                                  **{key:remote.get("details",{}).get(key) for key in ("device",) if key in remote.get("details",{})})
                await asyncio.sleep(2)
            if self.closing:return
            self.update_photo(identifier,state="running",label="正在保存图片",device="mps")
            await asyncio.to_thread(client.download_image,owner,remote_id,output)
            current=self.storage.get("photoJobs",identifier)
            if current["state"]=="cancelled":return
            source=self.storage.asset(job["inputAssetId"])
            filename=Path(source["filename"]).stem+"_4x.jpg"
            if job["model"]=="anime":filename=anime_export_filename(filename)
            width=current["macInputWidth"]*4
            height=current["macInputHeight"]*4
            importing=asyncio.create_task(asyncio.to_thread(self.storage.import_worker_output,output,filename,identifier,(width,height)))
            try:
                asset=await asyncio.shield(importing)
            except asyncio.CancelledError:
                asset=await importing
                saved=self.storage.asset_path(asset["id"])
                self.storage.remove("assets",asset["id"])
                saved.unlink(missing_ok=True)
                raise
            self.storage.add_history(asset["id"],"动漫增强" if job["model"]=="anime" else "通用增强",job_id=identifier)
            emit_timing("task_link","linked",source="server",photoJobId=identifier,requestId=job["requestId"],assetId=job["inputAssetId"],taskId=remote_id,outputAssetId=asset["id"])
            self.update_photo(identifier,state="completed",progress=1,label="增强完成",device="mps",
                              outputAssetId=asset["id"],outputAssets=[asset],error=None)
        except asyncio.CancelledError:
            if not self.closing and remote_id:
                try:await asyncio.to_thread(client.cancel,owner,remote_id)
                except Exception:pass
            raise
        except Exception as error:
            self.update_photo(identifier,state="failed",label="",error=str(error))
        finally:
            shutil.rmtree(task_directory,ignore_errors=True)

    async def run_remote_photo(self,identifier):
        try:
            job=self.storage.get("photoJobs",identifier)
            if not job.get("remoteJobId"):
                assets=[self.storage.public_asset(self.storage.asset(job["inputAssetId"]))]
                if job["feature"]=="remove":
                    assets.append(self.storage.public_asset(self.storage.asset(job["maskAssetId"])))
                self.update_photo(identifier,state="submitting",label="发送中")
                remote_id=await self.gateway.create_job({"prompt":REMOVE_PROMPT if job["feature"]=="remove" else COLORIZE_PROMPT,
                              "images":await asyncio.to_thread(self.payload_images,assets,[job["maskAssetId"]] if job["feature"]=="remove" else []),"conversationId":job["remoteConversationId"],
                              "requestId":job["requestId"],"reasoning":"low"})
                job=self.update_photo(identifier,remoteJobId=remote_id,state="running",label="请求已接收")
            for attempt in range(3):
                job=self.storage.get("photoJobs",identifier)
                try:
                    async for event in self.gateway.events(job["remoteJobId"],job["lastEventId"]):
                        current=self.storage.get("photoJobs",identifier)
                        if current["state"]=="cancelled":
                            return
                        if event.get("seq",0)<=current["lastEventId"]:
                            continue
                        for remote in ([event["asset"]] if event.get("asset") else [])+(event.get("assets") or []):
                            if any(x.get("remoteId")==remote["id"] for x in current["outputAssets"]):
                                continue
                            async def progress(received,total):
                                self.update_photo(identifier,label=f"接收图片 {received//1024} / {max(1,total//1024)} KB")
                            asset=await self.gateway.download(remote,self.storage,progress=progress)
                            current=self.storage.get("photoJobs",identifier)
                            if current["state"]=="cancelled":
                                return
                            current["outputAssets"].append(asset)
                            if asset["mimeType"].startswith("image/"):
                                current["outputAssetId"]=asset["id"]
                                self.storage.add_history(asset["id"],"AI 消除" if job["feature"]=="remove" else "老照片上色",job_id=job["remoteJobId"])
                            self.storage.put("photoJobs",current)
                        current=self.storage.get("photoJobs",identifier)
                        current.update(lastEventId=event["seq"],label=event.get("label",current["label"]))
                        kind=event.get("type")
                        if kind in TERMINAL:
                            current.update(state=kind,progress=1 if kind=="completed" else current["progress"],label="",error=event.get("error"))
                            if kind=="completed" and not current["outputAssetId"]:
                                current.update(state="failed",error=event.get("text") or "本次没有返回图片")
                        else:
                            current["state"]="running"
                        self.storage.put("photoJobs",current)
                        self.notify()
                        if kind in TERMINAL:
                            return
                    raise GatewayError("接收连接已结束")
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.update_photo(identifier,state="reconnecting",label="正在恢复连接")
                    if attempt<2:
                        await asyncio.sleep(2**attempt)
            self.update_photo(identifier,state="reconnecting",label="接收中断",error="接收中断，重新连接后可继续接收")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.update_photo(identifier,state="failed",label="",error=str(exc))

    async def stop_photo(self,identifier):
        job=self.storage.get("photoJobs",identifier)
        if job is None:
            raise ValueError("任务不存在")
        if job["state"] in TERMINAL:
            return
        task=self.tasks.pop("photo:"+identifier,None)
        if task:
            task.cancel()
        self.update_photo(identifier,state="cancelled",label="已停止",error=None)
        if job.get("macCompute") and job.get("remoteTaskId"):
            try:
                await asyncio.to_thread(MacComputeClient().cancel,self.account.get("owner"),job["remoteTaskId"])
            except MacComputeError:
                # Keep a durable cancellation marker; it is retried on restart.
                self.update_photo(identifier,macCancelPending=True)
        if job["feature"]!="enhance":
            intent={"id":job["requestId"],"requestId":job["requestId"],"kind":"photo","entityId":identifier}
            self.storage.put("stops",intent)
            await self.confirm_stop(intent)

    def delete_history(self,ids):
        for identifier in ids:
            self.storage.remove("history",identifier)
        self.notify()

    def export_history(self,ids):
        names=set()
        entries=[self.storage.get("history",identifier) for identifier in ids]
        if not entries or any(x is None for x in entries):
            raise ValueError("请先选择有效的图片记录")
        files=[]
        for entry in entries:
            asset=self.storage.asset(entry["assetId"])
            path=self.storage.asset_path(asset["id"])
            filename=self.storage.export_filename(asset,entry)
            base,ext=Path(filename).stem,Path(filename).suffix
            count=1
            while filename.casefold() in names:
                count+=1
                filename=f"{base}_{count}{ext}"
            names.add(filename.casefold())
            files.append((path,filename))
        return self.storage.save_archive(files)

    async def close(self):
        self.closing=True
        running=list(self.tasks.values())+list(self.background)
        for task in running:
            task.cancel()
        self.gateway.close()
        for process in list(self.processes.values()):
            if process.returncode is None:
                process.terminate()
        if running:
            await asyncio.gather(*running,return_exceptions=True)
        for item in self.storage.list("temporaryConversations"):
            self.storage.remove("temporaryConversations", item["id"])
        self.storage.close()
