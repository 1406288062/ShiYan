import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DotsAdapter } from './dots-adapter.mjs';
import { createDotsSidecar } from './dots-sidecar.mjs';

const owner='shiyan-private-owner';
function fixture(t){
  const root=mkdtempSync(path.join(os.tmpdir(),'dots-files-'));
  const manager={id:'manager:'+owner,ownerId:owner,status:'active',messages:[],tasks:[]};
  const calls=[],receipts=new Map();let loseReply=false;
  const client={async tool(name,args){
    if(name==='dots_get_manager_activity')return {activity:[],nextCursor:args.after_id,hasMore:false};
    if(name==='dots_get_manager_messages')return {messages:manager.messages,hasMore:false};
    if(name==='dots_get_manager')return {manager};
    if(name!=='dots_message_manager')throw Error(name);
    calls.push(args);
    if(receipts.has(args.request_id))return receipts.get(args.request_id);
    const message={id:manager.messages.length+1,role:'user',content:args.message,requestId:args.request_id};
    manager.messages.push(message);
    const result={accepted:true,message,manager:structuredClone(manager)};receipts.set(args.request_id,result);
    if(loseReply){loseReply=false;throw Error('lost reply');}return result;
  }};
  const options={root,client,eventReader:{close(){}},managerPollMs:0,recoverIntervalMs:0,subscriptionRefreshMs:0};
  let adapter=new DotsAdapter(options);
  t.after(()=>{adapter.close();rmSync(root,{recursive:true,force:true});});
  return {get adapter(){return adapter;},calls,manager,loseReply(){loseReply=true;},reopen(){adapter.close();adapter=new DotsAdapter(options);}};
}
const file=()=>({id:randomUUID(),filename:'说明.txt',mimeType:'text/plain',data:Buffer.from('这是上传文件的实际内容').toString('base64')});

test('file upload is owner scoped, durable, content checked and idempotent',t=>{
  const f=fixture(t),input=file(),a=f.adapter.attachments.upload(owner,input);
  assert.deepEqual(f.adapter.attachments.upload(owner,input),a);
  assert.throws(()=>f.adapter.attachments.download('other',a.id),e=>e.status===404);
  assert.throws(()=>f.adapter.attachments.upload(owner,{...input,data:Buffer.from('changed').toString('base64')}),e=>e.status===409);
  assert.throws(()=>f.adapter.attachments.upload(owner,{...file(),filename:'..'}));
  assert.throws(()=>f.adapter.attachments.upload(owner,{...file(),data:'invalid!'}));
  assert.throws(()=>f.adapter.attachments.resolve(owner,Array(9).fill(a.id)));
  f.reopen();assert.equal(f.adapter.attachments.download(owner,a.id).data.toString(),'这是上传文件的实际内容');
});

test('lost message reply retries the same files once and both client histories receive metadata',async t=>{
  const f=fixture(t),a=f.adapter.attachments.upload(owner,file());
  const input={requestId:randomUUID(),message:'分析这个文件',host:'shiyan_mobile',attachments:[a.id]};
  f.loseReply();await assert.rejects(f.adapter.messageManager(owner,input));
  const response=await f.adapter.messageManager(owner,input);
  assert.equal(f.manager.messages.length,1);assert.equal(response.message.content,input.message);
  assert.deepEqual(response.message.attachments,[a]);
  const metadata=JSON.parse(f.calls[0].message.split('[用户上传的附件]\n')[1].split('\n')[0]);
  assert.equal(readFileSync(metadata.path,'utf8'),'这是上传文件的实际内容');
  assert.equal(f.calls[0].request_id,f.calls[1].request_id);
  f.reopen();const history=await f.adapter.managerMessages(owner);
  assert.deepEqual(history.messages[0].attachments,[a]);assert.equal(history.messages[0].content,input.message);
  assert.throws(()=>f.adapter.attachments.resolve('other',[a.id]),e=>e.status===404);
});

test('signed upload/download HTTP routes retain exact bytes and reject wrong body hashes',async t=>{
  const f=fixture(t),server=createDotsSidecar({adapter:f.adapter,recover:false,authenticate:req=>req.headers['x-owner']===owner?{owner}:null});
  // The fixture owns adapter disposal; the HTTP server must not close it twice.
  server.removeAllListeners('close');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/v1/dots';
  const raw=JSON.stringify(file()),headers={'x-owner':owner,'content-type':'application/json','x-shiyan-body-sha':createHash('sha256').update(raw).digest('hex')};
  assert.equal((await fetch(base+'/attachments',{method:'POST',body:raw,headers:{...headers,'x-shiyan-body-sha':'bad'}})).status,401);
  const uploaded=await fetch(base+'/attachments',{method:'POST',body:raw,headers});assert.equal(uploaded.status,200);
  const {attachment}=await uploaded.json(),download=await fetch(base+'/attachments/'+attachment.id,{headers});
  assert.equal(download.status,200);assert.equal(await download.text(),'这是上传文件的实际内容');
  assert.equal(download.headers.get('x-content-sha256'),attachment.sha256);
  const imageInput={id:randomUUID(),filename:'wechat.png',mimeType:'image/png',data:Buffer.from('fake-png-bytes').toString('base64')};
  const imageRaw=JSON.stringify(imageInput),imageHeaders={...headers,'x-shiyan-body-sha':createHash('sha256').update(imageRaw).digest('hex')};
  const imageUpload=await fetch(base+'/attachments',{method:'POST',body:imageRaw,headers:imageHeaders});
  const {attachment:imageAttachment}=await imageUpload.json(),imageResponse=await fetch(base+'/attachments/'+imageAttachment.id,{headers});
  assert.equal(imageResponse.headers.get('content-type'),'image/png');
  assert.match(imageResponse.headers.get('content-disposition')||'',/^inline;/);
  assert.equal((await fetch(base+'/attachments/'+attachment.id)).status,401);
});
