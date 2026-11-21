import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {loadRuntimeState,combinedRuntimeState} from './runtime-state.ts';
test('isolated runtime migrates only member state and never rewrites active administrator state',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'shiyan-state-'));
  try{
    const legacy={jobs:{admin:{owner:'admin',status:'running'},member:{owner:'member',status:'completed'}},conversations:{a:{owner:'admin'},b:{owner:'member',memberHistory:[{text:'private'}]}},assets:{x:{owner:'member'}},requests:{'admin:req':'admin','member:req':'member'},cancelledRequests:{'admin:request-id':1,'member:request-id':2}};
    const before=JSON.stringify(legacy);writeFileSync(path.join(dir,'state.json'),before);
    const result=loadRuntimeState({data:dir,stateFile:path.join(dir,'member-runtime-state.json'),memberOnly:true,access:owner=>({role:owner==='admin'?'admin':'user',serverAccess:owner==='admin'})});
    assert.deepEqual(Object.keys(result.state.jobs),['member']);assert.deepEqual(Object.keys(result.state.requests),['member:req']);assert.deepEqual(result.state.cancelledRequests,{'member:request-id':2});
    assert.equal(readFileSync(path.join(dir,'state.json'),'utf8'),before);
    assert.deepEqual(combinedRuntimeState([legacy,{...result.state,jobs:{member:{owner:'member',status:'new'}}}]).jobs.member.status,'new');
    assert.throws(()=>loadRuntimeState({data:dir,memberOnly:true,access:()=>({})}),/separate state/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
