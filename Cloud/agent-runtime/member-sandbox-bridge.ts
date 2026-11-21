// Runs inside the private network namespace. The parent validates every target.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const tunnels = new Map(); let next = 0, processControl;
const send = value => { try { fs.writeSync(3, JSON.stringify(value) + '\n'); } catch {} };
const lines = createInterface({ input: new net.Socket({ fd: 4, readable: true, writable: false }) });
lines.on('line', line => { let m; try { m=JSON.parse(line); } catch { return; } if(m.type==='resize'){processControl?.write(JSON.stringify({cols:m.cols,rows:m.rows})+'\n');return;} const state=tunnels.get(m.id); if(!state)return;
  if(m.type==='open'){state.open=true;state.ready?.();}
  if(m.type==='data')state.socket.write(Buffer.from(m.data,'base64'));
  if(m.type==='close'){state.socket.destroy();tunnels.delete(m.id);}
});
function tunnel(socket, host, port, ready, initial) {
  const id=String(++next);const state={socket,ready,open:false};tunnels.set(id,state);
  socket.on('data',data=>send({type:'data',id,data:data.toString('base64')}));
  socket.on('error',()=>{});socket.on('close',()=>{send({type:'close',id});tunnels.delete(id);});
  send({type:'connect',id,host,port});if(initial?.length)send({type:'data',id,data:initial.toString('base64')});
}
const proxy=http.createServer((req,res)=>{
  let target;try{target=new URL(req.url || '/');}catch{res.writeHead(400).end();return;}
  if(target.protocol!=='http:'||target.username||target.password){res.writeHead(403).end();return;}
  // The HTTP response itself is relayed, so take ownership of the socket.
  const socket=req.socket;req.pause();
  const headers={...req.headers,host:target.host,connection:'close'};delete headers['proxy-connection'];delete headers['proxy-authorization'];
  const head=`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n`+Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n';
  const chunks: any[]=[];req.on('data',d=>chunks.push(d));req.on('end',()=>tunnel(socket,target.hostname,Number(target.port||80),null,Buffer.concat([Buffer.from(head),...chunks])));req.resume();
});
proxy.on('connect',(req,socket,head)=>{let url;try{url=new URL('https://'+req.url);}catch{socket.destroy();return;}
  tunnel(socket,url.hostname,Number(url.port||443),()=>socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'),head);
});
proxy.listen(0,'127.0.0.1',()=>{
  const address='http://127.0.0.1:'+(proxy.address() as any).port;
  const command=JSON.parse(process.argv[2]);
  const env={...process.env,HTTP_PROXY:address,HTTPS_PROXY:address,ALL_PROXY:address,http_proxy:address,https_proxy:address,all_proxy:address,NO_PROXY:'localhost,127.0.0.1',no_proxy:'localhost,127.0.0.1'};
  const interactive=command[0].endsWith('bash')&&command.includes('-i');
  const pythonPTY=String.raw`import os,pty,select,sys,json,struct,fcntl,termios,signal
command=json.loads(sys.argv[1])
pid,master=pty.fork()
if pid==0: os.execvpe(command[0],command,os.environ)
def resize(cols,rows):
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
resize(100,30)
control=b''
while True:
 ready,_,_=select.select([0,3,master],[],[])
 if master in ready:
  try: data=os.read(master,65536)
  except OSError: break
  if not data: break
  os.write(1,data)
 if 0 in ready:
  data=os.read(0,65536)
  if not data:
   try: os.kill(pid,signal.SIGHUP)
   except OSError: pass
   break
  os.write(master,data)
 if 3 in ready:
  data=os.read(3,4096)
  if not data: continue
  control+=data
  while b'\n' in control:
   line,control=control.split(b'\n',1)
   try:
    value=json.loads(line);cols=int(value['cols']);rows=int(value['rows'])
    if 20<=cols<=500 and 5<=rows<=200: resize(cols,rows)
   except Exception: pass
try:
 _,status=os.waitpid(pid,0)
 sys.exit(os.waitstatus_to_exitcode(status))
except ChildProcessError: pass
`;
  const child=interactive?spawn('/usr/bin/python3',['-u','-c',pythonPTY,JSON.stringify(command)],{env,stdio:['inherit','inherit','inherit','pipe']}):spawn(command[0],command.slice(1),{env,stdio:['inherit','inherit','inherit']});
  if(interactive){processControl=child.stdio[3];processControl.on('error',()=>{});}
  // Bound persistent storage even for shell writes bypassing the file API.
  // This is an execution watchdog; filesystem hard quotas are separate.
  let scanning=false;
  async function storageUsage(){let size=0,count=0;async function visit(dir){let entries;try{entries=await fs.promises.opendir(dir);}catch{return;}for await(const entry of entries){const file=dir+'/'+entry.name;try{const st=await fs.promises.lstat(file);if(st.isSymbolicLink())continue;count++;size+=st.size;if(size>2147483648||count>100000)throw new Error('quota');if(st.isDirectory())await visit(file);}catch(error){if((error as any).message==='quota')throw error;}}}await visit('/workspace');await visit('/home/member');}
  const quota=setInterval(async()=>{if(scanning)return;scanning=true;try{await storageUsage();}catch{process.stderr.write('隔离工作区超过存储配额，请清理文件后重试。\n');child.kill('SIGKILL');process.exit(122);}finally{scanning=false;}},500);quota.unref();
  child.on('error',()=>process.exit(126));child.on('exit',(code,signal)=>{send({type:'exit'});process.exit(code??(signal?128:1));});
  process.on('SIGTERM',()=>{child.kill('SIGTERM');setTimeout(()=>process.exit(143),1000).unref();});
});
