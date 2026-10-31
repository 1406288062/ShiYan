import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DotsAdapter } from './dots-adapter.mjs';
import { createDotsActivityReader } from './dots-activity.mjs';
import { DotsSchedules, nextScheduleRun } from './dots-schedules.mjs';
import { createDotsSidecar } from './dots-sidecar.mjs';

const OWNER='shiyan-private-owner';
const baseSchedule={enabled:true,repeat:'daily',time:'21:00',timezone:'Asia/Shanghai',startDate:'2026-10-13',endDate:null};
test('schedule calendar preserves local timezone, weekdays, month end and inclusive end date',()=>{
  assert.equal(new Date(nextScheduleRun(baseSchedule,Date.parse('2026-10-13T12:59:00Z'))).toISOString(),'2026-10-13T13:00:00.000Z');
  assert.equal(new Date(nextScheduleRun(baseSchedule,Date.parse('2026-10-13T13:00:00Z'))).toISOString(),'2026-10-14T13:00:00.000Z');
  assert.equal(new Date(nextScheduleRun({...baseSchedule,repeat:'weekdays'},Date.parse('2026-10-16T14:00:00Z'))).toISOString(),'2026-10-19T13:00:00.000Z');
  assert.equal(new Date(nextScheduleRun({...baseSchedule,repeat:'monthly',startDate:'2026-01-31'},Date.parse('2026-01-31T14:00:00Z'))).toISOString(),'2026-02-28T13:00:00.000Z');
  assert.equal(nextScheduleRun({...baseSchedule,endDate:'2026-10-13'},Date.parse('2026-10-13T13:00:00Z')),null);
  assert.equal(new Date(nextScheduleRun({...baseSchedule,time:'09:00',timezone:'America/New_York',startDate:'2026-10-31'},Date.parse('2026-10-31T14:00:00Z'))).toISOString(),'2026-11-01T14:00:00.000Z');
});

function scheduleFixture(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'dots-schedule-test-'));
  let timestamp=Date.parse('2026-10-13T12:59:00Z'),status='active',lost=false;
  const calls=[],receipts=new Map();
  const client={async rpc(){return {};},async tool(name,args){
    calls.push({name,args});
    if(name==='dots_get_manager')return {manager:{id:'manager:'+OWNER,ownerId:OWNER,name:'大内总管',status,tasks:[],messages:[],activityCursor:0}};
    if(name==='dots_create_goal'){
      if(receipts.has(args.request_id))return receipts.get(args.request_id);
      const result={goal:{id:100+receipts.size,title:args.title,instruction:args.instruction,status:'active',created_at:Math.floor(timestamp/1000)}};receipts.set(args.request_id,result);
      if(lost){lost=false;throw Object.assign(new Error('Lost response'),{status:503});}return result;
    }
    throw new Error('Unexpected fixture tool: '+name);
  }};
  const adapter=new DotsAdapter({root,client,eventReader:null,activityReader:null,recoverIntervalMs:0,subscriptionRefreshMs:0,managerPollMs:0,schedulePollMs:0});
  adapter.schedules.close();adapter.schedules=new DotsSchedules(adapter,{pollMs:0,now:()=>timestamp});
  t.after(()=>{adapter.close();rmSync(root,{recursive:true,force:true});});
  return {adapter,calls,receipts,setNow(value){timestamp=Date.parse(value);},status(value){status=value;},lose(){lost=true;}};
}
test('schedule settings persist, updates deduplicate, response loss never dispatches twice and manager pause blocks runs',async t=>{
  const f=scheduleFixture(t),s=f.adapter.schedules;
  const input={requestId:'create-schedule',title:'夜间项目安排',instruction:'汇总已授权任务',...baseSchedule};
  const created=await s.create(OWNER,input),id=created.schedule.id;
  assert.equal((await s.create(OWNER,input)).schedule.id,id);
  assert.equal(s.list(OWNER).schedules.length,1);
  const reopened=new DatabaseSync(f.adapter.store.db.location());assert.equal(reopened.prepare('SELECT title FROM dots_schedules').get().title,input.title);reopened.close();
  await assert.rejects(s.create(OWNER,{...input,requestId:'bad',timezone:'Not/AZone'}),error=>error.status===400);
  assert.throws(()=>s.get('foreign-owner',id),error=>error.status===404);
  f.setNow('2026-10-13T13:00:01Z');f.status('paused');await s.tick();assert.equal(f.receipts.size,0);
  f.status('active');f.lose();await s.tick();assert.equal(f.receipts.size,1);assert.equal(s.get(OWNER,id).schedule.lastTaskId,null);
  await s.tick();assert.equal(f.receipts.size,1);assert.equal(s.get(OWNER,id).schedule.lastTaskId,100);
  assert.equal(s.get(OWNER,id).schedule.nextRunAt,Date.parse('2026-10-14T13:00:00Z'));
  await s.tick();assert.equal(f.calls.filter(c=>c.name==='dots_create_goal').length,2);
  const changed=await s.update(OWNER,id,{requestId:'change-schedule',title:'新的标题'});assert.equal(changed.schedule.title,'新的标题');
  const revision=changed.schedule.revision;await s.update(OWNER,id,{requestId:'change-schedule',title:'新的标题'});assert.equal(s.get(OWNER,id).schedule.revision,revision);
  await s.control(OWNER,id,{requestId:'pause-schedule',action:'pause'});assert.equal(s.get(OWNER,id).schedule.enabled,false);
  const cancel={requestId:'cancel-schedule',action:'cancel'};assert.equal((await s.control(OWNER,id,cancel)).deleted,true);assert.equal((await s.control(OWNER,id,cancel)).deleted,true);assert.equal(s.list(OWNER).schedules.length,0);
});

test('recent activity excludes imported history and acceptance runs without dropping current follow-up tasks',async t=>{
  const f=scheduleFixture(t);
  const tasks=Array.from({length:30},(_,i)=>({id:i+1,title:i>=23&&i<25?'接入验收':'任务 '+(i+1),status:'done',createdAt:1000+i,updatedAt:1000+i,legacyImported:i<25,originHost:i>=25&&i%2?'other':'shiyan_desktop'}));
  f.adapter.client.tool=async name=>{
    assert.equal(name,'dots_get_manager');
    return {manager:{id:'manager:'+OWNER,ownerId:OWNER,name:'大内总管',status:'active',tasks,messages:[],activityCursor:0}};
  };
  let outputIDs;
  f.adapter.activityReader={outputs(ids,owner){assert.equal(owner,OWNER);outputIDs=ids;return ids.map(id=>({id:'output:'+id,taskId:id}));},close(){}};
  const panel=await f.adapter.activity(OWNER,{limit:500});
  assert.deepEqual(panel.activities.map(a=>a.taskId),[30,29,28,27,26]);
  assert.deepEqual(outputIDs,[26,27,28,29,30]);
  assert.deepEqual(panel.outputs.map(o=>o.taskId),outputIDs);
  assert.equal(panel.hasMore,false);
  assert.ok(panel.activities.some(a=>a.taskId===28)); // Current follow-ups may have originHost=other.
  assert.equal(JSON.parse(f.adapter.store.manager(OWNER).snapshot).tasks.length,30);
  assert.equal(f.adapter.store.mappings(OWNER).length,30); // Hiding leaves the archive intact.
});

test('worker projection reads real visible turns and downloads only files in the owned workspace',async t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'dots-activity-test-')),databasePath=path.join(root,'runtime.db'),workspaceRoot=path.join(root,'workspaces'),workspace=path.join(workspaceRoot,'7'),sessionRoot=path.join(root,'sessions');
  mkdirSync(workspace,{recursive:true});mkdirSync(sessionRoot);writeFileSync(path.join(workspace,'answer.txt'),'actual output');
  writeFileSync(path.join(root,'outside.txt'),'private');symlinkSync(path.join(root,'outside.txt'),path.join(workspace,'escape.txt'));
  const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE goals(id INTEGER,manager_id TEXT,instruction TEXT,thread_id TEXT,workspace TEXT,created_at INTEGER); CREATE TABLE events(id INTEGER,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER); CREATE TABLE agent_outputs(id INTEGER,goal_id INTEGER,run_number INTEGER,status TEXT,raw_result TEXT,summary TEXT,notification TEXT,created_at INTEGER); CREATE TABLE manager_messages(id INTEGER,manager_id TEXT,task_id INTEGER,role TEXT,content TEXT,request_id TEXT,created_at INTEGER);');
  const thread='12345678-1234-1234-1234-123456789abc';db.prepare('INSERT INTO goals VALUES(?,?,?,?,?,?)').run(7,'manager:'+OWNER,'用户真实指令',thread,workspace,1791877200);
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(1,7,'user_instruction','追加真实指令',1791877201);
  db.prepare('INSERT INTO manager_messages VALUES(?,?,?,?,?,?,?)').run(4,'manager:'+OWNER,7,'user','完成后追加问题','req-followup',Date.parse('2026-10-13T13:00:04Z')/1000);
  db.prepare('INSERT INTO agent_outputs VALUES(?,?,?,?,?,?,?,?)').run(2,7,1,'done','{"summary":"实际完成的回复","notification":"实际完成的回复"}','实际完成的回复','',1791877203);
  writeFileSync(path.join(sessionRoot,'rollout-'+thread+'.jsonl'),[
    {timestamp:'2026-10-13T13:00:02Z',type:'response_item',payload:{type:'message',id:'reasoning',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'NEVER EXPOSE REASONING'}]}},
    {timestamp:'2026-10-13T13:00:02Z',type:'response_item',payload:{type:'message',id:'visible',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'正在处理真实任务'}]}},
    {timestamp:'2026-10-13T13:00:03Z',type:'response_item',payload:{type:'message',id:'final',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'{"summary":"实际完成的回复","notification":"实际完成的回复"}'}]}}
  ].map(JSON.stringify).join('\n'));
  const reader=createDotsActivityReader({databasePath,workspaceRoot,sessionRoot});t.after(()=>{reader.close();db.close();rmSync(root,{recursive:true,force:true});});
  const conversation=reader.conversation(7,OWNER);assert.equal(conversation.transcriptAvailable,true);assert.ok(conversation.messages.some(m=>m.content==='正在处理真实任务'));assert.ok(!JSON.stringify(conversation).includes('NEVER EXPOSE'));
  assert.ok(conversation.messages.some(m=>m.content==='实际完成的回复'));assert.equal(conversation.messages.at(-1).content,'完成后追加问题');assert.equal(conversation.messages.at(-1).source,'manager_message');assert.throws(()=>reader.conversation(7,'foreign-owner'),error=>error.status===404);
  const outputs=reader.outputs([7],OWNER);assert.ok(outputs.some(o=>o.kind==='text'));const file=outputs.find(o=>o.filename==='answer.txt');assert.ok(file);assert.ok(!outputs.some(o=>o.filename==='escape.txt'));
  assert.equal(reader.artifact(7,file.downloadPath.split('/').at(-1),OWNER).data.toString(),'actual output');
  assert.throws(()=>reader.artifact(7,Buffer.from('../outside.txt').toString('base64url'),OWNER));assert.throws(()=>reader.artifact(7,Buffer.from('escape.txt').toString('base64url'),OWNER));
});

test('schedule HTTP API authenticates owners and rejects unsigned writes',async t=>{
  const f=scheduleFixture(t),server=createDotsSidecar({adapter:f.adapter,recover:false,authenticate:req=>req.headers['x-fixture-owner']?{owner:req.headers['x-fixture-owner']}:null});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.removeAllListeners('close');server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port,headers={'x-fixture-owner':OWNER};
  assert.equal((await fetch(base+'/v1/dots/schedules')).status,401);
  const body=JSON.stringify({requestId:'http-schedule',title:'实际定时任务',instruction:'实际指令',...baseSchedule});
  assert.equal((await fetch(base+'/v1/dots/schedules',{method:'POST',headers,body})).status,401);
  const response=await fetch(base+'/v1/dots/schedules',{method:'POST',headers:{...headers,'x-shiyan-body-sha':createHash('sha256').update(body).digest('hex')},body});assert.equal(response.status,200);
  const created=await response.json();assert.equal(created.schedule.title,'实际定时任务');
  assert.equal((await (await fetch(base+'/v1/dots/schedules/'+created.schedule.id,{headers})).json()).schedule.repeat,'daily');
});
