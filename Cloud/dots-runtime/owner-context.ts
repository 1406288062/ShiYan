import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import path from 'node:path';
export const validOwner=(owner: any)=>typeof owner==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner);
export const ownerKey=(owner: any)=>{if(!validOwner(owner))throw Object.assign(Error('Invalid owner'),{statusCode:401});return createHash('sha256').update(owner).digest('hex');};
export function createOwnerRegistry({defaultOwner,create}: any){
 const context=new AsyncLocalStorage(),entries=new Map();let started=false;
 const currentOwner=()=>context.getStore()||defaultOwner;
 const run=(owner: any,callback: any)=>{ownerKey(owner);return context.run(owner,callback);};
 const get=(owner=currentOwner())=>{
  ownerKey(owner);
  if(!entries.has(owner))run(owner,()=>{const value=create(owner);entries.set(owner,value);if(started)value.start?.();});
  return entries.get(owner);
 };
 const proxy=(key: string): any=>new Proxy({}, {get(_target,property){const value=get()[key];const item=value?.[property];return typeof item==='function'?item.bind(value):item;}});
 return {currentOwner,run,get,proxy,entries,start(){started=true;for(const [owner,value]of entries)run(owner,()=>value.start?.());},close(){for(const [owner,value]of entries)run(owner,()=>value.close?.());entries.clear();}};
}

// Dots control metadata stays outside the member mount. Only virtual paths are
// passed to executable tools; this mapping never reads a user-managed path.
export function memberDotsWorkingDirectory(controlRoot: any,workingDirectory: any){
 const root=path.resolve(controlRoot),relative=path.relative(root,path.resolve(workingDirectory||root));
 if(relative!=='.manager'&&!/^[1-9][0-9]*$/.test(relative))throw Object.assign(Error('Invalid member workspace'),{statusCode:400});
 return '/workspace/dots/'+relative;
}
