import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../shared/frontend/app.js',import.meta.url),'utf8');
const saveSource=source.slice(source.indexOf('  async function saveAsset(a)'),source.indexOf('  async function shareAssets(items)'));
function setup(mode: any){
 const nativeCalls: any[]=[],downloads: any[]=[];
 const context: any={window:{ShiYanPlatform:{mode}},URL,location:{href:'http://127.0.0.1:17861/'},
  assetUrl:(a: any)=>a.downloadUrl,exportFilename:(a: any)=>a.filename,
  native:(action: any,body: any)=>{nativeCalls.push({action,body});return mode==='desktop';},
  document:{createElement:(): any=>({click(){downloads.push({url:this.href,filename:this.download});},remove(){}}),body:{appendChild(){}}}};
 vm.createContext(context);vm.runInContext(saveSource,context);
 return {...context,nativeCalls,downloads};
}
test('desktop ZIP downloads use WebKit file downloads above the native preview byte limit',async()=>{
 const s=setup('desktop');
 await s.saveAsset({id:'archive',filename:'拾燕图片.zip',mimeType:'application/zip',bytes:48*1024*1024,downloadUrl:'/api/assets/archive/file?download=1'});
 assert.equal(s.nativeCalls.length,0);
 assert.deepEqual(s.downloads,[{url:'/api/assets/archive/file?download=1',filename:'拾燕图片.zip'}]);
});
test('single desktop JPEG continues using the native save dialog',async()=>{
 const s=setup('desktop');
 await s.saveAsset({filename:'result.jpg',mimeType:'image/jpeg',downloadUrl:'/api/assets/image/file?download=1'});
 assert.equal(s.downloads.length,0);assert.equal(s.nativeCalls.length,1);
 assert.equal(s.nativeCalls[0].action,'save');
 assert.equal(s.nativeCalls[0].body.url,'http://127.0.0.1:17861/api/assets/image/file?download=1');
});
test('web ZIP keeps the normal browser download path',async()=>{
 const s=setup('web');
 await s.saveAsset({filename:'results.zip',mimeType:'application/zip',downloadUrl:'/api/assets/zip/file?download=1'});
 assert.equal(s.downloads.length,1);assert.equal(s.downloads[0].filename,'results.zip');
});
