import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../shared/frontend/app.js',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('  function photoBatchEntries()'),source.indexOf('  async function chooseWebHomeImage'));
const extract=name=>source.match(new RegExp('  async function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}'))[0];
function setup(){
  const fields=new Map(),calls=[],uploads=[],toasts=[],assets=new Map(),revoked=[],stopped=[];let sequence=0,failUpload=null;
  const ui={photoBatchEntries:[],photoBatchIndex:0,photoBatch:null,photoUploading:false,feature:'enhance',model:'general'};
  const state={settings:{},photoJobs:[],history:[]};
  const api=async(path,method,body)=>{
    calls.push({path,method,body});
    if(path==='/api/photo/jobs/batch'){
      const batch={id:'batch-'+(++sequence),state:'queued'};
      return {ok:true,batch,jobs:body.assetIds.map((id,index)=>({id:batch.id+'-'+index,inputAssetId:id,state:'queued',photoRevision:1})),assets:[],history:[]};
    }
    if(path.endsWith('/cancel'))return {batch:{...ui.photoBatch,state:'cancelled'},jobs:state.photoJobs.map(job=>({...job,state:'cancelled',photoRevision:job.photoRevision+1})),assets:[],history:[]};
    if(path==='/api/history/export')return {ok:true,asset:{id:'archive',filename:'results.zip'}};
    return {ok:true};
  };
  class TestURL{static createObjectURL(){return 'blob:'+ ++sequence;}static revokeObjectURL(url){revoked.push(url);}}
  const context={ui,state,assets,window:{ShiYanPlatform:{mode:'web'},ShiYanPhotoStatus:{newer:(a,b)=>!b||a.photoRevision>=b.photoRevision,label:job=>job?.label||'正在增强',error:value=>String(value||'')}},
    URL:TestURL,Image:class{naturalWidth=32;naturalHeight=24;set src(value){this.onload?.();}},photoBatchPoll:{stop(){stopped.push('batch');}},photoStatusPoll:{stop(){stopped.push('single');}},
    busyStates:new Set(['queued','running','cancelling']),$:id=>{if(!fields.has(id))fields.set(id,{value:'',disabled:false});return fields.get(id);},
    setText:(id,text)=>context.$(id).textContent=text,esc:String,assetUrl:asset=>asset?.url,renderPhoto(){},renderHistory(){},
    photoBusy:()=>ui.photoUploading||ui.photoSubmitting||['queued','running','cancelling'].includes(ui.photoBatch?.state),
    toast:message=>toasts.push(message),api,upload:async files=>{
      uploads.push(files[0].name);if(files[0].name===failUpload)throw Error('network failed');
      const asset={id:'asset-'+files[0].name,filename:files[0].name,url:'/api/assets/'+files[0].name+'/file'};assets.set(asset.id,asset);return [asset];
    },saveWorkspace:async()=>{},chooseHomeImage:async file=>{ui.input={id:'single-'+file.name};},remember:asset=>{if(asset)assets.set(asset.id,asset);},
    resolveAsset:async id=>assets.get(id),exportFilename:asset=>asset.filename};
  vm.createContext(context);vm.runInContext(helpers+'\n'+extract('cancelPhoto')+'\n'+extract('processPhoto')+'\n'+source.slice(source.indexOf('  function photoJob()'),source.indexOf('  function setFeature(')),context);
  return {context,ui,state,calls,uploads,toasts,assets,fields,revoked,stopped,setFailure:name=>failUpload=name};
}
const files=count=>Array.from({length:count},(_,n)=>({name:n+'.png',size:100,type:'image/png'}));
test('10-file selection keeps local previews and sequential upload; 11 does not mutate selection',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(10));assert.equal(s.ui.photoBatchEntries.length,10);assert.equal(s.uploads.length,10);
 assert(s.ui.photoBatchEntries.every(item=>item.input.url.startsWith('blob:')&&!item.file));assert.equal(s.ui.photoUploading,false);
 const selected=s.ui.photoBatchEntries;await s.context.chooseHomeImages(files(11));assert.equal(s.ui.photoBatchEntries,selected);assert.equal(s.uploads.length,10);assert.match(s.toasts.at(-1),/10/);
});
test('upload failures retain only failed originals and retry does not reupload successful images',async()=>{
 const s=setup();s.setFailure('1.png');await s.context.chooseHomeImages(files(3));
 assert.equal(s.ui.photoBatchEntries[0].file,null);assert.equal(s.ui.photoBatchEntries[1].file.name,'1.png');assert.match(s.ui.photoError,/部分/);
 s.setFailure(null);await s.context.uploadPhotoBatch();assert.deepEqual(s.uploads,['0.png','1.png','2.png','1.png']);assert.equal(s.ui.photoBatchEntries[1].file,null);
});
test('batch request queues every input; failed enhancement retry sends only failed input and retains prior successes',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(3));await s.context.processPhotoBatch();
 const first=s.calls.find(call=>call.path==='/api/photo/jobs/batch');assert.equal(first.body.assetIds.length,3);assert.equal(s.ui.photoBatch.state,'queued');
 const jobs=s.state.photoJobs.map((job,index)=>({...job,state:index===1?'failed':'completed',photoRevision:2,outputAssetId:index===1?null:'out-'+index}));
 s.context.applyPhotoBatchStatus({batch:{...s.ui.photoBatch,state:'failed'},jobs,assets:[{id:'out-0'},{id:'out-2'}],history:[]});
 assert.equal(s.context.photoBatchSummary().completed,2);assert.equal(s.context.photoBatchSummary().failed,1);
 await s.context.processPhotoBatch();const last=s.calls.filter(call=>call.path==='/api/photo/jobs/batch').at(-1);
 assert.deepEqual(Array.from(last.body.assetIds),['asset-1.png']);assert.equal(s.ui.photoBatchEntries[0].result.id,'out-0');
});
test('selection changes compared image independently from a running batch; cancel updates all queued states',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));await s.context.processPhotoBatch();
 s.context.selectPhotoBatch(1);assert.equal(s.ui.input.id,'asset-1.png');assert.equal(s.ui.photoBatchIndex,1);
 await s.context.cancelPhoto();assert.equal(s.ui.photoBatch.state,'cancelled');assert(s.state.photoJobs.every(job=>job.state==='cancelled'));
});
test('switching back to one file releases every batch preview URL and retains the single-image flow',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));await s.context.chooseHomeImages(files(1));
 assert.equal(s.ui.photoBatchEntries.length,0);assert.equal(s.revoked.length,2);assert.equal(s.ui.input.id,'single-0.png');
});

test('late pre-cancel batch snapshots do not regress a cancelled batch',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));await s.context.processPhotoBatch();
 s.ui.photoBatch.updatedAt='2026-10-24T08:02:00Z';s.ui.photoBatch.state='cancelled';
 s.context.applyPhotoBatchStatus({batch:{...s.ui.photoBatch,state:'running',updatedAt:'2026-10-24T08:01:00Z'},jobs:[],assets:[],history:[]});
 assert.equal(s.ui.photoBatch.state,'cancelled');
});
test('verified input dimensions replace preview hints while local preview URLs stay immediate',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));
 const localURL=s.ui.photoBatchEntries[0].localURL;
 s.assets.set('asset-0.png',{id:'asset-0.png',width:240,height:320,url:'/api/assets/verified/file'});
 s.context.syncPhotoBatchSelection();assert.equal(s.ui.input.width,240);assert.equal(s.ui.input.height,320);assert.equal(s.ui.input.url,localURL);
});

test('unknown server dimensions preserve local preview dimensions without updating server assets',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));
 s.assets.set('asset-0.png',{id:'asset-0.png',width:null,height:null,url:'/api/assets/asset-0.png/file'});
 s.context.syncPhotoBatchSelection();assert.equal(s.ui.input.width,32);assert.equal(s.ui.input.height,24);
 assert.equal(s.assets.get('asset-0.png').width,null);assert(s.ui.input.url.startsWith('blob:'));
});
test('a local image decoded after batch upload still updates the selected preview dimensions',async()=>{
 const s=setup(),pending=[];s.context.Image=class{naturalWidth=88;naturalHeight=99;set src(value){pending.push(()=>this.onload());}};
 await s.context.chooseHomeImages(files(2));pending[0]();s.context.syncPhotoBatchSelection();
 assert.equal(s.ui.input.width,88);assert.equal(s.ui.input.height,99);assert.equal(s.assets.get('asset-0.png').width,undefined);
});

for(const mode of ['web','desktop']){
 test(mode+': one successful batch result saves the image and two results use ZIP',async()=>{
  const s=setup(),saved=[],archives=[];s.context.window.ShiYanPlatform.mode=mode;
  s.context.saveAsset=async asset=>saved.push(asset.id);
  s.context.window.ShiYanPhotoArchive={download:async items=>archives.push(items.map(x=>x.id))};
  s.ui.photoBatchEntries=[{result:{id:'only',filename:'only.jpg'}},{}];
  await s.context.savePhotoBatch();assert.deepEqual(saved,['only']);assert.equal(archives.length,0);
  assert(!s.calls.some(c=>c.path==='/api/history/export'));
  s.ui.photoBatchEntries=[{result:{id:'a',filename:'a.jpg'}},{result:{id:'b',filename:'b.jpg'}}];
  s.state.history=[{id:'h-a',assetId:'a'},{id:'h-b',assetId:'b'}];
  await s.context.savePhotoBatch();
  if(mode==='web'){assert.equal(archives.length,1);assert.deepEqual(Array.from(archives[0]),['a','b']);}
  else {assert.deepEqual(Array.from(s.calls.find(c=>c.path==='/api/history/export').body.ids),['h-a','h-b']);assert.equal(saved.at(-1),'archive');}
  assert.deepEqual(s.toasts,[]);
 });
}

function addCompletedResults(s){
 for(const [index,entry] of s.ui.photoBatchEntries.entries()){
  const result={id:'out-'+index,filename:index+'.jpg',mimeType:'image/jpeg'};
  const job={id:'job-'+index,inputAssetId:entry.input.id,outputAssetId:result.id,state:'completed',photoRevision:2};
  s.assets.set(result.id,result);s.state.photoJobs.push(job);entry.jobId=job.id;entry.result=result;
 }
 s.context.syncPhotoBatchSelection();
}

for(const removedIndex of [0,1,2]){
 test('remove '+['first','middle','last'][removedIndex]+' selection preserves paired results through 2 → 1 → 0',async()=>{
  const s=setup();await s.context.chooseHomeImages(files(3));addCompletedResults(s);
  const expected=Array.from(s.ui.photoBatchEntries).filter((_,index)=>index!==removedIndex).map(entry=>entry.input.id);
  const removedURL=s.ui.photoBatchEntries[removedIndex].localURL;
  s.context.selectPhotoBatch(removedIndex);s.context.removeCurrentPhoto();
  assert.deepEqual(Array.from(s.ui.photoBatchEntries,entry=>entry.input.id),expected);
  assert.equal(s.ui.photoBatchIndex,Math.min(removedIndex,1));
  assert.equal(s.ui.input.id,expected[s.ui.photoBatchIndex]);
  assert.equal(s.ui.result.id,s.ui.photoBatchEntries[s.ui.photoBatchIndex].result.id);
  assert(s.revoked.includes(removedURL));
  s.context.selectPhotoBatch(1);s.context.removeCurrentPhoto();
  assert.equal(s.ui.photoBatchEntries.length,1);assert.equal(s.ui.photoBatchIndex,0);
  assert.equal(s.ui.input.id,expected[0]);assert.equal(s.ui.result.id,s.ui.photoBatchEntries[0].result.id);
  assert.deepEqual(JSON.parse(JSON.stringify(s.context.photoSelection())),{index:0,total:1});
  s.context.removeCurrentPhoto();
  assert.equal(s.ui.photoBatchEntries.length,0);assert.equal(s.ui.photoBatchIndex,0);
  for(const key of ['input','result','photoJobId','photoBatch','photoLocalURL','photoUploadFile'])assert.equal(s.ui[key],null,key+' must clear');
  assert.deepEqual(JSON.parse(JSON.stringify(s.context.photoSelection())),{index:0,total:0});
  assert.equal(s.revoked.length,3);assert(s.stopped.includes('single'));assert(s.stopped.includes('batch'));
 });
}

test('removing the final image ignores late batch results rather than reviving selection',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));addCompletedResults(s);
 const priorVersion=s.ui.photoSelectionVersion;
 const jobs=s.state.photoJobs.map(job=>({...job}));
 s.ui.photoBatch={id:'old-batch',state:'completed'};
 s.context.removeCurrentPhoto();s.context.removeCurrentPhoto();
 const currentVersion=s.ui.photoSelectionVersion;
 s.context.applyPhotoBatchStatus({batch:{id:'old-batch',state:'completed'},jobs,assets:[{id:'late-output'}],photoSelectionVersion:priorVersion});
 assert.equal(s.ui.photoBatch,null);assert.equal(s.ui.input,null);assert.equal(s.ui.result,null);
 assert.equal(s.ui.photoBatchEntries.length,0);assert.equal(s.ui.photoSelectionVersion,currentVersion);
 // A batch response without a selection tag must also be harmless in empty state.
 s.context.applyPhotoBatchStatus({batch:{id:'old-batch',state:'completed'},jobs,assets:[]});
 assert.equal(s.ui.photoBatch,null);assert.equal(s.ui.input,null);
});

for(const phase of ['uploading','submitting','running','exporting','restoring']){
 test(phase+': removal is blocked while changing the compared image remains available',async()=>{
  const s=setup();await s.context.chooseHomeImages(files(2));addCompletedResults(s);
  if(phase==='running')s.ui.photoBatch={id:'batch-active',state:'running'};
  else s.ui[{uploading:'photoUploading',submitting:'photoSubmitting',exporting:'photoExporting',restoring:'restoring'}[phase]]=true;
  const version=s.ui.photoSelectionVersion,entries=s.ui.photoBatchEntries;
  s.context.removeCurrentPhoto();assert.equal(s.ui.photoBatchEntries,entries);assert.equal(entries.length,2);
  assert.equal(s.ui.photoSelectionVersion,version);assert.equal(s.revoked.length,0);
  s.context.selectPhotoBatch(1);assert.equal(s.ui.photoBatchIndex,1);
  assert.equal(s.ui.input.id,'asset-1.png');assert.equal(s.ui.result.id,'out-1');
 });
}

test('one remaining batch entry still submits enhancement with the surviving input',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));
 s.context.removeCurrentPhoto();assert.equal(s.ui.photoBatchEntries.length,1);
 await s.context.processPhoto();
 const request=s.calls.find(call=>call.path==='/api/photo/jobs/batch');
 assert.deepEqual(Array.from(request.body.assetIds),['asset-1.png']);
 assert.equal(s.ui.input.id,'asset-1.png');assert.equal(s.ui.photoJobId,s.state.photoJobs[0].id);
 assert.equal(s.ui.photoBatch.state,'queued');
});

for(const mode of ['web','desktop']){
 test(mode+': the unified save action keeps legacy single-image downloads direct',async()=>{
  const s=setup(),saved=[];s.context.window.ShiYanPlatform.mode=mode;
  s.context.saveAsset=async asset=>saved.push(asset);
  s.ui.result={id:'legacy-result',filename:'legacy.jpg',mimeType:'image/jpeg'};
  await s.context.savePhotoBatch();
  assert.equal(saved.length,1);assert.equal(saved[0],s.ui.result);
  assert(!s.calls.some(call=>call.path==='/api/history/export'));
 });
}

test('previous/next selection clears unrelated results and retains the failed image error',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(3));addCompletedResults(s);
 const failed=s.ui.photoBatchEntries[1];failed.result=null;failed.error='图片上传失败';
 const job=s.state.photoJobs.find(job=>job.id===failed.jobId);job.state='failed';job.outputAssetId=null;
 s.context.selectPhotoBatch(0);assert.equal(s.ui.result.id,'out-0');
 s.context.selectPhotoBatch(1);assert.equal(s.ui.input.id,'asset-1.png');assert.equal(s.ui.result,null);assert.equal(s.ui.photoError,'图片上传失败');
 s.context.selectPhotoBatch(2);assert.equal(s.ui.input.id,'asset-2.png');assert.equal(s.ui.result.id,'out-2');assert.equal(s.ui.photoError,'');
 s.context.selectPhotoBatch(1);assert.equal(s.ui.result,null);
 s.context.selectPhotoBatch(-1);assert.equal(s.ui.photoBatchIndex,1);
 s.context.selectPhotoBatch(3);assert.equal(s.ui.photoBatchIndex,1);
});

test('removal persists only surviving IDs and selected input; refresh cannot re-add removed batch jobs',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(3));addCompletedResults(s);
 s.ui.photoBatch={id:'batch-completed',state:'completed'};
 vm.runInContext('let workspaceSaveQueue=Promise.resolve();\n'+extract('saveWorkspace'),s.context);
 s.context.selectPhotoBatch(1);s.context.removeCurrentPhoto();await s.context.saveWorkspace();
 let persisted=s.calls.filter(call=>call.path==='/api/settings?compact=1').at(-1).body;
 assert.deepEqual(Array.from(persisted.homeInputAssetIds),['asset-0.png','asset-2.png']);
 assert.equal(persisted.homeInputAssetId,'asset-2.png');
 const restored=setup();restored.state.settings=JSON.parse(JSON.stringify(persisted));
 restored.state.photoJobs=s.state.photoJobs;
 for(const [id,asset] of s.assets)restored.assets.set(id,asset);
 restored.context.api=async()=>({batch:{id:'batch-completed',state:'completed'},jobs:s.state.photoJobs,assets:[]});
 await restored.context.restorePhotoBatch(persisted.homeInputAssetIds,persisted.homePhotoBatchId);
 assert.deepEqual(Array.from(restored.ui.photoBatchEntries,entry=>entry.input.id),['asset-0.png','asset-2.png']);
 assert.equal(restored.ui.input.id,'asset-2.png');assert.equal(restored.ui.result.id,'out-2');
 s.context.removeCurrentPhoto();await s.context.saveWorkspace();
 persisted=s.calls.filter(call=>call.path==='/api/settings?compact=1').at(-1).body;
 assert.deepEqual(Array.from(persisted.homeInputAssetIds),['asset-0.png']);assert.equal(persisted.homeInputAssetId,'asset-0.png');
 s.context.removeCurrentPhoto();await s.context.saveWorkspace();
 persisted=s.calls.filter(call=>call.path==='/api/settings?compact=1').at(-1).body;
 assert.deepEqual(Array.from(persisted.homeInputAssetIds),[]);assert.equal(persisted.homeInputAssetId,null);assert.equal(persisted.homePhotoBatchId,null);
});

test('a tagged old result cannot attach to a replacement selection',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));
 const oldVersion=s.ui.photoSelectionVersion;
 await s.context.chooseHomeImages([{name:'new-a.png',type:'image/png'},{name:'new-b.png',type:'image/png'}]);
 const inputs=Array.from(s.ui.photoBatchEntries,entry=>entry.input.id);
 s.context.applyPhotoBatchStatus({batch:{id:'stale',state:'completed'},jobs:[{id:'stale-job',inputAssetId:inputs[0],state:'completed',outputAssetId:'stale-output'}],assets:[{id:'stale-output'}],photoSelectionVersion:oldVersion});
 assert.equal(s.ui.photoBatch,null);assert.equal(s.ui.result,null);
 assert.deepEqual(Array.from(s.ui.photoBatchEntries,entry=>entry.input.id),inputs);
 assert(s.ui.photoBatchEntries.every(entry=>entry.jobId===null&&entry.result===null));
});

test('removing a neighboring item retains the surviving upload failure and its retryable original',async()=>{
 const s=setup();s.setFailure('1.png');await s.context.chooseHomeImages(files(2));
 s.context.selectPhotoBatch(0);s.context.removeCurrentPhoto();
 assert.equal(s.ui.photoBatchEntries.length,1);assert.equal(s.ui.input.filename,'1.png');
 assert.equal(s.ui.photoError,'network failed');assert.equal(s.ui.photoBatchEntries[0].file.name,'1.png');
 s.setFailure(null);await s.context.processPhoto();
 assert.equal(s.ui.photoBatchEntries[0].file,null);assert.equal(s.ui.input.id,'asset-1.png');
 assert.deepEqual(s.uploads,['0.png','1.png','1.png']);
 await s.context.processPhoto();
 assert.deepEqual(Array.from(s.calls.find(call=>call.path==='/api/photo/jobs/batch').body.assetIds),['asset-1.png']);
});

test('a late cancel response cannot attach its old batch to newly chosen pictures',async()=>{
 const s=setup();await s.context.chooseHomeImages(files(2));await s.context.processPhoto();
 const oldBatch={...s.ui.photoBatch},oldJobs=s.state.photoJobs.map(job=>({...job,state:'cancelled',photoRevision:2}));
 let resolveCancel;const originalApi=s.context.api;
 s.context.api=(path,method,body)=>path.endsWith('/cancel')?new Promise(resolve=>{resolveCancel=resolve;}):originalApi(path,method,body);
 const pending=s.context.cancelPhoto();
 // A terminal status can arrive over events before the cancel HTTP response.
 s.ui.photoBatch.state='completed';s.state.photoJobs.forEach(job=>job.state='completed');
 await s.context.chooseHomeImages([{name:'new-a.png',type:'image/png'},{name:'new-b.png',type:'image/png'}]);
 resolveCancel({batch:{...oldBatch,state:'cancelled'},jobs:oldJobs,assets:[],history:[]});await pending;
 assert.equal(s.ui.photoBatch,null);assert.equal(s.ui.input.id,'asset-new-a.png');assert.equal(s.ui.result,null);
 assert(s.ui.photoBatchEntries.every(entry=>entry.jobId===null));
});

test('removing an uploaded image beside a failed upload never persists a local preview ID',async()=>{
 const s=setup();s.setFailure('1.png');await s.context.chooseHomeImages(files(2));
 vm.runInContext('let workspaceSaveQueue=Promise.resolve();\n'+extract('saveWorkspace'),s.context);
 s.context.removeCurrentPhoto();await s.context.saveWorkspace();
 assert.equal(s.ui.photoBatchEntries.length,1);assert(s.ui.input.id.startsWith('local:'));
 const persisted=s.calls.filter(call=>call.path==='/api/settings?compact=1').at(-1).body;
 assert.equal(persisted.homeInputAssetId,null);assert.deepEqual(Array.from(persisted.homeInputAssetIds),[]);
 assert.equal(s.ui.photoBatchEntries[0].file.name,'1.png');
});
