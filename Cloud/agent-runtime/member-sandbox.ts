// Ordinary accounts execute in a mount/PID/network namespace, never the host.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT=process.env.SHIYAN_MEMBER_SANDBOX_ROOT||path.join(ROOT,'data','member-workspaces');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const activeByOwner=new Map(),ownerLimits=new Map();
const execFileAsync=promisify(execFile);
const resourceEnvironment={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',XDG_RUNTIME_DIR:'/run/user/'+(process.getuid?.() ?? 0),DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/'+(process.getuid?.() ?? 0)+'/bus'};
async function ownerResourceSlice(owner){
 const slice='shiyan-member-'+crypto.createHash('sha256').update(owner).digest('hex').slice(0,24)+'.slice';
 if(!ownerLimits.has(slice))ownerLimits.set(slice,execFileAsync('/usr/bin/systemctl',['--user','set-property','--runtime',slice,'MemoryMax=1073741824','TasksMax=128','CPUQuota=100%'],{env:resourceEnvironment,timeout:10000,maxBuffer:8192}).catch(()=>{ownerLimits.delete(slice);throw fail('隔离资源控制暂不可用',503);}));
 await ownerLimits.get(slice);return slice;
}
export function virtualWorkspacePath(value='/workspace'){
 if(typeof value!=='string'||value.includes('\0'))throw fail('工作区路径无效');
 const out=path.posix.resolve('/workspace',value);if(out!=='/workspace'&&!out.startsWith('/workspace/'))throw fail('只能访问自己的工作区',403);return out;
}
export function memberWorkspaceHostPath(owner,{root=DEFAULT_ROOT}={}){
 if(typeof owner!=='string'||!owner.trim()||owner.length>512)throw fail('用户身份无效',403);
 return path.join(root,crypto.createHash('sha256').update(owner).digest('hex'),'workspace');
}
export async function ensureOwnerSandbox(owner,options={}){
 const workspace=memberWorkspaceHostPath(owner,options),base=path.dirname(workspace),home=path.join(base,'home');
 await fs.mkdir(workspace,{recursive:true,mode:0o700});await fs.mkdir(home,{recursive:true,mode:0o700});
 // These directories are only mounted into this account's namespace.
 for(const dir of [base,workspace,home])await fs.chmod(dir,0o700);
 return{workspace,home};
}
const blockedPublic=new Set(['129.226.81.110',...Object.values(os.networkInterfaces()).flatMap(v=>v??[]).map(a=>a.address)]);
export function isPublicSandboxAddress(address){
 address=String(address).replace(/^\[|\]$/g,'').toLowerCase();
 if(address.startsWith('::ffff:'))return isPublicSandboxAddress(address.slice(7));
 if(blockedPublic.has(address))return false;
 if(net.isIP(address)===4){const n=address.split('.').map(Number);return !(n[0]===0||n[0]===10||n[0]===127||n[0]>=224||(n[0]===100&&n[1]>=64&&n[1]<=127)||(n[0]===169&&n[1]===254)||(n[0]===172&&n[1]>=16&&n[1]<=31)||(n[0]===192&&(n[1]===168||n[1]===0))||(n[0]===198&&(n[1]===18||n[1]===19||(n[1]===51&&n[2]===100)))||(n[0]===203&&n[1]===0&&n[2]===113));}
 if(net.isIP(address)===6){const first=parseInt(address.split(':')[0],16);return first>=0x2000&&first<=0x3fff&&!address.startsWith('2001:db8:')&&!address.startsWith('2001:0:')&&!address.startsWith('2002:');}
 return false;
}
export async function resolveSandboxDestination(host,{lookup=dns.lookup}={}){
 if(typeof host!=='string'||host.length>253)throw fail('网络目标不可访问',403);
 host=host.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
 if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host==='metadata.tencentyun.com')throw fail('网络目标不可访问',403);
 const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await lookup(host,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(a=>!isPublicSandboxAddress(a.address)))throw fail('网络目标不可访问',403);
 return addresses[0]; // Pin the checked address: no second DNS lookup during connect.
}
function networkBroker(child){
 const sockets=new Map();let total=0,closed=false;child.stdio[4].on('error',()=>{});
 const send=m=>{if(!closed&&!child.stdio[4].destroyed)child.stdio[4].write(JSON.stringify(m)+'\n');};
 const lines=createInterface({input:child.stdio[3]});
 lines.on('line',async line=>{if(line.length>256*1024)return child.kill('SIGKILL');let m;try{m=JSON.parse(line);}catch{return;}
  if(typeof m.id!=='string'||m.id.length>32)return;
  if(m.type==='connect'){
   if(sockets.size>=32||sockets.has(m.id)||!Number.isInteger(m.port)||![22,80,443,9418,8080,8443].includes(m.port)){send({type:'close',id:m.id});return;}
   const state: {socket: net.Socket | null; pending: Buffer[]; bytes: number}={socket:null,pending:[],bytes:0};sockets.set(m.id,state);
   try{const address=await resolveSandboxDestination(m.host);if(closed||sockets.get(m.id)!==state)return;const socket=net.connect({host:address.address,family:address.family,port:m.port});state.socket=socket;socket.setTimeout(30000);
    socket.on('connect',()=>{send({type:'open',id:m.id});for(const data of state.pending)socket.write(data);state.pending=[];});
    socket.on('data',data=>{total+=data.length;if(total>128*1024*1024){socket.destroy();return;}send({type:'data',id:m.id,data:data.toString('base64')});});
    const end=()=>{sockets.delete(m.id);send({type:'close',id:m.id});};socket.on('error',end);socket.on('close',end);socket.on('timeout',()=>socket.destroy());
   }catch{sockets.delete(m.id);send({type:'close',id:m.id});}
  }else if(m.type==='data'){
   const state=sockets.get(m.id);if(!state||typeof m.data!=='string'||m.data.length>200000)return;const data=Buffer.from(m.data,'base64');total+=data.length;state.bytes+=data.length;
   if(total>128*1024*1024||state.bytes>64*1024*1024){state.socket?.destroy();sockets.delete(m.id);send({type:'close',id:m.id});return;}
   if(state.socket?.writable)state.socket.write(data);else if(state.pending.length<32)state.pending.push(data);
  }else if(m.type==='close'){sockets.get(m.id)?.socket?.destroy();sockets.delete(m.id);}
 });
 const close=()=>{closed=true;lines.close();for(const state of sockets.values())state.socket?.destroy();sockets.clear();};child.once('close',close);return {close,send};
}
// The returned ChildProcess has normal stdin/stdout/stderr for persistent terminals.
// No host environment, secrets, sockets, network namespace, /home or /proc is inherited.
export async function spawnSandbox(owner,{command=['/bin/bash','--noprofile','--norc'],cwd='/workspace',signal,root,timeoutMs=120000,maxProcesses=16}: {command?: string | string[]; cwd?: string; signal?: AbortSignal; root?: string; timeoutMs?: number; maxProcesses?: number}={}){
 cwd=virtualWorkspacePath(cwd);if(typeof command==='string')command=['/bin/bash','--noprofile','--norc','-c',command];
 if(!Array.isArray(command)||!command.length||command.some(v=>typeof v!=='string'||v.includes('\0')))throw fail('执行参数无效');
 const active=activeByOwner.get(owner)||0;if(active>=maxProcesses)throw fail('当前工作区执行较多，请稍后重试',429);
 activeByOwner.set(owner,active+1);let workspace,home,slice;try{({workspace,home}=await ensureOwnerSandbox(owner,{root}));slice=await ownerResourceSlice(owner);}catch(error){activeByOwner.set(owner,Math.max(0,(activeByOwner.get(owner)||1)-1));throw error;}
 const args=['--unshare-all','--unshare-user','--disable-userns','--die-with-parent','--new-session','--cap-drop','ALL','--hostname','workspace','--clearenv',
 '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
 '--dir','/etc','--ro-bind','/etc/ssl/certs','/etc/ssl/certs','--dir','/opt','--dir','/opt/shiyan',
 '--ro-bind',path.join(ROOT,'member-sandbox-bridge.ts'),'/opt/shiyan/bridge.ts',
 '--ro-bind',path.join(ROOT,'member-workspace-ops.ts'),'/opt/shiyan/workspace-ops.ts',
 '--ro-bind',path.join(ROOT,'member-mcp.ts'),'/opt/shiyan/mcp.ts',
 '--dir','/home','--bind',home,'/home/member','--bind',workspace,'/workspace',
 '--tmpfs','/tmp','--dir','/proc','--dir','/sys','--dev','/dev',
 '--setenv','HOME','/home/member','--setenv','USER','member','--setenv','LOGNAME','member','--setenv','PATH','/home/member/.local/bin:/workspace/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
 '--setenv','LANG','C.UTF-8','--setenv','TERM','xterm-256color','--setenv','SSL_CERT_FILE','/etc/ssl/certs/ca-certificates.crt',
 '--setenv','NODE_OPTIONS','--max-old-space-size=256 --disable-wasm-trap-handler --use-env-proxy','--setenv','GIT_CONFIG_NOSYSTEM','1','--setenv','PYTHONDONTWRITEBYTECODE','1','--chdir',cwd,
 '--','/usr/bin/node','/opt/shiyan/bridge.ts',JSON.stringify(command)];
 let child;try{child=spawn('/usr/bin/systemd-run',['--user','--scope','--quiet','--collect','--unit','shiyan-member-run-'+crypto.randomUUID(),'--slice',slice,'--property','MemoryMax=805306368','--property','TasksMax=64','/usr/bin/prlimit','--as=17179869184','--nproc=1024','--fsize=134217728','--nofile=512','--cpu=120','--','/usr/bin/bwrap',...args],{env:resourceEnvironment,stdio:['pipe','pipe','pipe','pipe','pipe']});}catch(error){activeByOwner.set(owner,active);throw fail('隔离执行环境不可用',503);}
 const broker=networkBroker(child);child.resize=(cols,rows)=>broker.send({type:'resize',cols,rows});let timer;
 if(timeoutMs>0){timer=setTimeout(()=>child.kill('SIGKILL'),Math.min(timeoutMs,30*60*1000));timer.unref();}
 const abort=()=>child.kill('SIGKILL');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 child.once('close',()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);activeByOwner.set(owner,Math.max(0,(activeByOwner.get(owner)||1)-1));});
 return child;
}
export async function execSandbox(owner,{command,cwd,timeoutMs=120000,signal,input='',root,maxOutput=2*1024*1024,onStdout,onStderr}: {command?: string | string[]; cwd?: string; timeoutMs?: number; signal?: AbortSignal; input?: string; root?: string; maxOutput?: number; onStdout?: (text: string) => void; onStderr?: (text: string) => void}={}){
 const child=await spawnSandbox(owner,{command,cwd,timeoutMs,signal,root});let stdout='',stderr='',count=0;const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
 return await new Promise<{stdout: string; stderr: string; exitCode: number; signal: string | null; truncated: boolean}>((resolve,reject)=>{
  child.on('error',()=>reject(fail('隔离执行环境不可用',503)));
  for(const[key,stream,callback]of[['stdout',child.stdout,onStdout],['stderr',child.stderr,onStderr]])stream.on('data',data=>{count+=data.length;if(count>maxOutput){child.kill('SIGKILL');return;}const text=decoders[key].write(data);if(key==='stdout')stdout+=text;else stderr+=text;callback?.(text);});
  child.on('close',(exitCode,exitSignal)=>{stdout+=decoders.stdout.end();stderr+=decoders.stderr.end();if(signal?.aborted)return reject(signal.reason||fail('执行已停止'));resolve({stdout,stderr,exitCode:exitCode??1,signal:exitSignal||null,truncated:count>maxOutput});});
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
export async function workspaceOperation(owner,input,{signal,root}: {signal?: AbortSignal; root?: string}={}){
 virtualWorkspacePath(input?.path);const result=await execSandbox(owner,{command:['/usr/bin/node','/opt/shiyan/workspace-ops.ts'],input:JSON.stringify(input),signal,root,maxOutput:24*1024*1024});
 let value;try{value=JSON.parse(result.stdout);}catch{throw fail('隔离工作区暂不可用',503);}
 if(result.exitCode!==0||value.error)throw fail(value.error||'工作区操作失败',value.error==='文件或目录不存在'?404:400);return value;
}
export { runIsolatedJob, mcpSandboxOperation, MEMBER_AGENT_TOOLS, collectSandboxArtifacts } from './member-agent.ts';
