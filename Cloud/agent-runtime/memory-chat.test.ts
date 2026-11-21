import test from 'node:test';
import assert from 'node:assert/strict';
import {chatMemoryScope,createChatMemory} from './memory-chat.ts';

function fixture(){
  const reads: any[]=[],contexts: any[]=[],captures: any[]=[],warnings: any[]=[];
  const state={conversations:{c:{id:'conversation',owner:'owner'}}};
  const records=new Map([['conversations:conversation',{data:{projectId:'project'}}],['projects:project',{data:{id:'project'}}]]);
  const syncStore={get(owner,kind,id){reads.push({owner,kind,id});return records.get(kind+':'+id);}};
  const memory={context(owner,input){contexts.push({owner,input});return 'REMEMBERED_CONTEXT';},enqueue(input){captures.push(input);return true;}};
  const bridge=createChatMemory(memory,{state,syncStore,logger:{warn:x=>warnings.push(x)}});
  const job={id:'job',owner:'owner',conversationKey:'c',prompt:'请继续拾燕项目',text:'当前进展',status:'completed',createdAt:1000,projectId:'spoofed'};
  return {state,records,reads,memory,contexts,captures,warnings,bridge,job,syncStore};
}

test('memory context uses authenticated conversation/project metadata, never the claimed project',()=>{
  const f=fixture(),before=JSON.stringify(f.job);
  assert.match(f.bridge.context(f.job),/REMEMBERED_CONTEXT/);
  assert.match(f.bridge.context(f.job),/Previously injected memory not listed this turn has been withdrawn/);
  assert.deepEqual(f.contexts[0],{owner:'owner',input:{text:f.job.prompt,conversationId:'conversation',projectId:'project'}});
  assert.ok(f.reads.every(r=>r.owner==='owner'));
  assert.equal(JSON.stringify(f.job),before);
  f.records.delete('projects:project');
  assert.equal(chatMemoryScope(f.job,f)?.projectId,undefined);
  f.state.conversations.c.owner='foreign';
  assert.equal(f.bridge.context(f.job),'');
  assert.equal(f.bridge.completed(f.job),false);
});

test('completed chat captures only this turn with a stable source, without waiting for extraction',()=>{
  const f=fixture();assert.equal(f.bridge.completed(f.job),true);
  assert.deepEqual(f.captures[0],{owner:'owner',sourceId:'job:job',source:'chat',userText:f.job.prompt,assistantText:f.job.text,sourceAt:1000,conversationId:'conversation',projectId:'project'});
  assert.equal(f.bridge.completed({...f.job,status:'cancelled'}),false);
  assert.equal(f.bridge.completed({...f.job,status:'failed'}),false);
  assert.equal(f.captures.length,1);
  f.memory.context=()=>{throw new Error('private error');};f.memory.enqueue=()=>{throw new Error('private error');};
  assert.match(f.bridge.context(f.job),/No additional long-term memory is available/);assert.equal(f.bridge.completed(f.job),false);
  assert.equal(f.warnings.length,2);assert.ok(f.warnings.every(w=>!w.includes('private error')));
});
