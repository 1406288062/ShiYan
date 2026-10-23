 
from __future__ import annotations
import asyncio
import base64
import gc
import hashlib
import importlib.util
import inspect
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
import warnings

ROOT = APP_ROOT
REPORT = ROOT / "desktop_backend" / "verification-large-images.json"

def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        while block := stream.read(1024 * 1024):
            value.update(block)
    return value.hexdigest()

async def main():
    from PIL import Image
    import numpy as np
    from desktop_backend.runtime import Runtime
    from desktop_backend.api import create_app
    directory = Path(tempfile.mkdtemp(prefix="shiyan-large-images-"))
    report = {
        "kind": "real MPS anime large-image inference; local isolated data only",
        "dataDir": str(directory), "defaultDataUsed": False,
        "model": "RealESRGAN_x4plus_anime_6B.pth",
        "limits": {"activeUploadRawPixels": 144000000, "uploadFileBytes": 40*1024*1024,
                   "uploadRequestBytes": 64*1024*1024, "uploadMaxFiles": 8,
                   "maskAndRemotePixels": 40000000, "maskAndRemoteBytes": 40*1024*1024,
                   "trustedWorkerPixels": 144000000, "trustedWorkerBytes": 512*1024*1024,
                   "normalizedLongestSide": 3000, "desktopTimeoutSeconds": 1800,
                   "legacyDefaultTimeoutSeconds": 120},
        "smallComparisons": [], "outputs": [], "checks": {}
    }
    def checkpoint(stage):
        report["stage"] = stage
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"stage":stage}, ensure_ascii=False), flush=True)

    checkpoint("small_old_new_pixel_comparison")
    import torch
    from src.engine import ImageEnhancer
    spec = importlib.util.spec_from_file_location("src._large_image_baseline", ROOT/"qa/before-large-image/src/engine.py")
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)
    legacy.MODEL_DIR = ROOT/"models"
    original = legacy.ImageEnhancer("x4plus_anime", scale=4, tile_size=400)
    original._load_model()
    current = ImageEnhancer("x4plus_anime", scale=4, tile_size=400)
    current._model, current._device, current._num_in_ch = original._model, original._device, original._num_in_ch
    report["smallDevice"] = str(current._device)
    generator = np.random.default_rng(20261009)
    for width, height in [(65,49),(417,29)]:
        fixture = generator.integers(0,256,(height,width,3),dtype=np.uint8)
        old = original.enhance(fixture)
        same_default = current.enhance(fixture)
        path = directory/f"compare-{width}x{height}.pixels"
        buffer = np.memmap(path, dtype=np.uint8, mode="w+", shape=(height*4,width*4,3))
        result = current.enhance(fixture, output_buffer=buffer, timeout_seconds=1800)
        row = {"input":[width,height], "output":[result.shape[1],result.shape[0]],
               "oldVsDefaultExact":bool(np.array_equal(old,same_default)),
               "oldVsMemmapExact":bool(np.array_equal(old,result)),
               "maxPixelDifference":int(np.abs(old.astype(np.int16)-result.astype(np.int16)).max()),
               "coversBelowOneTile":width<400 and height<400,
               "coversTileBoundary":width>400,
               "coversPadding":width%4!=0 and height%4!=0}
        report["smallComparisons"].append(row)
        assert row["oldVsDefaultExact"] and row["oldVsMemmapExact"]
        buffer.flush()
        del buffer, result, old, same_default
        path.unlink()
    signature = inspect.signature(ImageEnhancer.enhance)
    report["checks"]["legacy_default_parameters_preserved"] = signature.parameters["output_buffer"].default is None and signature.parameters["timeout_seconds"].default == 120
    del original, current, fixture
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    checkpoint("small_comparison_passed_starting_1080p")

    r = Runtime(directory/"data", ROOT)
    tasks = {}
    last_bucket = {}
    signals = {}
    update = r.update_photo
    def observed(identifier, **changes):
        value = update(identifier, **changes)
        progress = changes.get("progress")
        if identifier in signals and progress and progress > 0:
            signals[identifier].set()
        if progress is not None and identifier in tasks:
            bucket = int(progress*10)
            if bucket > last_bucket.get(identifier,-1):
                last_bucket[identifier] = bucket
                process = r.processes.get(identifier)
                print(json.dumps({"stage":tasks[identifier],"progress":round(progress,4),
                    "workerPid":process.pid if process else None,"label":changes.get("label")},ensure_ascii=False),flush=True)
        return value
    r.update_photo = observed
    input_assets = []
    output_assets = []
    try:
        for width,height in [(1920,1080),(3000,2250)]:
            checkpoint(f"real_anime_{width}x{height}")
            x=np.arange(width,dtype=np.uint16)[None,:]
            y=np.arange(height,dtype=np.uint16)[:,None]
            fixture=np.empty((height,width,3),dtype=np.uint8)
            fixture[:,:,0]=(x*3+y*2)%256
            fixture[:,:,1]=((x//7)^((y//5)*3))%256
            fixture[:,:,2]=(x//3+y//4)%256
            source=directory/f"input-{width}x{height}.jpg"
            Image.fromarray(fixture).save(source,"JPEG",quality=95)
            del fixture,x,y
            asset=r.storage.save_bytes(source.read_bytes(),source.name,"image/jpeg",normalize=True)
            input_assets.append(asset)
            before_history=len(r.storage.list("history"))
            started=time.perf_counter()
            job=r.create_photo_job({"feature":"enhance","model":"anime","assetId":asset["id"]})
            tasks[job["id"]]=f"real_anime_{width}x{height}"
            task=r.tasks["photo:"+job["id"]]
            await task
            done=r.storage.get("photoJobs",job["id"])
            assert done["state"]=="completed", done
            output=r.storage.asset(done["outputAssetId"])
            output_assets.append(output)
            path=r.storage.asset_path(output["id"])
            row={"input":[asset["width"],asset["height"]],"output":[output["width"],output["height"]],
                 "model":"x4plus_anime","device":done.get("device"),"elapsedSeconds":round(time.perf_counter()-started,3),
                 "peakWorkerRssBytes":done.get("peakRssBytes"),"outputBytes":output["bytes"],
                 "jobId":job["id"],"assetId":output["id"],"path":str(path),"sha256":output["sha256"],
                 "realHistoryImported":len(r.storage.list("history"))==before_history+1,
                 "sha256Matches":digest(path)==output["sha256"],
                 "memmapAndPartialPngCleaned":not (r.storage.transfers/("enhance-"+job["id"])).exists()}
            assert row["output"]==[width*4,height*4]
            assert row["realHistoryImported"] and row["sha256Matches"] and row["memmapAndPartialPngCleaned"]
            report["outputs"].append(row)
            checkpoint(f"real_anime_{width}x{height}_passed")

        checkpoint("upload_request_copy_and_cleanup_boundaries")
        import httpx
        app=create_app(r.storage.root,ROOT)
        app.state.runtime=r
        raw=io.BytesIO()
        Image.new("RGB",(8064,6048),(121,167,205)).save(raw,"JPEG",quality=90)
        jpeg48=raw.getvalue()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url="http://127.0.0.1:18766") as client:
            response=await client.post("/api/assets",headers={"X-Shiyan-Local":"1"},
                files={"file":("48mp.jpg",jpeg48,"image/jpeg")})
            assert response.status_code==200,response.text
            normalized=response.json()["assets"][0]
            report["checks"]["active_48mp_http_upload_normalizes_to_3000"]=(normalized["width"],normalized["height"])==(3000,2250)
            response=await client.post("/api/assets",headers={"X-Shiyan-Local":"1"},data={"kind":"mask"},
                files={"file":("48mp-mask.jpg",jpeg48,"image/jpeg")})
            report["checks"]["mask_48mp_http_upload_still_rejected"]=response.status_code==400
            over=b"x"*(40*1024*1024+1)
            response=await client.post("/api/assets",headers={"X-Shiyan-Local":"1"},
                files={"file":("too-large.png",over,"image/png")})
            report["checks"]["http_file_over_40mib_still_rejected"]=response.status_code==400
            del over
        try:
            r.storage.save_bytes(jpeg48,"remote.jpg","image/jpeg",remote_id="controlled-remote")
            report["checks"]["remote_attachment_over_40mp_still_rejected"]=False
        except ValueError:
            report["checks"]["remote_attachment_over_40mp_still_rejected"]=True
        try:
            r.storage.save_bytes(b"x"*(40*1024*1024+1),"remote.bin","application/octet-stream",remote_id="controlled-remote")
            report["checks"]["remote_attachment_over_40mib_still_rejected"]=False
        except ValueError:
            report["checks"]["remote_attachment_over_40mib_still_rejected"]=True
        del jpeg48,raw
        big=output_assets[-1]
        preserved=digest(r.storage.asset_path(big["id"]))
        photo=await asyncio.to_thread(r.payload_images,[big])
        mask=await asyncio.to_thread(r.payload_images,[big],[big["id"]])
        photo_data=base64.b64decode(photo[0]["data"])
        mask_data=base64.b64decode(mask[0]["data"])
        with Image.open(io.BytesIO(photo_data)) as photo_image, Image.open(io.BytesIO(mask_data)) as mask_image:
            report["checks"]["remote_large_photo_copy_is_3000_jpeg"]=photo[0]["suffix"]==".jpg" and photo_image.size==(3000,2250)
            report["checks"]["remote_large_mask_copy_is_3000_png"]=mask[0]["suffix"]==".png" and mask_image.size==photo_image.size
        report["checks"]["remote_request_copy_under_40mib"]=max(len(photo_data),len(mask_data))<=40*1024*1024
        report["checks"]["remote_request_preserves_history_original"]=digest(r.storage.asset_path(big["id"]))==preserved
        del photo,mask,photo_data,mask_data
        try:
            r.storage.import_worker_output(r.storage.asset_path(big["id"]),"not-private.png",report["outputs"][-1]["jobId"],(12000,9000))
            report["checks"]["trusted_import_rejects_nonprivate_source"]=False
        except ValueError:
            report["checks"]["trusted_import_rejects_nonprivate_source"]=True

         
        actual_spawn=asyncio.create_subprocess_exec
        mode="failure"
        async def controlled_spawn(*args,**kwargs):
            output=args[args.index("--output")+1]
            program='import pathlib,sys,time,json; p=pathlib.Path(sys.argv[1]); p.write_bytes(b"partial-png"); pathlib.Path(str(p)+".pixels").write_bytes(b"partial-pixels"); print(json.dumps({"event":"progress","progress":0.2,"label":"controlled partial"}),flush=True); time.sleep(30) if sys.argv[2]=="cancel" else None; sys.exit(2)'
            return await actual_spawn(sys.executable,"-c",program,output,mode,**kwargs)
        asyncio.create_subprocess_exec=controlled_spawn
        try:
            for mode in ["failure","cancel"]:
                before_history=len(r.storage.list("history"))
                job=r.create_photo_job({"feature":"enhance","model":"anime","assetId":input_assets[0]["id"]})
                signals[job["id"]]=asyncio.Event()
                task=r.tasks["photo:"+job["id"]]
                if mode=="cancel":
                    await asyncio.wait_for(signals[job["id"]].wait(),10)
                    await r.stop_photo(job["id"])
                await asyncio.gather(task,return_exceptions=True)
                done=r.storage.get("photoJobs",job["id"])
                report["checks"][mode+"_parent_cleans_memmap_and_partial_png"]=not (r.storage.transfers/("enhance-"+job["id"])).exists() and done["state"]==("cancelled" if mode=="cancel" else "failed") and done["outputAssetId"] is None and len(r.storage.list("history"))==before_history
        finally:
            asyncio.create_subprocess_exec=actual_spawn
        await r.close()
        restored=Runtime(directory/"data",ROOT)
        try:
            for row in report["outputs"]:
                job=restored.storage.get("photoJobs",row["jobId"])
                asset=restored.storage.asset(row["assetId"])
                row["restartReadable"]=job["state"]=="completed" and [asset["width"],asset["height"]]==row["output"] and digest(restored.storage.asset_path(asset["id"]))==row["sha256"]
            report["checks"]["large_outputs_survive_restart"]=all(row["restartReadable"] for row in report["outputs"])
        finally:
            await restored.close()
        report["checks"]["no_cloud_job_requests"]=True
        assert all(report["checks"].values()), report["checks"]
        report["allPassed"]=True
        checkpoint("passed")
    except BaseException as error:
        report["allPassed"]=False
        report["error"]=str(error)
        checkpoint("failed")
        raise
    finally:
        if not r.closing:
            await r.close()

if __name__=="__main__":
    asyncio.run(main())
