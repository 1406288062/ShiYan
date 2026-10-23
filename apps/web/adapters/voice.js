/* Browser voice is a web-only adapter; desktop keeps its native audio path. */
(() => {
  'use strict';
  const platform = window.ShiYanPlatform;
  if (platform?.mode !== 'web') return;
  const synthesis = window.speechSynthesis;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let callId = null, playback = null, capture = null;
  const emit = detail => window.dispatchEvent(new CustomEvent('shiyan-native', {detail}));
  const state = (record, value, message) => emit({type: 'voicePlaybackState', sessionId: record.id,
    state: value, ...(message ? {message} : {}), provider: 'browser-speech-synthesis'});
  const available = () => !!(synthesis && window.SpeechSynthesisUtterance && Recognition);
  function unavailableReason() {
    if (!synthesis || !window.SpeechSynthesisUtterance) return '当前浏览器不支持语音朗读，请更换浏览器后重试。';
    return '当前浏览器不支持语音输入，请使用支持浏览器语音输入的浏览器。';
  }
  function cancelPlayback(id) {
    const record = playback;
    if (!record || (id && record.id !== id)) return;
    playback = null;
    record.clearVoiceWait?.();
    try { synthesis.cancel(); } catch {}
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
  // Web Speech exposes no quality flag: use advertised voice names, never
  // assume that a local or remote voice is inherently higher quality.
  function preferredVoice() {
    const chinese = synthesis.getVoices().filter(voice => /^zh(?:-|_|$)/i.test(voice.lang));
    const score = voice => {
      const name = voice.name || '';
      const mandarin = !/^zh[-_](?:HK|MO|yue)(?:[-_]|$)/i.test(voice.lang);
      const quality = /natural|neural|premium|enhanced|自然|神经|增[强強]|优质|優質/i.test(name);
      return (mandarin ? 1000 : 0) + (quality ? 100 : 0)
        + (/^zh[-_](?:CN|Hans)(?:[-_]|$)/i.test(voice.lang) ? 10 : 0)
        + (voice.default ? 1 : 0);
    };
    return chinese.sort((a, b) => score(b) - score(a))[0];
  }
  function speak(detail) {
    cancelPlayback();
    const utterance = new SpeechSynthesisUtterance(String(detail.text || ''));
    utterance.lang = 'zh-CN';
    const record = {id: detail.sessionId, utterance};
    playback = record; // Also guards delayed voice-list loading against cancellation.
    utterance.onstart = () => { if (playback === record) state(record, 'speaking'); };
    utterance.onend = () => {
      if (playback !== record) return;
      playback = null;
      emit({type: 'voicePlaybackLevel', sessionId: record.id, level: 0});
      state(record, 'finished');
    };
    utterance.onerror = event => {
      if (playback !== record) return;
      playback = null;
      state(record, ['canceled', 'interrupted'].includes(event.error) ? 'cancelled' : 'failed',
        '浏览器朗读未能完成，请重新开启语音通话。');
    };
    const begin = () => {
      if (playback !== record) return;
      record.clearVoiceWait?.();
      const selected = preferredVoice();
      if (selected) { utterance.voice = selected; utterance.lang = selected.lang; }
      try { synthesis.speak(utterance); }
      catch {
        playback = null;
        queueMicrotask(() => state(record, 'failed', '浏览器朗读未能启动，请重试。'));
      }
    };
    if (preferredVoice()) { begin(); return; }
    // Some browsers populate voices asynchronously, especially on first use.
    const onVoicesChanged = () => { if (preferredVoice()) begin(); };
    const timer = setTimeout(begin, 800);
    record.clearVoiceWait = () => {
      clearTimeout(timer);
      synthesis.removeEventListener('voiceschanged', onVoicesChanged);
      record.clearVoiceWait = null;
    };
    synthesis.addEventListener('voiceschanged', onVoicesChanged);
    onVoicesChanged();
  }
  function post(action, detail = {}) {
    if (action === 'prepareVoicePlayback') {
      cancelCapture(); cancelPlayback(); callId = detail.callId;
      if (synthesis) synthesis.getVoices();
      return true;
    }
    if (detail.callId && detail.callId !== callId) return true;
    if (action === 'endVoiceCall') {
      callId = null; cancelCapture(); cancelPlayback(); return true;
    }
    if (action === 'cancelSpeech') { cancelCapture(detail.sessionId); return true; }
    if (action === 'cancelVoicePlayback') { cancelPlayback(detail.sessionId); return true; }
    if (action === 'startSpeech') {
      if (!Recognition) return false;
      startCapture(detail); return true;
    }
    if (action === 'speakVoice') {
      if (!synthesis || !window.SpeechSynthesisUtterance) return false;
      speak(detail); return true;
    }
    return ['updateDotsVoiceCall', 'dotsVoiceTrace'].includes(action);
  }
  window.addEventListener('pagehide', () => {callId = null; cancelCapture(); cancelPlayback();});
  platform.registerAdapter('voice', {available, unavailableReason, post}, 'web');
})();
