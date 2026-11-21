import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../apps/web/adapters/voice.js', import.meta.url), 'utf8');
const panelSource = fs.readFileSync(new URL('../shared/frontend/assets/workbench-dots-panels.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
function response({ok = true, type = 'audio/mpeg', size = 10} = {}) {
  return {ok, headers: {get: () => type}, arrayBuffer: async () => new ArrayBuffer(size)};
}
function browser({mode = 'web', recognition = true, webkit = false, withAudio = true, autoFetch = true, delayDecode = false}: any = {}): any {
  const events: any[] = [], requests: any[] = [], sources: any[] = [], contexts: any[] = [], recognitions: any[] = [], listeners: any = {};
  class Context { [key: string]: any;
    constructor() { this.state = 'suspended'; this.destination = {}; this.resumes = 0; this.decodes = []; contexts.push(this); }
    resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    decodeAudioData(bytes: any) { const job = deferred(); this.decodes.push({bytes, ...job}); if (!delayDecode) (job.resolve as any)?.({duration: 1}); return job.promise; }
    createBufferSource() {
      const item = {started: false, stopped: false, disconnected: false, onended: () => {},
        connect: () => {}, disconnect() { this.disconnected = true; },
        start() { this.started = true; }, stop() { this.stopped = true; this.onended?.(); },
        end() { this.onended?.(); }};
      sources.push(item); return item;
    }
  }
  let adapter;
  const window: any = {ShiYanPlatform: {mode, registerAdapter: (name: any, value: any) => { assert.equal(name, 'voice'); adapter = value; }},
    addEventListener: (name: any, fn: any) => { listeners[name] = fn; }, dispatchEvent: (event: any) => { events.push(event.detail); }};
  if (withAudio) window[webkit ? 'webkitAudioContext' : 'AudioContext'] = Context;
  if (recognition) window.SpeechRecognition = class { constructor() { recognitions.push(this); } start() {} abort() {} };
  const fetch = (url: any, options: any) => {
    const job = deferred(); requests.push({url, options, ...job});
    if (autoFetch) (job.resolve as any)?.(response());
    return job.promise;
  };
  vm.runInNewContext(source, {window, fetch, AbortController, ArrayBuffer, CustomEvent: class {type: any; detail: any; constructor(type: any, {detail}: any) {this.type = type; this.detail = detail;}}, setTimeout, clearTimeout, queueMicrotask});
  return {adapter, events, requests, sources, contexts, recognitions, listeners, window};
}
const states = (b: any) => b.events.filter((event: any) => event.type === 'voicePlaybackState').map((event: any) => [event.sessionId, event.state]);

test('Only web registers the replacement voice adapter', () => {
  assert.equal(browser({mode: 'desktop'}).adapter, undefined);
  assert.equal(browser({mode: 'ios'}).adapter, undefined);
});
test('WebAudio and speech recognition determine call availability; readMessage does not require recognition', async () => {
  const b = browser({recognition: false, webkit: true});
  assert.equal(b.adapter.available(), false);
  assert.equal(b.adapter.post('readMessage', {sessionId: 'read', text: '你好。'}), true);
  assert.equal(b.contexts[0].resumes, 1, 'resume is requested synchronously during the read gesture');
  await flush(); assert.equal(b.sources.length, 1);
  const unsupported = browser({withAudio: false});
  assert.equal(unsupported.adapter.available(), false);
  assert.equal(unsupported.adapter.post('readMessage', {sessionId: 'none', text: '你好'}), false);
});
test('The call gesture unlocks audio and both call and read use the same authenticated MP3 endpoint', async () => {
  const b = browser();
  b.adapter.post('prepareVoicePlayback', {callId: 'call'});
  assert.equal(b.contexts[0].resumes, 1);
  b.adapter.post('speakVoice', {callId: 'call', sessionId: 'voice', text: '你好，我是 Dots。'});
  await flush();
  const request = b.requests[0];
  assert.equal(request.url, '/api/voice/synthesize');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers['X-Shiyan-Local'], '1');
  assert.deepEqual(JSON.parse(request.options.body), {text: '你好，我是 Dots。'});
  assert.deepEqual(states(b), [['voice', 'speaking']]);
  assert.equal(b.events.find((event: any) => event.state === 'speaking').provider, 'xiaoxiao-neural');
  b.sources[0].end(); await flush();
  assert.deepEqual(states(b), [['voice', 'speaking'], ['voice', 'finished']]);
  b.adapter.post('readMessage', {sessionId: 'read', text: '朗读同样使用自然语音。'}); await flush();
  assert.equal(b.requests[1].url, request.url);
});
test('Cancelling a pending request aborts it and a late response cannot play or emit failed', async () => {
  const b = browser({autoFetch: false});
  b.adapter.post('readMessage', {sessionId: 'old', text: '不该播放。'}); await flush();
  b.adapter.post('stopMessageReading', {sessionId: 'old'});
  assert.equal(b.requests[0].options.signal.aborted, true);
  b.requests[0].resolve(response()); await flush();
  assert.equal(b.sources.length, 0);
  assert.deepEqual(states(b), [['old', 'cancelled']]);
});
test('Replacing a session while audio decodes never starts the old buffer', async () => {
  const b = browser({delayDecode: true});
  b.adapter.post('readMessage', {sessionId: 'old', text: '旧内容。'}); await flush();
  b.adapter.post('readMessage', {sessionId: 'new', text: '新内容。'}); await flush();
  b.contexts[0].decodes[0].resolve({duration: 1}); await flush();
  assert.equal(b.sources.length, 0);
  b.contexts[0].decodes[1].resolve({duration: 1}); await flush();
  assert.equal(b.sources.length, 1);
  assert.deepEqual(states(b), [['old', 'cancelled'], ['new', 'speaking']]);
});
test('Cancel stops active playback and aborts the one prefetched following segment', async () => {
  const b = browser({autoFetch: false});
  b.adapter.post('readMessage', {sessionId: 'read', text: '甲'.repeat(700)}); await flush();
  b.requests[0].resolve(response()); await flush();
  assert.equal(b.requests.length, 2); assert.equal(b.sources[0].started, true);
  b.adapter.post('stopMessageReading', {sessionId: 'another'});
  assert.equal(b.requests[0].options.signal.aborted, false);
  b.adapter.post('stopMessageReading', {sessionId: 'read'}); await flush();
  assert.equal(b.sources[0].stopped, true); assert.equal(b.sources[0].disconnected, true);
  assert.equal(b.requests[1].options.signal.aborted, true);
  b.requests[1].reject(Object.assign(new Error('Aborted'), {name: 'AbortError'})); await flush();
  assert.deepEqual(states(b), [['read', 'speaking'], ['read', 'cancelled']]);
});
test('Long text is synthesized and played in order with only one next segment prefetched', async () => {
  const b = browser({autoFetch: false});
  const text = '甲'.repeat(319) + '。' + '乙'.repeat(319) + '！' + '丙'.repeat(40);
  b.adapter.post('readMessage', {sessionId: 'long', text}); await flush();
  assert.equal(b.requests.length, 1);
  b.requests[0].resolve(response()); await flush();
  assert.equal(b.sources.length, 1); assert.equal(b.requests.length, 2);
  b.requests[1].resolve(response()); await flush();
  assert.equal(b.sources.length, 1); assert.equal(b.requests.length, 2, 'does not fetch the entire long message');
  b.sources[0].end(); await flush();
  assert.equal(b.sources.length, 2); assert.equal(b.requests.length, 3);
  b.requests[2].resolve(response()); b.sources[1].end(); await flush();
  assert.equal(b.sources.length, 3);
  const segments = b.requests.map((item: any) => JSON.parse(item.options.body).text);
  assert.equal(segments.join(''), text);
  assert.equal(segments.every((part: any) => Array.from(part).length <= 320), true);
  b.sources[2].end(); await flush();
  assert.deepEqual(states(b), [['long', 'speaking'], ['long', 'finished']]);
});
test('Server failures and invalid audio fail safely without browser speech fallback', async () => {
  for (const bad of [response({ok: false}), response({type: 'application/json'}), response({size: 0})]) {
    const b = browser({autoFetch: false});
    b.adapter.post('readMessage', {sessionId: 'bad', text: '测试。'}); await flush();
    b.requests[0].resolve(bad); await flush();
    assert.equal(b.sources.length, 0); assert.deepEqual(states(b), [['bad', 'failed']]);
    assert.equal(b.events.at(-1).message, '自然语音暂时不可用，请稍后重试。');
  }
});
test('Call termination and page hiding suppress pending and stale call requests', async () => {
  const b = browser({autoFetch: false});
  b.adapter.post('prepareVoicePlayback', {callId: 'current'});
  b.adapter.post('speakVoice', {callId: 'old-call', sessionId: 'stale', text: '旧通话'}); await flush();
  assert.equal(b.requests.length, 0);
  b.adapter.post('speakVoice', {callId: 'current', sessionId: 'pending', text: '当前通话'}); await flush();
  b.adapter.post('endVoiceCall', {callId: 'current'});
  b.requests[0].resolve(response()); await flush();
  assert.equal(b.sources.length, 0); assert.deepEqual(states(b), [['pending', 'cancelled']]);
  b.adapter.post('readMessage', {sessionId: 'page', text: '页面关闭'}); await flush();
  b.listeners.pagehide(); b.requests[1].resolve(response()); await flush();
  assert.equal(b.sources.length, 0); assert.equal(b.contexts[0].state, 'closed');
});
test('Empty and oversized messages do not synthesize audio', async () => {
  for (const text of ['', 'x'.repeat(20001)]) {
    const b = browser(); b.adapter.post('readMessage', {sessionId: 'invalid', text}); await flush();
    assert.equal(b.requests.length, 0); assert.deepEqual(states(b), [['invalid', 'failed']]);
  }
});

function panel(mode: any): any {
  const calls: any[] = [], native: any[] = [], errors: any[] = [];
  const context = {readSession: null, readingIndex: -1, readUtterance: null, currentConversation: {messages: [{role: 'assistant', content: '这条消息需要朗读。'}]},
    conversationDialog: null, C: {showError: (error: any) => errors.push(error.message)}, crypto: {randomUUID: () => 'read-session'},
    $: () => null, syncReadButtons: () => {},
    window: {ShiYanPlatform: {mode, adapter: (name: any) => {assert.equal(name, 'voice'); return {post: (action: any, detail: any) => {calls.push({action, detail}); return true;}};}},
      webkit: {messageHandlers: {native: {postMessage: (data: any) => native.push(data)}}}}};
  vm.createContext(context);
  vm.runInContext(panelSource.slice(panelSource.indexOf('  function stopReading()'), panelSource.indexOf('  async function openConversation(')), context);
  return {context, calls, native, errors};
}
test('Web message reading delegates to the same voice adapter even if a native bridge exists', () => {
  const p = panel('web'); p.context.readMessage(0);
  assert.equal(p.calls[0].action, 'readMessage');
  assert.equal(p.calls[0].detail.text, '这条消息需要朗读。'); assert.equal(p.native.length, 0);
  p.context.stopReading(); assert.equal(p.calls[1].action, 'stopMessageReading');
});
test('Desktop message reading retains its original native path', () => {
  const p = panel('desktop'); p.context.readMessage(0);
  assert.equal(p.native[0].action, 'readMessage'); assert.equal(p.calls.length, 0);
  p.context.stopReading(); assert.equal(p.native[1].action, 'stopMessageReading');
});


for (const {name, segments, expected} of [
  {name: 'continuous Chinese', segments: ['你 的 声 音 为 什 么 这 么 难 听 呢'], expected: '你的声音为什么这么难听呢'},
  {name: 'recognition result boundaries', segments: ['你 的 ', '声 音'], expected: '你的声音'},
  {name: 'horizontal whitespace variants', segments: ['你\t好\u00a0你\u3000好'], expected: '你好你好'},
  {name: 'Latin words and email', segments: ['请 打 开 Visual Studio Code 2026 并 搜 索 user@example.com'], expected: '请打开 Visual Studio Code 2026 并搜索 user@example.com'},
  {name: 'separate numbers and units', segments: ['版 本 1 2 3 配 置 20 GB'], expected: '版本 1 2 3 配置 20 GB'},
  {name: 'line breaks', segments: ['第 一 行\n第 二 行'], expected: '第一行\n第二行'},
  {name: 'English sentences', segments: ['hello world and good morning'], expected: 'hello world and good morning'},
  {name: 'supplementary Han characters', segments: ['𠮷 野 家'], expected: '𠮷野家'},
]) {
  test(`Recognition removes only Han word gaps in preview and final text: ${name}`, () => {
    const b = browser();
    b.adapter.post('startSpeech', {sessionId: 'capture'});
    const recognition = b.recognitions[0];
    recognition.onresult({results: segments.map(transcript => [{transcript}])});
    recognition.onend();
    const speech = b.events.filter((event: any) => event.type === 'speech');
    assert.deepEqual(speech.map((event: any) => [event.text, event.isFinal]), [[expected, false], [expected, true]]);
  });
}

test('Recognition normalization does not rewrite text passed to message reading', async () => {
  const b = browser();
  const text = '你 的 原 文 with spaces 1 2';
  b.adapter.post('readMessage', {sessionId: 'read', text});
  await flush();
  assert.equal(JSON.parse(b.requests[0].options.body).text, text);
});
