import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { agentPrompt } from './agent-input.ts';
const dir=await mkdtemp(path.join(os.tmpdir(),'shiyan-input-'));
try {
 const cli=path.join(dir,'fake-codex.cjs'),report=path.join(dir,'input.json');
 await writeFile(cli,`#!/usr/bin/env node\nlet s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').writeFileSync(process.env.SHIYAN_INPUT_REPORT,JSON.stringify({stdin:s,args:process.argv.slice(2)}));if(!s.trim()){console.error('No prompt provided via stdin.');process.exit(1)}console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));});\n`);await chmod(cli,0o700);
 const codex=new Codex({codexPathOverride:cli,env:{PATH:process.env.PATH || '',SHIYAN_INPUT_REPORT:report}});
 await assert.rejects(async()=>{
  const {events}=await codex.startThread().runStreamed([{type:'local_image',path:'/tmp/reference.png'}]);
  for await(const e of events){}
 }, /No prompt provided via stdin/);
 for(const prompt of ['', '  ', '按图修改颜色']) {
  const input=[{type:'text',text:agentPrompt(prompt,[],1)},{type:'local_image',path:'/tmp/reference.png'}];
  const {events}=await codex.startThread({skipGitRepoCheck:true}).runStreamed(input as any);for await(const e of events){}
  const x=JSON.parse(await readFile(report,'utf8'));assert(x.stdin.trim());assert(x.args.includes('/tmp/reference.png'));
  if(prompt.trim())assert.equal(x.stdin,prompt);
 }
 assert.equal(agentPrompt('原文\n第二行',[],0),'原文\n第二行');
 assert(agentPrompt('',[{role:'user',text:'先前请求'}],1).includes('先前请求'));
 console.log('PASS: image-only and whitespace-only input deliver nonempty stdin with images; text remains exact; branch history retained');
} finally {await rm(dir,{recursive:true,force:true});}
