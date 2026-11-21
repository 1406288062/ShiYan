/* Browser voice is a web-only adapter; desktop keeps its native audio path. */
(() => {
  'use strict';
  const platform = (window as any).ShiYanPlatform;
  if (platform?.mode !== 'web') return;
  const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  let callId: any = null, playback: any = null, capture: any = null, audio: any = null;
  const emit = (detail: any) => window.dispatchEvent(new CustomEvent('shiyan-native', {detail}));
  const state = (record: any, value: any, message?: any) => emit({type: 'voicePlaybackState', sessionId: record.id,
    state: value, ...(message ? {message} : {}), provider: 'xiaoxiao-neural'});
  const available = () => !!(AudioContext && Recognition);
  function unavailableReason() {
    if (!AudioContext) return '当前浏览器不支持语音播放，请更换浏览器后重试。';
    return '当前浏览器不支持语音输入，请使用支持浏览器语音输入的浏览器。';
  }
  function cancelPlayback(id?: any) {
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
  function cancelCapture(id?: any) {
    const record = capture;
    if (!record || (id && record.id !== id)) return;
    capture = null;
    clearTimeout(record.timer);
    try { record.recognition.abort(); } catch {}
  }
  function finishCapture(record: any) {
    if (capture !== record) return;
    // 浏览器没检测到有人说话（没有 speechstart，或结果在开始后瞬间就到）时不发送：
    // 这类文字来自环境声音或浏览器残留的上一轮识别，不是这次说的话。
    // 有的浏览器不触发 speechstart：边说边出现的多次中间结果同样说明是真在说话。
    const live = (record.speech || record.events >= 2) && record.heardAt - record.startedAt >= 400;
    const text = live ? record.text.trim() : '';
    cancelCapture(record.id);
    // 拦下的“幻听”文字不结束通话，静默地重新开始聆听（最多 3 次）。
    if (!text && record.text.trim() && (record.detail.restarts || 0) < 3) {
      startCapture({...record.detail, restarts: (record.detail.restarts || 0) + 1}); return;
    }
    if (text) emit({type: 'speech', sessionId: record.id, text, isFinal: true});
    else emit({type: 'speechState', sessionId: record.id, active: false});
  }
  function normalizeTranscript(text: any) {
    // Chinese recognition can insert word separators between every Han character.
    // Keep Latin words, numbers, mixed-language boundaries and line breaks intact.
    return text.replace(/(\p{Script=Han})[ \t\u00a0\u3000]+(?=\p{Script=Han})/gu, '$1');
  }
  function startCapture(detail: any) {
    cancelCapture();
    const recognition = new Recognition();
    const record: any = {id: detail.sessionId, detail, recognition, text: '', timer: 0, speech: false, events: 0, startedAt: Date.now(), heardAt: 0};
    capture = record;
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    const schedule = () => {
      clearTimeout(record.timer);
      if (record.text.trim()) record.timer = setTimeout(() => finishCapture(record),
        Math.max(300, Number(detail.autoStopAfterSilence || 1.4) * 1000));
    };
    recognition.onresult = (event: any) => {
      if (capture !== record) return;
      if (!record.heardAt) record.heardAt = Date.now();
      record.events++;
      record.text = normalizeTranscript(Array.from(event.results, (result: any) => result[0]?.transcript || '').join(''));
      emit({type: 'speech', sessionId: record.id, text: record.text, isFinal: false});
      schedule();
    };
    recognition.onspeechstart = () => { if (capture === record) { record.speech = true; clearTimeout(record.timer); } };
    recognition.onspeechend = () => { if (capture === record) schedule(); };
    recognition.onend = () => finishCapture(record);
    recognition.onerror = (event: any) => {
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
  // 第一段只放第一句（最多 60 字）：网络慢时也能很快开口；后面每段逐步变长（120、320 字），
  // 播放当前段时预取下一段。音频约 6KB/秒，下载比播放快时就不会断。
  const partLimit = (index: any) => index === 0 ? 60 : index === 1 ? 120 : 320;
  function speechParts(text: any) {
    const parts: any[] = [];
    let pending = '';
    const append = (value: any) => {
      if (pending && (parts.length === 0 || Array.from(pending + value).length > partLimit(parts.length))) {
        parts.push(pending); pending = '';
      }
      pending += value;
    };
    for (const sentence of text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/gu) || []) {
      const characters = Array.from(sentence);
      for (let offset = 0; offset < characters.length;) {
        const size = pending ? 320 : partLimit(parts.length);
        append(characters.slice(offset, offset + size).join(''));
        offset += size;
      }
    }
    if (pending) parts.push(pending);
    return parts;
  }
  async function fetchAudio(record: any, text: any) {
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
  async function play(record: any, text: any, ready: any) {
    const context = await ready;
    if (playback !== record) return;
    const parts = speechParts(text);
    let pending: any = fetchAudio(record, parts[0]);
    for (let index = 0; index < parts.length; index++) {
      const bytes = await pending;
      if (playback !== record) return;
      // At most one following segment is fetched while this segment plays.
      pending = index + 1 < parts.length ? fetchAudio(record, parts[index + 1]) : null;
      pending?.catch(() => {}); // A prefetch failure is handled on its next turn.
      const buffer = await context.decodeAudioData(bytes);
      if (playback !== record) return;
      await new Promise<void>((resolve, reject) => {
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
  function speak(detail: any) {
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
  function post(action: any, detail: any = {}) {
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
