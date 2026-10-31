import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {createManagerThread} from './manager-stream-transport.mjs';

function server({tool=false,configFailure=false}={}){
  const calls=[],processes=[];
  const spawnProcess=(binary,args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.emit('exit',0);return true;};processes.push({binary,args,child});
    const emit=message=>child.stdout.write(JSON.stringify(message)+'\n');
    child.stdin=new Writable({write(chunk,_encoding,done){for(const line of String(chunk).trim().split('\n')){
      const message=JSON.parse(line);calls.push(message);if(message.id===undefined)continue;
      const reply=result=>queueMicrotask(()=>emit({id:message.id,result}));
      if(message.method==='initialize')reply({});
      else if(message.method==='config/read')reply(configFailure?{}:{config:{mcp_servers:{'private-server':{command:'unused',tool_timeout_sec:null},'server.with.dots':{url:'unused',environment_id:null}}}});
      else if(message.method==='thread/start'||message.method==='thread/resume')reply({thread:{id:'thread-fixture'}});
      else if(message.method==='turn/start'){reply({turn:{id:'turn-fixture'}});setImmediate(()=>{
        const item=tool?{id:'tool-one',type:'mcpToolCall',server:'private-server',tool:'read'}:{id:'answer',type:'agentMessage',phase:'final_answer',text:'{"action":"discard"}'};
        emit({method:'item/started',params:{threadId:'thread-fixture',turnId:'turn-fixture',item}});
        if(!tool){emit({method:'item/agentMessage/delta',params:{threadId:'thread-fixture',turnId:'turn-fixture',itemId:'answer',delta:item.text}});emit({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item}});emit({method:'turn/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',turn:{id:'turn-fixture',status:'completed'}}});}
      });}else reply({});
    }done();}});return child;
  };
  return {calls,processes,spawnProcess};
}
const consume=async thread=>{const result=[];const {events}=await thread.runStreamed('synthetic review',{outputSchema:{type:'object'}});for await(const event of events)result.push(event);return result;};

test('private review uses ephemeral read-only configuration and disables each inherited MCP server',async()=>{
 const fake=server(),thread=createManagerThread({options:{allowTools:false,workingDirectory:'/tmp',sandboxMode:'danger-full-access',approvalPolicy:'on-request'},spawnProcess:fake.spawnProcess});
 const events=await consume(thread);assert.ok(events.some(event=>event.type==='turn.completed'));
 const params=fake.calls.find(call=>call.method==='thread/start').params;assert.equal(params.ephemeral,true);assert.equal(params.sandbox,'read-only');assert.equal(params.approvalPolicy,'never');
 assert.deepEqual(params.config.mcp_servers['private-server'],{command:'unused',enabled:false});assert.deepEqual(params.config.mcp_servers['server.with.dots'],{url:'unused',enabled:false});
 for(const feature of ['shell_tool','apps','plugins','hooks','multi_agent','browser_use','computer_use','goals'])assert.equal(params.config['features.'+feature],false);
 assert.equal(params.config.web_search,'disabled');assert.ok(fake.processes[0].args.includes('features.hooks=false'));
});

test('ordinary manager keeps existing transport and does not read or replace tool configuration',async()=>{
 const fake=server();await consume(createManagerThread({options:{workingDirectory:'/tmp'},spawnProcess:fake.spawnProcess}));
 assert.deepEqual(fake.processes[0].args,['app-server','--stdio']);assert.equal(fake.calls.some(call=>call.method==='config/read'),false);
 const params=fake.calls.find(call=>call.method==='thread/start').params;assert.equal(params.ephemeral,undefined);assert.equal(params.config['features.apps'],undefined);
});

test('private review rejects unexpected tool events and fails closed when configuration cannot be checked',async()=>{
 const fake=server({tool:true});await assert.rejects(consume(createManagerThread({options:{allowTools:false,workingDirectory:'/tmp'},spawnProcess:fake.spawnProcess})),/tool operation/);
 const failed=server({configFailure:true});await assert.rejects(consume(createManagerThread({options:{allowTools:false,workingDirectory:'/tmp'},spawnProcess:failed.spawnProcess})),/configuration/);assert.equal(failed.calls.some(call=>call.method==='turn/start'),false);
 assert.throws(()=>createManagerThread({threadId:'existing',options:{allowTools:false}}),/isolated thread/);
});
