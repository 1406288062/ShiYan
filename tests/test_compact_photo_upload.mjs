import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../shared/frontend/app.js',import.meta.url),'utf8');
const extract=name=>source.match(new RegExp('  async function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}'))[0];
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function setup({uploadFailure=false,saveFailure=false,uploadPending=false}={}){
 const calls=[],toasts=[],fields=new Map(),ui={input:null,result:null,photoUploadFile:null,photoLocalURL:null,feature:'enhance',model:'general',photoUploading:false};let releaseSave,releaseUpload;
 const context={ui,state:{settings:{}},window:{ShiYanPlatform:{mode:'web'}},FormData:class{append(){}},URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},Image:class{naturalWidth=32;naturalHeight=24;set src(v){this.onload?.()}},$:id=>{if(!fields.has(id))fields.set(id,{disabled:false,value:''});return fields.get(id)},renderPhoto(){},toast:m=>toasts.push(m),confirmAction:async()=>true,photoBusy:()=>false,setText(){},show(){},remember:a=>a,
 api:async(path,method,body)=>{calls.push({path,body});if(path.startsWith('/api/assets')){if(uploadFailure)throw Error('upload failed');if(uploadPending)await new Promise(resolve=>releaseUpload=resolve);return {assets:[{id:'asset-a',width:32,height:24,url:'/api/assets/asset-a/file'}]};}if(saveFailure)throw Error('settings failed');return new Promise(r=>releaseSave=r);}};
 vm.createContext(context);vm.runInContext('let workspaceSaveQueue=Promise.resolve();\n'+['upload','saveWorkspace','choosePreviewHomeImage','chooseHomeImage'].map(extract).join('\n'),context);
 return {context,ui,calls,toasts,fields,release:()=>releaseSave?.({ok:true}),releaseUpload:()=>releaseUpload?.()};
}
test('web upload becomes ready while settings response stays pending',async()=>{const s=setup();await s.context.choosePreviewHomeImage({name:'fixture.png',size:128});await settle();assert.equal(s.ui.photoUploading,false);assert.equal(s.ui.photoUploadFile,null);assert.equal(s.ui.input.id,'asset-a');assert.equal(s.ui.input.url,'blob:fixture');assert.equal(s.fields.get('homeFileInput').disabled,false);assert(s.calls.some(c=>c.path==='/api/assets?compact=1'));assert(s.calls.some(c=>c.path==='/api/settings?compact=1'));s.release();});
test('desktop also releases file selection without waiting for preferences',async()=>{const s=setup();s.context.window.ShiYanPlatform.mode='desktop';await s.context.chooseHomeImage({name:'fixture.png',size:128});assert.equal(s.fields.get('homeFileInput').disabled,false);assert.equal(s.ui.input.id,'asset-a');s.release();});
test('upload failure retains the local preview and retry file',async()=>{const s=setup({uploadFailure:true});const file={name:'fixture.png',size:128};await s.context.choosePreviewHomeImage(file);assert.equal(s.ui.photoUploadFile,file);assert.equal(s.ui.input.url,'blob:fixture');assert.equal(s.ui.photoUploading,false);assert.match(s.ui.photoError,/upload failed/);assert(!s.calls.some(c=>c.path.includes('/api/settings')));});
test('background settings failure does not relabel successful upload as failed',async()=>{const s=setup({saveFailure:true});await s.context.choosePreviewHomeImage({name:'fixture.png',size:128});await settle();assert.equal(s.ui.input.id,'asset-a');assert.equal(s.ui.photoError,'');assert.equal(s.ui.photoUploading,false);assert(s.toasts.some(m=>m.includes('settings failed')));});
test('preference saves stay ordered and old responses do not overwrite the latest local selection',async()=>{const s=setup();s.ui.input={id:'asset-a'};const a=s.context.saveWorkspace();s.ui.input={id:'asset-b'};const b=s.context.saveWorkspace();await settle();assert.equal(s.calls.length,1);assert.equal(s.calls[0].body.homeInputAssetId,'asset-a');assert.equal(s.context.state.settings.homeInputAssetId,'asset-b');s.release();await a;await settle();assert.equal(s.calls[1].body.homeInputAssetId,'asset-b');s.release();await b;assert.equal(s.context.state.settings.homeInputAssetId,'asset-b');});

for(const mode of ['web','desktop']){
 test(mode+': choosing a new image replaces the previous original before upload completes',async()=>{
  const s=setup({uploadPending:true});s.context.window.ShiYanPlatform.mode=mode;
  s.ui.input={id:'old',url:'/old.png'};s.ui.result=null;s.ui.photoJobId='old-job';
  const file={name:'new.png',size:128},pending=s.context.chooseHomeImage(file);await settle();
  assert.equal(s.ui.input.url,'blob:fixture');assert.notEqual(s.ui.input.id,'old');
  assert.equal(s.ui.result,null);assert.equal(s.ui.photoJobId,null);assert.equal(s.ui.photoUploading,true);
  s.releaseUpload();await pending;assert.equal(s.ui.input.id,'asset-a');s.release();
 });
 test(mode+': cancelling file selection keeps the previous image',async()=>{
  const s=setup();s.context.window.ShiYanPlatform.mode=mode;const previous={id:'old',url:'/old.png'};s.ui.input=previous;
  await s.context.chooseHomeImage(null);assert.equal(s.ui.input,previous);assert.equal(s.calls.length,0);
 });
}
