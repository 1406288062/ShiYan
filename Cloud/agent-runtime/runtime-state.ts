import path from 'node:path';
import {readFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';

export const emptyRuntimeState=(): any=>({jobs:{},conversations:{},assets:{},requests:{},cancelledRequests:{}});
export function partitionRuntimeState(source,includeOwner){
  const result=emptyRuntimeState();
  for(const kind of ['jobs','conversations','assets'])for(const [id,value] of (Object.entries(source?.[kind]||{}) as [string, any][]))
    if(value?.owner&&includeOwner(value.owner))result[kind][id]=value;
  for(const [key,id] of (Object.entries(source?.requests||{}) as [string, any][]))if(result.jobs[id])result.requests[key]=id;
  for(const [key,value] of Object.entries(source?.cancelledRequests||{})){
    const separator=key.lastIndexOf(':');
    if(separator>0&&includeOwner(key.slice(0,separator)))result.cancelledRequests[key]=value;
  }
  return result;
}
export function loadRuntimeState({data,stateFile,memberOnly=false,access}){
  const file=stateFile||path.join(data,'state.json');
  if(memberOnly&&path.resolve(file)===path.resolve(data,'state.json'))throw new Error('Member runtime requires a separate state file');
  if(existsSync(file))return {file,state:JSON.parse(readFileSync(file,'utf8'))};
  let state=emptyRuntimeState();
  if(memberOnly){
    const legacy=path.join(data,'state.json');
    if(existsSync(legacy))state=partitionRuntimeState(JSON.parse(readFileSync(legacy,'utf8')),owner=>{
      const account=access(owner);return account.role!=='admin'||account.serverAccess!==true;
    });
    const temporary=file+'.initial.tmp';writeFileSync(temporary,JSON.stringify(state),{mode:0o600});renameSync(temporary,file);
  }
  return {file,state};
}
export function combinedRuntimeState(states){
  const result=emptyRuntimeState();
  for(const state of states)for(const kind of Object.keys(result))Object.assign(result[kind],state?.[kind]||{});
  return result;
}
