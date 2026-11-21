import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../adapters/workspace.js', import.meta.url), 'utf8');

function loadAdapter({install}: any = {}): any {
  const calls: any[] = [];
  const originalApiCalls: any[] = [];
  const listeners = new Map();
  const account = {
    user: {id: 'account-a'},
    request: async (path, method = 'GET', body) => {
      calls.push({path, method, body});
      if (path === '/web-workspace/projects') return {ok:true, projects:[], devices:[], connected:false};
      if (path === '/web-workspace/files/read') return {ok:true, file:{fileId:'remote-file-1', path:'src/main.py', kind:'text', text:'print(1)', contentHash:'hash-1'}};
      return {ok:true};
    }
  };
  const nativeFetch = async (...args) => {
    originalApiCalls.push(args);
    return new Response(JSON.stringify({ok:true, route:String(args[0])}), {status:200, headers:{'Content-Type':'application/json'}});
  };
  const window: any = {
    ShiYanPlatform: {mode:'web'},
    ShiYanAccount: account,
    crypto: {randomUUID: () => 'request-uuid'},
    fetch: nativeFetch,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener() {},
    shiyan: {toast() {}, confirmAction: async () => true},
  };
  const context = {
    window,
    location: new URL('https://example.test/'),
    URL,
    Response,
    URLSearchParams,
    crypto: window.crypto,
    queueMicrotask,
    requestAnimationFrame: callback => callback(),
    clearTimeout,
    setTimeout,
    console,
  };
  const baseInstall = install || function(C) {
    return {
      initFile() {},
      openAsset() {},
      afterBoot: async () => {},
      inspect: () => ({})
    };
  };
  window.ShiYanV2 = {install: baseInstall};
  vm.runInNewContext(source, context, {filename:'workspace.js'});
  return {window, context, account, calls, originalApiCalls, nativeFetch, listeners};
}

function makeContext(window, originalApiCalls, overrides = {}): any {
  const prefs = {selectedProjectId:'cloud-project-1'};
  const context = {
    prefs,
    api: async (path, method = 'GET', body) => {
      const response = await window.fetch('/api/workspace' + path, {method, body:body === undefined ? undefined : JSON.stringify(body)});
      return response.json();
    },
    openTab: () => null,
    selectTab() {},
    selectProject: async () => 'cloud-selected',
    workspaceTool: () => 'desktop-tool',
    native: () => 'native',
    nativeAvailable: () => true,
    pick: async () => null,
    tabs: [],
    panes: new Map(),
    activeTab: '',
    closeTab: async () => {},
    renderTabs() {},
    renderState() {},
    ...overrides,
  };
  return context;
}

test('adapter leaves native fetch and shared bootstrap/preferences/cloud routes intact', async () => {
  const {window, originalApiCalls: nativeCalls, nativeFetch} = loadAdapter();
  const C = makeContext(window, nativeCalls);
  window.ShiYanV2.install(C);

  assert.equal(window.fetch, nativeFetch);
  await C.api('/bootstrap', 'POST', {});
  await C.api('/preferences', 'PATCH', {selectedProjectId:'cloud-project-1'});
  await C.api('/projects', 'GET');
  await C.api('/files/read', 'POST', {projectId:'cloud-project-1', path:'README.md'});
  assert.deepEqual(nativeCalls.map(call => call[0]), [
    '/api/workspace/bootstrap', '/api/workspace/preferences', '/api/workspace/projects', '/api/workspace/files/read'
  ]);
});

test('remote read/save/diff routes use the account API and retain one requestId', async () => {
  const {window, calls, originalApiCalls} = loadAdapter();
  const C = makeContext(window, originalApiCalls);
  window.ShiYanV2.install(C);

  assert.equal(C.openTab({type:'browser'}), null);
  assert.equal(C.native('show'), false);
  await C.api('/files/read', 'POST', {projectId:'web-device-123', path:'src/main.py'});
  await C.api('/files/save-text', 'POST', {fileId:'remote-file-1', contentHash:'hash-1', text:'print(2)', confirmed:true, requestId:'stable-request-1'});
  await C.api('/files/changes', 'POST', {fileId:'remote-file-1', baselineText:'print(1)'});

  const read = calls.find(call => call.path === '/web-workspace/files/read');
  const save = calls.find(call => call.path === '/web-workspace/files/save-text');
  const changes = calls.find(call => call.path === '/web-workspace/files/changes');
  assert.ok(read);
  assert.equal(read.body.projectId, 'web-device-123');
  assert.ok(save);
  assert.equal(save.body.projectId, 'web-device-123');
  assert.equal(save.body.path, 'src/main.py');
  assert.equal(save.body.requestId, 'stable-request-1');
  assert.ok(changes);
  assert.equal(changes.body.projectId, 'web-device-123');
  assert.equal(changes.body.path, 'src/main.py');
  assert.equal(calls.filter(call => call.path.startsWith('/web-workspace/')).length, 4); // includes the bootstrap refresh
  assert.equal(originalApiCalls.length, 0);
});

test('an empty device pane isolates original initFile from the cloud selectedProjectId', () => {
  let seenProjectId;
  const {window, originalApiCalls} = loadAdapter({install: C => ({
    initFile(tab, pane) {
      seenProjectId = C.prefs.selectedProjectId;
      return {tab, pane, projectId:seenProjectId};
    },
    openAsset() {},
    afterBoot: async () => {}
  })});
  const pane = {querySelector: () => null};
  const C = makeContext(window, originalApiCalls);
  const result = window.ShiYanV2.install(C);
  result.initFile({id:'device-empty', type:'files'}, pane);
  assert.equal(seenProjectId, null);
  assert.equal(C.prefs.selectedProjectId, 'cloud-project-1');
});

test('left cloud project selection restores the selected remote device tab', async () => {
  const selected: any[] = [];
  const {window, originalApiCalls} = loadAdapter();
  const C = makeContext(window, originalApiCalls, {
    tabs: [{id:'device-tab', type:'files', projectId:'web-device-123', webDeviceId:'device-1'}],
    activeTab: 'device-tab',
    selectTab: id => selected.push(id),
    selectProject: async () => { selected.push('cloud-select'); }
  });
  window.ShiYanV2.install(C);
  await C.selectProject('cloud-project-1');
  assert.deepEqual(selected, ['cloud-select', 'device-tab']);
});

test('web project files and device files collapse into one remote file pane', () => {
  const {window, originalApiCalls} = loadAdapter();
  const tabs = [
    {id:'project-files', type:'files', title:'项目文件'},
    {id:'device-files', type:'files', title:'设备文件', webDevicePane:true, projectId:'web-device-123'}
  ];
  const C = makeContext(window, originalApiCalls, {
    tabs,
    closeTab: async id => { const index=C.tabs.findIndex(tab=>tab.id===id); if(index>=0)C.tabs.splice(index,1); },
    selectTab() {}
  });
  window.ShiYanV2.install(C);
  const selected = C.workspaceTool('files');
  assert.equal(selected.id, 'device-files');
  assert.equal(C.tabs.length, 1);
  assert.equal(C.tabs[0].webDevicePane, true);
  assert.equal(C.tabs[0].title, '项目文件');
});

test('web adapter uses bounded document sandboxing and no global cleanup/fetch/link interception', () => {
  assert.equal(source.includes('window.fetch ='), false);
  assert.equal(source.includes('localStorage'), false);
  assert.equal(source.includes('setInterval'), false);
  assert.equal(source.includes('message-reference'), false);
  assert.equal(source.includes('allow-same-origin'), false);
  assert.match(source, /setAttribute\('sandbox', 'allow-scripts'\)/);
  const {window} = loadAdapter();
  assert.deepEqual([...window.ShiYanWebWorkspace.remoteFileRoutes].sort(), [
    '/directory-details', '/files/changes', '/files/read', '/files/save-text', '/files/search'
  ]);
  assert.equal(window.ShiYanWebWorkspace.safePreviewURL({previewUrl:'/api/web-workspace/document/opaque'}), 'https://example.test/api/web-workspace/document/opaque');
  assert.throws(() => window.ShiYanWebWorkspace.safePreviewURL({previewUrl:'https://evil.test/file.pdf'}), /无效/);
});
