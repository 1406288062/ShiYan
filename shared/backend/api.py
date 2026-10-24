 
from __future__ import annotations
import asyncio
import base64
from contextlib import asynccontextmanager
import io
import json
import mimetypes
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit, quote
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from .message_view import conversation_view
from .runtime import Runtime
from .gateway import GatewayError
from .workbench import Workbench, register_workbench
from .dots import register_dots
from .schedules import DesktopSchedules, register_schedules
from .account_sessions import AccountSessions, register_accounts
from .account_avatar import register_account_avatar
from .knowledge import register_knowledge
from .platforms import resolve_profile
from .member_workspace import proxy_member_request

def create_app(directory, root, legacy=None, profile="desktop"):
    root=Path(root)
    platform=resolve_profile(profile,root)
    @asynccontextmanager
    async def lifespan(app):
        if platform.mode == "web" or os.environ.get("SHIYAN_MULTIUSER_WEB") == "1":
            from .web_sessions import BrowserAccountRegistry
            accounts=BrowserAccountRegistry(app,directory,root,legacy,platform=platform)
        else:
            accounts=AccountSessions(app,directory,root,legacy,platform=platform)
        app.state.accounts=accounts
        if os.environ.get("SHIYAN_OFFLINE_TEST") != "1":
            accounts.prepare_restore()
        yield
        await accounts.close()

    app=FastAPI(title="拾燕",docs_url=None,redoc_url=None,openapi_url=None,lifespan=lifespan)

    app.state.platform=platform

    register_workbench(app)
    register_dots(app)
    register_schedules(app)
    register_accounts(app)
    register_account_avatar(app)
    register_knowledge(app)

    @app.middleware("http")
    async def local_only(request,call_next):
        server=request.scope.get("server")
        port=server[1] if server else None
        allowed={f"127.0.0.1:{port}",f"localhost:{port}"}
        host=request.headers.get("host","").lower()
        if host not in allowed:
            return JSONResponse({"ok":False,"error":"请求地址无效"},status_code=403)
        origin=request.headers.get("origin")
        if origin:
            parsed=urlsplit(origin)
            if parsed.scheme!="http" or parsed.netloc.lower() not in allowed:
                return JSONResponse({"ok":False,"error":"不允许跨站请求"},status_code=403)
        if request.headers.get("sec-fetch-site")=="cross-site":
            return JSONResponse({"ok":False,"error":"不允许跨站请求"},status_code=403)
        if request.url.path.startswith("/api/") and request.method not in {"GET","HEAD","OPTIONS"}:
            if request.headers.get("x-shiyan-local")!="1":
                return JSONResponse({"ok":False,"error":"本地请求校验失败"},status_code=403)
            try:
                if int(request.headers.get("content-length","0"))>64*1024*1024:
                    return JSONResponse({"ok":False,"error":"上传内容过大"},status_code=413)
            except ValueError:
                return JSONResponse({"ok":False,"error":"请求长度无效"},status_code=400)
        try:
            await request.app.state.accounts.protect(request)
            isolated = await proxy_member_request(request)
            if isolated is not None:
                return isolated
        except GatewayError as error:
            return JSONResponse({"ok":False,"error":str(error)},status_code=error.status)
        response=await call_next(request)
        if hasattr(app.state.accounts, "finish"):
            app.state.accounts.finish(request, response)
        response.headers["X-Content-Type-Options"]="nosniff"
        response.headers["Referrer-Policy"]="no-referrer"
        if request.url.path.startswith("/assets/knowledge-ui/"):
            response.headers["Content-Security-Policy"]="default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
            response.headers["Cache-Control"]="no-store"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"]="no-store"
        return response

    @app.exception_handler(ValueError)
    async def invalid(request,exc):
        return JSONResponse({"ok":False,"error":str(exc)},status_code=400)

    @app.exception_handler(GatewayError)
    async def remote_error(request,exc):
        return JSONResponse({"ok":False,"error":str(exc)},status_code=exc.status if 400<=exc.status<600 else 503)

    def runtime(request):
        return request.app.state.runtime

    def result(request,**extra):
        if isinstance(extra.get("conversation"), dict):
            extra["conversation"] = conversation_view(extra["conversation"])
        return {"ok":True,**extra,"state":runtime(request).snapshot()}

    async def object_body(request):
        try:
            value=await request.json()
        except (ValueError,UnicodeDecodeError):
            raise ValueError("请求格式无效")
        if not isinstance(value,dict):
            raise ValueError("请求应为 JSON 对象")
        return value

    @app.get("/")
    async def home():
        return FileResponse(root/"web"/"index.html",media_type="text/html",
              headers={"Cache-Control":"no-cache","Content-Security-Policy":"default-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"})

    @app.get("/api/platform")
    async def platform_info():
        return {"ok":True,**platform.public()}

    @app.get("/assets/platform-voice.js")
    async def platform_voice_script():
        source = ""
        if platform.mode == "web":
            adapter = Path(__file__).resolve().parents[2] / "apps/web/adapters/voice.js"
            source = adapter.read_text(encoding="utf-8")
        return Response(source, media_type="application/javascript", headers={"Cache-Control": "no-store"})

    @app.get("/assets/site-icon.png")
    async def site_icon():
        name = "web-favicon.png" if platform.mode == "web" else "app-icon.png"
        return FileResponse(root/"web"/"assets"/name, media_type="image/png",
                            headers={"Cache-Control":"public, max-age=86400"})

    @app.get("/platform.js")
    async def platform_script():
        source="window.__SHIYAN_PLATFORM__="+json.dumps(platform.public(),ensure_ascii=True,separators=(",",":"))+";\n"
        return Response(source,media_type="application/javascript",headers={"Cache-Control":"no-store"})

    @app.get("/app.js")
    async def app_script():
        return FileResponse(root/"web"/"app.js",media_type="application/javascript",headers={"Cache-Control":"no-cache"})

    @app.get("/styles.css")
    async def app_styles():
        return FileResponse(root/"web"/"styles.css",media_type="text/css",headers={"Cache-Control":"no-cache"})

    @app.get("/api/health")
    async def health(request:Request):
        return {"ok":True,"service":"shiyan-desktop","version":"accounts-v1"}

    @app.get("/api/state")
    async def state(request:Request):
        return result(request)

    @app.get("/api/account/quota")
    async def account_quota(request:Request):
        try:
            data=await runtime(request).gateway.json("GET","account/quota",timeout=18)
            return {"ok":True,"quota":data.get("quota",{"available":False,"windows":[]})}
        except Exception:
            return {"ok":True,"quota":{"available":False,"windows":[],"error":"暂时无法获取剩余额度"}}

    @app.get("/api/capabilities")
    async def capabilities(request:Request):
        r=runtime(request)
        return {"ok":True,"capabilities":r.capabilities,"connection":r.connection}

    @app.post("/api/agent/connect")
    async def connect(request:Request):
        r=runtime(request)
        if os.environ.get("SHIYAN_OFFLINE_TEST") == "1":
            r.connection = {"status":"offline","error":None}
            r.notify()
            return result(request)
        await runtime(request).connect(force=True)
        return result(request)

    @app.get("/api/events")
    async def events(request:Request):
        r=runtime(request)
        queue=asyncio.Queue(maxsize=1)
        r.listeners.add(queue)
        async def stream():
            try:
                yield "event: state\ndata: "+json.dumps(r.snapshot(),ensure_ascii=False,separators=(",",":"))+"\n\n"
                while not r.closing:
                    try:
                        state=await asyncio.wait_for(queue.get(),timeout=15)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    if state is None or r.closing: return
                    yield "event: state\ndata: "+json.dumps(state,ensure_ascii=False,separators=(",",":"))+"\n\n"
            finally:
                r.listeners.discard(queue)
        return StreamingResponse(stream(),media_type="text/event-stream",
                 headers={"Cache-Control":"no-cache, no-transform","X-Accel-Buffering":"no"})

    @app.post("/api/assets")
    async def upload(request:Request):
        r=runtime(request)
        items=[]
        if request.headers.get("content-type","").startswith("application/json"):
            data=await object_body(request)
            encoded=str(data.get("dataUrl",""))
            if "," not in encoded or not encoded.startswith("data:image/"):
                raise ValueError("图片数据无效")
            head,encoded=encoded.split(",",1)
            try:
                raw=base64.b64decode(encoded,validate=True)
            except ValueError:
                raise ValueError("图片数据不完整")
            items=[(data.get("filename","图片.png"),head[5:].split(";")[0],raw)]
            kind=data.get("kind","input")
        else:
            form=await request.form(max_files=8,max_fields=4,max_part_size=40*1024*1024)
            kind=str(form.get("kind","input"))
            files=form.getlist("files") or form.getlist("file")
            for uploaded in files:
                if not hasattr(uploaded,"read"):
                    continue
                data=await uploaded.read(40*1024*1024+1)
                await uploaded.close()
                items.append((uploaded.filename,uploaded.content_type,data))
        if not items or len(items)>8:
            raise ValueError("请选择 1 到 8 个附件")
        assets=[]
        for filename,mime,data in items:
            if len(data)>40*1024*1024:
                raise ValueError("单张图片超过 40 MB")
            if Path(filename or "").suffix.lower() in {".heic",".heif"}:
                with tempfile.TemporaryDirectory(dir=r.storage.transfers) as tmp:
                    source=Path(tmp)/"input.heic"
                    target=Path(tmp)/"converted.png"
                    source.write_bytes(data)
                    process=await asyncio.create_subprocess_exec("/usr/bin/sips","-s","format","png",str(source),"--out",str(target),
                            stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
                    await asyncio.wait_for(process.wait(),30)
                    if process.returncode!=0 or not target.exists():
                        raise ValueError("HEIC 图片转换失败")
                    data=target.read_bytes()
                    filename=Path(filename).stem+".png"
                    mime="image/png"
            mime = (mime or "").split(";")[0].lower()
            if not mime or mime == "application/octet-stream":
                mime = mimetypes.guess_type(filename or "")[0] or "application/octet-stream"
            if not mime.startswith("image/"):
                if kind != "attachment":
                    raise ValueError("请选择图片文件")
                if len(data) > 10 * 1024 * 1024:
                    raise ValueError("单个文档不能超过 10 MB")
            asset=await asyncio.to_thread(r.storage.save_bytes,data,filename,mime,normalize=kind!="mask",mask=kind=="mask")
            assets.append(asset)
        r.notify()
        return result(request,assets=assets)

    @app.get("/api/assets/{identifier}")
    async def asset_info(identifier:str,request:Request):
        r=runtime(request)
        return {"ok":True,"asset":r.storage.public_asset(r.storage.asset(identifier))}

    @app.get("/api/assets/{identifier}/thumbnail")
    async def asset_thumbnail(identifier: str, request: Request):
        path = await asyncio.to_thread(runtime(request).storage.thumbnail_path, identifier)
        return FileResponse(path, media_type="image/png",
                            headers={"Cache-Control": "private, max-age=31536000, immutable",
                                     "Cross-Origin-Resource-Policy": "same-origin",
                                     "Content-Security-Policy": "sandbox; default-src 'none'"})

    @app.get("/api/assets/{identifier}/file")
    async def asset_file(identifier:str,request:Request,download:int=0):
        r=runtime(request)
        asset=r.storage.asset(identifier)
        inline=asset["mimeType"] in {"image/jpeg","image/png","image/webp","image/bmp"} and not download
        return FileResponse(r.storage.asset_path(identifier),media_type=asset["mimeType"],
                            filename=asset["filename"] if inline else r.storage.export_filename(asset),content_disposition_type="inline" if inline else "attachment",
                            headers={"X-Content-SHA256":asset["sha256"],"Content-Security-Policy":"sandbox; default-src 'none'"})

    @app.post("/api/conversations")
    async def new_conversation(request:Request):
        r=runtime(request)
        data=await object_body(request) if await request.body() else {}
        project_id=data.get("projectId") if "projectId" in data else r.storage.setting("workspace",{}).get("selectedProjectId")
        if project_id and not r.storage.get("projects",str(project_id)):
            raise ValueError("项目不存在")
        item=r.new_conversation(project_id=project_id,force_new=False)
        return result(request,conversation=item)

    @app.patch("/api/conversations/{identifier}")
    async def patch_conversation(identifier:str,request:Request):
        item=runtime(request).patch_conversation(identifier,await object_body(request))
        return result(request,conversation=item)

    @app.post("/api/conversations/{identifier}/file-changes")
    async def import_file_changes(identifier:str,request:Request):
        from .file_changes import diff_record
        r=runtime(request);data=await object_body(request);c=r.conversation(identifier)
        message=next((m for m in c["messages"] if m["id"]==data.get("messageId") and m["role"]=="assistant"),None)
        if not message or message.get("state")!="completed":
            raise ValueError("只能补充已完成回复的修改记录")
        roots=[Path(p).resolve() for p in c.get("fileChangeRoots",[])]
        files=data.get("files")
        if not isinstance(files,list) or len(files)>200:raise ValueError("文件修改记录无效")
        records=[];size=0
        for f in files:
            if not isinstance(f,dict) or not isinstance(f.get("path"),str):raise ValueError("文件路径无效")
            path=Path(f["path"])
            if not path.is_absolute() or not any(path.resolve().is_relative_to(root) for root in roots):raise ValueError("文件不在修改记录目录内")
            before=f.get("before");after=f.get("after")
            if not isinstance(before,str) or not isinstance(after,str):raise ValueError("缺少真实修改前后内容")
            size+=len(before.encode())+len(after.encode())
            if size>8*1024*1024:raise ValueError("修改记录过大")
            record=diff_record(str(path),before,after,str(f.get("kind","update")))
            if record["diff"]:records.append(record)
        message["fileChanges"]=records;r.save_conversation(c)
        return result(request,files=len(records))

    @app.get("/api/conversations/{identifier}/messages/{message_id}/details")
    async def message_details(identifier:str,message_id:str,request:Request):
        r=runtime(request)
        conversation=r.conversation(identifier)
        message=next((m for m in conversation.get("messages",[]) if m.get("id")==message_id),None)
        if message is None:
            raise ValueError("消息不存在")
        if message.get("executionDetailsAvailable") is True:
            details=await r.gateway.json("GET","sync/messages/"+quote(message_id,safe="")+"/details",timeout=90)
            fields=("rawResult","fileChanges","displayItems")
            if not isinstance(details,dict) or details.get("ok") is not True or any(field not in details for field in fields):
                raise GatewayError("完整记录暂时无法读取，请重试",502)
            # A details view never changes the sync baseline or stages a partial
            # execution record as a new cloud mutation.
            full={field:details[field] for field in fields}
            if not message.get("remoteJobId"):
                for field in fields:
                    if field in (message.get("executionDetailsChanged") or []):
                        full[field]=message.get(field,None if field=="rawResult" else [])
            message={**message,**full,"detailsDeferred":False}
        return {"ok":True,"message":message}

    @app.get("/api/memory")
    async def memory_list(request:Request,query:str=""):
        suffix="?query="+quote(query[:200],safe="") if query else ""
        return await runtime(request).gateway.json("GET","memory"+suffix)

    @app.get("/api/memory/settings")
    async def memory_settings_read(request:Request):
        return await runtime(request).gateway.json("GET","memory/settings")

    @app.patch("/api/memory/settings")
    async def memory_settings(request:Request):
        return await runtime(request).gateway.json("PATCH","memory/settings",await object_body(request))

    @app.post("/api/memory")
    async def memory_create(request:Request):
        return await runtime(request).gateway.json("POST","memory",await object_body(request))

    @app.delete("/api/memory")
    async def memory_clear(request:Request):
        return await runtime(request).gateway.json("DELETE","memory")

    @app.patch("/api/memory/{memory_id}")
    async def memory_update(memory_id:str,request:Request):
        return await runtime(request).gateway.json("PATCH","memory/"+quote(memory_id,safe=""),await object_body(request))

    @app.delete("/api/memory/{memory_id}")
    async def memory_delete(memory_id:str,request:Request):
        return await runtime(request).gateway.json("DELETE","memory/"+quote(memory_id,safe=""))

    @app.get("/api/conversations/{identifier}/questions")
    async def user_questions(identifier:str,request:Request):
        r=runtime(request);conversation=r.conversation(identifier)
        message=next((m for m in reversed(conversation.get("messages",[])) if m.get("role")=="assistant" and m.get("remoteJobId")),None)
        if message is None:
            return {"ok":True,"pendingQuestions":[]}
        if platform.mode == "web" and message.get("state") in {"completed", "failed", "cancelled", "interrupted"}:
            return {"ok":True,"pendingQuestions":[],"polling":False}
        try:
            return await r.gateway.user_questions(message["remoteJobId"])
        except GatewayError as error:
            # The conversation was authorized above. Missing remote mailboxes may
            # belong to old/local jobs; never swallow authentication or service errors.
            if platform.mode == "web" and error.status == 404:
                return {"ok":True,"pendingQuestions":[],"unavailable":True,"pollAfterMs":30000}
            raise

    @app.post("/api/conversations/{identifier}/questions/{question_id}/answer")
    async def answer_user_question(identifier:str,question_id:str,request:Request):
        r=runtime(request);conversation=r.conversation(identifier);data=await object_body(request)
        job_id=data.get("jobId")
        if not isinstance(job_id,str) or not any(m.get("remoteJobId")==job_id for m in conversation.get("messages",[])):
            raise ValueError("问题不属于当前会话")
        if not isinstance(data.get("answers"),dict) or not data["answers"]:
            raise ValueError("请先选择或填写回答")
        return await r.gateway.answer_question(job_id,question_id,data["answers"])

    @app.post("/api/conversations/{identifier}/select")
    async def select(identifier:str,request:Request):
        runtime(request).select(identifier)
        return result(request)

    @app.delete("/api/conversations/{identifier}")
    async def delete_conversation(identifier:str,request:Request):
        await runtime(request).delete_conversation(identifier)
        return result(request)

    @app.post("/api/conversations/{identifier}/send")
    async def send(identifier:str,request:Request):
        data=await object_body(request)
        message=await runtime(request).send(identifier,data.get("text",""),data.get("assetIds",[]),data.get("editingMessageId"),urgent=data.get("priority")=="urgent",urgent_confirmed=data.get("urgentConfirmed") is True)
        return result(request,messageId=message["id"])

    @app.post("/api/conversations/{identifier}/queue/{message_id}/priority")
    async def priority_queue(identifier:str,message_id:str,request:Request):
        data=await object_body(request)
        runtime(request).prioritize_queued_message(identifier,message_id,data.get("confirmed") is True)
        return result(request)

    @app.delete("/api/conversations/{identifier}/queue/{message_id}")
    async def remove_queue(identifier:str,message_id:str,request:Request):
        runtime(request).remove_queued_message(identifier,message_id)
        return result(request)

    @app.post("/api/conversations/{identifier}/stop")
    async def stop(identifier:str,request:Request):
        await runtime(request).stop_conversation(identifier)
        return result(request)

    @app.post("/api/conversations/{identifier}/retry")
    async def retry(identifier:str,request:Request):
        runtime(request).retry(identifier)
        return result(request)

    @app.post("/api/photo/jobs")
    async def photo_job(request:Request):
        job=runtime(request).create_photo_job(await object_body(request))
        return result(request,jobId=job["id"])

    @app.post("/api/photo/jobs/{identifier}/cancel")
    async def cancel_photo(identifier:str,request:Request):
        await runtime(request).stop_photo(identifier)
        return result(request)

    @app.post("/api/photo/jobs/{identifier}/retry")
    async def retry_photo(identifier:str,request:Request):
        r=runtime(request)
        job=r.storage.get("photoJobs",identifier)
        if job is None:
            raise ValueError("任务不存在")
        raise ValueError("此图片工具已下线，请使用变清晰创建新任务")
        return result(request)

    @app.delete("/api/history/{identifier}")
    async def delete_history(identifier:str,request:Request):
        runtime(request).delete_history([identifier])
        return result(request)

    @app.post("/api/history/delete")
    async def delete_histories(request:Request):
        data=await object_body(request)
        runtime(request).delete_history(data.get("ids",[]))
        return result(request)

    @app.post("/api/history/export")
    async def export_history(request:Request):
        r=runtime(request)
        data=await object_body(request)
        asset=await asyncio.to_thread(r.export_history,data.get("ids",[]))
        r.notify()
        return result(request,asset=asset)

    @app.patch("/api/settings")
    async def settings(request:Request):
        r=runtime(request)
        data=await object_body(request)
        allowed={"historyViewMode","homeInputAssetId","homeFeature","homeModel","homeOutputAssetId","avatarAssetId"}
        current=r.storage.setting("settings",{"historyViewMode":"list"})
        if data.get("avatarAssetId"):
            avatar=r.storage.get("assets",str(data["avatarAssetId"]))
            if not avatar or not str(avatar.get("mimeType", "")).startswith("image/"):
                raise ValueError("请选择有效的头像图片")
        for key in allowed:
            if key in data:
                current[key]=data[key]
        r.storage.set_setting("settings",current)
        r.notify()
        return result(request)

    asset_root=root/"web"/"assets"
    app.mount("/assets",StaticFiles(directory=asset_root,check_dir=False),name="assets")
     
    if legacy:
        @app.api_route("/{rest:path}",methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"])
        async def legacy_proxy(rest:str,request:Request):
            return await legacy.proxy(request,rest)

    return app
