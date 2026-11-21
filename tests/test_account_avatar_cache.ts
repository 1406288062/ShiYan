import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../shared/frontend/assets/account-avatar.js', import.meta.url), 'utf8');
function launch({userId = 'owner-A', store = new Map(), legacy = 'old-asset-id', storageFails = false} = {}): any {
  const requests: any[] = [], listeners = new Map(), streams: any[] = [];
  const storage = {
    getItem(key) { return store.get(key) ?? null; },
    setItem(key, value) { if (storageFails) throw new Error('QuotaExceededError'); store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
  };
  const image = {
    isConnected: true, hidden: true, src: '',
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  };
  const placeholder = {
    hidden: false,
    toggleAttribute(name, enabled) { if (name === 'hidden') this.hidden = !!enabled; },
    removeAttribute(name) { if (name === 'hidden') this.hidden = false; }
  };
  class EventSourceFake { [key: string]: any;
    static CLOSED = 2;
    constructor(url) { this.url = url; this.handlers = {}; this.readyState = 1; streams.push(this); }
    addEventListener(type, callback) { this.handlers[type] = callback; }
    emit(type, body) { this.handlers[type]?.({data: JSON.stringify(body)}); }
    close() { this.readyState = EventSourceFake.CLOSED; }
  }
  const user = {id:userId, username:userId};
  const account = {
    user, ready: Promise.resolve(),
    request(path, method = 'GET') {
      assert.equal(path, '/account/avatar');
      assert.equal(method, 'GET');
      return new Promise((resolve, reject) => requests.push({resolve, reject}));
    }
  };
  const window: any = {
    ShiYanAccount: account,
    shiyan: {getState:()=>({settings:{avatarAssetId:legacy}}), toast:()=>{}},
    addEventListener(type, callback) { listeners.set(type, callback); }
  };
  const document = {
    body: {append(){}}, hidden:false,
    createElement(type) { assert.equal(type, 'input'); return {}; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(type, handler) {listeners.set('document:'+type,handler);}
  };
  const context = vm.createContext({
    window, document, localStorage: storage, EventSource: EventSourceFake,
    setTimeout:()=>1,clearTimeout:()=>{},
    fetch:()=>{ throw new Error('Legacy should not fetch before server confirmation'); }
  });
  vm.runInContext(script,context,{filename:'account-avatar.js'});
  assert.equal(typeof window.ShiYanAvatar?.bind, 'function');
  window.ShiYanAvatar.bind(image,placeholder);
  return {
    image,placeholder,store,requests,streams,account,
    fire(type) {listeners.get(type)?.();},
    key:'shiyan.account.'+encodeURIComponent(userId)+'.avatar.snapshot.v1',
    async ready() { await Promise.resolve(); },
    async respond(avatar) {
      assert(requests.length,'No pending GET');
      requests.shift().resolve({avatar}); await Promise.resolve(); await Promise.resolve();
    },
    send(avatar) {assert(streams.length,'No event stream'); streams.at(-1).emit('avatar',{avatar});}
  };
}
const avatar=(revision,data)=>({revision,data});
const logo='UkVDRU5U', latest='TEFURVNU', old='T0xE';
{
  const boot=launch();
  assert.equal(boot.image.src,'', 'No cache: never render the legacy asset');
  assert.equal(boot.image.hidden,true);
  assert.equal(boot.placeholder.hidden,false);
  await boot.ready();
  assert.equal(boot.requests.length,1,'Server refresh should still start');
  console.log('PASS first launch uses placeholder without old avatar');
}
{
  const store=new Map([['shiyan.account.owner-A.avatar.snapshot.v1',JSON.stringify(avatar(2,logo))]]);
  const boot=launch({store});
  assert.equal(boot.image.src,'data:image/jpeg;base64,'+logo);
  assert.equal(boot.image.hidden,false);
  assert.equal(boot.placeholder.hidden,true);
  await boot.ready(); assert.equal(boot.requests.length,1);
  await boot.respond(avatar(3,latest));
  assert.equal(boot.image.src,'data:image/jpeg;base64,'+latest);
  assert.deepEqual(JSON.parse(store.get(boot.key) as string), avatar(3,latest));
  const reopened=launch({store});
  assert.equal(reopened.image.src,'data:image/jpeg;base64,'+latest);
  console.log('PASS cached current avatar displays immediately after restart');
}
{
  const store=new Map([['shiyan.account.owner-A.avatar.snapshot.v1',JSON.stringify(avatar(5,logo))]]);
  const boot=launch({store});await boot.ready();
  boot.send(avatar(7,latest));
  assert.equal(boot.image.src,'data:image/jpeg;base64,'+latest);
  await boot.respond(avatar(6,old));
  assert.equal(boot.image.src,'data:image/jpeg;base64,'+latest);
  assert.deepEqual(JSON.parse(store.get(boot.key) as string),avatar(7,latest));
  console.log('PASS stale delayed GET cannot undo a newer event');
}
{
  const store=new Map([['shiyan.account.owner-A.avatar.snapshot.v1',JSON.stringify(avatar(2,logo))]]);
  const boot=launch({store});await boot.ready();
  boot.send(avatar(3,null));
  assert.equal(boot.image.src,'');
  assert.equal(boot.image.hidden,true);
  assert.equal(boot.placeholder.hidden,false);
  assert.deepEqual(JSON.parse(store.get(boot.key) as string),avatar(3,null));
  const reopened=launch({store});
  assert.equal(reopened.image.hidden,true);
  console.log('PASS deletion persists and does not resurrect old photo');
}
{
  const store=new Map([['shiyan.account.owner-A.avatar.snapshot.v1',JSON.stringify(avatar(3,latest))]]);
  const other=launch({userId:'owner-B',store});
  assert.equal(other.image.src,'');
  assert.equal(other.placeholder.hidden,false);
  await other.ready();
  await other.respond(avatar(1,old));
  assert.deepEqual(JSON.parse(store.get('shiyan.account.owner-A.avatar.snapshot.v1') as string),avatar(3,latest));
  assert.deepEqual(JSON.parse(store.get(other.key) as string),avatar(1,old));
  other.fire('shiyan-account-changing');
  assert.equal(other.image.hidden,true);
  other.send(avatar(2,logo));
  assert.equal(other.image.hidden,true);
  console.log('PASS user isolation and logout teardown');
}
{
  const store=new Map([['shiyan.account.owner-A.avatar.snapshot.v1','{"revision":999,"data":"%%%"}']]);
  const boot=launch({store});
  assert.equal(boot.image.src,'');
  assert.equal(store.has(boot.key),false);
  await boot.ready(); boot.send(avatar(2,latest));
  assert.equal(boot.image.src,'data:image/jpeg;base64,'+latest);
  console.log('PASS corrupt snapshot ignored and repaired');
}
{
  const boot=launch({storageFails:true});
  await boot.ready();
  boot.send(avatar(2,latest));
  assert.equal(boot.image.src,'data:image/jpeg;base64,'+latest);
  assert.equal(boot.store.has(boot.key),false);
  console.log('PASS storage quota errors do not block avatar rendering');
}
console.log('PASS all avatar startup/cache checks');
