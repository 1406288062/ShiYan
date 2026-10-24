import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../shared/frontend/app.js',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('  function photoBatchEntries()'),source.indexOf('  async function chooseWebHomeImage'));
const extract=name=>source.match(new RegExp('  async function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}'))[0];
function setup(){
  const fields=new Map(),calls=[],uploads=[],toasts=[],assets=new Map(),revoked=[];let sequence=0,failUpload=null;
  const ui={photoBatchEntries:[],photoBatchIndex:0,photoBatch:null,photoUploading:false,feature:'enhance',model:'general'};
  const state={settings:{},photoJobs:[],history:[]};
  const api=async(path,method,body)=>{
    calls.push({path,method,body});
    if(path==='/api/photo/jobs/batch'){
      const batch={id:'batch-'+(++sequence),state:'queued'};
      return {ok:true,batch,jobs:body.assetIds.map((id,index)=>({id:batch.id+'-'+index,inputAssetId:id,state:'queued',photoRevision:1})),assets:[],history:[]};
    }
    if(path.endsWith('/cancel'))return {batch:{...ui.photoBatch,state:'cancelled'},jobs:state.photoJobs.map(job=>({...job,state:'cancelled',photoRevision:job.photoRevision+1})),assets:[],history:[]};
    return {ok:true};
  };
  class TestURL{static createObjectURL(){return 'blob:'+ ++sequence;}static revokeObjectURL(url){revoked.push(url);}}
  const context={ui,state,assets,window:{ShiYanPlatform:{mode:'web'},ShiYanPhotoStatus:{newer:(a,b)=>!b||a.photoRevision>=b.photoRevision}},
    URL:TestURL,Image:class{naturalWidth=32;naturalHeight=24;set src(value){this.onload?.();}},photoBatchPoll:{stop(){}},
    busyStates:new Set(['queued','running','cancelling']),$:id=>{if(!fields.has(id))fields.set(id,{value:'',disabled:false});return fields.get(id);},
    setText:(id,text)=>context.$(id).textContent=text,esc:String,assetUrl:asset=>asset?.url,renderPhoto(){},renderHistory(){},
    photoBusy:()=>ui.photoUploading||ui.photoSubmitting||['queued','running','cancelling'].includes(ui.photoBatch?.state),
    toast:message=>toasts.push(message),api,upload:async files=>{
      uploads.push(files[0].name);if(files[0].name===failUpload)throw Error('network failed');
      const asset={id:'asset-'+files[0].name,filename:files[0].name,url:'/api/assets/'+files[0].name+'/file'};assets.set(asset.id,asset);return [asset];
    },saveWorkspace:async()=>{},chooseHomeImage:async file=>{ui.input={id:'single-'+file.name};},remember:asset=>{if(asset)assets.set(asset.id,asset);},
    resolveAsset:async id=>assets.get(id),exportFilename:asset=>asset.filename};
  vm.createContext(context);vm.runInContext(helpers+'\n'+extract('cancelPhoto'),context);
  return {context,ui,state,calls,uploads,toasts,assets,fields,revoked,setFailure:name=>failUpload=name};
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
