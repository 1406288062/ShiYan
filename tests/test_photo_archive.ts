import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
const source=fs.readFileSync(new URL('../shared/frontend/assets/photo-archive.js',import.meta.url),'utf8');
function setup(options: any = {}): any {
  const written: any[] = [], calls: any[] = [], anchors: any[] = [], pickers: any[] = []; let closed=false,aborted=false;
  const writable={write:async (bytes: any)=>written.push(Buffer.from(bytes)),close:async()=>closed=true,abort:async()=>aborted=true};
  const window: any = options.stream===false?{}:{showSaveFilePicker:async (config: any)=>{pickers.push(config);return {createWritable:async()=>writable};}};
  const localTime=new Date(2026,9,25,22,55,0);
  class Clock extends Date{constructor(...args: any[]){super(...((args.length?args:[localTime.getTime()]) as [number, number, number, number, number, number, number]));}}
  const context={window,TextEncoder,Uint8Array,Uint32Array,DataView,Blob,URL,AbortController,Date:Clock,location:{href:'https://example.test/',origin:'https://example.test'},
    document:{createElement:()=>({click(){anchors.push(this);},remove(){}}),body:{appendChild(){}}},setTimeout(){},
    fetch:async(url: any,config: any)=>{calls.push({url,config});return {ok:!(options.failSecond&&calls.length===2),body:new Blob([calls.length===1?'first':'second']).stream()};}};
  vm.runInNewContext(source,context);
  return {api:window.ShiYanPhotoArchive,written,calls,anchors,pickers,get closed(){return closed;},get aborted(){return aborted;}};
}
test('archive filename reflects actual result types and local save time',()=>{
  const s=setup(),when=new Date(2026,0,2,3,4,5);
  assert.equal(s.api.archiveFilename([{enhancementModel:'general'},{modelName:'通用增强'}],when),'拾燕_通用增强_20260102_030405.zip');
  assert.equal(s.api.archiveFilename([{modelName:'anime'},{enhancementModel:'x4anime'}],when),'拾燕_动漫增强_20260102_030405.zip');
  assert.equal(s.api.archiveFilename([{modelName:'general'},{modelName:'动漫增强'}],when),'拾燕_混合增强_20260102_030405.zip');
  assert.equal(s.api.archiveFilename([{modelName:'unknown'},{}],when),'拾燕_增强图片_20260102_030405.zip');
  assert.equal(s.api.archiveFilename([],when),'拾燕_增强图片_20260102_030405.zip');
  assert.equal(s.api.archiveFilename([{modelName:'general'},{}],when),'拾燕_混合增强_20260102_030405.zip');
});
for(const stream of [true,false]){
  test((stream?'streaming picker':'memory download')+' uses a ZIP name with enhancement type and current local time',async()=>{
    const s=setup({stream});
    await s.api.download([{id:'a',filename:'a.jpg',enhancementModel:'anime'},{id:'b',filename:'b.jpg',modelName:'动漫增强'}]);
    const name=stream?s.pickers[0].suggestedName:s.anchors[0].download;
    assert.equal(name,'拾燕_动漫增强_20261025_225500.zip');
  });
}
test('streamed ZIP is readable by Python with UTF-8 names, STORE data and deduplicated names',async()=>{
  const s=setup(), progress: any[] = [];
  const entries=['图片.jpg','图片.jpg'].map((filename,index)=>({filename,chunks:async function*(){yield new Uint8Array([65+index]);yield new Uint8Array([66+index]);}}));
  await s.api.writeZip(entries,{write:async (bytes: any)=>s.written.push(Buffer.from(bytes))},{onProgress:(p: any)=>progress.push(p)});
  const data=Buffer.concat(s.written);
  const python=process.platform==='darwin'?'/opt/homebrew/bin/python3':'python3';
  const result=JSON.parse(execFileSync(python,['-c','import io,json,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps([[i.filename,z.read(i).decode(),i.compress_type] for i in z.infolist()]))'],{input:data}).toString());
  assert.deepEqual(result,[['图片.jpg','AB',0],['图片_2.jpg','BC',0]]);assert.equal(data.readUInt16LE(12),33);assert.equal(progress.at(-1).completed,2);
});
test('archive fetches sequential same-origin asset URLs whose redirects deliver COS data, then closes destination',async()=>{
  const s=setup();await s.api.download([{id:'a',filename:'a.jpg'},{id:'b',filename:'b.jpg'}]);
  assert.equal(s.closed,true);assert.equal(s.calls.length,2);assert.equal(s.calls[0].config.credentials,'same-origin');
  assert.equal(s.calls[0].config.mode,'cors');assert.equal(s.calls[0].config.headers,undefined);
  assert.equal(s.calls[0].url,'https://example.test/api/assets/a/file?download=1');assert.equal(s.aborted,false);
});
test('a missing result aborts the file instead of producing a silently incomplete ZIP',async()=>{
  const s=setup({failSecond:true});
  await assert.rejects(s.api.download([{id:'a',filename:'a.jpg'},{id:'b',filename:'b.jpg'}]),/下载增强图片失败/);
  assert.equal(s.closed,false);assert.equal(s.aborted,true);assert.equal(s.calls[0].config.signal.aborted,true);
});
test('memory fallback rejects known oversized archives before fetching; writer enforces unknown sizes too',async()=>{
  const s=setup({stream:false});
  await assert.rejects(s.api.download([{id:'a',bytes:193*1024*1024}]),/单张/);assert.equal(s.calls.length,0);
  await assert.rejects(s.api.writeZip([{filename:'a.jpg',chunks:async function*(){yield new Uint8Array(32);}}],{write:async()=>{}},{limit:40}),/单张/);
});
test('archive rejects cross-origin entry URLs and caps selection at 10',async()=>{
  const s=setup();await assert.rejects(s.api.download([{id:'a',downloadUrl:'https://foreign.test/a'}]),/地址/);assert.equal(s.calls.length,0);
  await assert.rejects(s.api.download(Array.from({length:11},(_,index)=>({id:String(index)}))),/10/);
});

test('a truncated result aborts the destination even when the HTTP response is successful',async()=>{
  const s=setup();await assert.rejects(s.api.download([{id:'a',filename:'a.jpg',bytes:100}]),/不完整/);
  assert.equal(s.closed,false);assert.equal(s.aborted,true);
});
