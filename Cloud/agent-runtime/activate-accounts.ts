// Finish the account rollout only after the task implementing it has returned.
// Restarting the runtime earlier would terminate that task and its client stream.
import { readFile, writeFile, stat, rename, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const run=promisify(execFile),sleep=(ms: any)=>new Promise(resolve=>setTimeout(resolve,ms));
const root=process.env.SHIYAN_ROOT||'/home/ubuntu/boss-codex-service/shiyan-v2';
const jobId=process.argv[2],manifest=process.argv[3];
if(!/^[a-f0-9-]{36}$/.test(jobId||'')||!manifest?.startsWith(root+'/workspaces/')||!manifest.endsWith('/.shiyan/changes/'+jobId+'.jsonl'))throw new Error('Invalid activation attribution');
const stateFile=path.join(root,'data/state.json');
let signature='',ready=false;
for(let attempt=0;attempt<5400;attempt++){
  const info=await stat(stateFile),current=info.mtimeMs+':'+info.size;
  if(current!==signature){
    signature=current;
    const state=JSON.parse(await readFile(stateFile,'utf8'));
    const job=state.jobs?.[jobId];
    const busy=(Object.values(state.jobs||{}) as any[]).some(value=>['queued','running'].includes(value.status));
    if(job?.status==='completed'&&!busy){
      const verified=await readFile(manifest+'.ready','utf8').catch(()=>'');
      if(verified.trim()===jobId){ready=true;break;}
    }
  }
  await sleep(2000);
}
if(!ready)throw new Error('Activation timed out; transition guard remains closed');
await sleep(3000);
await run('systemctl',['--user','restart','shiyan-runtime.service'],{timeout:60000});
let healthy=false;
for(let n=0;n<20;n++){
  try{const response=await fetch('http://127.0.0.1:4323/shiyan/v1/auth/status',{signal:AbortSignal.timeout(2000)});if(response.ok&&((await response.json()) as any).ok){healthy=true;break;}}catch{}
  await sleep(500);
}
if(!healthy)throw new Error('Updated runtime did not become healthy; transition guard remains closed');
const filename='/etc/nginx/conf.d/boss-codex.conf';
const before=await readFile(filename,'utf8');
const guard='        # SHIYAN_ACCOUNT_TRANSITION_GUARD\n        if ($http_authorization != "") { return 503; }\n';
if(!before.includes(guard))throw new Error('Expected transition guard missing');
const after=before.replace(guard,'');
const directory=await mkdtemp(path.join(os.tmpdir(),'shiyan-account-activate-'));
try{
  const candidate=path.join(directory,'nginx.conf');await writeFile(candidate,after,{mode:0o600});
  await run('sudo',['-n','install','-m','644',candidate,filename]);
  try{await run('sudo',['-n','nginx','-t']);await run('sudo',['-n','systemctl','reload','nginx']);}
  catch(error){await writeFile(candidate,before,{mode:0o600});await run('sudo',['-n','install','-m','644',candidate,filename]);throw error;}
  const snapshot=(text: any)=>({exists:true,text,sha256:createHash('sha256').update(text).digest('hex')});
  const record={version:1,jobId,deviceId:'device_c70716a1-23a5-494d-8cd9-eb7401d95539',path:filename,before:snapshot(before),after:snapshot(await readFile(filename,'utf8'))};
  const previous=await readFile(manifest,'utf8');
  await writeFile(manifest+'.activation',previous+JSON.stringify(record)+'\n',{mode:0o600});await rename(manifest+'.activation',manifest);
  console.log('Account rollout activated; runtime and ingress verified.');
}finally{await rm(directory,{recursive:true,force:true});}
