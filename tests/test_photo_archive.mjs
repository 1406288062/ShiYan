import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
const source=fs.readFileSync(new URL('../shared/frontend/assets/photo-archive.js',import.meta.url),'utf8');
function setup(options={}){
  const written=[],calls=[],anchors=[];let closed=false,aborted=false;
  const writable={write:async bytes=>written.push(Buffer.from(bytes)),close:async()=>closed=true,abort:async()=>aborted=true};
  const window=options.stream===false?{}:{showSaveFilePicker:async()=>({createWritable:async()=>writable})};
  const context={window,TextEncoder,Uint8Array,Uint32Array,DataView,Blob,URL,AbortController,location:{href:'https://example.test/',origin:'https://example.test'},
    document:{createElement:()=>({click(){anchors.push(this);},remove(){}}),body:{appendChild(){}}},setTimeout(){},
    fetch:async(url,config)=>{calls.push({url,config});return {ok:!(options.failSecond&&calls.length===2),body:new Blob([calls.length===1?'first':'second']).stream()};}};
  vm.runInNewContext(source,context);
  return {api:window.ShiYanPhotoArchive,written,calls,anchors,get closed(){return closed;},get aborted(){return aborted;}};
}
test('streamed ZIP is readable by Python with UTF-8 names, STORE data and deduplicated names',async()=>{
  const s=setup(),progress=[];
  const entries=['图片.jpg','图片.jpg'].map((filename,index)=>({filename,chunks:async function*(){yield new Uint8Array([65+index]);yield new Uint8Array([66+index]);}}));
  await s.api.writeZip(entries,{write:async bytes=>s.written.push(Buffer.from(bytes))},{onProgress:p=>progress.push(p)});
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
