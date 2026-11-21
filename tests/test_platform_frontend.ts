import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../shared/frontend/assets/platform.js',import.meta.url),'utf8');
function platform(mode,config={},withBridge=false): any {
  const calls: any[] = [];
  const window: any = {__SHIYAN_PLATFORM__:{mode,config}};
  if(withBridge)window.webkit={messageHandlers:{native:{postMessage:value=>calls.push(value)}}};
  vm.runInNewContext(source,{window});
  return {p:window.ShiYanPlatform,window,calls};
}

for(const mode of ['desktop','web']) {
  test(`${mode} keeps the shared native bridge behavior`,()=>{
    const {p,calls}=platform(mode,{},true);
    assert.equal(p.mode,mode);
    assert.equal(p.adapter('native').available(),true);
    assert.equal(p.postNative('save',{filename:'a.txt'}),true);
    assert.equal(calls.length,1);
    assert.equal(calls[0].action,'save');
    assert.equal(calls[0].filename,'a.txt');
  });
  test(`${mode} returns false when the native bridge is absent`,()=>{
    const {p}=platform(mode);
    assert.equal(p.adapter('native').available(),false);
    assert.equal(p.postNative('save'),false);
  });
}

test('reads the explicit merged configuration without implicit feature values',()=>{
  const config={appearance:{spacing:12,contrast:false},items:['first'],empty:null};
  const {p}=platform('web',config);
  assert.equal(p.config,config);
  assert.equal(p.get(),config);
  assert.equal(p.get('appearance.spacing'),12);
  assert.equal(p.get(['appearance','contrast'],true),false);
  assert.equal(p.get('items.0'),'first');
  assert.equal(p.get('empty','fallback'),null);
  assert.equal(p.get('missing.value','fallback'),'fallback');
  assert.equal(p.get('appearance.toString','fallback'),'fallback');
  assert.equal(p.get('features.nativeBrowser'),undefined);
});

test('adapters use shared implementations until explicitly overridden for a profile',()=>{
  const {p}=platform('web');
  const shared={value:'shared'},desktop={value:'desktop'},web={value:'web'};
  p.registerAdapter('example',shared);
  p.registerAdapter('example',desktop,'desktop');
  assert.equal(p.adapter('example'),shared);
  p.registerAdapter('example',web,'web');
  assert.equal(p.adapter('example'),web);
  assert.equal(p.adapter('unknown'),undefined);
});

test('a desktop adapter override does not replace the shared implementation of other profiles',()=>{
  const {p}=platform('desktop');
  const shared={},desktop={},web={};
  p.registerAdapter('example',shared);
  p.registerAdapter('example',web,'web');
  assert.equal(p.adapter('example'),shared);
  p.registerAdapter('example',desktop,'desktop');
  assert.equal(p.adapter('example'),desktop);
});

test('an explicit native adapter is used even without a built-in bridge',()=>{
  const {p}=platform('web');
  const calls: any[] = [];
  p.registerAdapter('native',{available:()=>true,post:(action,detail)=>{calls.push({action,detail});return true;}},'web');
  assert.equal(p.postNative('workbench',{op:'chooseFile'}),true);
  assert.equal(calls[0].action,'workbench');
  assert.equal(calls[0].detail.op,'chooseFile');
});

test('bridge detection stays live when a bridge is installed after startup',()=>{
  const {p,window}=platform('desktop');
  const calls: any[] = [];
  window.webkit={messageHandlers:{native:{postMessage:value=>calls.push(value)}}};
  assert.equal(p.adapter('native').available(),true);
  assert.equal(p.postNative('late'),true);
  assert.equal(calls[0].action,'late');
});

test('missing metadata retains the shared default configuration and native adapter',()=>{
  const window: any = {};
  vm.runInNewContext(source,{window});
  assert.equal(window.ShiYanPlatform.mode,'desktop');
  assert.equal(Object.keys(window.ShiYanPlatform.config).length,0);
  assert.equal(window.ShiYanPlatform.postNative('save'),false);
});
