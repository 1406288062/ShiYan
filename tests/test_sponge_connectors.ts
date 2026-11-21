import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../shared/frontend/assets/sponge.js', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../shared/frontend/assets/workbench-dots-panels.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../shared/frontend/assets/workbench-dots.css', import.meta.url), 'utf8');
const validUrl = () => {
  const url = new URL('https://mcp.yandot.ai/oauth/authorize');
  for (const [key, value] of Object.entries({
    shiyan_ticket:'ticket', client_id:'client', state:'state-value',
    code_challenge:'A'.repeat(43), code_challenge_method:'S256',
    response_type:'code', resource:'https://mcp.yandot.ai/mcp',
    redirect_uri:'https://mcp.yandot.ai/shiyan/callback'
  })) url.searchParams.set(key, value);
  return url.href;
};
function setup(startResult = {authorizeUrl:validUrl()}) {
  const calls: any[] = [], opened: any[] = [];
  const popup: any = {closed:false, opener:{}, location:{url:'',replace(url){this.url=url;}}, close(){this.closed=true;}};
  const window: any = {
    ShiYanAccount:{request:async(...args)=>{calls.push(args);if(args[0].endsWith('/start'))return startResult;return {ok:true,connected:true,devices:[]};}},
    ShiYanPlatform:{adapter:()=>({available:()=>false})},
    open:(...args)=>{opened.push(args);return popup;}
  };
  vm.runInNewContext(source,{window,URL,Error});
  return {service:window.ShiYanSpongeIntegration,calls,opened,popup};
}

test('Sponge status and disconnect use the authenticated account bridge', async()=>{
  const s=setup();
  await s.service.status();
  await s.service.disconnect();
  assert.equal(JSON.stringify(s.calls),JSON.stringify([['/integrations/sponge/status','GET',null],['/integrations/sponge/disconnect','POST',{}]]));
});

test('connect opens a tab during the click and navigates only to the validated provider URL',async()=>{
  const s=setup();
  const result=await s.service.connect();
  assert.equal(s.opened[0][0],'about:blank');
  assert.equal(s.popup.opener,null);
  assert.equal(s.popup.location.url,validUrl());
  assert.equal(JSON.stringify(result),JSON.stringify({opened:true}));
  assert.equal(JSON.stringify(s.calls),JSON.stringify([['/integrations/sponge/start','POST',{}]]));
});

test('an unexpected authorization host is rejected and its temporary tab is closed',async()=>{
  const s=setup({authorizeUrl:'https://attacker.invalid/oauth/authorize?ticket=x'});
  await assert.rejects(s.service.connect(),/连接地址无效/);
  assert.equal(s.popup.closed,true);
});

test('device management opens the fixed provider account page',()=>{
  const s=setup();
  assert.equal(s.service.manage(),true);
  assert.equal(s.opened[0][0],'https://mcp.yandot.ai/account');
});

test('Dots Connectors owns the Sponge management UI and image-only messages have no gray bubble',()=>{
  assert.match(panel,/data-sponge-act="manage"/);
  assert.match(panel,/data-sponge-act="connect"/);
  assert.match(panel,/data-sponge-act="connect">连接海绵宝宝<\/button>/);
  assert.doesNotMatch(panel,/data-sponge-act="open">连接<\/button>/);
  assert.match(panel,/data-sponge-act="disconnect"/);
  assert.match(panel,/window\.ShiYanSpongeIntegration/);
  assert.doesNotMatch(source,/settings-devices-page|settings-section-title/);
  assert.match(css,/\.dots-manager-message\.is-user\.is-image-only \{[^}]*background:transparent !important/);
  assert.match(css,/\.dots-image img[^\n]*box-shadow:none!important;filter:none!important/);
  assert.match(panel,/dots-weixin-expired-state/);
  assert.match(panel,/重新获取/);
  assert.match(panel,/设备与远程控制/);
  assert.doesNotMatch(panel,/设备管理<\/h3>/);
  assert.doesNotMatch(panel,/Dots 请你批准某个操作/);
  assert.match(css,/\.dots-dialog-overlay \.dots-settings-card \{ width:min\(470px,94vw\);height:min\(620px/);
  assert.match(css,/\.dots-weixin-card,\.dots-settings-card \{ width:min\(470px,94vw\);height:min\(620px/);
});
