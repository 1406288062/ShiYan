import http from 'node:http';
import {buildConnectors} from './dots-connectors.ts';
import {createSpongeClient} from './sponge-client.ts';
const spongeClient=createSpongeClient({timeoutMs:5000});
const spongeStatus=(owner: any)=>spongeClient.status(owner,{signal:AbortSignal.timeout(5000)});
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { authenticateDevice, digest } from './device-auth.ts';
import { DotsAdapter } from './dots-adapter.ts';
import { createDotsProfile } from './dots-profile.ts';
import { getAccountStore, requestBearer } from './accounts.ts';
import { startRegistrationReceiver } from './registration-events.ts';
import { createStepSummaries } from './step-summary.ts';
import { mcpConnectors } from './mcp-connectors.ts';
import { BrowserSessionManager, normalizeIdentity, sweepStaleBrowser } from './browser-session.ts';
import { BrowserStore } from './browser-store.ts';
import { BrowserAgentHost, startBrowserAgentSocket, defaultBrowserSocket } from './browser-agent.ts';

const ROOT=process.env.SHIYAN_ROOT||'/home/ubuntu/boss-codex-service/shiyan-v2';
const json=(res: any,status: any,value: any)=>{const data=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(data)});res.end(data);};
const failure=(message: any,status=400)=>Object.assign(new Error(message),{status});
const download=(res: any,file: any)=>{res.writeHead(200,{'Content-Type':file.mimeType||'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.filename),'X-Content-SHA256':file.sha256,'Cache-Control':'no-store','Content-Length':file.data.length});res.end(file.data);};
async function bytes(req: any,max=256*1024){let size=0;const chunks: Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw failure('请求内容过大',413);chunks.push(chunk);}return Buffer.concat(chunks);}
async function body(req: any,max=256*1024){const raw=await bytes(req,max);if(digest(raw)!==req.headers['x-shiyan-body-sha'])throw failure('请求校验失败',401);try{return JSON.parse(raw.toString()||'{}');}catch{throw failure('请求格式无效');}}
interface DotsSidecarOptions {
  root?: string;
  authenticate?: (req: any) => any;
  adapter?: any;
  recover?: boolean;
  registrationSocket?: any;
  browser?: any;
  browserStore?: any;
  browserSocket?: any;
}

export function createDotsSidecar({root=ROOT,authenticate=authenticateDevice,adapter=new DotsAdapter({root:path.join(root,'data'),allowedOwner:process.env.SHIYAN_DOTS_OWNER||'shiyan-private-owner',callbackURL:process.env.SHIYAN_DOTS_CALLBACK_URL||'',importPrivateGoals:process.env.SHIYAN_DOTS_IMPORT_PRIVATE_GOALS==='1'}),recover=true,registrationSocket=recover?(process.env.DOTS_REGISTRATION_SOCKET||path.join(root,'data','registration-events.sock')):null,browser=new BrowserSessionManager({validateAccountToken:token=>Boolean(getAccountStore().authenticate(token))}),browserStore=null,browserSocket=recover?(process.env.SHIYAN_BROWSER_SOCKET||defaultBrowserSocket(root)):null}: DotsSidecarOptions={}) {
  const profile=createDotsProfile(adapter,root);
  // Dots browser tasks: durable task/question/permission/vault state plus the agent host that drives
  // the same isolated Chrome. Its private socket serves the MCP bridges and the Dots executor.
  const browserTasks=browserStore||new BrowserStore(path.join(root,'data','browser'));
  const browserAgent=new BrowserAgentHost({manager:browser,store:browserTasks,attachments:adapter.attachments});
  const browserRoutes=async(req: any,res: any,pathname: any,owner: any,auth: any)=>{
    const m=pathname.match(/^\/v1\/dots\/browser\/(tasks|questions|permissions|site-rules|identities|vault)(?:\/([A-Za-z0-9_-]{1,64}))?(?:\/(answer|secure|takeover|handback|close))?$/);
    if(!m)return false;const [,kind,id,action]=m;
    if(kind==='tasks'&&!id&&req.method==='GET'){json(res,200,{ok:true,tasks:browserTasks.listTasks(owner,{limit:40}).map((task: any)=>browserAgent.publicTask(task)),takeover:browserAgent.takeover?.owner===owner?browserAgent.takeover!.taskId:null});return true;}
    if(kind==='tasks'&&id&&!action&&req.method==='GET'){json(res,200,{ok:true,task:browserAgent.publicTask(browserTasks.task(owner,id))});return true;}
    if(kind==='tasks'&&id&&action==='takeover'&&req.method==='POST'){await body(req,1024);const accountToken=auth.accountSession?requestBearer(req):null;json(res,201,await browserAgent.startTakeover(owner,id,{accountToken}));return true;}
    if(kind==='tasks'&&id&&action==='handback'&&req.method==='POST'){const input=await body(req,4096);json(res,200,await browserAgent.handback(owner,id,{note:typeof input.note==='string'?input.note:''}));return true;}
    if(kind==='tasks'&&id&&action==='close'&&req.method==='POST'){await body(req,1024);json(res,200,await browserAgent.userClose(owner,id));return true;}
    if(kind==='questions'&&id&&action==='answer'&&req.method==='POST'){json(res,200,await browserAgent.userAnswer(owner,id,await body(req,16*1024)));return true;}
    // Secure input: the value is typed into the page and dropped; it is never stored or logged.
    if(kind==='questions'&&id&&action==='secure'&&req.method==='POST'){const input=await body(req,8*1024);json(res,200,await browserAgent.submitSecureInput(owner,id,input.value));return true;}
    if(kind==='permissions'&&!id){if(req.method==='GET'){json(res,200,{ok:true,permissions:browserTasks.permissions(owner),siteRules:browserTasks.siteRules(owner)});return true;}if(req.method==='PATCH'){json(res,200,{ok:true,permissions:browserTasks.setPermissions(owner,await body(req,4096))});return true;}}
    if(kind==='site-rules'&&!id&&req.method==='PUT'){const input=await body(req,4096);json(res,200,{ok:true,rule:browserTasks.setSiteRule(owner,input.origin,input.setting??null),siteRules:browserTasks.siteRules(owner)});return true;}
    if(kind==='identities'){if(!id&&req.method==='GET'){json(res,200,{ok:true,identities:browserTasks.identities(owner)});return true;}if(!id&&req.method==='POST'){const input=await body(req,4096);json(res,200,{ok:true,identity:browserTasks.addIdentity(owner,{id:normalizeIdentity(input.id),label:input.label,note:input.note})});return true;}if(id&&req.method==='DELETE'){browserTasks.removeIdentity(owner,normalizeIdentity(id));json(res,200,{ok:true});return true;}}
    if(kind==='vault'){
      if(!id&&req.method==='GET'){json(res,200,{ok:true,entries:browserTasks.vaultList(owner)});return true;}
      if(!id&&req.method==='POST'){const input=await body(req,8*1024);json(res,200,{ok:true,entry:browserTasks.vaultSave(owner,{origin:input.origin,username:input.username,password:input.password,label:input.label,identity:normalizeIdentity(input.identity||'default')})});return true;}
      if(id&&req.method==='PATCH'){const input=await body(req,8*1024);json(res,200,{ok:true,entry:browserTasks.vaultSave(owner,{id,origin:input.origin,username:input.username,password:input.password,label:input.label,identity:normalizeIdentity(input.identity||'default')})});return true;}
      if(id&&req.method==='DELETE'){browserTasks.vaultDelete(owner,id);json(res,200,{ok:true});return true;}
    }
    return false;
  };
  const stepSummaries=createStepSummaries(adapter.store.db);
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||'/','http://localhost'),pathname=url.pathname.replace(/^\/shiyan/,'');
      if(req.method==='POST'&&pathname==='/v1/dots/webhook')return json(res,200,await adapter.webhook(req.headers,await bytes(req)));
      if(req.method==='POST'&&pathname==='/v1/dots/browser/exchange'){const input=JSON.parse((await bytes(req,2048)).toString()||'{}');return json(res,200,await browser.exchangeTicket(input.ticket,req.headers.origin||''));}
      if(req.method==='POST'&&pathname==='/v1/dots/browser/poll'){const input=JSON.parse((await bytes(req,2048)).toString()||'{}');if(typeof input.clientDiag==='string'&&input.clientDiag)process.stderr.write('[browser-client-poll] '+input.clientDiag.replace(/[\r\n]+/g,' ').slice(0,240)+'\n');return json(res,200,await browser.pollMessagesForToken(input.sessionToken,{wantFrames:input.wantFrames===true,frameSeq:Number(input.frameSeq)||0}));}
      if(req.method==='POST'&&pathname==='/v1/dots/browser/control'){const input=JSON.parse((await bytes(req,64*1024)).toString()||'{}');return json(res,200,await browser.handleHttpMessagesForToken(input.sessionToken,input.messages));}
      // 连接器 OAuth 回调（浏览器跳回，经 hub.yandot.ai 转发）：用 state 找到账号，不需要设备凭据。
      if(req.method==='GET'&&pathname==='/v1/dots/connectors/oauth/callback'){const out=await mcpConnectors().callback(url.searchParams);res.writeHead(out.status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(out.html);}
      const auth=authenticate(req);if(!auth)return json(res,401,{ok:false,error:'服务连接未获授权'});const owner=auth.owner;adapter.authorize(owner);
      if(req.method==='POST'&&pathname==='/v1/dots/browser/session'){await body(req,1024);const accountToken=auth.accountSession?requestBearer(req):null;return json(res,201,{ok:true,...(await browser.createTicket(owner,{accountToken}))});}
      if(req.method==='DELETE'&&pathname==='/v1/dots/browser/session'){await browser.closeOwner(owner);return json(res,200,{ok:true});}
      if(pathname.startsWith('/v1/dots/browser/')&&await browserRoutes(req,res,pathname,owner,auth))return;

      if(req.method==='POST'&&pathname==='/v1/dots/rounds/summary'){const input=await body(req,512*1024);return json(res,200,{ok:true,rounds:await stepSummaries.rounds(input.rounds)});}
      if(req.method==='POST'&&pathname==='/v1/dots/steps/summary'){const input=await body(req,512*1024);return json(res,200,{ok:true,steps:await stepSummaries.summarize(input.steps)});}
      if(req.method==='GET'&&pathname==='/v1/dots/subscriptions')return json(res,200,await adapter.subscriptions(owner));
      if(req.method==='GET'&&pathname==='/v1/dots/connectors'){
        // 连接器只保留微信，其余是 MCP：常用插件 + 自定义。订阅类在“事件订阅”里。
        const [weixin]=await Promise.allSettled([adapter.weixin(owner,'status')]);
        const base=buildConnectors({weixin:weixin.status==='fulfilled'?weixin.value:null});
        const mcp=mcpConnectors().list(owner);
        const connectors=base.connectors.filter(c=>c.kind==='weixin');
        const connected=connectors.filter(c=>c.state==='connected').length+mcp.plugins.filter((p: any)=>p.state==='connected').length+mcp.custom.filter((c: any)=>c.state==='connected').length;
        return json(res,200,{ok:true,connectors,plugins:mcp.plugins,custom:mcp.custom,summary:{connected}});
      }
      if(req.method==='POST'&&pathname==='/v1/dots/connectors/mcp')return json(res,200,await mcpConnectors().connect(owner,await body(req)));
      const mcpRoute=pathname.match(/^\/v1\/dots\/connectors\/mcp\/([a-z0-9_-]{1,64})(?:\/(refresh))?$/);
      if(mcpRoute&&req.method==='DELETE'&&!mcpRoute[2])return json(res,200,mcpConnectors().remove(owner,mcpRoute[1]));
      if(mcpRoute&&req.method==='POST'&&mcpRoute[2])return json(res,200,await mcpConnectors().refresh(owner,mcpRoute[1]));

      if(pathname==='/v1/dots/weixin'){
        if(req.method==='GET')return json(res,200,await adapter.weixin(owner,'status'));
        if(req.method==='PATCH')return json(res,200,await adapter.weixin(owner,'push',await body(req)));
        if(req.method==='DELETE')return json(res,200,await adapter.weixin(owner,'unbind'));
      }
      if(req.method==='POST'&&pathname==='/v1/dots/weixin/login')return json(res,200,await adapter.weixin(owner,'login'));
      if(req.method==='POST'&&pathname==='/v1/dots/weixin/verify')return json(res,200,await adapter.weixin(owner,'verify',await body(req)));
      if(req.method==='GET'&&pathname==='/v1/dots/settings')return json(res,200,await adapter.settings(owner));
      if(pathname==='/v1/dots/life-goals'){if(req.method==='GET')return json(res,200,await adapter.lifeGoals(owner,'list'));if(req.method==='POST')return json(res,200,await adapter.lifeGoals(owner,'create',null,await body(req)));}
      const lifeGoal=pathname.match(/^\/v1\/dots\/life-goals\/(\d+)(?:\/(milestones|replan))?$/);
      if(lifeGoal){const [,goalId,sub]=lifeGoal;
        if(!sub&&req.method==='PATCH')return json(res,200,await adapter.lifeGoals(owner,'update',goalId,await body(req)));
        if(!sub&&req.method==='DELETE')return json(res,200,await adapter.lifeGoals(owner,'remove',goalId));
        if(sub==='milestones'&&req.method==='POST')return json(res,200,await adapter.lifeGoals(owner,'milestone',goalId,await body(req)));
        if(sub==='replan'&&req.method==='POST')return json(res,200,await adapter.lifeGoals(owner,'replan',goalId));
      }
      if(req.method==='GET'&&pathname==='/v1/dots/audit'){const q=new URL(req.url||'/','http://localhost').searchParams;return json(res,200,await adapter.audit(owner,{limit:q.get('limit'),before:q.get('before'),category:q.get('category')}));}
      if(req.method==='GET'&&pathname==='/v1/dots/approval-grants')return json(res,200,await adapter.approvalGrants(owner));
      const grantRoute=pathname.match(/^\/v1\/dots\/approval-grants\/(\d+)$/);if(req.method==='DELETE'&&grantRoute)return json(res,200,await adapter.revokeApprovalGrant(owner,grantRoute[1]));
      if(req.method==='PATCH'&&pathname==='/v1/dots/settings')return json(res,200,await adapter.updateSettings(owner,await body(req)));
      const subscription=pathname.match(/^\/v1\/dots\/subscriptions\/(github|google-calendar|email|rss)$/);
      if(subscription&&['PATCH','PUT','POST'].includes(req.method||''))return json(res,200,await adapter.updateSubscription(owner,subscription[1]!,await body(req)));
      if(subscription&&req.method==='DELETE')return json(res,200,await adapter.deleteSubscription(owner,subscription[1]));
      if(req.method==='GET'&&pathname==='/v1/dots/capabilities')return json(res,200,await adapter.capabilities(owner));
      if(req.method==='GET'&&pathname==='/v1/dots/profile')return json(res,200,profile.get(owner));
      if(req.method==='PATCH'&&pathname==='/v1/dots/profile')return json(res,200,profile.save(owner,await body(req)));
      if(req.method==='GET'&&pathname==='/v1/dots/relationship')return json(res,200,await adapter.relationship(owner));
      const relationshipTopic=pathname.match(/^\/v1\/dots\/relationship\/topics\/([A-Za-z0-9_-]{1,128})$/);
      if(relationshipTopic&&req.method==='PATCH')return json(res,200,await adapter.updateRelationshipTopic(owner,relationshipTopic[1],await body(req)));
      if(relationshipTopic&&req.method==='DELETE')return json(res,200,await adapter.deleteRelationshipTopic(owner,relationshipTopic[1]));
      if(req.method==='GET'&&pathname==='/v1/dots/pets/bundle'){
        const file=path.join(root,'data','dots-pets','previews-bundle.tar.gz');let size;try{size=statSync(file).size;}catch{throw failure('桌宠预览尚未准备好',404);}if(size>40*1024*1024)throw failure('桌宠预览文件过大',413);
        const data=readFileSync(file);return download(res,{filename:'dots-pets-previews.tar.gz',mimeType:'application/gzip',data,sha256:createHash('sha256').update(data).digest('hex')});
      }
      if(req.method==='GET'&&pathname==='/v1/dots/activity')return json(res,200,await adapter.activity(owner,{limit:Number(url.searchParams.get('limit')||100)}));
      if(req.method==='GET'&&pathname==='/v1/dots/schedules')return json(res,200,adapter.schedules.list(owner));
      if(req.method==='POST'&&pathname==='/v1/dots/schedules')return json(res,200,await adapter.schedules.create(owner,await body(req)));
      const schedule=pathname.match(/^\/v1\/dots\/schedules\/([0-9a-f-]{36})(?:\/(control))?$/i);
      if(schedule){if(req.method==='GET'&&!schedule[2]){const result=adapter.schedules.get(owner,schedule[1]);adapter.markActivityRead(owner,'schedule:'+schedule[1]);return json(res,200,result);}if((req.method==='PATCH'||req.method==='POST')&&!schedule[2])return json(res,200,await adapter.schedules.update(owner,schedule[1],await body(req)));if(req.method==='POST'&&schedule[2]==='control')return json(res,200,await adapter.schedules.control(owner,schedule[1],await body(req)));}
      const conversation=pathname.match(/^\/v1\/dots\/goals\/(\d+)\/conversation$/);if(req.method==='GET'&&conversation)return json(res,200,await adapter.conversation(owner,conversation[1]));
      const artifact=pathname.match(/^\/v1\/dots\/artifacts\/(\d+)\/([A-Za-z0-9_-]{1,2048})$/);if(req.method==='GET'&&artifact)return download(res,await adapter.artifact(owner,artifact[1],artifact[2]));
      const outputFile=pathname.match(/^\/v1\/dots\/outputs\/(\d+)\/file$/);if(req.method==='GET'&&outputFile)return download(res,await adapter.outputFile(owner,outputFile[1],{format:url.searchParams.get('format')||'txt'}));
      if(req.method==='POST'&&pathname==='/v1/dots/attachments')return json(res,200,{ok:true,attachment:adapter.attachments.upload(owner,await body(req,32*1024*1024))});
      const attachment=pathname.match(/^\/v1\/dots\/attachments\/([A-Za-z0-9-]{1,64})$/);
      if(req.method==='GET'&&attachment){
        const file=adapter.attachments.download(owner,attachment[1]);
        const inline=['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimeType);res.writeHead(200,{'Content-Type':inline?file.mimeType:'application/octet-stream','Content-Disposition':(inline?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(file.filename),'X-Content-SHA256':file.sha256,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Length':file.data.length});res.end(file.data);return;
      }
      if(req.method==='GET'&&pathname==='/v1/dots/people')return json(res,200,await adapter.digitalPeople(owner));
      if(req.method==='POST'&&pathname==='/v1/dots/people')return json(res,201,await adapter.createDigitalPerson(owner,await body(req,16*1024)));
      const digitalPerson=pathname.match(/^\/v1\/dots\/people\/([0-9a-f-]{36})(?:\/(import|messages|memories)(?:\/([0-9a-f-]{36}))?)?$/i);
      if(digitalPerson){
        const [,personId,operation,childId]=digitalPerson;
        if(!operation&&req.method==='GET')return json(res,200,await adapter.digitalPerson(owner,personId));
        if(!operation&&req.method==='PATCH')return json(res,200,await adapter.updateDigitalPerson(owner,personId,await body(req,16*1024)));
        if(!operation&&req.method==='DELETE')return json(res,200,await adapter.deleteDigitalPerson(owner,personId));
        if(operation==='import'&&req.method==='POST')return json(res,200,await adapter.importDigitalPerson(owner,personId,await body(req,512*1024)));
        if(operation==='messages'&&req.method==='GET')return json(res,200,await adapter.digitalPersonMessages(owner,personId,{before:url.searchParams.get('before')||0,limit:url.searchParams.get('limit')||100}));
        if(operation==='messages'&&req.method==='POST')return json(res,200,await adapter.sendDigitalPersonMessage(owner,personId,await body(req,16*1024)));
        if(operation==='memories'&&!childId&&req.method==='GET')return json(res,200,await adapter.digitalPersonMemories(owner,personId));
        if(operation==='memories'&&childId&&req.method==='PATCH')return json(res,200,await adapter.updateDigitalPersonMemory(owner,personId,childId,await body(req,16*1024)));
        if(operation==='memories'&&childId&&req.method==='DELETE')return json(res,200,await adapter.deleteDigitalPersonMemory(owner,personId,childId));
      }
      if(req.method==='GET'&&pathname==='/v1/dots/manager')return json(res,200,await adapter.manager(owner));
      if(req.method==='GET'&&pathname==='/v1/dots/manager/messages')return json(res,200,await adapter.managerMessages(owner,{before:Number(url.searchParams.get('before')||0),limit:Number(url.searchParams.get('limit')||100)}));
      const feedbackRoute=pathname.match(/^\/v1\/dots\/manager\/messages\/(\d{1,12})\/feedback$/);
      if(feedbackRoute&&req.method==='POST')return json(res,200,await adapter.messageFeedback(owner,feedbackRoute[1],(await body(req)).value));
      if(req.method==='POST'&&pathname==='/v1/dots/manager/messages')return json(res,200,await adapter.messageManager(owner,await body(req)));
      if(req.method==='POST'&&pathname==='/v1/dots/manager/control')return json(res,200,await adapter.controlManager(owner,await body(req)));
      if(req.method==='GET'&&pathname==='/v1/dots/manager/activity')return json(res,200,await adapter.managerActivity(owner,{after:Number(url.searchParams.get('after')||0),limit:Number(url.searchParams.get('limit')||50)}));
      if(req.method==='GET'&&pathname==='/v1/dots/goals')return json(res,200,await adapter.list(owner,{after:Number(url.searchParams.get('after')||0),limit:Number(url.searchParams.get('limit')||50),status:url.searchParams.get('status')||undefined}));
      if(req.method==='POST'&&pathname==='/v1/dots/goals')return json(res,200,await adapter.create(owner,await body(req)));
      if(req.method==='GET'&&pathname==='/v1/dots/notifications')return json(res,200,adapter.events(owner,{after:Number(url.searchParams.get('after')||0),limit:Number(url.searchParams.get('limit')||100)}));
      if(req.method==='POST'&&pathname==='/v1/dots/notifications/ack')return json(res,200,adapter.acknowledge(owner,await body(req)));
      if(req.method==='GET'&&pathname==='/v1/dots/events'){
        if(auth.accountSession){const timer=setInterval(()=>{if(!getAccountStore().authenticate(requestBearer(req)))res.end();},2000);timer.unref();res.on('close',()=>clearInterval(timer));}
        adapter.stream(owner,res,Number(url.searchParams.get('after')||req.headers['last-event-id']||0));return;
      }
      const output=pathname.match(/^\/v1\/dots\/outputs\/(\d+)$/);if(req.method==='GET'&&output)return json(res,200,await adapter.output(owner,output[1]));
      const approval=pathname.match(/^\/v1\/dots\/goals\/(\d+)\/approvals\/(\d+)\/decision$/);if(req.method==='POST'&&approval)return json(res,200,await adapter.decide(owner,approval[1],approval[2],await body(req)));
      const goal=pathname.match(/^\/v1\/dots\/goals\/(\d+)(?:\/(instruct|control|timeline|outputs|approvals))?$/);
      if(goal){const id=goal[1],action=goal[2];
        if(req.method==='GET'&&!action)return json(res,200,await adapter.goal(owner,id));
        if(req.method==='POST'&&action==='instruct')return json(res,200,await adapter.instruct(owner,id,await body(req)));
        if(req.method==='POST'&&action==='control')return json(res,200,await adapter.control(owner,id,await body(req)));
        if(req.method==='GET'&&action==='timeline')return json(res,200,await adapter.timeline(owner,id,{after:Number(url.searchParams.get('after')||0),limit:Number(url.searchParams.get('limit')||50)}));
        if(req.method==='GET'&&action==='outputs')return json(res,200,await adapter.outputs(owner,id,{limit:Number(url.searchParams.get('limit')||50)}));
        if(req.method==='GET'&&action==='approvals')return json(res,200,await adapter.approvals(owner,id));
      }
      return json(res,404,{ok:false,error:'接口不存在',code:'not_found'});
    }catch(error){if(!res.headersSent)json(res,(error as any).status||500,{ok:false,error:(error as any).status?(error as any).message:'Dots 操作未完成，请刷新后重试',code:(error as any).code||'request_failed'});else res.end();}
  });
  let registrationReceiver: any;
  (server as any).registrationReady=Promise.resolve();
  if(registrationSocket)server.on('listening',()=>{
    (server as any).registrationReady=startRegistrationReceiver({socketPath:registrationSocket,ingest:(event: any)=>adapter.registrationNotice(event)}).then(async receiver=>{if(!server.listening){await receiver.close();return null;}registrationReceiver=receiver;return receiver;});
    (server as any).registrationReady.catch(()=>console.error('[registration-notices] private receiver unavailable; durable outboxes retain events'));
  });
  server.on('upgrade',(req,socket,head)=>{let pathname='';try{pathname=new URL(req.url||'/', 'http://localhost').pathname.replace(/^\/shiyan/,'');}catch{}if(pathname==='/v1/dots/browser/stream')return browser.acceptWebSocket(req,socket,head);socket.destroy();});
  let agentSocket: any=null;
  if(browserSocket)server.on('listening',()=>{startBrowserAgentSocket(browserAgent,browserSocket).then((value: any)=>{if(!server.listening){value.close();return;}agentSocket=value;}).catch(error=>console.error('[browser-agent] private socket unavailable:',error?.message||error));});
  (server as any).browserAgent=browserAgent;
  server.on('close',()=>{void registrationReceiver?.close();agentSocket?.close();browserAgent.close();void browser.close();browserTasks.close();adapter.close();});

  if(recover)server.on('listening',()=>void adapter.recover().catch(()=>{}));
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  // 先清掉上次进程留下的服务器 Chrome；退出（systemd 重启/停止）时关掉当前浏览器，不留孤儿进程。
  await sweepStaleBrowser().catch(error=>console.warn('[browser-lifecycle] startup sweep failed: '+String(error?.message||error).slice(0,200)));
  const sidecar=createDotsSidecar();
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;const timer=setTimeout(()=>process.exit(0),8000);timer.unref?.();sidecar.close(()=>{sweepStaleBrowser().catch(()=>{}).finally(()=>process.exit(0));});sidecar.closeAllConnections?.();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  sidecar.listen(Number(process.env.SHIYAN_DOTS_PORT||4325),'127.0.0.1',()=>console.log('Shiyan Dots listening on 127.0.0.1:'+Number(process.env.SHIYAN_DOTS_PORT||4325)));
}
