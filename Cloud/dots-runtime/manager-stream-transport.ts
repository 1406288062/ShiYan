// Manager-only app-server transport. Unlike exec --json, app-server preserves
// agentMessage deltas. No worker/tool/reasoning events enter the reply channel.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const privateReviewFeatures=['shell_tool','unified_exec','apps','plugins','remote_plugin','hooks','multi_agent','multi_agent_v2','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','computer_use','goals','sleep_tool','memories','request_permissions_tool','skill_mcp_dependency_install','skill_search','tool_suggest','recommended_plugins','image_generation','view_image','code_mode','code_mode_host','in_app_local_automation','in_app_voice','realtime_conversation'];

export interface ManagerThreadOptions { allowTools?: boolean; mcpOnly?: boolean; workingDirectory?: string; onItem?: (item: any) => void; webSearchMode?: string; mcpServers?: Record<string, any>; modelReasoningEffort?: string; model?: string; approvalPolicy?: string; sandboxMode?: string; threadSource?: string; }
export function createManagerThread({threadId=null,options={},codexPath=process.env.CODEX_PATH||'/home/ubuntu/.local/bin/codex',spawnProcess=spawn,rpcTimeoutMs=15000}: { threadId?: string | null; options?: ManagerThreadOptions; codexPath?: string; spawnProcess?: any; rpcTimeoutMs?: number }={}) {
  const privateReview=options.allowTools===false;
  // mcpOnly: a thread whose only tools are the MCP servers passed in options (Dots browser executor).
  // Built-in shell/exec/browser features and every inherited MCP server are disabled.
  const mcpOnly=!privateReview&&options.mcpOnly===true;
  if(privateReview&&threadId)throw new Error('Private review must start an isolated thread');
  const thread: any={id:threadId};
  thread.runStreamed=async(prompt,{outputSchema,signal,images=[]}: { outputSchema?: any; signal?: AbortSignal; images?: any[] }={})=>({events:stream(prompt,outputSchema,signal,images)});
  async function* stream(prompt,outputSchema,signal,images: any[] = []) {
    if(signal?.aborted)throw signal.reason||new Error('Manager turn aborted');
    const child=spawnProcess(codexPath,['app-server','--stdio',...(privateReview||mcpOnly?privateReviewFeatures.flatMap(name=>['-c','features.'+name+'=false']):[])],{cwd:options.workingDirectory,stdio:['pipe','pipe','pipe']});
    child.stderr?.resume();
    const pending=new Map(),items=new Map(),queue: any[]=[];
    let nextId=0,turnId=null,started=false,done=false,failure: any=null,wake: ((value?: unknown) => void) | null=null,usage: any=null,closing=false,exited=false;
    const notify=()=>{wake?.();wake=null;};
    const fail=cause=>{if(closing||done)return;failure=cause instanceof Error?cause:new Error(String(cause));done=true;for(const request of pending.values()){clearTimeout(request.timer);request.reject(failure);}pending.clear();notify();};
    const push=event=>{queue.push(event);notify();};
    const send=value=>{if(child.stdin.destroyed||!child.stdin.writable)throw new Error('Manager stream connection closed');child.stdin.write(JSON.stringify(value)+'\n');};
    const rpc=(method,params): Promise<any>=>new Promise((resolve,reject)=>{
      if(done)return reject(failure||new Error('Manager stream has ended'));
      const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Manager stream RPC timed out: '+method));},rpcTimeoutMs);timer.unref?.();pending.set(id,{resolve,reject,timer});
      try{send({id,method,params});}catch(cause){clearTimeout(timer);pending.delete(id);reject(cause);}
    });
    const stop=()=>{
      if(turnId&&thread.id&&child.stdin.writable)try{send({id:++nextId,method:'turn/interrupt',params:{threadId:thread.id,turnId}});}catch{}
      fail(signal?.reason||new Error('Manager turn aborted'));
    };
    child.on('error',fail);child.on('exit',()=>{exited=true;if(!closing&&!done)fail(new Error('Manager stream process exited before completion'));});child.stdin.on('error',fail);
    signal?.addEventListener('abort',stop,{once:true});
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      if(done||closing)return;
      if(line.length>2*1024*1024)return fail(new Error('Manager stream event too large'));
      let message;try{message=JSON.parse(line);}catch{return fail(new Error('Invalid manager stream event'));}
      if(Object.hasOwn(message,'id')&&pending.has(message.id)){
        const request=pending.get(message.id);pending.delete(message.id);clearTimeout(request.timer);
        message.error?request.reject(new Error(message.error.message||'Manager stream RPC failed')):request.resolve(message.result);return;
      }
      if(Object.hasOwn(message,'id')&&message.method){
        // Approval is never granted by the transport, even for an unexpected
        // request from a misconfigured server. The manager remains read-only.
        try{send({id:message.id,error:{code:-32601,message:'Manager interaction is not enabled'}});}catch(cause){fail(cause);}return;
      }
      const p=message.params||{};
      if(!thread.id||p.threadId!==thread.id)return;
      if(message.method==='turn/started'){
        if(!turnId&&started)turnId=p.turn?.id||null;
        return;
      }
      if(!turnId||p.turnId&&p.turnId!==turnId)return;
      if(privateReview&&['item/started','item/completed'].includes(message.method)&&p.item?.type&&!['agentMessage','reasoning','userMessage','contextCompaction'].includes(p.item.type))return fail(new Error('Private review attempted a tool operation'));
      if(message.method==='item/started'){
        const item=p.item;if(item?.type==='agentMessage'&&(!item.phase||['final_answer','final'].includes(item.phase)))items.set(item.id,{text:'',phase:item.phase});
      }else if(message.method==='item/agentMessage/delta'){
        const item=items.get(p.itemId);if(!item||typeof p.delta!=='string')return;
        item.text+=p.delta;if(item.text.length>256000)return fail(new Error('Manager reply exceeds stream limit'));
        push({type:'item.updated',item:{id:p.itemId,type:'agent_message',text:item.text}});
      }else if(message.method==='item/completed'){
        // Agent runs (Dots workers, browser executor) record every tool step for the timeline.
        if(p.item&&p.item.type!=='agentMessage'&&typeof options.onItem==='function')try{options.onItem(p.item);}catch{}
        const item=p.item;if(item?.type!=='agentMessage'||item.phase&&!['final_answer','final'].includes(item.phase))return;
        if(typeof item.text!=='string')return fail(new Error('Invalid completed manager reply'));
        items.set(item.id,{text:item.text,phase:item.phase});push({type:'item.completed',item:{id:item.id,type:'agent_message',text:item.text}});
      }else if(message.method==='thread/tokenUsage/updated'){
        const u=p.tokenUsage?.last;if(u)usage={input_tokens:u.inputTokens||0,cached_input_tokens:u.cachedInputTokens||0,cache_write_input_tokens:u.cacheWriteInputTokens||0,output_tokens:u.outputTokens||0,reasoning_output_tokens:u.reasoningOutputTokens||0};
      }else if(message.method==='turn/completed'&&p.turn?.id===turnId){
        if(p.turn.status!=='completed')return fail(new Error(p.turn.error?.message||'Manager turn '+p.turn.status));
        push({type:'turn.completed',usage});done=true;notify();
      }
    });
    try{
      await rpc('initialize',{clientInfo:{name:'shiyan-dots-manager',version:'1.0'},capabilities:{experimentalApi:true}});send({method:'initialized'});
      const config: any={web_search:options.webSearchMode||'disabled','sandbox_workspace_write.network_access':false};
      // Account-scoped connectors are supplied by the Dots runtime. Never read
      // a global user's connector config: each MCP bridge carries its owner/id.
      if(options.mcpServers&&typeof options.mcpServers==='object')config.mcp_servers=options.mcpServers;
      if(options.modelReasoningEffort)config.model_reasoning_effort=options.modelReasoningEffort;
      if(privateReview){
        // Per-thread overrides use actual App Server config fields. Explicitly
        // disable every inherited MCP server while retaining its transport fields;
        // a cleared table plus enabled-only overrides is invalid configuration.
        const effective=await rpc('config/read',{includeLayers:false,cwd:options.workingDirectory});
        if(!effective?.config||typeof effective.config!=='object')throw new Error('Cannot verify private review configuration');
        config.mcp_servers=Object.fromEntries(Object.entries(effective.config.mcp_servers||{}).map(([name,server])=>[name,{...Object.fromEntries(Object.entries(server as any).filter(([,value])=>value!=null)),enabled:false}]) as [string, any][]);
        for(const name of privateReviewFeatures)config['features.'+name]=false;
        config.web_search='disabled';config['sandbox_workspace_write.network_access']=false;
      }
      if(mcpOnly){
        const effective=await rpc('config/read',{includeLayers:false,cwd:options.workingDirectory});
        if(!effective?.config||typeof effective.config!=='object')throw new Error('Cannot verify executor configuration');
        const inherited=Object.fromEntries(Object.entries(effective.config.mcp_servers||{}).filter(([name])=>!Object.hasOwn(options.mcpServers||{},name)).map(([name,server])=>[name,{...Object.fromEntries(Object.entries(server as any).filter(([,value])=>value!=null)),enabled:false}]) as [string, any][]);
        config.mcp_servers={...inherited,...(options.mcpServers||{})};
        for(const name of privateReviewFeatures)config['features.'+name]=false;
        config.web_search='disabled';config['sandbox_workspace_write.network_access']=false;
      }
      const common={cwd:options.workingDirectory,model:options.model,approvalPolicy:privateReview?'never':options.approvalPolicy||'never',sandbox:privateReview?'read-only':options.sandboxMode||'read-only',config,...(privateReview?{ephemeral:true}: {})};
      const resumed=await rpc(thread.id?'thread/resume':'thread/start',{...common,...(thread.id?{threadId:thread.id,excludeTurns:true}:{threadSource:options.threadSource||'dots-manager',experimentalRawEvents:false})});
      const id=resumed?.thread?.id;if(!id||thread.id&&id!==thread.id)throw new Error('Manager stream thread identity changed');
      thread.id=id;yield {type:'thread.started',thread_id:id};
      started=true;
      const accepted=await rpc('turn/start',{threadId:id,input:[{type:'text',text:String(prompt),text_elements:[]},...(images||[]).map(path=>({type:'localImage',path}))],outputSchema,...(options.modelReasoningEffort?{effort:options.modelReasoningEffort}:{})});
      const acceptedId=accepted?.turn?.id;if(!acceptedId||turnId&&turnId!==acceptedId)throw new Error('Manager stream turn identity changed');turnId=acceptedId;
      while(!done||queue.length){if(queue.length){yield queue.shift();continue;}await new Promise(resolve=>{wake=resolve;});}
      if(failure)throw failure;
    }finally{
      closing=true;signal?.removeEventListener('abort',stop);lines.close();for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Manager stream closed'));}pending.clear();
      if(child.stdin.writable)child.stdin.end();
      if(!exited){child.kill('SIGTERM');const killTimer=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},1000);killTimer.unref?.();}
    }
  }
  return thread;
}
