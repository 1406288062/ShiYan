import path from 'node:path';
import {workspaceOperation} from './member-sandbox.ts';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const fail=(message,status=400,code='invalid_request')=>Object.assign(new Error(message),{status,code});
export const millis=value=>{const n=Number(value)||0;return n>0&&n<1e12?n*1000:n;};
const decode=(value,fallback: any={})=>{try{return JSON.parse(value);}catch{return fallback;}};
export function readableResult(value){
  const result=decode(value,null);
  if(result&&typeof result==='object'){
    const readable=field=>typeof field==='string'?field.trim()?field:'':field&&typeof field==='object'?JSON.stringify(field,null,2):'';
    const collect=keys=>keys.map(key=>readable(result[key])).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join('\n\n');
    return collect(['result','message'])||collect(['summary','notification'])||JSON.stringify(result,null,2);
  }
  return String(value||'');
}
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
// 面板只展示客户要的文件：脚本、测试文件不展示；只有回复里明确引用的文件，或图片/文档类交付物才展示。
const SCRIPT_EXTENSIONS=new Set(['.py','.sh','.bash','.zsh','.js','.mjs','.cjs','.ts','.rb','.pl','.ps1','.bat','.cmd','.swift','.java','.go','.rs','.c','.cpp','.h']);
const DELIVERABLE_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.gif','.webp','.pdf','.docx','.xlsx','.pptx','.csv']);
const TEST_NAME=/(^|[._-])(test|tests|spec|mock|fixture)([._-]|$)|[.](test|spec)[.]/i;
const TEST_DIRS=new Set(['test','tests','__tests__','qa','tmp','fixtures','mock','mocks']);
const mime=file=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.json':'application/json','.csv':'text/csv; charset=utf-8','.html':'text/html; charset=utf-8','.zip':'application/zip'})[path.extname(file).toLowerCase()]||'application/octet-stream';

// This projection only reads runtime records and visible assistant messages.
// System/developer prompts, reasoning and tool payloads are never returned.
export function createDotsActivityReader({databasePath='/home/ubuntu/dots-runtime/data/dots.sqlite3',workspaceRoot='/home/ubuntu/dots-runtime/workspaces',sessionRoot='/home/ubuntu/.codex/sessions',workspaceOperationImpl=workspaceOperation}={}){
  const privateOwner=owner=>owner===(process.env.SHIYAN_DOTS_OWNER||'shiyan-private-owner');
  let db;let sessionIndex=new Map(),indexedAt=0;
  const database=()=>db??=new DatabaseSync(databasePath,{readOnly:true});
  const goal=id=>database().prepare('SELECT id,manager_id,instruction,thread_id,workspace,created_at FROM goals WHERE id=?').get(id);
  const sessionFile=id=>{
    if(!/^[0-9a-f-]{20,64}$/i.test(id||''))return null;
    if(!sessionIndex.has(id)&&Date.now()-indexedAt>60000){
      sessionIndex=new Map();indexedAt=Date.now();
      const visit=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())visit(file);else if(entry.isFile()&&entry.name.endsWith('.jsonl')){const match=entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);if(match)sessionIndex.set(match[1],file);}}};
      try{visit(sessionRoot);}catch{}
    }
    return sessionIndex.get(id)||null;
  };
  const assistantMessages=threadId=>{
    const file=sessionFile(threadId);if(!file||statSync(file).size>32*1024*1024)return [];
    const messages: any[]=[],seen=new Set();
    for(const [index,line] of readFileSync(file,'utf8').split('\n').entries()){
      const event=decode(line,null),message=event?.payload;
      if(event?.type!=='response_item'||message?.type!=='message'||message.role!=='assistant'||message.channel==='analysis'||message.phase==='analysis')continue;
      if(message.channel&&!['commentary','final'].includes(message.channel))continue;
      const content=readableResult((message.content||[]).filter(c=>['output_text','text'].includes(c.type)).map(c=>c.text||'').join('\n')).trim();
      if(!content)continue;const id=message.id||'line-'+index;if(seen.has(id))continue;seen.add(id);
      messages.push({id:'worker:'+id,role:'assistant',content:content.slice(0,100000),createdAt:Date.parse(event.timestamp)||0,source:'worker_transcript',phase:message.phase||message.channel||'final'});
    }
    return messages.slice(-300);
  };
  const scopedWorkspace=(id,owner)=>{
    const row=goal(id);if(!row||row.manager_id!=='manager:'+owner)throw fail('输出不存在',404,'not_found');
    const root=realpathSync(workspaceRoot),workspace=realpathSync(row.workspace);
    if(!within(root,workspace)||workspace===root)throw fail('输出目录无效',404,'not_found');
    return workspace;
  };
  const replyCache=new Map();
  const replyText=id=>{if(!replyCache.has(id))replyCache.set(id,database().prepare('SELECT summary,notification FROM agent_outputs WHERE goal_id=? ORDER BY id DESC LIMIT 20').all(id).map(row=>[row.summary,row.notification].filter(Boolean).join(' ')).join(' '));return replyCache.get(id);};
  const wantedFile=(id,relative,name)=>{
    const ext=path.posix.extname(name).toLowerCase();
    if(SCRIPT_EXTENSIONS.has(ext)||TEST_NAME.test(name)||relative.split('/').some(part=>TEST_DIRS.has(part)))return false;
    const reply=replyText(Number(id));
    if(reply.includes('](' + relative)||reply.includes('](./' + relative))return true;
    return DELIVERABLE_EXTENSIONS.has(ext);
  };
  const files=(ids,owner,{limit=100}={})=>{
    const found: any[]=[];
    for(const id of ids){
      let workspace;try{workspace=scopedWorkspace(id,owner);}catch{continue;}
      let inspected=0;
      const walk=(dir,depth=0)=>{
        if(depth>6||inspected>3000||found.length>=limit)return;
        for(const entry of readdirSync(dir,{withFileTypes:true})){
          inspected++;if(entry.name.startsWith('.')||['node_modules','__pycache__','venv'].includes(entry.name))continue;
          const full=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;
          if(entry.isDirectory()){walk(full,depth+1);continue;}if(!entry.isFile())continue;
          const stat=statSync(full);if(!stat.size||stat.size>32*1024*1024)continue;
          const relative=path.relative(workspace,full),key=Buffer.from(relative).toString('base64url');
          if(!wantedFile(id,relative,entry.name))continue;
          found.push({id:'file:'+id+':'+key,kind:'file',taskId:Number(id),filename:entry.name,relativePath:relative,mimeType:mime(full),bytes:stat.size,createdAt:stat.mtimeMs,downloadPath:'/v1/dots/artifacts/'+id+'/'+key});
          if(found.length>=limit)return;
        }
      };
      try{walk(workspace);}catch{}
    }
    return found.sort((a,b)=>b.createdAt-a.createdAt).slice(0,limit);
  };
  const memberFiles=async(ids,owner,{limit=100}={})=>{
    const allowed=new Set(ids.filter(id=>goal(id)?.manager_id==='manager:'+owner).map(Number));
    if(!allowed.size)return [];
    const snapshot=await workspaceOperationImpl(owner,{operation:'snapshot'}),result: any[]=[];
    for(const file of snapshot.files||[]){
      const match=String(file.path||'').match(/^\/workspace\/dots\/(\d+)\/(.+)$/);if(!match||!allowed.has(Number(match[1])))continue;
      const relative=match[2];if(relative.split('/').some(part=>part.startsWith('.')||['node_modules','__pycache__','venv'].includes(part)))continue;
      if(!file.size||file.size>32*1024*1024)continue;
      const id=Number(match[1]),key=Buffer.from(relative).toString('base64url');
      if(!wantedFile(id,relative,path.posix.basename(relative)))continue;
      result.push({id:'file:'+id+':'+key,kind:'file',taskId:id,filename:path.posix.basename(relative),relativePath:relative,mimeType:mime(relative),bytes:file.size,createdAt:file.modifiedAt||0,downloadPath:'/v1/dots/artifacts/'+id+'/'+key});
    }
    return result.sort((a,b)=>b.createdAt-a.createdAt).slice(0,limit);
  };
  const memberArtifact=async(id,relative,owner)=>{
    if(goal(id)?.manager_id!=='manager:'+owner)throw fail('输出不存在',404,'not_found');
    const file=await workspaceOperationImpl(owner,{operation:'read',path:'/workspace/dots/'+id+'/'+relative});
    const data=Buffer.from(file.data||'','base64');if(data.length>32*1024*1024)throw fail('输出文件过大',413);
    return {filename:path.posix.basename(relative),mimeType:mime(relative),data,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
  };
  return {
    conversation(id,owner){
      const row=goal(id);if(!row||row.manager_id!=='manager:'+owner)throw fail('对话不存在',404,'not_found');
      const messages: any[]=[{id:'instruction:'+id,role:'user',content:row.instruction,createdAt:millis(row.created_at),source:'task_instruction'}];
      for(const item of database().prepare("SELECT id,payload,created_at FROM events WHERE goal_id=? AND type IN ('user_instruction','user_message') ORDER BY id LIMIT 300").all(id)){
        const parsed=decode(item.payload,null),content=typeof parsed==='string'?parsed:parsed?.message||parsed?.content||item.payload;
        if(content)messages.push({id:'input:'+item.id,role:'user',content,createdAt:millis(item.created_at),source:'user_instruction'});
      }
      // Follow-ups to completed tasks are sent to the manager with taskId.
      // Include those real user/assistant records in this task's conversation.
      try{for(const message of database().prepare("SELECT id,role,content,request_id,created_at FROM manager_messages WHERE manager_id=? AND task_id=? AND role IN ('user','assistant') ORDER BY id LIMIT 300").all('manager:'+owner,id)){
        if(message.role==='user'&&messages.some(existing=>existing.role==='user'&&existing.content===message.content&&Math.abs(existing.createdAt-millis(message.created_at))<5000))continue;
        messages.push({id:'manager:'+message.id,role:message.role,content:message.content,requestId:message.request_id,createdAt:millis(message.created_at),source:'manager_message'});
      }}catch{}
      const transcript=privateOwner(owner)?assistantMessages(row.thread_id):[];
      const outputs=database().prepare('SELECT id,goal_id,run_number,status,raw_result,summary,notification,created_at FROM agent_outputs WHERE goal_id=? ORDER BY id DESC LIMIT 100').all(id).reverse();
      if(transcript.length)messages.push(...transcript);
      else for(const output of outputs){const content=readableResult(output.raw_result)||output.notification||output.summary;if(content)messages.push({id:'output:'+output.id,role:'assistant',content,createdAt:millis(output.created_at),source:'worker_summary',runNumber:output.run_number});}
      return {messages:messages.sort((a,b)=>a.createdAt-b.createdAt),outputs,transcriptAvailable:transcript.length>0};
    },
    outputs(ids,owner,{limit=100}={}){
      if(!ids.length)return [];
      const rows=database().prepare('SELECT o.id,o.goal_id,o.run_number,o.status,o.summary,o.notification,o.created_at FROM agent_outputs o JOIN goals g ON g.id=o.goal_id WHERE g.manager_id=? AND o.goal_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY o.id DESC LIMIT ?').all('manager:'+owner,...ids,limit);
      // Run replies are no longer listed as .txt outputs.
      const unusedTexts=rows.map(row=>({id:'output:'+row.id,outputId:row.id,kind:'text',taskId:row.goal_id,filename:'任务-'+row.goal_id+'-第'+row.run_number+'次回复.txt',mimeType:'text/plain; charset=utf-8',summary:row.notification||row.summary,createdAt:millis(row.created_at),status:row.status,downloadPath:'/v1/dots/outputs/'+row.id+'/file'}));
      const combine=files=>[...files].sort((a,b)=>b.createdAt-a.createdAt).slice(0,limit);
      return privateOwner(owner)?combine(files(ids,owner,{limit})):memberFiles(ids,owner,{limit}).then(combine);
    },
    artifact(id,key,owner){
      if(!/^[A-Za-z0-9_-]{1,2048}$/.test(key))throw fail('文件标识无效');
      const relative=Buffer.from(key,'base64url').toString('utf8');if(Buffer.from(relative).toString('base64url')!==key||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||p.startsWith('.')))throw fail('文件路径无效');
      if(!privateOwner(owner))return memberArtifact(id,relative,owner);
      const workspace=scopedWorkspace(id,owner),file=path.resolve(workspace,relative);
      if(!within(workspace,file)||file===workspace||realpathSync(file)!==file||!lstatSync(file).isFile())throw fail('输出文件不存在',404,'not_found');
      const stat=statSync(file);if(stat.size>32*1024*1024)throw fail('输出文件过大',413);
      const data=readFileSync(file);return {filename:path.basename(file),mimeType:mime(file),data,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
    },close(){db?.close();}
  };
}
