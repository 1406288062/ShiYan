 
from __future__ import annotations
import io
import json
import os
from pathlib import Path
import sys
for _parent in Path(__file__).resolve().parents:
    if (_parent / "shared" / "paths.py").is_file():
        if str(_parent) not in sys.path:
            sys.path.insert(0, str(_parent))
        break
from shared.paths import APP_ROOT
import signal
import subprocess
import tempfile
import time
import zipfile
import httpx
from PIL import Image

ROOT=APP_ROOT
results={}
temp=Path(tempfile.mkdtemp(prefix="shiyan-backend-check-"))
ready=temp/"ready.json"
log=open(temp/"server.log","w")
process=None

def launch():
    global process
    process=subprocess.Popen([sys.executable,str(ROOT/"desktop_server.py"),"--port","0","--ready-file",str(ready),"--data-dir",str(temp/"data")],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
    deadline=time.monotonic()+40
    while not ready.exists() or json.loads(ready.read_text()).get("pid")!=process.pid:
        if process.poll() is not None:
            raise RuntimeError("server exited before readiness")
        if time.monotonic()>deadline:
            raise TimeoutError("startup timeout")
        time.sleep(0.1)
    return json.loads(ready.read_text())["url"].rstrip("/")

def stop():
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=12)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

def image_bytes(width=96,height=64):
    image=Image.new("RGB",(width,height))
    image.putdata([((x*3)%256,(y*5)%256,((x+y)*2)%256) for y in range(height) for x in range(width)])
    buffer=io.BytesIO()
    image.save(buffer,"PNG")
    return buffer.getvalue()

def states(response):
    for line in response.iter_lines():
        if line.startswith("data: "):
            yield json.loads(line[6:])

try:
    base=launch()
    client=httpx.Client(base_url=base,headers={"X-Shiyan-Local":"1"},timeout=90,trust_env=False)
    state=client.get("/api/state").json()["state"]
    results["startup"]=client.get("/api/health").status_code==200
    results["legacy_output_copied"]=len(state["history"])>=1
    results["root_and_static"]=all(client.get(path).status_code==200 for path in ["/","/app.js","/styles.css"])
    results["cross_origin_blocked"]=client.post("/api/conversations",headers={"Origin":"https://attacker.invalid"},json={}).status_code==403
    results["host_rebind_blocked"]=client.get("/api/state",headers={"Host":"attacker.invalid"}).status_code==403
    results["csrf_header_required"]=httpx.post(base+"/api/conversations",json={},trust_env=False).status_code==403
    results["arbitrary_file_blocked"]=client.get("/api/assets/not-a-valid-asset/file").status_code==400
    connection=client.post("/api/agent/connect",json={}).json()["state"]["connection"]
    results["real_device_authorization_status"]=connection["status"]
    uploaded=client.post("/api/assets",files={"files":("test.png",image_bytes(),"image/png")}).json()
    assert uploaded.get("ok"),uploaded
    asset=uploaded["assets"][0]
    results["upload_normalization"]=(asset["width"],asset["height"])==(96,64)
    cid=state["selectedConversationId"]
    patched=client.patch("/api/conversations/"+cid,json={"title":"后端隔离回归","isPinned":True,"draft":"草稿不丢失","draftAssets":[asset["id"]],"reasoning":"medium"}).json()
    assert patched.get("ok"),patched
    settings=client.patch("/api/settings",json={"historyViewMode":"grid","homeInputAssetId":asset["id"],"homeFeature":"enhance","homeModel":"anime"}).json()
    assert settings.get("ok"),settings
    new=client.post("/api/conversations",json={}).json()["conversation"]
    results["conversation_crud"]=new["id"]!=cid
    assert client.post("/api/conversations/"+cid+"/select",json={}).status_code==200
    completed=[]
    progress_values=[]
    for model in ["anime","general"]:
        with client.stream("GET","/api/events") as response:
            iterator=states(response)
            next(iterator)
            created=client.post("/api/photo/jobs",json={"feature":"enhance","assetId":asset["id"],"model":model}).json()
            assert created.get("ok"),created
            jid=created["jobId"]
            for state in iterator:
                job=next((j for j in state["photoJobs"] if j["id"]==jid),None)
                if not job:
                    continue
                if model=="anime":
                    progress_values.append(job["progress"])
                if job["state"] in {"completed","failed","cancelled","interrupted"}:
                    assert job["state"]=="completed",job
                    completed.append(job)
                    break
        output=client.get("/api/assets/"+completed[-1]["outputAssetId"]+"/file")
        out=Image.open(io.BytesIO(output.content))
        results["real_"+model+"_4x"]=out.size==(384,256)
    results["sse_progress"]=any(0<v<1 for v in progress_values) and 1 in progress_values
    state=client.get("/api/state").json()["state"]
    selected=[h["id"] for h in state["history"] if h.get("jobId") in {j["id"] for j in completed}]
    exported=client.post("/api/history/export",json={"ids":selected}).json()
    assert exported.get("ok"),exported
    zip_response=client.get(exported["asset"]["downloadUrl"])
    archive=zipfile.ZipFile(io.BytesIO(zip_response.content))
    results["batch_export_collision_safe"]=len(archive.namelist())==2 and len(set(archive.namelist()))==2
    results["safe_download_headers"]="attachment" in zip_response.headers.get("content-disposition","") and zip_response.headers.get("x-content-type-options")=="nosniff"
     
    larger=client.post("/api/assets",files={"files":("cancel.png",image_bytes(640,400),"image/png")}).json()["assets"][0]
    with client.stream("GET","/api/events") as response:
        iterator=states(response)
        next(iterator)
        jid=client.post("/api/photo/jobs",json={"feature":"enhance","assetId":larger["id"],"model":"general"}).json()["jobId"]
        for state in iterator:
            job=next((j for j in state["photoJobs"] if j["id"]==jid),None)
            if job and job["state"]=="running":
                time.sleep(0.25)
                cancelled=client.post("/api/photo/jobs/"+jid+"/cancel",json={}).json()["state"]
                target=next(j for j in cancelled["photoJobs"] if j["id"]==jid)
                results["real_worker_cancelled"]=target["state"]=="cancelled" and target["outputAssetId"] is None
                break
    before=client.get("/api/state").json()["state"]
    history_count=len(before["history"])
    assert client.delete("/api/conversations/"+new["id"]).status_code==200
    client.close()
    stop()
    base=launch()
    client=httpx.Client(base_url=base,headers={"X-Shiyan-Local":"1"},timeout=90,trust_env=False)
    after=client.get("/api/state").json()["state"]
    restored=next(c for c in after["conversations"] if c["id"]==cid)
    results["restart_draft_and_attachment"]=restored["draft"]=="草稿不丢失" and restored["draftAssets"][0]["id"]==asset["id"]
    results["restart_pin_title_reasoning"]=restored["isPinned"] and restored["title"]=="后端隔离回归" and restored["reasoning"]=="medium"
    results["restart_history_no_duplicate_import"]=len(after["history"])==history_count
    results["restart_home_settings"]=after["settings"]["homeInputAssetId"]==asset["id"]
    client.close()
finally:
    stop()
    log.close()
    results["testDataDir"]=str(temp)
    destination=ROOT/"desktop_backend"/"verification-local.json"
    destination.write_text(json.dumps(results,ensure_ascii=False,indent=2))
    print(json.dumps(results,ensure_ascii=False,indent=2),flush=True)
