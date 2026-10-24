"""Content-free enhancement phase diagnostics; never part of task correctness."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import math
import os
import re
import time

STAGES = frozenset({'upload','mac_download','model_load','gpu_inference','result_encode','mac_upload','web_download','task_link'})
IDENTIFIERS = ('taskId','photoJobId','requestId','assetId','outputAssetId','attemptId','scopeId')
NUMBERS = ('durationMs','startedAtMs','endedAtMs','bytes','transferBytes','width','height','receiveMs','processMs')

def timing_event(stage, status, **fields):
    """Allowlist values so errors, paths, image content and credentials cannot leak."""
    if stage not in STAGES or status not in {'started','completed','failed','linked','cancelled'}:
        raise ValueError('Invalid enhancement timing event')
    event = {'event':'enhancement_timing','stage':stage,'status':status,
             'at':datetime.now(timezone.utc).isoformat(timespec='milliseconds')}
    task = fields.get('taskId') or os.environ.get('SHIYAN_ENHANCEMENT_TASK_ID')
    if task: fields['taskId'] = task
    for key in IDENTIFIERS:
        value=fields.get(key)
        if isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',value):event[key]=value
    for key in NUMBERS:
        value=fields.get(key)
        if isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>=0:event[key]=round(value,3)
    for key, allowed in {'source':{'browser','mac','server','engine'},'device':{'mps','cpu','cuda'},'cacheStatus':{'cache','network','cache_or_unreported'},'errorType':{'CancelledError','KeyboardInterrupt','Exception'}}.items():
        if fields.get(key) in allowed:event[key]=fields[key]
    return event

def emit_timing(stage, status, **fields):
    try:print(json.dumps(timing_event(stage,status,**fields),ensure_ascii=False,separators=(',',':')),flush=True)
    except Exception:pass  # Broken log output must not change an image result.

@contextmanager
def timed_stage(stage, **fields):
    start=time.perf_counter(); started=time.time()*1000
    emit_timing(stage,'started',startedAtMs=started,**fields)
    try:yield
    except BaseException as exc:
        emit_timing(stage,'cancelled' if isinstance(exc,KeyboardInterrupt) else 'failed',
                    startedAtMs=started,endedAtMs=time.time()*1000,durationMs=(time.perf_counter()-start)*1000,
                    errorType='KeyboardInterrupt' if isinstance(exc,KeyboardInterrupt) else 'Exception',**fields)
        raise
    else:emit_timing(stage,'completed',startedAtMs=started,endedAtMs=time.time()*1000,durationMs=(time.perf_counter()-start)*1000,**fields)

def browser_timing(data, storage):
    """Validate telemetry against the current account's storage, never host paths."""
    if not isinstance(data.get('stage'),str) or not isinstance(data.get('status'),str) or data.get('stage') not in {'upload','web_download'} or data.get('status') not in {'completed','failed'}:
        raise ValueError('Invalid browser timing stage')
    for key in ('durationMs','startedAtMs','endedAtMs'):
        value=data.get(key)
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or value<0:
            raise ValueError('Invalid browser timing value')
    if data['durationMs']>86_400_000:raise ValueError('Invalid browser timing duration')
    for key in IDENTIFIERS:
        if key in data and (not isinstance(data[key],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',data[key])):
            raise ValueError('Invalid timing identifier')
    asset=data.get('assetId');job_id=data.get('photoJobId')
    if asset:storage.asset(asset)  # Account-scoped lookup; unknown/foreign assets fail closed.
    if data['stage']=='web_download':
        job=storage.get('photoJobs',job_id)
        if not job or job.get('feature')!='enhance' or job.get('outputAssetId')!=asset or not asset:
            raise ValueError('Invalid enhancement result reference')
    elif not asset and (data['status']!='failed' or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',str(data.get('attemptId','')))):
        raise ValueError('Invalid upload reference')
    fields={key:data[key] for key in (*IDENTIFIERS,*NUMBERS,'cacheStatus') if key in data and key not in {'scopeId','taskId','requestId','outputAssetId'}}
    if job_id:
        job=storage.get('photoJobs',job_id)
        if not job:raise ValueError('Unknown photo task')
        fields.update(taskId=job.get('remoteTaskId'),requestId=job.get('requestId'))
    return fields
