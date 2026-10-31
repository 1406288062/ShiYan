import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatedOutputVisible, generatedPathVisible } from './generated-output.mjs';
import { SyncStore, jobMessageData } from './sync-store.mjs';
import { jobSnapshot } from './output-display.mjs';

const asset=filename=>({id:filename.replace(/\W/g,'_'),syncAssetId:filename.replace(/\W/g,'_'),filename,mimeType:'application/octet-stream',bytes:10});

test('generated transport and control directories never become deliverables even with document names',()=>{
  for(const file of ['/workspace/.shiyan/transport/snapshot.docx','/workspace/.shiyan/changes/result.pdf','/workspace/.git/report.pdf','/workspace/inputs/doc.docx','/workspace/outputs/.private.pdf'])assert.equal(generatedPathVisible(file),false,file);
  assert.equal(generatedPathVisible('/workspace/outputs/report.docx'),true);
  assert.equal(generatedPathVisible('/workspace/outputs/photo.png'),true);
  assert.equal(generatedPathVisible('/workspace/qa/report.docx'),true);
  assert.equal(generatedPathVisible('image.png'),true,'generated-image roots may live in .codex; capture checks paths relative to the allowed root');
});
test('document families and images survive but snapshots, source, archives and unknown extensions are hidden',()=>{
  for(const name of ['报告.docx','模板.dotx','合同.doc','正文.rtf','文档.odt','导出.pdf','表格.xlsx','数据.csv','演示.pptx','photo.png'])assert.equal(generatedOutputVisible(asset(name)),true,name);
  for(const name of ['ios-gap-snapshots-052f6b95.b64','metadata.jsonl','metadata.json','patch.py','bundle.zip','notes.bin','说明.txt','说明.md','private.key'])assert.equal(generatedOutputVisible(asset(name)),false,name);
});
test('job snapshots and authoritative assistant messages apply the same policy without changing user attachments',()=>{
  const assets=[asset('snapshot.b64'),asset('report.docx'),asset('photo.png')],job={id:'job',status:'completed',assets};
  assert.deepEqual(jobSnapshot(job).assets.map(a=>a.filename),['report.docx','photo.png']);
  assert.deepEqual(jobMessageData(job,{role:'assistant'}).assets.map(a=>a.filename),['report.docx','photo.png']);
  assert.deepEqual(jobMessageData(job,{role:'user',assets}).assets,assets);
});
test('legacy assistant helper cards create a fresh sync revision once; user uploads and on-disk assets remain unchanged',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-doc-output-'));let store=new SyncStore(root);
  try{
    const assets=[asset('snapshot.b64'),asset('report.docx'),asset('photo.png')];
    store.write('owner','messages','assistant',{id:'assistant',conversationId:'conversation',role:'assistant',text:'原文',state:'completed',assets});
    store.write('owner','messages','user',{id:'user',conversationId:'conversation',role:'user',assets});
    const cursor=store.list('owner').cursor;store.close();store=new SyncStore(root);
    assert.equal(store.get('owner','messages','assistant').revision,2);
    assert.deepEqual(store.get('owner','messages','assistant').data.assets.map(a=>a.filename),['report.docx','photo.png']);
    assert.equal(store.get('owner','messages','assistant').data.text,'原文');
    assert.equal(store.get('owner','messages','user').revision,1);
    assert.deepEqual(store.get('owner','messages','user').data.assets,assets);
    assert.deepEqual(store.list('owner',cursor).changes.map(c=>c.id),['assistant']);
    store.close();store=new SyncStore(root);assert.equal(store.get('owner','messages','assistant').revision,2);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('incoming assistant mutations cannot restore hidden attachments, while arbitrary user uploads sync',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-doc-mutations-'));const store=new SyncStore(root);
  try{
    const assets=[asset('snapshot.b64'),asset('document.docx')];
    for(const role of ['assistant','user'])store.putAuthoritative('owner','messages',role,{id:role,conversationId:'conversation',role,assets});
    assert.deepEqual(store.get('owner','messages','assistant').data.assets.map(a=>a.filename),['document.docx']);
    assert.equal(store.get('owner','messages','user').data.assets.length,2);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('streamed startup migration preserves large execution archives and visits each changed primary key once',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'shiyan-doc-long-'));let store=new SyncStore(root);
  try{
    const rawResult='long execution 原文 '.repeat(100000),displayItems=[{id:'tool',type:'mcp_tool_call',result_text:rawResult}];
    for(let i=0;i<4;i++)store.write('owner','messages','assistant-'+i,{id:'assistant-'+i,conversationId:'conversation',role:'assistant',text:'原文'+i,rawResult,displayItems,assets:[asset('snapshot.b64'),asset('report.docx')]});
    store.write('owner','messages','empty',{id:'empty',conversationId:'conversation',role:'assistant',rawResult,displayItems});
    store.write('owner','messages','user',{id:'user',conversationId:'conversation',role:'user',assets:[asset('snapshot.b64')]});
    const cursor=Number(store.db.prepare('SELECT MAX(seq) AS seq FROM sync_changes').get().seq);store.close();store=new SyncStore(root);
    for(let i=0;i<4;i++){
      const current=store.get('owner','messages','assistant-'+i);
      assert.equal(current.revision,2);assert.equal(current.data.rawResult,rawResult);assert.deepEqual(current.data.displayItems,displayItems);assert.equal(current.data.text,'原文'+i);
      assert.deepEqual(current.data.assets.map(a=>a.filename),['report.docx']);
    }
    assert.equal(store.get('owner','messages','empty').revision,1);
    assert.equal(store.get('owner','messages','empty').data.rawResult,rawResult);
    assert.equal(store.get('owner','messages','user').revision,1);
    store.removeInternalGeneratedAttachments();for(let i=0;i<4;i++)assert.equal(store.get('owner','messages','assistant-'+i).revision,2);
    let after=cursor,changed=[];while(true){const page=store.list('owner',after);changed.push(...page.changes.map(c=>c.id));after=page.cursor;if(!page.hasMore)break;}
    assert.deepEqual(changed,['assistant-0','assistant-1','assistant-2','assistant-3']);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
