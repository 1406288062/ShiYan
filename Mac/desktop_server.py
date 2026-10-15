#!/usr/bin/env python3
 
from __future__ import annotations
import argparse
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import uvicorn
from desktop_backend.api import create_app

ROOT=Path(__file__).resolve().parent

def main(default_legacy=False):
    parser=argparse.ArgumentParser()
    parser.add_argument("--port",type=int,default=7860)
    parser.add_argument("--ready-file")
    parser.add_argument("--data-dir",default=str(Path.home()/"Library"/"Application Support"/"image_enhancer"))
    parser.add_argument("--legacy",action=argparse.BooleanOptionalAction,default=default_legacy)
    args=parser.parse_args()
    if not 0<=args.port<=65535:
        parser.error("port must be between 0 and 65535")
    legacy=None
    if args.legacy:
        from desktop_backend.legacy import LegacyHost
        legacy=LegacyHost(ROOT,args.data_dir)
    app=create_app(args.data_dir,ROOT,legacy)
    sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    sock.bind(("127.0.0.1",args.port))
    sock.listen(2048)
    port=sock.getsockname()[1]
    ready=Path(args.ready_file).expanduser() if args.ready_file else None
    parent_pid=int(os.environ.get("SHIYAN_PARENT_PID","0"))
    class LocalServer(uvicorn.Server):
        async def startup(self,sockets=None):
            await super().startup(sockets)
            if self.started:
                information={"port":port,"url":f"http://127.0.0.1:{port}/","pid":os.getpid()}
                if ready:
                    ready.parent.mkdir(parents=True,exist_ok=True)
                    temp=ready.with_name(ready.name+".tmp")
                    temp.write_text(json.dumps(information))
                    os.chmod(temp,0o600)
                    temp.replace(ready)
                print("SHIYAN_READY "+json.dumps(information),flush=True)
                if parent_pid:
                    self.parent_watcher=asyncio.create_task(self.watch_parent())
        async def shutdown(self,sockets=None):
            try:
                await super().shutdown(sockets)
            finally:
                if ready and ready.exists():
                    try:
                        if json.loads(ready.read_text()).get("pid")==os.getpid():
                            ready.unlink()
                    except (OSError,ValueError):
                        pass

        async def watch_parent(self):
            while not self.should_exit:
                try:
                    os.kill(parent_pid,0)
                except ProcessLookupError:
                    self.should_exit=True
                    return
                await asyncio.sleep(1)
    server=LocalServer(uvicorn.Config(app,host="127.0.0.1",port=port,log_level="warning",
                            access_log=False,timeout_graceful_shutdown=3))
    try:
        server.run(sockets=[sock])
    finally:
        sock.close()
        if ready and ready.exists():
            try:
                if json.loads(ready.read_text()).get("pid")==os.getpid():
                    ready.unlink()
            except (OSError,ValueError):
                pass

if __name__=="__main__":
    main()
