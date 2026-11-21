import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execSandbox,workspaceOperation,resolveSandboxDestination,isPublicSandboxAddress,runIsolatedJob,mcpSandboxOperation} from './member-sandbox.ts';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'shiyan-member-test-'));const root=temp;test.after(()=>fs.rm(temp,{recursive:true,force:true}));
const event=(e: any)=>'data: '+JSON.stringify(e)+'\n\n';
const response=(output: any)=>new Response(output.map(event).join(''));
const provider=async()=>({url:'https://provider.invalid/responses',headers:{Authorization:'Bearer provider-secret'}});
test('actual shell cannot see host home, secrets, proc, network, or another user workspace',async()=>{
 await workspaceOperation('account:A',{operation:'write',path:'/workspace/private.txt',content:'owner A secret'},{root});
 const a=await execSandbox('account:A',{command:'cat /workspace/private.txt; hostname; test ! -e /home/ubuntu && echo no-host; test ! -e /proc/1/root && echo no-proc; find /home -maxdepth 1 -type d; curl --noproxy "*" --max-time 1 -s http://127.0.0.1:4323; test $? -ne 0 && echo no-host-network',root});
 assert.equal(a.exitCode,0);assert.match(a.stdout,/owner A secret/);assert.match(a.stdout,/workspace/);assert.match(a.stdout,/no-host/);assert.match(a.stdout,/no-proc/);assert.match(a.stdout,/no-host-network/);assert.doesNotMatch(a.stdout,/ubuntu/);
 await assert.rejects(workspaceOperation('account:B',{operation:'read',path:'/workspace/private.txt'},{root}),/不存在/);
 const escape=await execSandbox('account:A',{command:'ln -sf /home/ubuntu/.codex/auth.json /workspace/escape; cat /workspace/escape; unshare -Ur true',root});assert.notEqual(escape.exitCode,0);assert.doesNotMatch(escape.stdout,/access_token/);
 await assert.rejects(workspaceOperation('account:A',{operation:'read',path:'/workspace/escape'},{root}));
 await assert.rejects(workspaceOperation('account:A',{operation:'read',path:'/etc/passwd'},{root}),/工作区/);
});
test('own tools can create projects, nested files, mutate and read them across processes',async()=>{
 await workspaceOperation('account:project',{operation:'mkdir',path:'/workspace/projects/hello',recursive:true},{root});
 await workspaceOperation('account:project',{operation:'write',path:'/workspace/projects/hello/main.py',content:'print("works")\n'},{root});
 const run=await execSandbox('account:project',{command:'python3 main.py; git init -q; git add main.py; git diff --cached --numstat',cwd:'/workspace/projects/hello',root});assert.equal(run.exitCode,0);assert.match(run.stdout,/works/);assert.match(run.stdout,/1\s+0\s+main.py/);
 const files=await workspaceOperation('account:project',{operation:'list',path:'/workspace/projects/hello'},{root});assert.equal(files.entries.find((f: any)=>f.name==='main.py').size,15);
});
test('egress resolver rejects private, reserved, metadata, host, dual-resolution and IPv6 escapes',async()=>{
 for(const ip of ['127.0.0.1','10.8.2.3','169.254.169.254','100.100.100.200','172.16.0.1','192.168.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fe80::1','2001:db8::1','129.226.81.110'])assert.equal(isPublicSandboxAddress(ip),false,ip);
 for(const host of ['localhost','metadata.tencentyun.com','x.local','x.internal','127.0.0.1'])await assert.rejects(resolveSandboxDestination(host));
 await assert.rejects(resolveSandboxDestination('rebind.example',{lookup:(async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]) as any}));
 assert.deepEqual(await resolveSandboxDestination('public.example',{lookup:(async()=>[{address:'8.8.8.8',family:4}]) as any}),{address:'8.8.8.8',family:4});
});
test('per-account stdio MCP tools actually execute inside same isolated workspace',async()=>{
 const owner='account:mcp';await workspaceOperation(owner,{operation:'mkdir',path:'/workspace/.shiyan',recursive:true},{root});
 const server=`const r=require('readline').createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}}}}));if(m.id===2)console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:m.method==='tools/list'?{tools:[{name:'my_tool',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:require('fs').existsSync('/home/ubuntu')?'host leaked':'isolated-tool-'+m.params.arguments.value}]}}));});`;
 await workspaceOperation(owner,{operation:'write',path:'/workspace/mcp.cjs',content:server},{root});await workspaceOperation(owner,{operation:'write',path:'/workspace/.shiyan/mcp.json',content:JSON.stringify({servers:{mine:{command:'/usr/bin/node',args:['/workspace/mcp.cjs']}}})},{root});
 assert.equal((await mcpSandboxOperation(owner,{operation:'list_servers'},{root})).servers[0].name,'mine');
 assert.equal((await mcpSandboxOperation(owner,{operation:'list_tools',server:'mine'},{root})).result.tools[0].name,'my_tool');
 assert.equal((await mcpSandboxOperation(owner,{operation:'call_tool',server:'mine',name:'my_tool',arguments:{value:'A'}},{root})).result.content[0].text,'isolated-tool-A');
 assert.deepEqual((await mcpSandboxOperation('account:other',{operation:'list_servers'},{root})).servers,[]);
});
test('real tool loop calls isolated shell, reports changes and keeps transport credentials out of model/tools',async()=>{
 const requests: any[]=[],events: any[]=[];let n=0;const result=await runIsolatedJob({owner:'account:agent',prompt:'create a file',model:'test',reasoning:'low'},{root,getProvider:provider,refreshProvider:async()=>{},onEvent:e=>events.push(e),fetchImpl:async(url,options)=>{const request=JSON.parse(options.body);requests.push(request);n++;return n===1?response([{type:'response.completed',response:{status:'completed',output:[{type:'function_call',id:'fc_1',call_id:'call_1',name:'exec_command',arguments:JSON.stringify({command:'printf completed > result.txt'})}]}}]):response([{type:'response.output_text.delta',delta:'已创建'}, {type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'已创建'}]}],usage:{input_tokens:2,output_tokens:3}}}]);}});
 assert.equal(result.text,'已创建');assert.equal(result.fileChanges.find(f=>f.path==='/workspace/result.txt')!.kind,'add');assert.equal(events.find(e=>e.type==='item.completed')!.item.exit_code,0);assert.equal(requests[1].input.find((i: any)=>i.type==='function_call_output')!.call_id,'call_1');assert.equal(JSON.stringify(requests).includes('provider-secret'),false);assert.notDeepEqual(requests[0].tools,[]);
});

test('untrusted summaries cannot execute model-returned tools and strict structured output is preserved',async()=>{
 let request;await assert.rejects(runIsolatedJob({owner:'account:summary',prompt:'untrusted mail',model:'test'},{root,allowTools:false,outputSchema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false},getProvider:provider,fetchImpl:async(url,options)=>{request=JSON.parse(options.body);return response([{type:'response.completed',response:{status:'completed',output:[{type:'function_call',id:'bad',call_id:'bad',name:'exec_command',arguments:'{"command":"touch unsafe"}'}]}}]);}}),/AI服务/);
 assert.deepEqual(request!.tools,[]);assert.equal(request!.tool_choice,'none');assert.equal(request!.text.format.strict,true);await assert.rejects(workspaceOperation('account:summary',{operation:'read',path:'/workspace/unsafe'},{root}),/不存在/);
});
test('download artifacts are captured only from the same owner and skip private configuration',async()=>{
 const {collectSandboxArtifacts}=await import('./member-sandbox.ts');await workspaceOperation('account:download',{operation:'mkdir',path:'/workspace/.shiyan',recursive:true},{root});
 await workspaceOperation('account:download',{operation:'write',path:'/workspace/report.txt',content:'private result'},{root});await workspaceOperation('account:download',{operation:'write',path:'/workspace/.shiyan/mcp.json',content:'private credential'},{root});
 const found=await collectSandboxArtifacts('account:download',{text:'[下载](/workspace/report.txt) [配置](/workspace/.shiyan/mcp.json)',root});assert.equal(found.length,1);assert.equal(Buffer.from(found[0].data,'base64').toString(),'private result');assert.deepEqual(await collectSandboxArtifacts('account:download-other',{text:'[下载](/workspace/report.txt)',root}),[]);
});
test('aggregate workspace quota stops shell writes without deleting data and rejects further API writes',async()=>{
 const owner='account:quota';const run=await execSandbox(owner,{command:"python3 -c \"from pathlib import Path; [Path('/workspace/quota-'+str(i)).open('wb').truncate(134217728) for i in range(17)]\"; sleep 2",root,timeoutMs:10000});assert.notEqual(run.exitCode,0);assert.match(run.stderr,/存储配额/);
 await assert.rejects(workspaceOperation(owner,{operation:'write',path:'/workspace/new.txt',content:'new'},{root}),/配额/);
 const list=await workspaceOperation(owner,{operation:'list',path:'/workspace'},{root});assert.equal(list.entries.filter((f: any)=>f.name.startsWith('quota-')).length,17);
 // Cleanup is explicit and user initiated, never an automatic data deletion.
 assert.equal((await execSandbox(owner,{command:'rm -f /workspace/quota-*',root})).exitCode,0);await workspaceOperation(owner,{operation:'write',path:'/workspace/new.txt',content:'recovered'},{root});
});

test('terminal cancellation kills background descendants, not only the client process',async()=>{
 const {spawnSandbox,memberWorkspaceHostPath}=await import('./member-sandbox.ts');const pause=(ms: any)=>new Promise(resolve=>setTimeout(resolve,ms));
 for(const method of ['SIGTERM','SIGKILL','abort']){const owner='account:lifetime:'+method,abort=new AbortController();const child=await spawnSandbox(owner,{command:'(while true; do echo tick >> /workspace/ticks; sleep 0.1; done) & echo ready; wait',signal:abort.signal,root,timeoutMs:5000});child.stderr.resume();await new Promise(resolve=>child.stdout.once('data',resolve));const closed=new Promise(resolve=>child.once('close',resolve));if(method==='abort')abort.abort();else child.kill(method as any);await closed;const file=memberWorkspaceHostPath(owner,{root})+'/ticks',before=await fs.readFile(file,'utf8').catch(()=>null);await pause(350);assert.equal(await fs.readFile(file,'utf8').catch(()=>null),before,method);}
});
test('agent project IDs bind to the authenticated owner project and cannot select another owner project',async()=>{
 const owner='account:project-agent';await workspaceOperation(owner,{operation:'mkdir',path:'/workspace/.shiyan',recursive:true},{root});await workspaceOperation(owner,{operation:'mkdir',path:'/workspace/projects/bound',recursive:true},{root});await workspaceOperation(owner,{operation:'write',path:'/workspace/.shiyan/workspace.json',content:JSON.stringify({projects:[{id:'private-project-id',path:'/workspace/projects/bound'}]})},{root});
 let turn=0;const result=await runIsolatedJob({owner,projectId:'private-project-id',cwd:'/workspace',prompt:'where',model:'test'},{root,getProvider:provider,fetchImpl:async()=>++turn===1?response([{type:'response.completed',response:{status:'completed',output:[{type:'function_call',call_id:'where',name:'exec_command',arguments:'{"command":"pwd"}'}]}}]):response([{type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}]}}])});assert.match(result.displayItems[0].aggregated_output,/\/workspace\/projects\/bound/);
 await assert.rejects(runIsolatedJob({owner:'account:project-stranger',projectId:'private-project-id',prompt:'steal',model:'test'},{root,getProvider:provider,fetchImpl:()=>{throw Error('must not infer');}}),/项目不存在/);
});

test('real before/after edits return unified diffs and exact counts for the file change viewer',async()=>{
 const owner='account:diff-viewer',before='header\nold first\n'+Array.from({length:10},(_,i)=>'unchanged '+i+'\n').join('')+'old last\nfooter\n',after=before.replace('old first','new first').replace('old last','new last');
 await workspaceOperation(owner,{operation:'write',path:'/workspace/main.txt',content:before},{root});let turn=0;
 const result=await runIsolatedJob({owner,prompt:'update two lines',model:'test'},{root,getProvider:provider,fetchImpl:async()=>++turn===1?response([{type:'response.completed',response:{status:'completed',output:[{type:'function_call',call_id:'edit',name:'write_file',arguments:JSON.stringify({path:'/workspace/main.txt',content:after})}]}}]):response([{type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}]}}])});
 const file=result.fileChanges.find(f=>f.path==='/workspace/main.txt')!;assert.equal(file.kind,'update');assert.equal(file.available,true);assert.equal(file.added,2);assert.equal(file.removed,2);assert.equal(file.additions,2);assert.equal(file.deletions,2);assert.match(file.diff,/^--- a\/main.txt\n\+\+\+ b\/main.txt\n/m);assert.match(file.diff,/^-old first$/m);assert.match(file.diff,/^\+new last$/m);assert.equal((file.diff.match(/^@@/gm)||[]).length,2);assert(!file.diff.includes('/home/ubuntu'));
});
test('diff add/delete, binary explanations and aggregate limits preserve honest viewer semantics',async()=>{
 const {changedFiles}=await import('./member-agent.ts');
 const change=await changedFiles({files:[{path:'/workspace/removed.txt',text:'old\n',sha256:'a'}]},{files:[{path:'/workspace/added.txt',text:'new\n',sha256:'b'},{path:'/workspace/binary.dat',size:2,textUnavailableReason:'binary'}]});
 const added=change.find(f=>f.kind==='add'&&f.path.endsWith('added.txt'))!,removed=change.find(f=>f.kind==='delete')!;assert.equal(added.available,true);assert.equal(added.added,1);assert.equal(added.removed,0);assert.match(added.diff,/^\+new$/m);assert.equal(removed.available,true);assert.equal(removed.added,0);assert.equal(removed.removed,1);assert.match(removed.diff,/^-old$/m);
 const binary=change.find(f=>f.path.endsWith('.dat'))!;assert.equal(binary.available,false);assert.equal(binary.added,null);assert.equal(binary.diff,'');assert.match(binary.source!,/二进制/);
 const limited=await changedFiles({files:[]},{files:Array.from({length:205},(_,i)=>({path:'/workspace/f'+i,text:'x\n',sha256:String(i)}))},{maxDiffBytes:128});assert.equal(limited.length,200);assert(limited.reduce((sum,f)=>sum+Buffer.byteLength(f.diff),0)<=128);assert(limited.some(f=>f.available===false&&f.diffTruncated&&f.source!.includes('上限')));
 assert.deepEqual(await changedFiles({files:[{path:'/workspace/stable',size:7,modifiedAt:1,sha256:'stable',text:'stable!'}]},{files:[{path:'/workspace/stable',size:7,modifiedAt:1,textUnavailableReason:'snapshot-budget'}]}),[]);
 assert.deepEqual(await changedFiles({files:[],truncated:true},{files:[{path:'/workspace/unknown-existing',text:'x',sha256:'x'}]}),[]);
});
test('snapshot refuses invalid UTF8 and binary data instead of inventing text diff',async()=>{
 const owner='account:diff-bytes';await workspaceOperation(owner,{operation:'write',path:'/workspace/invalid.dat',data:Buffer.from([255,254,1]).toString('base64')},{root});await workspaceOperation(owner,{operation:'write',path:'/workspace/binary.dat',data:Buffer.from([0,1,2]).toString('base64')},{root});
 const snapshot=await workspaceOperation(owner,{operation:'snapshot'},{root});assert.equal(snapshot.files.find((f: any)=>f.path.endsWith('invalid.dat')).textUnavailableReason,'invalid-utf8');assert.equal(snapshot.files.find((f: any)=>f.path.endsWith('binary.dat')).textUnavailableReason,'binary');assert(snapshot.files.every((f: any)=>f.text===undefined));
});
