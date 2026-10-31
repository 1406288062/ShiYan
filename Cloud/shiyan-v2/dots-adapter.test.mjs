// All goals, tools and callbacks below are fixtures. No production Dots goal,
// device registration, model turn, Mac command or approval is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHmac, createHash } from 'node:crypto';
import { DotsAdapter, DotsStore, createLocalDotsClient } from './dots-adapter.mjs';
import { createDotsSidecar } from './dots-sidecar.mjs';

const OWNER='shiyan-private-owner';
const input=(extra={})=>({requestId:'create-one',conversationId:'conversation-one',title:'Fixture goal',instruction:'Fixture instruction',runNow:false,host:'shiyan_desktop',...extra});
const failure=()=>Object.assign(new Error('fixture lost reply'),{status:503,code:'runtime_unavailable'});
function signature(secret,body,eventId='evt_fixture',stamp=String(Math.floor(Date.now()/1000))){return {'webhook-id':eventId,'webhook-timestamp':stamp,'webhook-signature':'v1,'+createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(eventId+'.'+stamp+'.').update(body).digest('base64')};}

function fixture(t,{existing=[],callbackURL='',importPrivateGoals=false}={}){
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-dots-fixture-'));const store=new DotsStore(root);const calls=[],goals=new Map(existing.map(g=>[g.id,g])),receipts=new Map(),events=new Map(),outputs=new Map(),notifications=new Map();let next=100,loseCreate=false,loseInstruct=false,loseControl=false,loseAck=false;
  const client={async rpc(method,params){calls.push({method,params});if(method==='ping')return {};if(method==='events/subscribe'){const raw=Buffer.from(JSON.stringify({type:'verification',challenge:'fixture-challenge'}));const verified=await adapter.webhook(signature(params.delivery.secret,raw,'msg_verify_fixture'),raw);assert.equal(verified.challenge,'fixture-challenge');return {id:'sub_fixture_'+params.arguments.goal_id,refreshBefore:new Date(Date.now()+7*86400000).toISOString()};}throw new Error('unknown fixture rpc');},async tool(name,args){
    calls.push({name,args});
    if(name==='dots_list_goals')return {ok:true,goals:[...goals.values()].sort((a,b)=>b.id-a.id)};
    if(name==='dots_create_goal'){
      if(receipts.has(args.request_id))return receipts.get(args.request_id).response;
      const goal={id:next++,title:args.title,instruction:args.instruction,status:args.run_now?'active':'paused',created_at:1000,updated_at:1000,workspace:'/private/workspace',thread_id:'private-thread',client_context:args.client_context,timeline:[],outputs:[],approvals:[]};goals.set(goal.id,goal);const response={ok:true,goal};receipts.set(args.request_id,{operation:'goal:create',goal_id:goal.id,response});if(loseCreate){loseCreate=false;throw failure();}return response;
    }
    const goal=goals.get(args.goal_id);
    if(name==='dots_get_goal'){if(!goal)throw failure();return {ok:true,goal};}
    if(name==='dots_instruct_goal'){
      if(['done','cancelled'].includes(goal.status))throw Object.assign(new Error('terminal fixture goal'),{status:409});
      if(receipts.has(args.request_id))return receipts.get(args.request_id).response;
      const added={id:10,goal_id:goal.id,type:'user_instruction',payload:args.message,created_at:1001,consumed_at:null};events.set(goal.id,[...(events.get(goal.id)||[]),added]);const response={ok:true,goal};receipts.set(args.request_id,{operation:'goal:instruct:'+goal.id,goal_id:goal.id,response});if(loseInstruct){loseInstruct=false;throw failure();}return response;
    }
    if(name==='dots_control_goal'){goal.status={pause:'paused',resume:'active',cancel:'cancelled',wake:'active'}[args.action];if(loseControl){loseControl=false;throw failure();}return {ok:true,goal};}
    if(name==='dots_list_approvals')return {ok:true,approvals:(goal?.approvals||[]).filter(a=>a.status==='pending')};
    if(name==='dots_decide_approval'){const approval=[...goals.values()].flatMap(g=>g.approvals||[]).find(a=>a.id===args.approval_id);assert.equal(args.decision==='approve'?args.confirmed_command:approval.command,approval.command);approval.status=args.decision==='approve'?'approved':'rejected';return {ok:true};}
    if(name==='dots_get_timeline')return {timeline:(goal.timeline||[]).filter(e=>e.id>args.after_id),next_cursor:goal.timeline?.at(-1)?.id||args.after_id,has_more:false};
    if(name==='dots_list_outputs')return {outputs:[...outputs.values()].filter(o=>o.goal_id===args.goal_id)};
    if(name==='dots_read_output')return {output:outputs.get(args.output_id)};
    if(name==='dots_list_notifications'){const rows=(notifications.get(args.goal_id)||[]).filter(n=>n.id>args.after_id);return {notifications:rows,next_cursor:rows.at(-1)?.id??args.after_id,has_more:false};}
    if(name==='dots_ack_notifications'){assert.ok(store.db.prepare('SELECT seq FROM dots_events WHERE type=\'notification\' AND json_extract(payload,\'$.notification_id\')=?').get(args.notification_id),'ACK must follow durable notification');if(loseAck){loseAck=false;throw failure();}return {ok:true};}
    throw new Error('unknown fixture tool '+name);
  }};
  const eventReader={read(id){return events.get(id)||[];},request(id){return receipts.get(id);},close(){}};
  const adapter=new DotsAdapter({root,store,client,eventReader,callbackURL,importPrivateGoals,recoverIntervalMs:0,subscriptionRefreshMs:0});
  t.after(()=>{adapter.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,adapter,client,eventReader,calls,goals,receipts,events,outputs,notifications,loseCreate(){loseCreate=true;},loseInstruct(){loseInstruct=true;},loseControl(){loseControl=true;},loseAck(){loseAck=true;}};
}

test('device owner projection shares goal IDs across hosts and excludes private metadata',async t=>{
  const f=fixture(t);const created=await f.adapter.create(OWNER,input());assert.equal(created.goal.status,'paused');assert.equal(created.goal.originHost,'shiyan_desktop');assert.ok(!('workspace' in created.goal));assert.ok(!('thread_id' in created.goal));
  const mobile=await f.adapter.goal(OWNER,created.goal.id);assert.equal(mobile.goal.id,created.goal.id);assert.equal((await f.adapter.list(OWNER)).goals[0].conversationId,'conversation-one');
  await assert.rejects(f.adapter.goal('unknown-owner',created.goal.id),e=>e.status===404);assert.deepEqual((await f.adapter.list('unknown-owner')).goals,[]);
});
test('concurrent duplicate create, exact replay and changed-payload conflict',async t=>{
  const f=fixture(t);const [a,b]=await Promise.all([f.adapter.create(OWNER,input()),f.adapter.create(OWNER,input())]);assert.equal(a.goal.id,b.goal.id);assert.equal(f.calls.filter(c=>c.name==='dots_create_goal').length,1);
  await assert.rejects(f.adapter.create(OWNER,input({title:'changed'})),e=>e.status===409);
  await assert.rejects(f.adapter.create(OWNER,input({requestId:'different-request'})),e=>e.code==='conversation_conflict');
});
test('different simultaneous device requests cannot create two goals for one conversation',async t=>{
  const f=fixture(t);const results=await Promise.allSettled([f.adapter.create(OWNER,input()),f.adapter.create(OWNER,input({requestId:'mobile-create',host:'shiyan_mobile'}))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.goals.size,1);assert.equal(f.calls.filter(c=>c.name==='dots_create_goal').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'conversation_conflict');
});
test('lost create reply reuses namespaced runtime request and does not create a second goal',async t=>{
  const f=fixture(t);f.loseCreate();await assert.rejects(f.adapter.create(OWNER,input()));const result=await f.adapter.create(OWNER,input());assert.equal(f.goals.size,1);assert.equal(result.goal.id,100);const creates=f.calls.filter(c=>c.name==='dots_create_goal');assert.equal(creates[0].args.request_id,creates[1].args.request_id);assert.ok(!creates[0].args.request_id.includes(OWNER));
});
test('crash between binding and finishing recovers matching create receipt only',async t=>{
  const f=fixture(t);const result=await f.adapter.create(OWNER,input());f.store.db.prepare("UPDATE dots_requests SET state='pending',response=NULL").run();assert.equal((await f.adapter.create(OWNER,input())).goal.id,result.goal.id);assert.equal(f.calls.filter(c=>c.name==='dots_create_goal').length,1);
});
test('same SQLite survives reopen with mapping, request receipt and event cursor',async t=>{
  const f=fixture(t);const created=await f.adapter.create(OWNER,input());const second=new DotsStore(f.root);t.after(()=>second.close());assert.equal(second.mapping(OWNER,created.goal.id).conversation_id,'conversation-one');assert.equal(second.receipt(OWNER,'create-one').state,'completed');assert.equal(second.events(OWNER,0,10).events.length,1);assert.equal(second.webhookSecret,f.store.webhookSecret);
});
test('mobile instruction remains visible and lost reply after terminal completion never appends twice',async t=>{
  const f=fixture(t);const result=await f.adapter.create(OWNER,input());f.goals.get(result.goal.id).status='active';f.loseInstruct();await assert.rejects(f.adapter.instruct(OWNER,result.goal.id,{requestId:'mobile-instruction',message:'Keep this instruction'}));f.goals.get(result.goal.id).status='done';const recovered=await f.adapter.instruct(OWNER,result.goal.id,{requestId:'mobile-instruction',message:'Keep this instruction'});assert.equal(recovered.events[0].payload,'Keep this instruction');assert.equal(f.calls.filter(c=>c.name==='dots_instruct_goal').length,1);
  await assert.rejects(f.adapter.instruct(OWNER,result.goal.id,{requestId:'mobile-instruction',message:'changed'}),e=>e.status===409);
});
test('new control operates immediately and lost pause reconciles without another tool call',async t=>{
  const f=fixture(t);const {goal}=await f.adapter.create(OWNER,input({runNow:true}));f.loseControl();await assert.rejects(f.adapter.control(OWNER,goal.id,{requestId:'pause-once',action:'pause'}));const result=await f.adapter.control(OWNER,goal.id,{requestId:'pause-once',action:'pause'});assert.equal(result.goal.status,'paused');assert.equal(f.calls.filter(c=>c.name==='dots_control_goal').length,1);
});
test('uncertain wake is never repeated, even after reconnect',async t=>{
  const f=fixture(t);const {goal}=await f.adapter.create(OWNER,input());f.loseControl();await assert.rejects(f.adapter.control(OWNER,goal.id,{requestId:'wake-once',action:'wake'}));await assert.rejects(f.adapter.control(OWNER,goal.id,{requestId:'wake-once',action:'wake'}),e=>e.code==='action_uncertain');assert.equal(f.calls.filter(c=>c.name==='dots_control_goal').length,1);
});
test('approval requires exact command and correct goal; no mismatch executes',async t=>{
  const f=fixture(t);const {goal}=await f.adapter.create(OWNER,input());f.goals.get(goal.id).approvals=[{id:7,goal_id:goal.id,command:'printf "reviewed command"',status:'pending'}];
  await assert.rejects(f.adapter.decide(OWNER,goal.id,7,{requestId:'wrong-command',decision:'approve',confirmedCommand:'printf different'}),e=>e.code==='approval_changed');assert.equal(f.calls.filter(c=>c.name==='dots_decide_approval').length,0);
  const result=await f.adapter.decide(OWNER,goal.id,7,{requestId:'exact-command',decision:'approve',confirmedCommand:'printf "reviewed command"'});assert.equal(result.approvals[0].status,'approved');await f.adapter.decide(OWNER,goal.id,7,{requestId:'exact-command',decision:'approve',confirmedCommand:'printf "reviewed command"'});assert.equal(f.calls.filter(c=>c.name==='dots_decide_approval').length,1);
});
test('outputs are authorized by actual returned goal, never guessed output ID',async t=>{
  const f=fixture(t);const {goal}=await f.adapter.create(OWNER,input());f.outputs.set(1,{id:1,goal_id:goal.id,raw_result:'user visible fixture output',thread_id:'private-thread'});f.outputs.set(2,{id:2,goal_id:999,raw_result:'unmapped private result'});assert.equal((await f.adapter.output(OWNER,1)).output.raw_result,'user visible fixture output');assert.ok(!('thread_id' in (await f.adapter.output(OWNER,1)).output));await assert.rejects(f.adapter.output(OWNER,2),e=>e.status===404);
});
test('signed webhook persists before acceptance; tampering/stale/foreign subscriptions fail',async t=>{
  const f=fixture(t,{callbackURL:'https://fixture.invalid/shiyan/v1/dots/webhook'});const {goal}=await f.adapter.create(OWNER,input());await f.adapter.ensureSubscription(goal.id);
  const message={eventId:'evt_fixture',name:'goal.notification',data:{goal_id:goal.id,notification_id:5,output_id:null,level:'info',title:'Fixture done',message:'Fixture result'}};const raw=Buffer.from(JSON.stringify(message));const headers={...signature(f.store.webhookSecret,raw),'x-mcp-subscription-id':'sub_fixture_'+goal.id};
  assert.equal((await f.adapter.webhook(headers,raw)).durable,true);await f.adapter.webhook(headers,raw);assert.equal(f.store.events(OWNER,0,100).events.filter(e=>e.type==='notification').length,1);
  await assert.rejects(f.adapter.webhook(headers,Buffer.from(JSON.stringify({...message,data:{...message.data,message:'tampered'}}))),e=>e.status===401);
  await assert.rejects(f.adapter.webhook({...headers,...signature(f.store.webhookSecret,raw,'evt_fixture','1')},raw),e=>e.status===401);
  await assert.rejects(f.adapter.webhook({...headers,'x-mcp-subscription-id':'foreign'},raw),e=>e.status===503);
  const changed=Buffer.from(JSON.stringify({...message,data:{...message.data,message:'new validly signed content'}}));await assert.rejects(f.adapter.webhook({...headers,...signature(f.store.webhookSecret,changed)},changed),e=>e.code==='event_conflict');
});
test('recovery deduplicates webhook and replays durable missed notifications; ACK follows storage',async t=>{
  const f=fixture(t);const {goal}=await f.adapter.create(OWNER,input());f.notifications.set(goal.id,[{id:5,goal_id:goal.id,output_id:null,level:'info',title:'Done',body:'Stored result'}]);f.loseAck();await assert.rejects(f.adapter.recover());assert.equal(f.store.events(OWNER,0,100).events.filter(e=>e.type==='notification').length,1);await f.adapter.recover();assert.equal(f.store.events(OWNER,0,100).events.filter(e=>e.type==='notification').length,1);assert.equal(f.calls.filter(c=>c.name==='dots_ack_notifications').length,2);
});
test('consumer ACK is independent and never marks human read or other consumer',async t=>{
  const f=fixture(t);const {goal}=await f.adapter.create(OWNER,input());const cursor=f.adapter.events(OWNER).cursor;assert.equal(f.adapter.acknowledge(OWNER,{consumerId:'desktop',cursor}).handoffOnly,true);assert.equal(f.adapter.acknowledge(OWNER,{consumerId:'ios',cursor:0}).cursor,0);assert.equal(f.adapter.acknowledge(OWNER,{consumerId:'desktop',cursor:0}).cursor,cursor);await assert.rejects(async()=>f.adapter.acknowledge(OWNER,{consumerId:'desktop',cursor:999}),e=>e.status===400);assert.equal(goal.status,'paused');
});
test('opt-in imports existing private goals without recreating or activating them',async t=>{
  const f=fixture(t,{importPrivateGoals:true,existing:[{id:1,title:'ChatGPT goal',instruction:'Original',status:'blocked',client_context:{host:'chatgpt',conversation_id:'original-chat'}},{id:2,title:'Needs approval',instruction:'Review',status:'waiting_approval'}]});await f.adapter.importGoals();const list=await f.adapter.list(OWNER);assert.equal(list.goals.length,2);assert.equal(list.goals.find(g=>g.id===1).originContext.conversation_id,'original-chat');assert.equal(list.goals.find(g=>g.id===1).status,'blocked');assert.equal(f.calls.filter(c=>c.name==='dots_create_goal'||c.name==='dots_control_goal').length,0);assert.deepEqual((await f.adapter.list('other-owner')).goals,[]);
});
test('HTTP routing verifies body digest, rejects malformed owners, and streams durable events',async t=>{
  const f=fixture(t);const server=createDotsSidecar({adapter:f.adapter,recover:false,authenticate:req=>req.headers['x-fixture-owner']?{owner:req.headers['x-fixture-owner']}:null});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(()=>{server.closeAllConnections();server.removeAllListeners('close');server.close();});
  assert.equal((await fetch(base+'/shiyan/v1/dots/goals')).status,401);assert.equal((await fetch(base+'/shiyan/v1/dots/goals',{headers:{'x-fixture-owner':'other/owner'}})).status,401);
  const raw=JSON.stringify(input());const headers={'x-fixture-owner':OWNER,'x-shiyan-body-sha':createHash('sha256').update(raw).digest('hex'),'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/shiyan/v1/dots/goals',{method:'POST',headers:{...headers,'x-shiyan-body-sha':'bad'},body:raw})).status,401);
  const response=await fetch(base+'/shiyan/v1/dots/goals',{method:'POST',headers,body:raw});assert.equal(response.status,200);assert.equal((await response.json()).goal.status,'paused');
  const stream=await fetch(base+'/shiyan/v1/dots/events?after=0',{headers:{'x-fixture-owner':OWNER}});assert.equal(stream.headers.get('content-type'),'text/event-stream; charset=utf-8');const reader=stream.body.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/event: update/);assert.match(chunk,/goal-create/);await reader.cancel();
});
test('Unix socket MCP client uses no bearer or private URL and decodes actual tools envelope',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-dots-socket-'));const socketPath=path.join(root,'fixture.sock');const received=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received.push({url:req.url,headers:req.headers,body:JSON.parse(body)});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{structuredContent:{ok:true,fixture:true}}}));});await new Promise(resolve=>server.listen(socketPath,resolve));t.after(()=>{server.close();rmSync(root,{recursive:true,force:true});});
  const client=createLocalDotsClient({socketPath});assert.equal((await client.tool('dots_get_capabilities',{})).fixture,true);assert.equal(received[0].url,'/mcp');assert.equal(received[0].headers.authorization,undefined);assert.equal(received[0].body.method,'tools/call');
});
