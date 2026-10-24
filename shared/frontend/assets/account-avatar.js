(() => {
  'use strict';
  const account = window.ShiYanAccount;
  const owner = account.user?.id;
  // A verified snapshot is scoped to the authenticated account, never global legacy settings.
  const cacheKey = owner ? 'shiyan.account.' + encodeURIComponent(owner) + '.avatar.snapshot.v1' : null;
  const images = new Set();
  let profile = readCachedProfile(), busy = false, stopped = false, stream = null, pending = null;
  let migrationAttempted = false, serverConfirmed = false;
  let retryTimer = null, retryDelay = 1000;
  const active = () => !stopped && owner && account.user?.id === owner;
  const placeholderIcon = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="12" r="5"/><path d="M6 29v-4a10 10 0 0 1 20 0v4Z"/></svg>';
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.hidden = true; input.id = 'avatarInput';
  document.body.append(input);

  function validAvatar(value) {
    return value && typeof value === 'object' && Number.isSafeInteger(value.revision) &&
      value.revision >= 0 && (value.data === null || (typeof value.data === 'string' &&
        value.data.length <= 1400000 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data)));
  }

  function readCachedProfile() {
    if (!cacheKey) return null;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw === null) return null;
      if (raw.length <= 1400200) {
        const value = JSON.parse(raw);
        if (validAvatar(value)) return value;
      }
      localStorage.removeItem(cacheKey);
    } catch {} // Disabled storage must not block login.
    return null;
  }

  function cacheProfile(value) {
    if (!cacheKey) return;
    try {
      localStorage.setItem(cacheKey, JSON.stringify({revision: value.revision, data: value.data}));
    } catch {
      // If quota is exhausted, never leave a stale avatar ready for the next launch.
      try { localStorage.removeItem(cacheKey); } catch {}
    }
  }

  function render() {
    if (!active()) return;
    const src = profile?.data ? 'data:image/jpeg;base64,' + profile.data : '';
    for (const view of images) {
      if (!view.image.isConnected) { images.delete(view); continue; }
      if (view.source !== src) {
        view.source = src;
        view.image.hidden = !src; view.placeholder.toggleAttribute('hidden', !!src);
        if (src) view.image.src = src; else view.image.removeAttribute('src');
      }
    }
    for (const button of document.querySelectorAll('[data-account-avatar-change],[data-avatar-change]')) {
      button.disabled = busy;
      button.setAttribute('aria-busy', String(busy));
    }
  }

  function bind(image, placeholder) {
    const view = {image, placeholder, source: null};
    images.add(view);
    image.onerror = () => { image.hidden = true; placeholder.removeAttribute('hidden'); };
    render();
  }

  function accept(result) {
    if (!active()) return;
    const value = result?.avatar;
    if (!validAvatar(value)) return;
    // A delayed GET or upload response must never replace a newer event or cached revision.
    if (profile && value.revision < profile.revision) return;
    const changed = !profile || profile.revision !== value.revision || profile.data !== value.data;
    profile = value;
    serverConfirmed = true;
    if (changed) cacheProfile(value);
    render();
    migrateLegacy();
    return true;
  }

  async function refresh() {
    if (!active()) return;
    if (!pending) pending = account.request('/account/avatar').then(accept).finally(() => { pending = null; });
    return pending;
  }

  async function jpeg(file) {
    if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20 MB 的图片');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      if (!side) throw new Error('无法读取这张图片');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = Math.min(512, side);
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    } catch (error) {
      throw new Error(error.message?.includes('20 MB') ? error.message : '无法读取这张图片，请选择其他照片');
    } finally { URL.revokeObjectURL(url); }
  }

  async function migrateLegacy() {
    if (!active() || !serverConfirmed || busy || migrationAttempted || profile?.revision !== 0) return;
    const id = window.shiyan?.getState()?.settings?.avatarAssetId;
    if (!id) return;
    migrationAttempted = true;
    try {
      const response = await fetch('/api/assets/' + encodeURIComponent(id) + '/file', {cache:'no-store'});
      if (!response.ok) return;
      const data = await jpeg(await response.blob());
      if (!active() || profile?.revision !== 0 || busy) return;
      accept(await account.request('/account/avatar', 'PUT', {data, expectedRevision:0}));
    } catch (error) {
      if (active() && error.status === 409) refresh().catch(() => {});
    }
  }

  async function update(file) {
    if (!active() || busy) return;
    busy = true; render();
    try {
      const data = await jpeg(file);
      if (!active()) return;
      accept(await account.request('/account/avatar', 'PUT', {data}));
      if (active()) window.shiyan?.toast('头像已更新');
    } catch (error) {
      if (active() && error.name !== 'AbortError') window.shiyan?.toast(error.message);
    } finally { busy = false; input.value = ''; render(); }
  }

  function choose() { if (active() && !busy) input.click(); }
  input.onchange = () => { if (input.files?.[0]) update(input.files[0]); };

  function mountProfile() {
    const home = document.querySelector('.settings-home');
    if (!home || home.querySelector('.account-avatar-profile')) return;
    const section = document.createElement('section');
    section.className = 'account-avatar-profile';
    section.innerHTML = '<button type="button" class="account-avatar-picker" data-account-avatar-change aria-label="更换头像"><span class="account-avatar-picture">' + placeholderIcon + '<img alt="用户头像" hidden></span><span class="account-avatar-pencil" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m16 4 4 4M4 20l5-1L21 7a2.8 2.8 0 0 0-4-4L5 15z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></span></button><strong></strong>';
    section.querySelector('strong').textContent = account.user.displayName || account.user.email || account.user.username || '账户';
    section.querySelector('[data-account-avatar-change]').onclick = choose;
    home.querySelector('.memory-header')?.after(section);
    bind(section.querySelector('img'), section.querySelector('.account-avatar-picture>svg'));
  }

  function clearRetry() {
    clearTimeout(retryTimer); retryTimer = null;
  }

  function disconnect() {
    clearRetry(); stream?.close(); stream = null;
  }

  function reconnectLater() {
    if (!active() || document.hidden || retryTimer !== null) return;
    const delay = retryDelay;
    retryDelay = Math.min(15000, retryDelay * 2);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  function connect() {
    if (!active() || document.hidden) return;
    if (window.ShiYanPlatform?.deferUntilLoaded?.(connect)) return;
    if (stream && stream.readyState !== EventSource.CLOSED) return;
    disconnect();
    const source = stream = new EventSource('/api/account/avatar/events');
    source.addEventListener('avatar', event => {
      if (stream !== source) return;
      try { if (accept(JSON.parse(event.data))) retryDelay = 1000; } catch {}
    });
    source.addEventListener('error', () => {
      // Browsers retry a broken transport, but HTTP errors may close it permanently.
      if (stream !== source || source.readyState !== EventSource.CLOSED) return;
      source.close(); stream = null;
      reconnectLater();
    });
  }

  function stop() {
    stopped = true; disconnect(); profile = null;
    for (const view of images) { view.image.hidden = true; view.image.removeAttribute('src'); view.placeholder.removeAttribute('hidden'); }
    input.value = '';
  }

  window.ShiYanAvatar = {bind, choose};
  window.addEventListener('shiyan-settings-ready', mountProfile);
  window.addEventListener('shiyan-state', () => { render(); migrateLegacy(); });
  window.addEventListener('shiyan-account-changing', stop);
  window.addEventListener('pagehide', disconnect);
  window.addEventListener('pageshow', connect);
  window.addEventListener('online', () => { if (active()) { disconnect(); refresh().catch(() => {}); connect(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) disconnect();
    else if (active()) { refresh().catch(() => {}); connect(); }
  });
  account.ready.then(() => { if (active()) { mountProfile(); refresh().catch(() => {}); connect(); } });
})();
