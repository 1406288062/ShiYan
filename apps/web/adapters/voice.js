/* Browser voice is a web-only adapter; desktop keeps its native audio path. */
(() => {
  'use strict';
  const platform = window.ShiYanPlatform;
  if (platform?.mode !== 'web') return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let callId = null, playback = null, capture = null, audio = null;
  const emit = detail => window.dispatchEvent(new CustomEvent('shiyan-native', {detail}));
  const state = (record, value, message) => emit({type: 'voicePlaybackState', sessionId: record.id,
    state: value, ...(message ? {message} : {}), provider: 'xiaoxiao-neural'});
  const available = () => !!(AudioContext && Recognition);
  function unavailableReason() {
    if (!AudioContext) return '当前浏览器不支持语音播放，请更换浏览器后重试。';
    return '当前浏览器不支持语音输入，请使用支持浏览器语音输入的浏览器。';
  }
  function cancelPlayback(id) {
    const record = playback;
    if (!record || (id && record.id !== id)) return;
    playback = null;
    record.controller.abort();
    if (record.source) {
      record.source.onended = null;
      try { record.source.stop(); } catch {}
      record.source.disconnect();
    }
    record.finishPart?.();
    emit({type: 'voicePlaybackLevel', sessionId: record.id, level: 0});
    state(record, 'cancelled');
  }
  function cancelCapture(id) {
    const record = capture;
    if (!record || (id && record.id !== id)) return;
    capture = null;
    clearTimeout(record.timer);
    try { record.recognition.abort(); } catch {}
  }
  function finishCapture(record) {
    if (capture !== record) return;
    const text = record.text.trim();
    cancelCapture(record.id);
    if (text) emit({type: 'speech', sessionId: record.id, text, isFinal: true});
    else emit({type: 'speechState', sessionId: record.id, active: false});
  }
  function startCapture(detail) {
    cancelCapture();
    const recognition = new Recognition();
    const record = {id: detail.sessionId, recognition, text: '', timer: 0};
    capture = record;
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    const schedule = () => {
      clearTimeout(record.timer);
      if (record.text.trim()) record.timer = setTimeout(() => finishCapture(record),
        Math.max(300, Number(detail.autoStopAfterSilence || 1.4) * 1000));
    };
    recognition.onresult = event => {
      if (capture !== record) return;
      record.text = Array.from(event.results, result => result[0]?.transcript || '').join('');
      emit({type: 'speech', sessionId: record.id, text: record.text, isFinal: false});
      schedule();
    };
    recognition.onspeechstart = () => { if (capture === record) clearTimeout(record.timer); };
    recognition.onspeechend = () => { if (capture === record) schedule(); };
    recognition.onend = () => finishCapture(record);
    recognition.onerror = event => {
      if (capture !== record) return;
      cancelCapture(record.id);
      const denied = ['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error);
      emit({type: 'speechError', sessionId: record.id, message: denied
        ? '无法使用麦克风，请检查浏览器的麦克风权限。' : '浏览器语音识别暂时不可用，请重试。'});
    };
    try { recognition.start(); }
    catch {
      cancelCapture(record.id);
      queueMicrotask(() => emit({type: 'speechError', sessionId: record.id,
        message: '浏览器语音输入未能启动，请检查麦克风权限后重试。'}));
    }
  }
  function prepareAudio() {
    // Called synchronously from the user's call/read gesture before any fetch.
    if (!audio || audio.state === 'closed') audio = new AudioContext();
    const context = audio;
    return Promise.resolve(context.resume()).then(() => {
      if (context.state !== 'running') throw Error('请允许浏览器播放语音后重试。');
      return context;
    });
  }
  function speechParts(text) {
    const parts = [];
    let pending = '';
    const append = value => {
      if (pending && Array.from(pending + value).length > 320) {
        parts.push(pending); pending = '';
      }
      pending += value;
    };
    for (const sentence of text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/gu) || []) {
      const characters = Array.from(sentence);
      for (let offset = 0; offset < characters.length; offset += 320) {
        append(characters.slice(offset, offset + 320).join(''));
      }
    }
    if (pending) parts.push(pending);
    return parts;
  }
  async function fetchAudio(record, text) {
    const response = await fetch('/api/voice/synthesize', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type': 'application/json', 'X-Shiyan-Local': '1'},
      body: JSON.stringify({text}), signal: record.controller.signal,
    });
    if (!response.ok || !/^audio\/mpeg(?:;|$)/i.test(response.headers.get('content-type') || '')) {
      throw Error('自然语音暂时不可用，请稍后重试。');
    }
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw Error('自然语音暂时不可用，请稍后重试。');
    return bytes;
  }
  async function play(record, text, ready) {
    const context = await ready;
    if (playback !== record) return;
    const parts = speechParts(text);
    let pending = fetchAudio(record, parts[0]);
    for (let index = 0; index < parts.length; index++) {
      const bytes = await pending;
      if (playback !== record) return;
      // At most one following segment is fetched while this segment plays.
      pending = index + 1 < parts.length ? fetchAudio(record, parts[index + 1]) : null;
      pending?.catch(() => {}); // A prefetch failure is handled on its next turn.
      const buffer = await context.decodeAudioData(bytes);
      if (playback !== record) return;
      await new Promise((resolve, reject) => {
        const source = context.createBufferSource();
        record.source = source; record.finishPart = resolve;
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => {
          source.disconnect();
          if (record.source === source) { record.source = null; record.finishPart = null; }
          resolve();
        };
        try {
          source.start();
          if (!record.started) { record.started = true; state(record, 'speaking'); }
        } catch (error) { source.disconnect(); reject(error); }
      });
      if (playback !== record) return;
    }
    playback = null;
    emit({type: 'voicePlaybackLevel', sessionId: record.id, level: 0});
    state(record, 'finished');
  }
  function speak(detail) {
    cancelPlayback();
    const record = {id: detail.sessionId, controller: new AbortController(), source: null, finishPart: null, started: false};
    playback = record;
    const text = String(detail.text || '').trim();
    let ready;
    try {
      if (!text || text.length > 20000) throw Error('朗读内容为空或过长。');
      ready = prepareAudio();
    } catch (error) { ready = Promise.reject(error); }
    play(record, text, ready).catch(() => {
      if (playback !== record) return;
      playback = null;
      record.controller.abort();
      emit({type: 'voicePlaybackLevel', sessionId: record.id, level: 0});
      state(record, 'failed', '自然语音暂时不可用，请稍后重试。');
    });
  }
  function post(action, detail = {}) {
    if (action === 'prepareVoicePlayback') {
      cancelCapture(); cancelPlayback(); callId = detail.callId;
      if (AudioContext) { try { prepareAudio().catch(() => {}); } catch {} }
      return true;
    }
    if (detail.callId && detail.callId !== callId) return true;
    if (action === 'endVoiceCall') {
      callId = null; cancelCapture(); cancelPlayback(); return true;
    }
    if (action === 'cancelSpeech') { cancelCapture(detail.sessionId); return true; }
    if (action === 'cancelVoicePlayback' || action === 'stopMessageReading') { cancelPlayback(detail.sessionId); return true; }
    if (action === 'startSpeech') {
      if (!Recognition) return false;
      startCapture(detail); return true;
    }
    if (action === 'speakVoice' || action === 'readMessage') {
      if (!AudioContext) return false;
      speak(detail); return true;
    }
    return ['updateDotsVoiceCall', 'dotsVoiceTrace'].includes(action);
  }
  window.addEventListener('pagehide', () => {
    callId = null; cancelCapture(); cancelPlayback();
    if (audio) { try { Promise.resolve(audio.close()).catch(() => {}); } catch {} audio = null; }
  });
  platform.registerAdapter('voice', {available, unavailableReason, post}, 'web');
})();
