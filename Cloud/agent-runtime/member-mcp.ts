// Executed within the member namespace. Configurations and credentials belong
// to this workspace only; global/admin MCP servers are never inherited.
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
let chunks: Buffer[]=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
function decodeHTTP(text: any){let at=text.indexOf('\r\n\r\n');if(at<0)at=text.indexOf('\n\n');const header=text.slice(0,at),body=text.slice(at+(text[at]==='\r'?4:2));
 if(/^HTTP\/\S+ 200 Connection Established/i.test(header))return decodeHTTP(body);
 if(!/^HTTP\/\S+ 2\d\d/.test(header))throw new Error('MCP服务暂不可用');
 const session=header.match(/^mcp-session-id:\s*(.+)$/im)?.[1]?.trim();let value;
 try{value=JSON.parse(body);}catch{for(const line of body.split('\n'))if(line.startsWith('data:')){try{const next=JSON.parse(line.slice(5));if(next.id!==undefined)value=next;}catch{}}}
 return{value,session};
}
async function httpRequest(config: any,message: any,session?: any){return await new Promise<any>((resolve,reject)=>{
 const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(config.headers||{})};if(session)headers['Mcp-Session-Id']=session;
 const args=['--silent','--show-error','--include','--max-time','40','--request','POST'];for(const[k,v]of Object.entries(headers)){if(/[\r\n]/.test(k+v))return reject(new Error('MCP请求头无效'));args.push('--header',k+': '+v);}args.push('--data-binary','@-',config.url);
 const p=spawn('/usr/bin/curl',args,{stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>{out+=d;if(out.length>8*1024*1024)p.kill();});p.stderr.on('data',d=>{err+=d;});p.on('error',()=>reject(new Error('MCP连接失败')));p.on('close',code=>{try{if(code)throw new Error('MCP连接失败');resolve(decodeHTTP(out));}catch(e){reject(e);}});p.stdin.end(JSON.stringify(message));
 });}
async function callHTTP(config: any,request: any){const target=new URL(config.url);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('MCP网址无效');
 const init=await httpRequest(config,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'shiyan-member',version:'1.0'}}});
 if(init.value?.error)throw new Error('MCP初始化失败');
 // Stateless servers accept calls immediately; stateful servers receive their session.
 await httpRequest(config,{jsonrpc:'2.0',method:'notifications/initialized'},init.session).catch(()=>{});
 const result=await httpRequest(config,{jsonrpc:'2.0',id:2,...request},init.session);if(result.value?.error)throw new Error(String(result.value.error.message||'MCP调用失败'));return result.value?.result;
}
async function callStdio(config: any,request: any){return await new Promise<any>((resolve,reject)=>{
 if(typeof config.command!=='string'||!Array.isArray(config.args||[])||(config.args||[]).some((a: any)=>typeof a!=='string'))return reject(new Error('MCP命令配置无效'));
 const env={...process.env};for(const[k,v]of Object.entries(config.env||{}))if(typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))env[k]=v;
 const child=spawn(config.command,config.args||[],{env,stdio:['pipe','pipe','pipe']});const lines=createInterface({input:child.stdout});let finished=false,size=0;
 const finish=(error: any,result?: any)=>{if(finished)return;finished=true;clearTimeout(timer);lines.close();child.kill('SIGTERM');error?reject(error):resolve(result);};
 const timer=setTimeout(()=>finish(new Error('MCP工具执行超时')),45000);timer.unref();
 const send=(value: any)=>{if(!finished)child.stdin.write(JSON.stringify(value)+'\n');};
 child.on('error',()=>finish(new Error('MCP服务无法启动')));child.on('exit',()=>finish(new Error('MCP服务已退出')));child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
 lines.on('line',line=>{size+=line.length;if(size>8*1024*1024)return finish(new Error('MCP返回内容过大'));let message;try{message=JSON.parse(line);}catch{return;}
  if(message.id===1){if(message.error)return finish(new Error('MCP初始化失败'));send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,...request});}
  if(message.id===2)message.error?finish(new Error(String(message.error.message||'MCP工具调用失败'))):finish(null,message.result);
 });send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'shiyan-member',version:'1.0'}}});
 });}
try{
 const all=JSON.parse(await fs.readFile('/workspace/.shiyan/mcp.json','utf8').catch(error=>{if(error.code==='ENOENT')return '{"servers":{}}';throw error;}));const servers=all.servers||all.mcpServers||{};
 if(input.operation==='list_servers')console.log(JSON.stringify({servers:(Object.entries(servers) as [string, any][]).map(([name,c])=>({name,transport:c.url?'http':'stdio'}))}));
 else{const config=servers[input.server];if(!config||typeof config!=='object')throw new Error('当前账号尚未配置这个MCP服务器');const request=input.operation==='list_tools'?{method:'tools/list',params:{}}:{method:'tools/call',params:{name:input.name,arguments:input.arguments||{}}};const result=await(config.url?callHTTP(config,request):callStdio(config,request));console.log(JSON.stringify({result}));}
}catch(error){console.log(JSON.stringify({error:(error as any).message}));process.exitCode=1;}
