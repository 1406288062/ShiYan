from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import time
import httpx
ROOT=Path(__file__).resolve().parents[1]
tmp=Path(tempfile.mkdtemp(prefix="shiyan-legacy-check-"))
ready=tmp/"ready.json"
log=open(tmp/"server.log","w")
env=dict(os.environ)
env["GRADIO_ANALYTICS_ENABLED"]="False"
child=subprocess.Popen([sys.executable,str(ROOT/"webui.py"),"--port","0","--ready-file",str(ready),"--data-dir",str(tmp/"data")],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,env=env)
result={}
try:
    deadline=time.monotonic()+45
    while not ready.exists():
        if child.poll() is not None or time.monotonic()>deadline:
            raise RuntimeError("legacy host startup failed")
        time.sleep(.1)
    base=json.loads(ready.read_text())["url"]
    with httpx.Client(base_url=base,trust_env=False,timeout=70) as client:
        root=client.get("/")
        config=client.get("/config")
        info=client.get("/gradio_api/info")
        old=client.get("/legacy/")
        result={"new_home_available":root.status_code==200,"legacy_config_status":config.status_code,
                "legacy_info_status":info.status_code,"legacy_page_status":old.status_code,
                "legacy_named_endpoints":list(info.json().get("named_endpoints",{})) if info.status_code==200 else [],
                "testDataDir":str(tmp)}
        if config.status_code!=200:
            result["error"]=config.text[:300]
finally:
    child.terminate()
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    log.close()
    (ROOT/"desktop_backend"/"verification-legacy.json").write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result,ensure_ascii=False,indent=2))
