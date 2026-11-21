import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createManagerStore} from './manager-store.mjs';
import {repairMailPresentationLinks} from './mail-link-repair.mjs';

test('persisted mail repair advances revisions and publishes owner-scoped updates exactly once',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(`CREATE TABLE goals(id INTEGER PRIMARY KEY,title TEXT,instruction TEXT,status TEXT,workspace TEXT,created_at INTEGER,updated_at INTEGER,next_wake_at INTEGER,last_summary TEXT,run_count INTEGER);
   CREATE TABLE events(id INTEGER PRIMARY KEY,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);
   CREATE TABLE approvals(id INTEGER PRIMARY KEY,goal_id INTEGER,reason TEXT,command TEXT,status TEXT,created_at INTEGER);
   CREATE TABLE dots_mail_events(id TEXT PRIMARY KEY,manager_id TEXT,state TEXT,message_id INTEGER);`);
  const a=createManagerStore({db,ownerId:'account-A',now:()=>100}),b=createManagerStore({db,ownerId:'account-B',now:()=>100});
  const broken='邮件中的链接：\n[1. https://sz.duoyi.com（电脑端登录），使用手机号12345678901](<https://sz.duoyi.com（电脑端登录），使用手机号12345678901>)';
  for(const [id,manager]of [[1,a.managerId],[2,b.managerId]]){
   db.prepare("INSERT INTO manager_messages(id,manager_id,role,content,created_at,revision,origin)VALUES(?,?,'assistant',?,100,1,'proactive')").run(id,manager,broken);
   db.prepare("INSERT INTO dots_mail_events VALUES(?,?,'sent',?)").run('mail-'+id,manager,id);
  }
  assert.equal(repairMailPresentationLinks(a),1);
  const first=db.prepare('SELECT * FROM manager_messages WHERE id=1').get(),other=db.prepare('SELECT * FROM manager_messages WHERE id=2').get();
  assert.equal(first.revision,2);assert(first.content.includes('](<https://sz.duoyi.com>)（电脑端登录）'));
  assert.equal(other.content,broken);assert.equal(other.revision,1);
  const event=db.prepare('SELECT * FROM manager_activity WHERE manager_id=?').get(a.managerId);
  assert.equal(event.kind,'assistant_delta');assert.equal(JSON.parse(event.data).message.revision,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manager_activity WHERE manager_id=?').get(b.managerId).n,0);
  assert.equal(repairMailPresentationLinks(a),0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manager_activity').get().n,1);
  assert.equal(db.prepare('SELECT state,message_id FROM dots_mail_events WHERE id=?').get('mail-1').state,'sent');
 }finally{db.close();}
});
