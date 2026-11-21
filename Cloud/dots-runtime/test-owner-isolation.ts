import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createOwnerRegistry,memberDotsWorkingDirectory} from './owner-context.ts';
import {createMcpBridge} from './mcp-events.ts';
import {createManagerStore} from './manager-store.ts';
import {createDotsActivityReader} from '../boss-codex-service/shiyan-v2/dots-activity.ts';
import {workspaceOperation,execSandbox} from '../boss-codex-service/shiyan-v2/member-sandbox.ts';
import {createLocalDotsClient,DotsAdapter} from '../boss-codex-service/shiyan-v2/dots-adapter.ts';
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fixtureOwner='user:owner-isolation-A',otherOwner='user:owner-isolation-B';

test('owner async contexts remain independent across concurrent awaits and callbacks',async()=>{
 const made=[],registry=createOwnerRegistry({defaultOwner:'private',create:owner=>{made.push(owner);return {store:{id:owner,getId(){return this.id;}}};}}),store=registry.proxy('store');
 const values=await Promise.all([registry.run(fixtureOwner,async()=>{assert.equal(store.getId(),fixtureOwner);await tick(25);return [registry.currentOwner(),store.id];}),registry.run(otherOwner,async()=>{await tick(2);return [registry.currentOwner(),store.getId()];})]);
 assert.deepEqual(values,[[fixtureOwner,fixtureOwner],[otherOwner,otherOwner]]);assert.equal(registry.currentOwner(),'private');assert.deepEqual(made.sort(),[fixtureOwner,otherOwner].sort());
 assert.throws(()=>registry.run('../other',()=>{}),/Invalid owner/);
});

test('MCP wildcard subscriptions and notification cursors are scoped to actual goal owners',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY,manager_id TEXT);CREATE TABLE notifications(id INTEGER PRIMARY KEY,goal_id INTEGER,level TEXT,title TEXT,body TEXT,created_at INTEGER,output_id INTEGER);INSERT INTO goals VALUES(1,'manager:user:owner-isolation-A'),(2,'manager:user:owner-isolation-B');INSERT INTO notifications VALUES(1,1,'info','A','secret-A',100,NULL),(2,2,'info','B','secret-B',100,NULL);`);
 let owner=fixtureOwner;const delivered=[];
 const bridge=createMcpBridge({db,runtimeToken:'fixture',getOwner:()=>owner,defaultOwner:'private',retryIntervalMs:0,deliver:async(sub,event)=>{delivered.push([sub.id,event.data.message]);return {ok:true,status:200};}});
 const now=Math.floor(Date.now()/1000);const insert=db.prepare('INSERT INTO mcp_subscriptions(id,event_name,arguments_json,callback_url,secret,active,created_at,updated_at,owner_id) VALUES(?,?,?,?,?,1,?,?,?)');
 for(const [id,who]of [['sub-A',fixtureOwner],['sub-B',otherOwner],['sub-private','private']])insert.run(id,'goal.notification','{}','https://example.com/callback','whsec_'+Buffer.alloc(32).toString('base64'),now,now,who);
 await bridge.emitNotification({id:1,goalId:1,level:'info',title:'A',body:'secret-A',createdAt:100});await bridge.emitNotification({id:2,goalId:2,level:'info',title:'B',body:'secret-B',createdAt:100});
 assert.deepEqual(delivered,[['sub-A','secret-A'],['sub-B','secret-B']]);
 const server=http.createServer((req,res)=>bridge.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const rpc=async(name,args={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await response.json()).result;};
 try{
  const a=await rpc('dots_list_notifications',{consumer_id:'same-device'});assert.deepEqual(a.structuredContent.notifications.map(n=>n.body),['secret-A']);
  assert.equal((await rpc('dots_ack_notifications',{consumer_id:'same-device',notification_id:2})).isError,true);
  await rpc('dots_ack_notifications',{consumer_id:'same-device',notification_id:1});
  owner=otherOwner;const b=await rpc('dots_list_notifications',{consumer_id:'same-device'});assert.deepEqual(b.structuredContent.notifications.map(n=>n.body),['secret-B']);assert.equal(b.structuredContent.acknowledged_cursor,0);
  assert.equal((await rpc('dots_get_manager',{owner_id:fixtureOwner})).isError,true);
  assert.equal((await rpc('dots_get_goal',{goal_id:1})).isError,true);
 }finally{bridge.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});

async function liveFixture(t){
 const root=mkdtempSync(path.join(os.tmpdir(),'dots-owner-live-'));
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const token='isolated-fixture-token',child=spawn(process.execPath,['server.mjs'],{cwd:path.dirname(new URL(import.meta.url).pathname),env:{...process.env,DOTS_ROOT:root,DOTS_HOST:'127.0.0.1',DOTS_PORT:String(port),DOTS_TOKEN:token,DOTS_WEBHOOK_URL:'',SHIYAN_MEMORY_DATA:path.join(root,'memory'),SHIYAN_MEMBER_SANDBOX_ROOT:path.join(root,'member-workspaces'),DOTS_LOOP_MS:'60000'},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',b=>{log+=b;});child.stderr.on('data',b=>{log+=b;});
 const socketPath=path.join(root,'local-ipc','mcp.sock');for(let tries=0;tries<100&&!existsSync(socketPath)&&child.exitCode===null;tries++)await tick(50);
 assert.ok(existsSync(socketPath),'isolated runtime did not start: '+log);
 const base='http://127.0.0.1:'+port;
 const request=async(owner,url,options={})=>{const r=await fetch(base+url,{...options,headers:{Authorization:'Bearer '+token,'X-Dots-Owner':owner,'Content-Type':'application/json',...options.headers}});return {status:r.status,body:await r.json()};};
 const client=owner=>createLocalDotsClient({socketPath,owner});
 t.after(async()=>{child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),tick(3000)]);if(child.exitCode===null)child.kill('SIGKILL');rmSync(root,{recursive:true,force:true});});
 return{root,request,client,db:new DatabaseSync(path.join(root,'data','dots.sqlite3')),base,token};
}

test('live runtime gives two accounts independent managers, tasks, outputs, notifications and subscription configuration',async t=>{
 const f=await liveFixture(t);t.after(()=>f.db.close());
 const managerA=await f.request(fixtureOwner,'/v1/managers/'+encodeURIComponent(fixtureOwner)),managerB=await f.request(otherOwner,'/v1/managers/'+encodeURIComponent(otherOwner));
 assert.equal(managerA.status,200);assert.equal(managerB.status,200);assert.notEqual(managerA.body.manager.id,managerB.body.manager.id);assert.deepEqual(managerB.body.manager.messages,[]);
 assert.equal((await f.request(otherOwner,'/v1/managers/'+encodeURIComponent(fixtureOwner))).status,404);
 const create=owner=>f.request(owner,'/v1/goals',{method:'POST',body:JSON.stringify({title:'My private goal',instruction:'Private work',runNow:false,requestId:'same-request-id'})});
 const [createdA,createdB]=await Promise.all([create(fixtureOwner),create(otherOwner)]);const a=createdA.body.goal.id,b=createdB.body.goal.id;
 const controlRows=f.db.prepare('SELECT workspace FROM goals WHERE id IN (?,?)').all(a,b);assert.ok(controlRows.every(row=>row.workspace.startsWith(path.join(f.root,'data','owners')+path.sep)));assert.ok(controlRows.every(row=>!row.workspace.includes('member-workspaces')));
 assert.ok(a&&b);assert.notEqual(a,b);assert.equal((await create(fixtureOwner)).body.goal.id,a);
 assert.equal((await f.request(otherOwner,'/v1/goals/'+a)).status,404);
 assert.deepEqual((await f.client(fixtureOwner).tool('dots_list_goals')).goals.map(g=>g.id),[a]);assert.deepEqual((await f.client(otherOwner).tool('dots_list_goals')).goals.map(g=>g.id),[b]);
 const insertOutput=f.db.prepare("INSERT INTO agent_outputs(goal_id,run_number,status,raw_result,summary,notification,created_at) VALUES(?,1,'done',?,?,?,100)");
 const ao=Number(insertOutput.run(a,'secret-A','secret-A','secret-A').lastInsertRowid);insertOutput.run(b,'secret-B','secret-B','secret-B');
 assert.equal((await f.request(otherOwner,'/v1/outputs/'+ao)).status,404);assert.deepEqual((await f.request(fixtureOwner,'/v1/outputs')).body.outputs.map(o=>o.summary),['secret-A']);
 const insertNotice=f.db.prepare("INSERT INTO notifications(goal_id,level,title,body,created_at) VALUES(?,'info','private',?,100)");insertNotice.run(a,'notice-A');insertNotice.run(b,'notice-B');
 assert.deepEqual((await f.request(otherOwner,'/v1/notifications')).body.notifications.map(n=>n.body),['notice-B']);
 assert.deepEqual((await f.client(fixtureOwner).tool('dots_list_notifications')).notifications.map(n=>n.body),['notice-A']);
 const fakeConfig={provider:'github',config:{enabled:false,repository:'user/private-A',token:'private-token-A'}};
 await f.client(fixtureOwner).rpc('dots/subscriptions/update',fakeConfig);
 const listA=await f.client(fixtureOwner).rpc('dots/subscriptions/list'),listB=await f.client(otherOwner).rpc('dots/subscriptions/list');
 assert.equal(listA.subscriptions.find(p=>p.provider==='github').configured,true);assert.equal(listB.subscriptions.find(p=>p.provider==='github').configured,false);assert.ok(!JSON.stringify(listA).includes('private-token-A'));
 await f.client(otherOwner).rpc('dots/subscriptions/update',{provider:'github',config:{enabled:false,repository:'user/private-B',token:'private-token-B'}});
 await f.client(fixtureOwner).rpc('dots/subscriptions/delete',{provider:'github'});assert.equal((await f.client(otherOwner).rpc('dots/subscriptions/list')).subscriptions.find(p=>p.provider==='github').repository,'user/private-B');
 // Real runtime activity is replayed to the correct concurrent SSE listener only.
 const adapter=new DotsAdapter({root:path.join(f.root,'gateway'),client:createLocalDotsClient({socketPath:path.join(f.root,'local-ipc','mcp.sock')}),activityReader:{close(){}},eventReader:{close(){}},recoverIntervalMs:0,subscriptionRefreshMs:0,managerPollMs:0,schedulePollMs:0});
 class Listener extends EventEmitter{constructor(){super();this.chunks=[];this.destroyed=false;this.socket={setNoDelay(){}};}writeHead(){}flushHeaders(){}write(value){this.chunks.push(value);}end(){this.destroyed=true;this.emit('close');}}
 const listeners=[new Listener(),new Listener()];
 try{
  await adapter.managerSnapshot(fixtureOwner);await adapter.managerSnapshot(otherOwner);
  adapter.stream(fixtureOwner,listeners[0]);adapter.stream(otherOwner,listeners[1]);
  f.db.prepare('INSERT INTO manager_activity(manager_id,kind,message,data,created_at) VALUES(?,?,?,?,100)').run('manager:'+fixtureOwner,'event_subscription','only-A',JSON.stringify({marker:'only-A'}));
  f.db.prepare('INSERT INTO manager_activity(manager_id,kind,message,data,created_at) VALUES(?,?,?,?,100)').run('manager:'+otherOwner,'event_subscription','only-B',JSON.stringify({marker:'only-B'}));
  await Promise.all([adapter.syncManagerActivity(fixtureOwner),adapter.syncManagerActivity(otherOwner)]);
  const [streamA,streamB]=listeners.map(listener=>listener.chunks.join(''));assert.match(streamA,/only-A/);assert.doesNotMatch(streamA,/only-B/);assert.match(streamB,/only-B/);assert.doesNotMatch(streamB,/only-A/);
  // Scheduling one account never steals the other account's dispatch cycle.
  const time=Date.now();adapter.schedules.now=()=>time;const date=new Date(time+86400000).toISOString().slice(0,10);
  for(const owner of [fixtureOwner,otherOwner])await adapter.schedules.create(owner,{requestId:'same-schedule-request',title:'Own reminder',instruction:'Run inside my workspace',repeat:'once',time:'23:59',timezone:'UTC',startDate:date});
  assert.equal(adapter.schedules.list(fixtureOwner).schedules.length,1);assert.equal(adapter.schedules.list(otherOwner).schedules.length,1);
  const dispatched=[];adapter.create=async(owner)=>{dispatched.push(owner);return {goal:{id:owner===fixtureOwner?a:b}};};
  adapter.schedules.now=()=>Date.parse(date+'T23:59:30Z');await adapter.schedules.tick();assert.deepEqual(dispatched.sort(),[fixtureOwner,otherOwner].sort());
 }finally{adapter.close();}
 // Same user-facing request IDs, resource names and worker limits remain independent.
 let clock=Math.floor(Date.now()/1000)+3600;
 const stores=[fixtureOwner,otherOwner].map(owner=>createManagerStore({db:f.db,ownerId:owner,workspaceRoot:path.join(f.root,'manual',owner.replaceAll(':','_')),now:()=>clock,workerLimit:2}));
 const [sa,sb]=stores;
 const ma=sa.message({message:'private input A',requestId:'identical-manager-request'}),mb=sb.message({message:'private input B',requestId:'identical-manager-request'});
 assert.equal(ma.message.content,'private input A');assert.equal(mb.message.content,'private input B');assert.notEqual(ma.message.id,mb.message.id);
 const tasks=stores.map(store=>store.createTasks([1,2].map(n=>({key:'same-'+n,title:'Concurrent private work '+n,instruction:'Operate own workspace',resourceKey:'same-resource-'+n,dependencies:[]}))));
 const runsA=tasks[0].map(task=>sa.claimGoal(task.id)),runsB=tasks[1].map(task=>sb.claimGoal(task.id));
 assert.ok([...runsA,...runsB].every(Boolean),'each owner gets its own concurrency and resource locks');
 const macAction={type:'mac_codex',path:'/Users/other/project',content:'own device work'};f.db.prepare('INSERT INTO manager_resources(resource_key,run_id,lease_expires_at) VALUES(?,?,?)').run('mac:executor','privileged-operation',clock+600);
 sa.planActions(runsA[0],[macAction]);assert.notEqual(sa.beginAction(runsA[0],0,macAction).deferred,true);assert.equal(f.db.prepare("SELECT run_id FROM manager_resources WHERE resource_key='mac:executor'").get().run_id,'privileged-operation');
 assert.equal(sa.isCurrent(runsB[0]),false);assert.equal(sa.renewRun(runsB[0].id,runsB[0].fence),false);assert.equal(sa.finishRun(runsB[0]),false);
 assert.throws(()=>sa.taskEvidence(tasks[1][0].id),/Task not found/);
 clock+=120;sa.recoverExpired();assert.equal(f.db.prepare('SELECT state FROM manager_runs WHERE id=?').get(runsB[0].id).state,'running');
 assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM manager_activity WHERE manager_id=? AND task_id IN (?,?)').get(sa.managerId,...tasks[1].map(t=>t.id)).n===0);
 assert.equal((await f.request(otherOwner,'/health')).body.runningGoalIds,undefined);
 const unauth=await (await fetch(f.base+'/health',{headers:{'X-Dots-Owner':fixtureOwner}})).json();assert.deepEqual(unauth,{ok:true,service:'dots-runtime'});
});

test('ordinary Dots lists and downloads artifacts only through the existing owner namespace',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'dots-artifact-namespace-')),databasePath=path.join(root,'projection.sqlite3'),db=new DatabaseSync(databasePath);
 db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY,manager_id TEXT,instruction TEXT,thread_id TEXT,workspace TEXT,created_at INTEGER);CREATE TABLE agent_outputs(id INTEGER PRIMARY KEY,goal_id INTEGER,run_number INTEGER,status TEXT,summary TEXT,notification TEXT,created_at INTEGER);`);
 const insert=db.prepare('INSERT INTO goals VALUES(?,?,?,?,?,100)');insert.run(1,'manager:'+fixtureOwner,'own task','private-host-thread-id','/host/path/must/not/be/read');insert.run(2,'manager:'+otherOwner,'other task',null,'/host/other/path');
 const sandboxRoot=path.join(root,'isolated'),operate=(owner,input)=>workspaceOperation(owner,input,{root:sandboxRoot});
 let reader;
 try{
  await operate(fixtureOwner,{operation:'mkdir',path:'/workspace/dots/1',recursive:true});await operate(fixtureOwner,{operation:'write',path:'/workspace/dots/1/result.txt',content:'only account A'});
  await operate(otherOwner,{operation:'mkdir',path:'/workspace/dots/2',recursive:true});await operate(otherOwner,{operation:'write',path:'/workspace/dots/2/result.txt',content:'only account B'});
  reader=createDotsActivityReader({databasePath,workspaceRoot:'/host/must/not/be/read',sessionRoot:'/host/must/not/be/read',workspaceOperationImpl:operate});
  const a=await reader.outputs([1,2],fixtureOwner),b=await reader.outputs([1,2],otherOwner);
  assert.deepEqual(a.map(f=>f.taskId),[1]);assert.deepEqual(b.map(f=>f.taskId),[2]);assert.ok(!JSON.stringify(a).includes('/host/'));
  const key=Buffer.from('result.txt').toString('base64url');assert.equal((await reader.artifact(1,key,fixtureOwner)).data.toString(),'only account A');await assert.rejects(reader.artifact(1,key,otherOwner),e=>e.status===404);
  // A host path named in a user-created symlink is never opened by the backend.
  await execSandbox(fixtureOwner,{command:['/bin/ln','-s',databasePath,'/workspace/dots/1/outside-link.txt'],root:sandboxRoot});
  await assert.rejects(reader.artifact(1,Buffer.from('outside-link.txt').toString('base64url'),fixtureOwner));
 }finally{reader?.close();db.close();rmSync(root,{recursive:true,force:true});}
});

test('member control workspaces map to virtual task directories without following member paths',()=>{
 const root='/private/control/workspaces';
 assert.equal(memberDotsWorkingDirectory(root,root+'/17'),'/workspace/dots/17');
 assert.equal(memberDotsWorkingDirectory(root,root+'/.manager'),'/workspace/dots/.manager');
 for(const value of ['/workspace/dots/17','/private/control/workspaces-other/17',root+'/../other',root+'/17/nested'])assert.throws(()=>memberDotsWorkingDirectory(root,value),/Invalid member workspace/);
});
