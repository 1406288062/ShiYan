import path from 'node:path';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Cache only workspace identities, never the large execution archive.
export function createFilePathResolver(root,store,{stateFallback=true}={}){
  const jobs=new Map(),conversations=new Map();let version='';
  function refresh(){
    const file=path.join(root,'data/state.json');let info;
    try{info=statSync(file);}catch{return;}
    const next=info.mtimeMs+':'+info.size;if(next===version)return;
    const state=JSON.parse(readFileSync(file,'utf8'));
    for(const [key,conversation] of Object.entries(state.conversations||{})){
      const workspace=conversation.workspaceKey||key;
      if(/^[a-f0-9]{64}$/.test(workspace))conversations.set(key,path.join(root,'workspaces',workspace));
    }
    for(const job of Object.values(state.jobs||{})){
      const workspace=conversations.get(job.conversationKey);
      if(workspace)jobs.set(job.owner+':'+job.id,workspace);
    }
    version=next;
  }
  return function resolve(change,owner){
    if(change.kind!=='messages'||change.deleted||!change.data)return change;
    const data=change.data;
    const groups=[data.fileChanges,...(data.displayItems||[]).filter(item=>item.type==='file_change').map(item=>item.changes)];
    if(!groups.some(files=>Array.isArray(files)&&files.some(file=>typeof file?.path==='string'&&!path.isAbsolute(file.path))))return change;
    const registered=store.jobWorkspace?.(owner,data.remoteJobId,data.conversationId);
    const parent=store.get(owner,'conversations',data.conversationId)?.data;
    const remote=parent?.remoteConversationId||data.conversationId;
    const key=createHash('sha256').update(owner+':'+remote).digest('hex');
    const lookup=()=>jobs.get(owner+':'+data.remoteJobId)||conversations.get(key);
    let workspace=registered?path.join(root,'workspaces',registered):lookup();
    if(!workspace&&stateFallback){refresh();workspace=lookup();}
    const inferred=path.join(root,'workspaces',key);
    if(!workspace&&stateFallback&&existsSync(inferred))workspace=inferred;
    if(!workspace)return change; // Do not invent an absolute path when the origin is unknown.
    const files=values=>values?.map(file=>typeof file?.path==='string'&&!path.isAbsolute(file.path)?{...file,path:path.resolve(workspace,file.path)}:file);
    return {...change,data:{...data,
      ...(Array.isArray(data.fileChanges)?{fileChanges:files(data.fileChanges)}:{}),
      ...(Array.isArray(data.displayItems)?{displayItems:data.displayItems.map(item=>item.type==='file_change'?{...item,changes:files(item.changes)}:item)}:{})}};
  };
}
