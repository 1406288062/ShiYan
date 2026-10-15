 
 
 
import base64
import hashlib
import json
import pathlib
import shlex
import subprocess

app = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', 'booted', 'com.shiyan.enhancer', 'data'], text=True).strip()
file = pathlib.Path(app) / 'Documents/shiyan-device-public.json'
record = json.loads(file.read_text())
key = base64.b64decode(record['publicKey'], validate=True)
assert len(key) == 32
assert hashlib.sha256(key).hexdigest() == record['deviceID']
remote = '''import json,pathlib,sys,os
record=json.load(sys.stdin)
p=pathlib.Path('/home/ubuntu/boss-codex-service/shiyan-v2/devices.json')
try: devices=json.loads(p.read_text())
except FileNotFoundError: devices={}
id=record['deviceID']
devices[id]={'id':id,'publicKey':record['publicKey'],'approved':True,'owner':'shiyan-private-owner','revoked':False}
tmp=p.with_suffix('.tmp')
tmp.write_text(json.dumps(devices));tmp.chmod(0o600);tmp.replace(p)
print('SIMULATOR_PUBLIC_KEY_APPROVED')
'''
result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'ubuntu@129.226.81.110', 'python3 -c ' + shlex.quote(remote)], input=json.dumps(record), text=True, check=True)
