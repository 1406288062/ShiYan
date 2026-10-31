import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
let bytes=[];for await(const chunk of process.stdin)bytes.push(chunk);const input=JSON.parse(Buffer.concat(bytes).toString('utf8'));
const fail=message=>{throw new Error(message);};
function virtual(value='/workspace'){if(typeof value!=='string'||value.includes('\0'))fail('工作区路径无效');const result=path.posix.resolve('/workspace',value);if(result!=='/workspace'&&!result.startsWith('/workspace/'))fail('只能访问自己的工作区');return result;}
const target=virtual(input.path);let result;
async function confined(p,{missing=false}={}){let real;try{real=await fs.realpath(p);}catch(error){if(!missing||error.code!=='ENOENT')throw error;const parent=await confined(path.dirname(p),{missing:true});return path.join(parent,path.basename(p));}if(real!=='/workspace'&&!real.startsWith('/workspace/'))fail('路径不在授权工作区内');return real;}
async function storageUsage(){let size=0,count=0;async function visit(dir){let entries;try{entries=await fs.opendir(dir);}catch{return;}for await(const entry of entries){try{const p=dir+'/'+entry.name,st=await fs.lstat(p);if(st.isSymbolicLink())continue;count++;size+=st.size;if(st.isDirectory())await visit(p);}catch(error){if(error.code!=='ENOENT')throw error;}}}await visit('/workspace');await visit('/home/member');return{size,count};}
const run=async()=>{
 if(input.operation==='list'){
  await confined(target);const entries=[];for(const entry of (await fs.readdir(target,{withFileTypes:true})).slice(0,2000)){const file=path.join(target,entry.name);let blocked=false;try{await confined(file);}catch{blocked=true;}const st=await fs.lstat(file);entries.push({name:entry.name,path:file,directory:entry.isDirectory(),symlink:entry.isSymbolicLink(),blocked,size:st.size,modifiedAt:st.mtimeMs});}return {path:target,entries};
 }
 if(input.operation==='read'){await confined(target);const stat=await fs.stat(target);if(!stat.isFile()||stat.size>24*1024*1024)fail('文件过大或类型不支持');const data=await fs.readFile(target);return{path:target,data:data.toString('base64'),size:data.length,text:data.length<=1024*1024&&!data.includes(0)?data.toString('utf8'):undefined};}
 if(input.operation==='write'){await confined(target,{missing:true});const data=typeof input.data==='string'?Buffer.from(input.data,'base64'):Buffer.from(String(input.content??''));if(data.length>24*1024*1024)fail('文件过大');const usage=await storageUsage(),old=await fs.stat(target).catch(()=>({size:0}));if((usage.size-old.size+data.length>2147483648||usage.count>=100000)&&data.length>=old.size)fail('工作区存储配额已满，请清理文件后重试');await fs.writeFile(target,data,{mode:0o600});return{path:target,size:data.length};}
 if(input.operation==='mkdir'){await confined(target,{missing:true});await fs.mkdir(target,{recursive:Boolean(input.recursive),mode:0o700});return{path:target};}
 if(input.operation==='remove'){if(target==='/workspace')fail('不能删除工作区根目录');await confined(target);await fs.rm(target,{recursive:Boolean(input.recursive),force:false});return{path:target};}
 if(input.operation==='stat'){await confined(target);const stat=await fs.stat(target);return{path:target,size:stat.size,directory:stat.isDirectory(),modifiedAt:stat.mtimeMs};}
 if(input.operation==='rename'){const to=virtual(input.to);if(target==='/workspace'||to==='/workspace')fail('不能移动工作区根目录');await confined(target);await confined(to,{missing:true});await fs.rename(target,to);return{path:to};}
 if(input.operation==='snapshot'){
  const files=[];let total=0,truncated=false;
  async function walk(dir,depth){
   if(depth>16){truncated=true;return;}let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{truncated=true;return;}
   for(const item of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(['.git','node_modules','.cache','inputs'].includes(item.name)||item.isSymbolicLink())continue;
    if(files.length>=2000){truncated=true;return;}
    const p=path.join(dir,item.name);
    if(item.isDirectory())await walk(p,depth+1);
    else if(item.isFile())try{
     const stat=await fs.stat(p);
     if(stat.size>1024*1024||total+stat.size>8*1024*1024){files.push({path:p,size:stat.size,modifiedAt:stat.mtimeMs,textUnavailableReason:stat.size>1024*1024?'too-large':'snapshot-budget'});continue;}
     const data=await fs.readFile(p),text=data.toString('utf8');total+=data.length;
     const reason=data.includes(0)?'binary':!Buffer.from(text).equals(data)?'invalid-utf8':undefined;
     files.push({path:p,size:data.length,modifiedAt:stat.mtimeMs,sha256:crypto.createHash('sha256').update(data).digest('hex'),...(reason?{textUnavailableReason:reason}:{text})});
    }catch{truncated=true;}
   }
  }
  await walk('/workspace',0);return{files,truncated};
 }
 fail('不支持的工作区操作');
};
try{result=await run();console.log(JSON.stringify(result));}catch(error){console.log(JSON.stringify({error:error.code==='ENOENT'?'文件或目录不存在':error.code==='EACCES'?'工作区路径不可访问':error.message}));process.exitCode=1;}
