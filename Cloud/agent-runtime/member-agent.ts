// Full ordinary-account agent: inference credentials stay in this transport,
// local tools run in that account's OS namespace; managed MCP calls use the
// authenticated account and the remote device's own permissions.
import crypto from 'node:crypto';
import path from 'node:path';
import { memberProvider, refreshMemberProvider } from './member-chat.ts';
import { execSandbox, workspaceOperation, virtualWorkspacePath } from './member-sandbox.ts';
import { textFileChange } from './text-file-diff.ts';
import { createSpongeMcpAdapter } from './sponge-client.ts';
import { mcpConnectors } from './mcp-connectors.ts';
const unavailable=()=>Object.assign(new Error('AI服务暂不可用，请稍后重试'),{status:503});
const fn=(name: any,description: any,properties: any,required: string[]=[])=>({type:'function',name,description,parameters:{type:'object',properties,required,additionalProperties:false},strict:false});
const str={type:'string'},obj={type:'object',additionalProperties:true};
export const MEMBER_AGENT_TOOLS=[
 fn('exec_command','在当前用户的隔离工作区运行真实终端命令。支持代码、git、文件和公开网络；无法访问宿主、其他账号或内网。网络工具使用HTTP_PROXY/HTTPS_PROXY。',{command:str,cwd:str,timeout_ms:{type:'integer',minimum:1000,maximum:120000}},['command']),
 fn('read_file','读取当前账号授权工作区中的文件。返回UTF-8文本及base64。',{path:str},['path']),
 fn('write_file','创建或替换当前账号工作区内的文本文件。',{path:str,content:str},['path','content']),
 fn('list_files','列出当前账号工作区目录。',{path:str}),
 fn('mcp_list_servers','列出当前账号可用的MCP服务器，包括设置中连接的海绵宝宝（sponge）。访问设备前继续查询工具列表，不能仅凭服务器名称判断没有访问能力。',{}),
 fn('mcp_list_tools','获取当前账号MCP服务器公布的实际工具及参数。海绵宝宝使用 server=sponge，可发现当前账号绑定设备的文件、终端等工具。',{server:str},['server']),
 fn('mcp_call_tool','调用当前账号的MCP工具。海绵宝宝可按用户授权访问该账号绑定的远程设备；设备路径使用远程工具处理。先查询工具schema再传参。',{server:str,name:str,arguments:obj},['server','name','arguments']),
];
export async function mcpSandboxOperation(owner: any,input: any,{signal,root}: {signal?: AbortSignal; root?: string}={}){
 const result=await execSandbox(owner,{command:['/usr/bin/node','/opt/shiyan/mcp.mjs'],input:JSON.stringify(input),signal,root,timeoutMs:60000,maxOutput:8*1024*1024});
 let value;try{value=JSON.parse(result.stdout);}catch{throw new Error('MCP服务返回无效结果');}if(value.error)throw new Error(value.error);return value;
}
const spongeMcpOperation = createSpongeMcpAdapter({ sandboxOperation: mcpSandboxOperation });
// 连接器里绑定的 MCP（常用插件 / 自定义）由服务器带凭据直接调用，凭据不进沙箱。
async function memberMcpOperation(owner: any, input: any, options = {}) {
 const connectors = mcpConnectors();
 if (input.operation === 'list_servers') {
  const base = await spongeMcpOperation(owner, input, options);
  const bound = (await connectors.runtimeServers(owner).catch(() => [])).map((c: any) => ({ name: c.id, title: c.name, transport: 'connector', tools: c.tools?.length || undefined }));
  return { ...base, servers: [...(base.servers || []).filter((s: any) => !bound.some((b: any) => b.name === s.name)), ...bound] };
 }
 if (input.server && connectors.has(owner, input.server)) {
  if (input.operation === 'list_tools') return { result: await connectors.call(owner, input.server, 'tools/list', {}) };
  if (input.operation === 'call_tool') return { result: await connectors.call(owner, input.server, 'tools/call', { name: String(input.name || ''), arguments: input.arguments || {} }) };
 }
 return spongeMcpOperation(owner, input, options);
}
async function responseStream(request: any,{signal,fetchImpl,getProvider,refreshProvider,onText,onActivity}: any){
 const send=async()=>{const target=await getProvider();return await fetchImpl(target.url,{method:'POST',headers:target.headers,body:JSON.stringify(request),signal});};
 let response=await send();if(response.status===401&&!signal?.aborted){await response.body?.cancel();await refreshProvider();response=await send();}
 if(!response.ok||!response.body)throw unavailable();const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',text='',completed,output: any[]=[],size=0;
 function consume(line: any){if(!line.startsWith('data:')||line.slice(5).trim()==='[DONE]')return;let event;try{event=JSON.parse(line.slice(5));}catch{throw unavailable();}onActivity?.();
  if(['error','response.failed','response.incomplete'].includes(event.type))throw unavailable();
  if(event.type==='response.output_text.delta'){text+=event.delta||'';if(text.length>1024*1024)throw unavailable();onText?.(text);}
  if(event.type==='response.output_item.done'&&event.item)output.push(event.item);
  if(['response.completed','response.done'].includes(event.type)){if(event.response?.status!=='completed')throw unavailable();completed=event.response;if(Array.isArray(completed.output))output=completed.output;}
 }
 try{while(true){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>24*1024*1024)throw unavailable();buffer+=decoder.decode(value,{stream:true});let at;while((at=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,at).replace(/\r$/,''));buffer=buffer.slice(at+1);}}buffer+=decoder.decode();if(buffer.trim())consume(buffer.trim());if(!completed)throw unavailable();
  if(!text)text=output.filter(i=>i.type==='message').flatMap(i=>i.content||[]).filter(i=>i.type==='output_text').map(i=>i.text||'').join('\n');
  return{text,output,usage:(completed as any).usage||null};
 }finally{await reader.cancel().catch(()=>{});}
}
export async function collectSandboxArtifacts(owner: any,{text='',paths=[],signal,root}: {text?: string; paths?: string[]; signal?: AbortSignal; root?: string}={}){
 const candidates=new Set(paths);
 for(const match of text.matchAll(/\]\((?:sandbox:)?(\/workspace\/[^\s)]+)\)/g))candidates.add(match[1]);
 const artifacts: Array<{path: string; filename: string; mimeType: string; bytes: number; sha256: string; data: any}> = [];let total=0;
 const mimeFor=(ext: any)=>(({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.html':'text/html','.zip':'application/zip','.mp3':'audio/mpeg','.wav':'audio/wav','.mp4':'video/mp4'} as any)[ext]||'application/octet-stream');
 for(const candidate of candidates){if(artifacts.length>=10)break;let file;try{file=virtualWorkspacePath(decodeURIComponent(candidate));}catch{continue;}
  const relative=file.slice('/workspace/'.length),base=path.posix.basename(file),ext=path.posix.extname(base).toLowerCase();
  if(relative.split('/').some(p=>p.startsWith('.'))||relative.startsWith('inputs/')||['.pem','.key','.cer','.env'].includes(ext)||/credentials|secret|token|auth\.json/i.test(base))continue;
  try{const value=await workspaceOperation(owner,{operation:'read',path:file},{signal,root});const bytes=Buffer.from(value.data,'base64');if(!bytes.length||total+bytes.length>32*1024*1024)continue;total+=bytes.length;artifacts.push({path:file,filename:base,mimeType:mimeFor(ext),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),data:value.data});}catch{if(signal?.aborted)throw signal.reason;}
 }
 return artifacts;
}
interface FileChange { path: string; kind: string; available: boolean; diff: string; added: number | null; removed: number | null; additions: number | null; deletions: number | null; beforeSha256: string | null; afterSha256: string | null; source?: string; diffTruncated?: boolean; }
export async function changedFiles(before: any,after: any,{maxFiles=200,maxDiffBytes=1024*1024}={}){
 const a=new Map<string, any>((before.files||[]).map((f: any)=>[f.path,f])),b=new Map<string, any>((after.files||[]).map((f: any)=>[f.path,f])),changes: FileChange[]=[];let diffBytes=0;
 const reasons={'too-large':'文件超过文本快照大小上限','snapshot-budget':'文本快照总量达到上限','binary':'二进制文件不生成文本差异','invalid-utf8':'文件不是有效的 UTF-8 文本'};
 for(const file of [...new Set([...a.keys(),...b.keys()])].sort()){
  if(changes.length>=Math.min(200,maxFiles))break;
  if(file.startsWith('/workspace/inputs/'))continue;
  const old=a.get(file),next=b.get(file);
  // A partial snapshot does not establish that an unobserved file is absent.
  if((!old&&before.truncated)||(!next&&after.truncated))continue;
  if(old&&next&&(old.sha256&&next.sha256?old.sha256===next.sha256:old.size===next.size&&old.modifiedAt===next.modifiedAt))continue;
  const change: FileChange={path:file,kind:!old?'add':!next?'delete':'update',available:false,diff:'',added:null,removed:null,additions:null,deletions:null,beforeSha256:old?.sha256||null,afterSha256:next?.sha256||null};
  const unavailableRecord=[old,next].find(f=>f&&typeof f.text!=='string');
  if(unavailableRecord){change.source=(reasons as any)[unavailableRecord.textUnavailableReason]||'没有完整的修改前后文本，无法生成差异';changes.push(change);continue;}
  if(diffBytes>=maxDiffBytes){change.diffTruncated=true;change.source='本轮差异展示总量达到 1 MiB 上限';changes.push(change);continue;}
  try{
   // Only captured strings enter this trusted formatter. It never reads a model-
   // selected host path or evaluates user code; labels remain virtual paths.
   const formatted=await textFileChange(file.replace(/^\/workspace\//,''),old?.text,next?.text);
   if(!formatted)continue;
   change.added=change.additions=formatted.added;change.removed=change.deletions=formatted.removed;
   const bytes=Buffer.byteLength(formatted.diff);
   if(diffBytes+bytes>maxDiffBytes){change.diffTruncated=true;change.source='差异内容超过本轮 1 MiB 展示上限，保留完整增删统计';}
   else{change.available=true;change.diff=formatted.diff;change.source='隔离工作区执行前后的实际文本快照';diffBytes+=bytes;}
  }catch{change.source='差异生成未完成，未展示未经验证的内容';}
  changes.push(change);
 }
 return changes;
}
// 普通账号隔离执行的公共部分，所有 provider 共用：工作目录与项目、附件写入、沙箱工具执行、结果收集。
export function memberInstructions(cwd: any){
 return [
  "你是拾燕。根据用户请求，使用本轮实际可用的工具完成已授权的工作，并依据真实结果说明进展、结果和限制。",
  "本地文件和终端工具运行在当前账号的隔离环境，持久化工作区为 /workspace，当前目录为 "+cwd+"。不得绕过隔离访问宿主、其他账号或未授权资源。",
  "远程服务和设备通过当前账号的 MCP 工具访问，权限以账号连接、设备绑定和设备端权限为准。远程设备路径由远程工具处理，不受本地 /workspace 路径规则替代。",
  "海绵宝宝的服务器名为 sponge，由拾燕设置中的连接管理，不依赖 mcp.json。普通用户可以按授权访问自己绑定的设备，不得借用管理员或其他账号的连接。",
  "用户在连接器里绑定的服务（如 Notion、Linear、GitHub 或自定义 MCP）也会出现在 mcp_list_servers 里，按服务器名查询工具后调用。",
  "仅询问访问能力时使用只读操作验证。对用户已明确授权的必要操作继续执行，不反复索要已有授权。能力和连接状态以实际工具结果为准。",
 ].join('\n\n');
}
export async function prepareIsolatedJob(job: any,{signal,root}: {signal?: AbortSignal; root?: string}={}){
 const owner=job.owner;if(typeof owner!=='string'||!owner)throw new Error('隔离执行缺少账号身份');let cwd=virtualWorkspacePath(job.cwd||'/workspace');
 if(job.projectId){let config;try{const stored=await workspaceOperation(owner,{operation:'read',path:'/workspace/.shiyan/workspace.json'},{signal,root});config=JSON.parse(stored.text||Buffer.from(stored.data,'base64').toString());}catch{throw new Error('当前账号的项目不存在');}const project=config.projects?.find((p: any)=>p.id===job.projectId);if(!project)throw new Error('当前账号的项目不存在');cwd=virtualWorkspacePath(project.path);}
 await workspaceOperation(owner,{operation:'mkdir',path:cwd,recursive:true},{signal,root});
 const before=await workspaceOperation(owner,{operation:'snapshot'},{signal,root});
 const attachments: Array<{path: string; image?: {mime: string; data: any}}> = [];const uploads=[...(job.uploads||[]).map((f: any,i: any)=>({...f,filename:`image-${i+1}${f.suffix||'.png'}`,image:true})),...(job.files||[])];
 if(uploads.length){const inputDir='/workspace/inputs/'+crypto.randomUUID();await workspaceOperation(owner,{operation:'mkdir',path:inputDir,recursive:true},{signal,root});for(const file of uploads){const filename=path.posix.basename(String(file.filename||file.name||'attachment')).replace(/[\0\r\n]/g,'_'),filePath=inputDir+'/'+filename;await workspaceOperation(owner,{operation:'write',path:filePath,data:file.data},{signal,root});const attachment: {path: string; image?: {mime: string; data: any}} = {path:filePath};if(file.image){const mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as any)[file.suffix];if(mime)attachment.image={mime,data:file.data};}attachments.push(attachment);}}
 return {owner,cwd,before,attachments};
}
export async function executeMemberTool(owner: any,name: any,args: any,{cwd,signal,root}: {cwd?: string; signal?: AbortSignal; root?: string}={}){
 if(name==='exec_command')return await execSandbox(owner,{command:args.command,cwd:args.cwd||cwd,timeoutMs:Math.min(Number(args.timeout_ms)||120000,120000),signal,root});
 if(name==='read_file')return await workspaceOperation(owner,{operation:'read',path:args.path},{signal,root});
 if(name==='write_file')return await workspaceOperation(owner,{operation:'write',path:args.path,content:args.content},{signal,root});
 if(name==='list_files')return await workspaceOperation(owner,{operation:'list',path:args.path||cwd},{signal,root});
 if(name==='mcp_list_servers')return await memberMcpOperation(owner,{operation:'list_servers'},{signal,root});
 if(name==='mcp_list_tools')return await memberMcpOperation(owner,{operation:'list_tools',server:args.server},{signal,root});
 if(name==='mcp_call_tool')return await memberMcpOperation(owner,{operation:'call_tool',server:args.server,name:args.name,arguments:args.arguments},{signal,root});
 throw new Error('工具不可用');
}
export async function finishIsolatedJob(owner: any,{before,text='',signal,root}: {before?: any; text?: string; signal?: AbortSignal; root?: string}={}){
 const after=await workspaceOperation(owner,{operation:'snapshot'},{signal,root});const fileChanges=await changedFiles(before,after);const artifacts=await collectSandboxArtifacts(owner,{text,signal,root});return{fileChanges,artifacts};
}
export async function runIsolatedJob(job: any,{conversation,history=[],memory='',signal,onEvent=()=>{},onText=()=>{},onActivity=()=>{},outputSchema,schema,fetchImpl=fetch,getProvider=memberProvider,refreshProvider=refreshMemberProvider,root,maxRounds=48,allowTools=true}: {conversation?: any; history?: any[]; memory?: string; signal?: AbortSignal; onEvent?: (event: any) => void; onText?: (text: string) => void; onActivity?: () => void; outputSchema?: any; schema?: any; fetchImpl?: (...args: any[]) => any; getProvider?: (...args: any[]) => any; refreshProvider?: (...args: any[]) => any; root?: string; maxRounds?: number; allowTools?: boolean}={}){
 const {owner,cwd,before,attachments}=await prepareIsolatedJob(job,{signal,root});
 const input: any[]=[];if(memory)input.push({role:'user',content:[{type:'input_text',text:memory}]});
 for(const item of history.slice(-40))if(['user','assistant'].includes(item.role)&&typeof item.text==='string')input.push({role:item.role,content:[{type:item.role==='assistant'?'output_text':'input_text',text:item.text.slice(0,40000)}]});
 const content: any[]=[{type:'input_text',text:job.prompt||'请查看附件。'}];
 for(const attachment of attachments){content.push({type:'input_text',text:'用户上传的附件：'+attachment.path});if(attachment.image)content.push({type:'input_image',image_url:`data:${attachment.image.mime};base64,${attachment.image.data}`});}
 input.push({role:'user',content});const displayItems: any[]=[];const threadId=conversation?.threadId||job.threadId||'isolated_'+crypto.randomUUID();let allText='',usage: any=null;
 onEvent({type:'thread.started',thread_id:threadId});
 const instructions=memberInstructions(cwd);
 for(let round=0;round<maxRounds;round++){
  if(signal?.aborted)throw signal.reason||new Error('执行已停止');const request: {model: any; reasoning: {effort: any}; instructions: string; input: any[]; tools: any[]; tool_choice: string; parallel_tool_calls: boolean; store: boolean; stream: boolean; text?: any}={model:job.model,reasoning:{effort:job.reasoning||'low'},instructions,input,tools:allowTools?MEMBER_AGENT_TOOLS:[],tool_choice:allowTools?'auto':'none',parallel_tool_calls:false,store:false,stream:true};
  const format=outputSchema||schema;if(format)request.text={format:{type:'json_schema',name:'shiyan_result',strict:true,schema:format}};
  const result=await responseStream(request,{signal,fetchImpl,getProvider,refreshProvider,onActivity,onText:(text: any)=>onText(allText+(allText?'\n\n':'')+text)});if(result.usage){usage||={};for(const[key,value]of Object.entries(result.usage)){if(typeof value==='number')usage[key]=(usage[key]||0)+value;else if(value&&typeof value==='object'){usage[key]||={};for(const[k,n]of Object.entries(value))if(typeof n==='number')usage[key][k]=(usage[key][k]||0)+n;}}}
  if(result.text)allText+=(allText?'\n\n':'')+result.text;
  const calls=result.output.filter(i=>i.type==='function_call');if(!allowTools&&calls.length)throw unavailable();for(const item of result.output)if(['reasoning','message','function_call'].includes(item.type))input.push(item);
  if(!calls.length){if(!allText.trim())throw unavailable();const{fileChanges,artifacts}=await finishIsolatedJob(owner,{before,text:allText,signal,root});return{text:allText,usage,threadId,displayItems,fileChanges,artifacts};}
  for(const call of calls){const id=call.call_id||call.id||crypto.randomUUID(),item: {id: string; type: string; status: string; command?: string; server?: string; tool?: string; aggregated_output?: string; exit_code?: number; result?: any}={id,type:call.name==='exec_command'?'command_execution':'mcp_tool_call',status:'in_progress',...(call.name==='exec_command'?{command:''}:{server:'workspace',tool:call.name})};let args;try{args=JSON.parse(call.arguments||'{}');}catch{args={};}
   if(call.name==='exec_command')item.command=String(args.command||'');if(call.name.startsWith('mcp_')&&args.server)item.server=String(args.server);if(call.name==='mcp_call_tool')item.tool=String(args.name||call.name);displayItems.push(item);onEvent({type:'item.started',item:{...item}});let output;
   try{output=await executeMemberTool(owner,call.name,args,{cwd,signal,root});item.status='completed';}
   catch(error){if(signal?.aborted)throw error;output={error: error instanceof Error?error.message:String(error)};item.status='failed';}
   const text=JSON.stringify(output);item.aggregated_output=(call.name==='exec_command'?String(output.stdout||'')+String(output.stderr||''):text).slice(0,128000);item.exit_code=output.exitCode??(output.error?1:0);item.result={content:[{type:'text',text:text.slice(0,128000)}]};onEvent({type:'item.completed',item:{...item}});onActivity();
   input.push({type:'function_call_output',call_id:id,output:text.slice(0,256000)});
  }
 }
 throw new Error('本轮执行步骤较多，已保留工作区结果，请继续');
}
