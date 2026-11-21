import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../shared/frontend/assets/workbench-v2.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('  function renderCompareImage('),source.indexOf('  function renderCompare(){'));
function setup(){
 const context: any={window:{ShiYanPlatform:{mode:'web'}},assetURL:a=>a.url};vm.createContext(context);vm.runInContext(helper,context);
 const img: any={dataset:{},naturalWidth:0,naturalHeight:0,getAttribute(name){return this[name]||null;},removeAttribute(name){delete this[name];}},dimensions={textContent:''},empty={hidden:false};
 const card={querySelector:selector=>selector==='img'?img:selector==='.v2-compare-dimensions'?dimensions:empty};
 return {img,dimensions,empty,render:asset=>context.renderCompareImage(card,asset)};
}
test('restored remote-only image displays browser-decoded dimensions without changing asset metadata',()=>{
 const s=setup(),asset={id:'a',url:'/api/assets/a/file',width:null,height:null};s.render(asset);
 assert.equal(s.dimensions.textContent,'');s.img.naturalWidth=120;s.img.naturalHeight=80;s.img.onload();
 assert.equal(s.dimensions.textContent,'120 × 80');assert.equal(asset.width,null);assert.equal(asset.height,null);
 s.render(asset);assert.equal(s.dimensions.textContent,'120 × 80');assert.equal(s.img.crossOrigin,'anonymous');
});
test('switching images clears stale decoded dimensions and ignores the previous load callback',()=>{
 const s=setup();s.render({url:'/a'});const oldLoad=s.img.onload;s.img.naturalWidth=120;s.img.naturalHeight=80;oldLoad();
 s.render({url:'/b'});assert.equal(s.dimensions.textContent,'');oldLoad();assert.equal(s.dimensions.textContent,'');
 s.img.naturalWidth=90;s.img.naturalHeight=160;s.img.onload();assert.equal(s.dimensions.textContent,'90 × 160');
 s.render(null);assert.equal(s.dimensions.textContent,'');assert.equal(s.img.onload,null);
});
