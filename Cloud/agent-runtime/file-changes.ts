// Bound snapshots to this conversation workspace. Never follow symlinks or scan dependencies.
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {textFileChange} from './text-file-diff.ts';
import {readRemoteFileChanges,mergeFileChanges} from './remote-file-changes.ts';
const skip=new Set(['.git','.shiyan','node_modules','.venv','venv','__pycache__','inputs','.next','dist','build']);
const binary=/\.(?:png|jpe?g|webp|gif|ico|heic|pdf|zip|gz|tar|mp[34]|mov|woff2?|ttf|sqlite3?|db|pt|pth|safetensors)$/i;
export async function snapshotWorkspace(root: any){
 const files=new Map(),omitted=new Set();let bytes=0,visited=0,truncated=false;
 async function walk(dir: any){
  let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   if(++visited>30000){truncated=true;return;}
   const full=path.join(dir,entry.name),name=path.relative(root,full);
   if(entry.isSymbolicLink())continue;
   if(entry.isDirectory()){if(!skip.has(entry.name))await walk(full);continue;}
   if(!entry.isFile()||binary.test(name))continue;
   try{const info=await fs.stat(full);if(info.size>1024*1024||bytes+info.size>32*1024*1024){omitted.add(name);continue;}
    const data=await fs.readFile(full);if(data.includes(0)){omitted.add(name);continue;}
    const text=data.toString('utf8');if(!Buffer.from(text).equals(data)){omitted.add(name);continue;}files.set(name,text);bytes+=data.length;
   }catch{omitted.add(name);}
  }
 }
 await walk(root);return {files,omitted,truncated};
}
export async function collectFileChanges(root: any,before: any,items: any[]=[],{jobId=null}: {jobId?: string | null}={}){
 const after=await snapshotWorkspace(root),names=new Set([...before.files.keys(),...after.files.keys()]);
 const changes: any[]=[];
  for(const name of [...names].sort()){
   if(changes.length>=200)break;
   if(before.omitted.has(name)||after.omitted.has(name)||(!before.files.has(name)&&before.truncated)||(!after.files.has(name)&&after.truncated))continue;
   const change=await textFileChange(path.resolve(root,name),before.files.get(name),after.files.get(name));
   if(change)changes.push(change);
  }
  // SDK records outside the snapshot are listed without invented before/after content.
  let supplemental: any[]=[];
  if(jobId)try{supplemental=await readRemoteFileChanges(root,jobId);}catch{/* Invalid evidence never replaces genuine workspace changes. */}
  const merged=mergeFileChanges(changes,supplemental);
  const stagingPaths=new Set((supplemental as any).stagingPaths||supplemental.flatMap(file=>file.stagingPaths||[]));
  for(const item of items)if(item.type==='file_change'&&item.status==='completed')for(const c of item.changes||[]){
   if(typeof c.path!=='string'||/[\x00-\x1f\x7f]/.test(c.path)||!['add','delete','update'].includes(c.kind))continue;const absolute=path.resolve(root,c.path),relative=path.relative(root,absolute);
   if(stagingPaths.has(absolute))continue;
   if(relative==='.shiyan'||relative.startsWith('.shiyan'+path.sep))continue;
   if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative)){
    if(!merged.some(f=>f.path===absolute))merged.push({path:absolute,kind:c.kind,available:false,diff:'',source:'SDK 已确认文件修改，但未记录修改前后内容。'});
    continue;
   }
   if(!merged.some(f=>f.path===absolute)&& (before.omitted.has(relative)||after.omitted.has(relative)||before.truncated||after.truncated))merged.push({path:absolute,kind:c.kind,available:false,diff:'',source:'文件过大或无法读取，未记录 diff。'});
  }
  return merged.slice(0,200);
}
