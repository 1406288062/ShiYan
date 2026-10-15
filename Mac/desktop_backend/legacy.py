 
from __future__ import annotations
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from fastapi.responses import JSONResponse, StreamingResponse

class LegacyHost:
    def __init__(self,root,directory):
        self.root=Path(root)
        self.directory=Path(directory).expanduser()
        self.process=None
        self.port=None
        self.ready=asyncio.Event()
        self.error=None

    async def start(self):
        try:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1",0))
                self.port=probe.getsockname()[1]
            self.process=await asyncio.create_subprocess_exec(sys.executable,"-m","desktop_backend.legacy",
                               "--port",str(self.port),cwd=self.root,stdout=asyncio.subprocess.PIPE,
                               stderr=asyncio.subprocess.STDOUT)
            while True:
                line=await self.process.stdout.readline()
                if not line:
                    self.error="旧版图片接口未启动"
                    self.ready.set()
                    return
                if line.startswith(b"SHIYAN_LEGACY_READY"):
                    self.ready.set()
                    break
            while await self.process.stdout.readline():
                pass
        except asyncio.CancelledError:
            raise
        except Exception:
            self.error="旧版图片接口未启动"
            self.ready.set()

    async def proxy(self,request,path):
        try:
            await asyncio.wait_for(self.ready.wait(),45)
        except asyncio.TimeoutError:
            return JSONResponse({"error":"旧版图片接口正在准备"},status_code=503)
        if self.error or not self.port or self.process.returncode is not None:
            return JSONResponse({"error":self.error or "旧版图片接口未启动"},status_code=503)
        import httpx
        upstream_path=path[7:] if path.startswith("legacy/") else "" if path=="legacy" else path
        query=request.url.query
        url=f"http://127.0.0.1:{self.port}/"+upstream_path+("?" + query if query else "")
        headers={k:v for k,v in request.headers.items() if k.lower() not in {"host","connection","content-length","transfer-encoding","accept-encoding"}}
        client=httpx.AsyncClient(timeout=httpx.Timeout(140,connect=5),follow_redirects=False,trust_env=False)
        try:
            upstream=await client.send(client.build_request(request.method,url,headers=headers,content=await request.body()),stream=True)
        except Exception:
            await client.aclose()
            return JSONResponse({"error":"旧版图片接口连接失败"},status_code=502)
        async def content():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()
        response_headers={k:v for k,v in upstream.headers.items() if k.lower() not in {"connection","transfer-encoding","content-length"}}
        return StreamingResponse(content(),status_code=upstream.status_code,headers=response_headers)

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(),3)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()

def main():
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument("--port",type=int,required=True)
    args=parser.parse_args()
     
    os.environ.setdefault("GRADIO_ANALYTICS_ENABLED","False")
    import legacy_webui
    legacy_webui.demo.launch(server_name="127.0.0.1",server_port=args.port,
             share=False,inbrowser=False,prevent_thread_lock=True,quiet=True,root_path="/legacy")
    print("SHIYAN_LEGACY_READY",flush=True)
    import signal
    signal.pause()

if __name__=="__main__":
    main()
