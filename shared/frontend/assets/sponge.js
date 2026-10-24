(() => {
  'use strict';
  const accountId = () => window.ShiYanAccount?.user?.id || null;
  const api = (action, method = 'GET') => window.ShiYanAccount.request('/integrations/sponge/' + action, method, method === 'POST' ? {} : undefined);
  const nativeAvailable = () => window.ShiYanPlatform?.adapter('native')?.available?.() === true;
  let card, modal, home, observer, timer = null, visible = false, invalidated = false;
  let owner = null, generation = 0, loading = false, busy = false, status = null;
  let pendingUntil = 0, fallbackUrl = '', notice = '', error = '';
  const current = epoch => !invalidated && epoch === generation && owner === accountId();
  const find = selector => card.querySelector(selector);
  const isVisible = () => !!card && !invalidated && !document.hidden && !modal.hidden && !home.hidden;

  function openExternal(url) {
    // The existing native action is permitted for any active account and opens
    // the system browser, without entering the privileged workspace browser.
    return nativeAvailable() && window.ShiYanPlatform.postNative('openExternal', {url}) === true;
  }
  function followExternal(event, url) {
    if (!nativeAvailable()) return;
    event.preventDefault();
    if (invalidated || owner !== accountId()) return;
    try {
      if (!openExternal(url)) throw new Error('暂时无法打开网页，请重试。');
    } catch (cause) {
      error = cause.message || '暂时无法打开网页，请重试。';
      render();
    }
  }

  function authorizeUrl(value) {
    const url = new URL(value);
    if (url.origin !== 'https://mcp.yandot.ai' || url.pathname !== '/oauth/authorize' ||
        url.username || url.password || url.hash ||
        !url.searchParams.get('shiyan_ticket') || !url.searchParams.get('client_id') || !url.searchParams.get('state') ||
        !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') || '') ||
        url.searchParams.get('code_challenge_method') !== 'S256' ||
        url.searchParams.get('response_type') !== 'code' ||
        url.searchParams.get('resource') !== 'https://mcp.yandot.ai/mcp' ||
        url.searchParams.get('redirect_uri') !== 'https://mcp.yandot.ai/shiyan/callback') {
      throw new Error('连接地址无效，请重试。');
    }
    return url.href;
  }
  function stopPoll() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }
  function render() {
    if (!card || invalidated) return;
    const connected = status?.connected === true;
    const devices = Array.isArray(status?.devices) ? status.devices : [];
    const online = devices.filter(device => device.online === true).length;
    const pending = pendingUntil > Date.now();
    find('[data-sponge-state]').textContent = connected
      ? '已连接 · ' + devices.length + ' 台设备' + (devices.length ? ' · ' + online + ' 台在线' : '，请先绑定设备')
      : pending ? '连接中…' : loading && !status ? '正在读取连接状态…' : '未连接';
    find('[data-sponge-description]').textContent = connected
      ? 'AI 可以访问你在海绵宝宝中绑定的设备。'
      : '使用当前拾燕账号登录海绵宝宝并绑定设备，即可交给 AI 使用。';
    const connect = find('[data-sponge-connect]');
    connect.hidden = connected;
    connect.textContent = pending ? '重新连接' : '连接';
    const manage = find('[data-sponge-manage]');
    manage.hidden = !connected;
    find('[data-sponge-disconnect]').hidden = !connected;
    for (const button of card.querySelectorAll('button')) button.disabled = loading || busy;
    card.setAttribute('aria-busy', String(loading || busy));
    find('[data-sponge-notice]').textContent = notice;
    find('[data-sponge-notice]').hidden = !notice;
    find('[data-sponge-error]').textContent = error;
    find('[data-sponge-error]').hidden = !error;
    const fallback = find('[data-sponge-fallback]');
    fallback.hidden = !fallbackUrl;
    if (fallbackUrl) fallback.href = fallbackUrl;
    else fallback.removeAttribute('href');
  }
  function schedulePoll() {
    stopPoll();
    if (!pendingUntil || !isVisible()) return;
    if (pendingUntil <= Date.now()) {
      pendingUntil = 0;
      fallbackUrl = '';
      notice = '连接尚未完成，可刷新状态或重新连接。';
      render();
      return;
    }
    timer = window.setTimeout(() => { timer = null; loadStatus(); }, 3000);
  }
  async function loadStatus() {
    if (!isVisible() || loading || busy) return;
    const epoch = generation;
    loading = true;
    render();
    try {
      const result = await api('status');
      if (!current(epoch)) return;
      if (typeof result.connected !== 'boolean' || !Array.isArray(result.devices)) throw new Error('连接状态暂时不可用，请重试。');
      status = result;
      error = '';
      if (result.connected) {
        pendingUntil = 0;
        fallbackUrl = '';
        notice = result.needsPairing ? '请在海绵宝宝中绑定你的电脑，然后刷新设备状态。' : '';
        stopPoll();
      }
    } catch (cause) {
      if (current(epoch)) error = cause.message || '读取失败，请重试。';
    } finally {
      if (current(epoch)) {
        loading = false;
        render();
        schedulePoll();
      }
    }
  }
  async function connect() {
    if (busy || loading || invalidated || owner !== accountId()) return;
    // Open in the click gesture, before the network request. Sever the opener
    // while the window is still same-origin, then navigate only to the fixed
    // provider authorization endpoint after validating its one-time challenge.
    const native = nativeAvailable();
    let popup = null;
    if (!native) {
      try { popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null; } catch {}
    }
    const epoch = generation;
    busy = true;
    error = '';
    fallbackUrl = '';
    stopPoll();
    render();
    try {
      const result = await api('start', 'POST');
      if (!current(epoch)) { popup?.close(); return; }
      const url = authorizeUrl(result.authorizeUrl);
      pendingUntil = Date.now() + 5 * 60 * 1000;
      notice = '请在新页面使用当前拾燕账号登录海绵宝宝，并完成设备绑定。';
      if (native) {
        if (!openExternal(url)) fallbackUrl = url;
      } else if (popup && !popup.closed) {
        try { popup.location.replace(url); } catch { fallbackUrl = url; popup.close(); }
      } else fallbackUrl = url;
    } catch (cause) {
      popup?.close();
      if (current(epoch)) error = cause.message || '暂时无法连接，请重试。';
    } finally {
      if (current(epoch)) {
        busy = false;
        render();
        schedulePoll();
      }
    }
  }
  async function disconnect() {
    if (busy || loading || invalidated || owner !== accountId()) return;
    const epoch = generation;
    busy = true;
    error = '';
    stopPoll();
    render();
    try {
      await api('disconnect', 'POST');
      if (!current(epoch)) return;
      status = {connected:false, devices:[]};
      pendingUntil = 0;
      fallbackUrl = '';
      notice = '已断开连接。';
    } catch (cause) {
      if (current(epoch)) error = cause.message || '断开失败，请重试。';
    } finally {
      if (current(epoch)) { busy = false; render(); schedulePoll(); }
    }
  }
  function syncVisibility() {
    const next = isVisible();
    if (next === visible) return;
    visible = next;
    if (next) { loadStatus(); schedulePoll(); }
    else stopPoll();
  }
  function mount() {
    home = document.querySelector('.settings-home');
    modal = document.getElementById('memoryModal');
    if (!home || !modal || card || invalidated || !accountId()) return;
    owner = accountId();
    const heading = document.createElement('h3');
    heading.className = 'settings-section-title';
    heading.textContent = '设备连接';
    card = document.createElement('section');
    card.className = 'sponge-integration';
    card.setAttribute('aria-label', '海绵宝宝连接');
    card.innerHTML = '<div class="sponge-integration-header"><span class="settings-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 21h8m-4-5v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span><div><strong>海绵宝宝</strong><p data-sponge-state role="status" aria-live="polite"></p><p data-sponge-description></p></div></div><div class="sponge-integration-actions"><button type="button" class="wb-secondary" data-sponge-connect>连接</button><a data-sponge-manage href="https://mcp.yandot.ai/account" target="_blank" rel="noopener noreferrer" hidden>管理设备</a><button type="button" class="wb-text-button" data-sponge-refresh>刷新</button><button type="button" class="wb-text-button" data-sponge-disconnect hidden>断开连接</button></div><p data-sponge-notice role="status" hidden></p><p data-sponge-error class="sponge-integration-error" role="alert" hidden></p><a data-sponge-fallback class="sponge-integration-fallback" target="_blank" rel="noopener noreferrer" hidden>继续连接海绵宝宝</a>';
    home.append(heading, card);
    find('[data-sponge-connect]').addEventListener('click', connect);
    find('[data-sponge-refresh]').addEventListener('click', loadStatus);
    find('[data-sponge-disconnect]').addEventListener('click', disconnect);
    find('[data-sponge-manage]').addEventListener('click', event => followExternal(event, 'https://mcp.yandot.ai/account'));
    find('[data-sponge-fallback]').addEventListener('click', event => {
      if (!fallbackUrl) { event.preventDefault(); return; }
      try { followExternal(event, authorizeUrl(fallbackUrl)); }
      catch { event.preventDefault(); error = '连接地址无效，请重试。'; render(); }
    });
    observer = new MutationObserver(syncVisibility);
    observer.observe(modal, {attributes:true, attributeFilter:['hidden']});
    observer.observe(home, {attributes:true, attributeFilter:['hidden']});
    render();
    syncVisibility();
  }
  window.addEventListener('shiyan-account-changing', () => {
    invalidated = true;
    generation++;
    owner = null;
    status = null;
    fallbackUrl = '';
    pendingUntil = 0;
    stopPoll();
    observer?.disconnect();
    card?.replaceChildren();
  });
  window.addEventListener('shiyan-settings-ready', mount);
  document.addEventListener('visibilitychange', syncVisibility);
  window.addEventListener('focus', () => { syncVisibility(); if (isVisible()) loadStatus(); });
  window.addEventListener('pagehide', stopPoll);
  mount();
})();
