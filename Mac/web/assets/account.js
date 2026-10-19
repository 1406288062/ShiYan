(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const isOwner = account => account?.owner === 'shiyan-private-owner';
  const originalFetch = window.fetch.bind(window);
  let user = null, mode = 'login', status = null, busy = false, loaded = false, expiring = false, applicationStarted = false;
  let rememberedMode = false, trustedMode = false, hasRemembered = false;
  let codeSending = false, codeResendAt = 0, codeTimer = null;
  let statusLoad;
  let qrMode = false, qrVersion = 0, qrTimer = null, qrId = null, qrExpiry = 0;
  const startupTimings = window.__ShiYanAccountTimings = {};
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('shiyan.account.session') : null;
  const appearance = matchMedia('(prefers-color-scheme: light)');
  const syncAppearance = () => document.body.classList.toggle('account-light', appearance.matches);
  syncAppearance(); appearance.addEventListener('change', syncAppearance);

  async function request(path, method = 'GET', body) {
    if (expiring) throw new DOMException('账户会话已更改', 'AbortError');
    const response = await originalFetch('/api' + path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type':'application/json', 'X-Shiyan-Local':'1'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})
    });
    const data = await response.json().catch(() => ({}));
    if (expiring) throw new DOMException('账户会话已更改', 'AbortError');
    if (!response.ok || data.ok === false) {
      const reason = data.error || data.detail;
      const error = new Error(typeof reason === 'string' ? reason : reason?.message || '连接暂时中断，请稍后重试');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function invalidate() {
    if (expiring) return;
    expiring = true;
    document.documentElement.classList.remove('account-ready');
    document.documentElement.classList.add('account-locked');
    if ($('app')) $('app').inert = true;
    // A full document teardown closes streams and discards all account-specific memory.
    location.reload();
  }
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
    const accountRequest = url.origin === location.origin && url.pathname.startsWith('/api/');
    if (expiring && accountRequest) throw new DOMException('账户会话已更改', 'AbortError');
    const response = await originalFetch(input, options);
    if (expiring && accountRequest) throw new DOMException('账户会话已更改', 'AbortError');
    if (applicationStarted && accountRequest && response.status === 401) invalidate();
    return response;
  };
  channel?.addEventListener('message', event => {
    // Another tab can change the shared cookie while /auth/me or scripts are
    // still loading. Teardown applies before identity is known and before ready.
    if (['login','logout','permissions'].includes(event.data?.type)) invalidate();
  });

  function storageKey(key) {
    if (!user) throw new Error('请先登录');
    const scoped = 'shiyan.account.' + encodeURIComponent(user.id) + '.' + key;
    if (isOwner(user) && localStorage.getItem(scoped) === null) {
      const legacy = localStorage.getItem(key);
      if (legacy !== null) { localStorage.setItem(scoped, legacy); localStorage.removeItem(key); }
    }
    return scoped;
  }

  function showError(message, retry = false) {
    $('accountError').textContent = message || '';
    $('accountError').hidden = !message;
    $('accountRetry').hidden = !retry;
  }
  function render() {
    if (expiring) return;
    const register = mode === 'register';
    $('accountGate').dataset.authMode = register ? 'register' : 'login';
    if (register && qrMode) stopQR();
    $('accountRemembered').hidden = !rememberedMode;
    document.querySelector('.auth-switch').hidden = false;
    $('accountForm').hidden = qrMode || rememberedMode;
    $('accountQRPanel').hidden = !qrMode || trustedMode;
    $('accountPasswordMode').hidden = register;
    $('accountPasswordMode').textContent = qrMode || rememberedMode ? '密码登录' : hasRemembered ? '头像登录' : '扫码登录';
    $('accountPasswordMode').disabled = busy;
    $('accountTitle').textContent = register ? '创建账户' : '登录';
    $('accountNameField').hidden = !register;
    $('accountVerificationField').hidden = !register;
    $('accountVerificationCode').required = register;
    $('accountEmail').readOnly = codeSending;
    $('accountSendCode').disabled = busy || codeSending || Date.now() < codeResendAt;
    $('accountSendCode').textContent = codeSending ? '正在发送…' : Date.now() < codeResendAt ? Math.ceil((codeResendAt-Date.now())/1000) + ' 秒后重发' : '获取验证码';
    $('accountPassword').autocomplete = register ? 'new-password' : 'current-password';
    $('accountSubmitLabel').textContent = busy ? (applicationStarted ? '正在打开会话…' : register ? '正在创建账户…' : '正在登录…') : register ? '创建账户' : '登录';
    $('accountSwitchButton').textContent = register ? '返回登录' : '注册账号';
    $('accountSubmit').disabled = busy || codeSending;
    $('accountSwitchButton').disabled = busy || codeSending;
    $('accountReconnect').disabled = busy;
    const bootstrap = register && status?.bootstrapRequired;
    $('accountSetup').hidden = !register;
    $('accountSetup').textContent = bootstrap ? (status?.canBootstrap ? '此设备将创建你的所有者账户并保留现有资料。其他新账户默认为普通用户。' : '请先由所有者在原有授权设备上完成账户设置。') : '新账户默认为普通用户，权限由管理员管理。';
    if (bootstrap && !status?.canBootstrap) $('accountSubmit').disabled = true;
    $('accountGate').hidden = false;
  }

  // Fetch public code in parallel with authentication; execution stays gated.
  for (const placeholder of document.querySelectorAll('script[data-account-src]')) {
    const preload = document.createElement('link');
    preload.rel = 'preload'; preload.as = 'script'; preload.href = placeholder.dataset.accountSrc;
    document.head.append(preload);
  }

  function loadStatus() {
    if (!statusLoad) statusLoad = request('/auth/status').then(value => {
      status = value;
      if (!loaded && !applicationStarted) {
        if (status.bootstrapRequired && status.canBootstrap) mode = 'register';
        if (!busy) render();
      }
      return value;
    }).catch(error => { statusLoad = null; throw error; });
    return statusLoad;
  }

  async function loadApplication(nextUser) {
    if (expiring) return;
    if (!nextUser?.id || nextUser.status !== 'active') throw new Error('账户不可用，请联系管理员');
    stopQR();
    user = nextUser;
    startupTimings.authReady = performance.now();
    document.documentElement.dataset.accountRole = user.role;
    document.documentElement.dataset.accountOwner = String(isOwner(user));
    document.documentElement.classList.toggle('account-no-server', !user.serverAccess);
    // These scripts read caches during evaluation. Never evaluate before identity is known.
    applicationStarted = true;
    if (!$('accountGate').hidden) render();
    // Start downloads together; classic scripts with async=false still execute in order.
    // Identity must be established before any script can read account-specific caches.
    const scriptLoads = [...document.querySelectorAll('script[data-account-src]')].map(placeholder => {
      const script = document.createElement('script');
      script.src = placeholder.dataset.accountSrc;
      script.async = false;
      return new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => reject(new Error('界面加载失败，请重新连接'));
        placeholder.after(script);
      });
    });
    await Promise.all(scriptLoads);
    startupTimings.scriptsReady = performance.now();
    if (expiring) return;
    loaded = true;
    $('accountGate').hidden = true;
    $('app').inert = false;
    document.documentElement.classList.remove('account-locked');
    document.documentElement.classList.add('account-ready');
    resolveReady(user);
    mountSettingsEntry();
  }

  async function bootstrap() {
    if (busy) return;
    busy = true; showError('');
    try {
      try {
        let result;
        try { result = await request('/auth/me'); }
        catch (error) {
          if (error.name === 'AbortError' || (error.status && error.status < 500)) throw error;
          await new Promise(resolve => setTimeout(resolve, 200));
          result = await request('/auth/me');
        }
        await loadApplication(result.user);
        return;
      } catch (error) {
        if (![401,403].includes(error.status)) throw error;
      }
      // Login is usable immediately after a local 401; device/bootstrap status
      // is needed only for registration and must not block the initial screen.
      try {
        const saved = await request('/auth/remembered');
        if (saved.profile) {
          hasRemembered = true;
          $('accountRememberedName').textContent = saved.profile.name;
          const avatar = $('accountRememberedAvatar'); avatar.replaceChildren();
          if (typeof saved.profile.avatar === 'string' && /^[A-Za-z0-9+/=]{1,8192}$/.test(saved.profile.avatar)) {
            const image = document.createElement('img'); image.src = 'data:image/jpeg;base64,' + saved.profile.avatar; image.alt = ''; avatar.append(image);
          } else avatar.textContent = String(saved.profile.name || '拾燕').slice(0, 1);
        }
      } catch (_) { /* Password/QR login remains available if the remembered profile is absent. */ }
      busy = false; render();
      if (mode === 'login') { if (hasRemembered) showAvatarLogin(); else await startQR(); }
      loadStatus().catch(error => { if (!loaded && !applicationStarted && !busy) showError(error.message, true); });
    } catch (error) { showError(error.message, true); }
    finally { busy = false; if (!loaded) render(); }
  }

  async function authenticate(event) {
    event.preventDefault();
    if (applicationStarted) { location.reload(); return; }
    if (busy) return;
    busy = true; showError(''); render();
    try {
      if (mode === 'register' && !status) await loadStatus();
      const path = mode === 'login' ? 'login' : status?.bootstrapRequired && status?.canBootstrap ? 'bootstrap' : 'register';
      const result = await request('/auth/' + path, 'POST', {
        email: $('accountEmail').value.trim(), password: $('accountPassword').value,
        ...(mode === 'register' ? {display_name:$('accountName').value.trim(), verificationCode:$('accountVerificationCode').value.trim()} : {})
      });
      $('accountPassword').value = '';
      channel?.postMessage({type:'login',userId:result.user.id});
      await loadApplication(result.user);
    } catch (error) { showError(error.message, !error.status); }
    finally { busy = false; if (!loaded) render(); }
  }

  function stopQR() {
    qrMode = false; trustedMode = false; qrVersion++; clearTimeout(qrTimer); qrTimer = null; qrId = null;
    $('accountQRImage').hidden = true; $('accountQRImage').removeAttribute('src');
  }
  function showAvatarLogin() {
    stopQR(); rememberedMode = true; mode = 'login';
    $('accountRememberedLogin').disabled = false;
    $('accountRememberedStatus').textContent = ''; $('accountRememberedCode').textContent = '';
    showError(''); render();
  }
  async function startQR() {
    if (busy || loaded || applicationStarted) return;
    stopQR(); rememberedMode = false; qrMode = true; mode = 'login'; render(); showError('');
    const version = qrVersion;
    $('accountQRStatus').textContent = '正在生成二维码…'; $('accountQRCode').textContent = '';
    $('accountQRRefresh').disabled = true;
    try {
      const result = await request('/auth/qr/create', 'POST', {});
      if (!qrMode || version !== qrVersion) return;
      qrId = result.id; qrExpiry = result.expiresAt;
      $('accountQRImage').src = 'data:image/png;base64,' + result.image; $('accountQRImage').hidden = false; $('accountQRImage').style.opacity = '1';
      $('accountQRCode').textContent = '确认码 ' + result.code;
      $('accountQRStatus').textContent = '用拾燕 iOS“扫一扫”，核对确认码后登录';
      qrTimer = setTimeout(() => pollQR(version), 1500);
    } catch (error) { if (qrMode && version === qrVersion) $('accountQRStatus').textContent = error.message; }
    finally { if (version === qrVersion) $('accountQRRefresh').disabled = false; }
  }
  async function pollQR(version) {
    if (!qrMode || version !== qrVersion || loaded || document.hidden) {
      if (qrMode && version === qrVersion && !loaded) qrTimer = setTimeout(() => pollQR(version), 1500);
      return;
    }
    if (Date.now() >= qrExpiry) { $(trustedMode ? 'accountRememberedStatus' : 'accountQRStatus').textContent = '登录请求已过期，请重新发起'; $('accountRememberedLogin').disabled = false; $('accountQRImage').style.opacity = '0.4'; return; }
    const statusElement = $(trustedMode ? 'accountRememberedStatus' : 'accountQRStatus');
    try {
      const result = await request(trustedMode ? '/auth/device/poll' : '/auth/qr/poll', 'POST', {id:qrId});
      if (!qrMode || version !== qrVersion) return;
      if (result.state === 'approved') {
        channel?.postMessage({type:'login',userId:result.user.id});
        try { await loadApplication(result.user); }
        catch (error) { showError(error.message, true); }
        return;
      }
      if (['denied','superseded'].includes(result.state)) { statusElement.textContent = '登录请求已取消，请重新发起'; $('accountRememberedLogin').disabled = false; $('accountQRImage').style.opacity = '0.4'; return; }
    } catch (error) {
      if (!qrMode || version !== qrVersion) return;
      statusElement.textContent = error.message; $('accountRememberedLogin').disabled = false;
      if (error.status && error.status < 500) { $('accountQRImage').style.opacity = '0.4'; return; }
    }
    if (qrMode && version === qrVersion) qrTimer = setTimeout(() => pollQR(version), 1500);
  }
  $('accountRememberedLogin').onclick = async () => {
    if (busy || loaded || applicationStarted || $('accountRememberedLogin').disabled) return;
    stopQR(); rememberedMode = true; trustedMode = true; qrMode = true; render();
    const version = qrVersion;
    $('accountRememberedLogin').disabled = true;
    $('accountRememberedStatus').textContent = '正在请求手机确认…'; $('accountRememberedCode').textContent = '';
    try {
      const result = await request('/auth/device/request', 'POST', {});
      if (version !== qrVersion) return;
      qrId = result.id; qrExpiry = result.expiresAt;
      $('accountRememberedStatus').textContent = '请在手机上打开拾燕并确认登录';
      $('accountRememberedCode').textContent = '确认码 ' + result.code;
      qrTimer = setTimeout(() => pollQR(version), 1500);
    } catch (error) {
      if (version !== qrVersion) return;
      $('accountRememberedStatus').textContent = error.message; $('accountRememberedLogin').disabled = false;
    }
  };
  $('accountOtherLogin').onclick = startQR;
  $('accountQRRefresh').onclick = startQR;
  $('accountPasswordMode').onclick = () => { if (busy) return; if (!qrMode && !rememberedMode) { if (hasRemembered) showAvatarLogin(); else startQR(); return; } stopQR(); rememberedMode = false; $('accountRememberedLogin').disabled = false; showError(''); render(); };
  window.addEventListener('pagehide', stopQR);

  async function logout(button) {
    button.disabled = true;
    try {
      await request('/auth/logout', 'POST', {});
      channel?.postMessage({type:'logout'});
      invalidate();
    } catch (error) {
      button.disabled = false;
      const message = $('accountSettingsError');
      if (message) { message.textContent = error.message; message.hidden = false; }
      window.shiyan?.toast?.(error.message);
    }
  }

  function mountSettingsEntry() {
    const home = document.querySelector('.settings-home');
    if (!home || home.querySelector('[data-settings-account]')) return;
    const entry = document.createElement('button');
    entry.type = 'button'; entry.className = 'settings-memory-entry'; entry.dataset.settingsAccount = '';
    entry.innerHTML = '<span class="settings-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 21v-2a8 8 0 0 1 16 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></span><span class="settings-entry-copy"><strong>' + (user.role === 'admin' ? '用户权限管理' : '账户') + '</strong><span>' + (user.role === 'admin' ? '管理账户、角色和服务器访问权限' : '当前登录账户与退出登录') + '</span></span><svg class="settings-entry-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    entry.onclick = openSettings;
    home.appendChild(entry);
    const navigation = document.querySelector('.settings-sidebar nav');
    if (navigation && !navigation.querySelector('[data-settings-page="account"]')) {
      const category = document.createElement('button');
      category.type = 'button'; category.dataset.settingsPage = 'account';
      category.innerHTML = entry.querySelector('.settings-entry-icon').innerHTML + '<span>' + (user.role === 'admin' ? '用户权限管理' : '账户') + '</span>';
      navigation.querySelector('.settings-category-empty')?.before(category);
    }
    const section = document.createElement('section');
    section.id = 'accountSettings'; section.className = 'settings-account-page'; section.hidden = true;
    section.innerHTML = '<header class="memory-header"><h2 id="settingsAccountTitle" tabindex="-1">' + (user.role === 'admin' ? '用户权限管理' : '账户') + '</h2></header><section class="account-profile"><div class="account-profile-row"><div><strong id="accountDisplayName"></strong><p id="accountEmailLabel"></p></div><button type="button" class="wb-secondary" id="accountLogout">退出登录</button></div><p id="accountRoleLabel" class="settings-note"></p></section><section id="accountUsersSection" hidden><header><h3>用户</h3><button type="button" class="wb-text-button" id="accountRefreshUsers">刷新</button></header><p class="settings-note">新账户默认为普通用户。你可以调整角色、启用状态和服务器访问权限。</p><p id="accountUsersStatus" role="status"></p><div id="accountUsers"></div></section><p id="accountSettingsError" class="form-error" role="alert" hidden></p>';
    if (user.role !== 'admin') section.querySelector('#accountUsersSection')?.remove();
    $('accountSettings')?.remove();
    window.ShiYanSettings.registerPage('account', {element:section, titleId:'settingsAccountTitle', onShow:showAccount});
    $('accountLogout').onclick = event => logout(event.currentTarget);
    if ($('accountRefreshUsers')) $('accountRefreshUsers').onclick = loadUsers;
  }

  function openSettings() {
    window.ShiYanSettings?.open('account');
  }

  function showAccount() {
    $('accountDisplayName').textContent = user.displayName || user.username || user.email;
    $('accountEmailLabel').textContent = user.email;
    $('accountRoleLabel').textContent = (user.role === 'admin' ? '管理员' : '普通用户') + (user.serverAccess ? ' · 允许访问服务器' : ' · 仅可访问自己的资料');
    if ($('accountUsersSection')) $('accountUsersSection').hidden = user.role !== 'admin';
    $('accountSettingsError').hidden = true;
    if (user.role === 'admin') loadUsers();
  }

  let usersLoading = false;
  async function loadUsers() {
    if (user?.role !== 'admin' || usersLoading) return;
    usersLoading = true;
    const refresh = $('accountRefreshUsers'); refresh.disabled = true;
    $('accountUsersStatus').textContent = '正在加载…';
    $('accountSettingsError').hidden = true;
    try {
      const result = await request('/admin/users');
      renderUsers(result.users || []);
      $('accountUsersStatus').textContent = result.users?.length ? '' : '暂无用户';
    } catch (error) {
      $('accountUsers').replaceChildren(); $('accountUsersStatus').textContent = '';
      $('accountSettingsError').textContent = error.message; $('accountSettingsError').hidden = false;
      if (error.status === 401) invalidate();
    } finally { usersLoading = false; refresh.disabled = false; }
  }

  function renderUsers(users) {
    $('accountUsers').innerHTML = users.map(item => `<form class="account-user-row" data-user="${esc(item.id)}"><div class="account-user-identity"><strong>${esc(item.displayName || item.username || item.email)}</strong><small>${esc(item.email)}</small>${isOwner(item) ? '<span class="account-owner">所有者</span>' : ''}</div><div class="account-user-controls"><label>角色<select name="role" ${isOwner(item)?'disabled':''}><option value="user" ${item.role==='user'?'selected':''}>普通用户</option><option value="admin" ${item.role==='admin'?'selected':''}>管理员</option></select></label><label>状态<select name="status" ${isOwner(item)?'disabled':''}><option value="active" ${item.status==='active'?'selected':''}>已启用</option><option value="disabled" ${item.status==='disabled'?'selected':''}>已停用</option></select></label><label class="account-server-toggle"><input name="serverAccess" type="checkbox" ${item.serverAccess?'checked':''} ${isOwner(item)?'disabled':''}>服务器访问</label><button type="submit" class="wb-secondary" ${isOwner(item)?'disabled':''}>保存</button></div><p class="account-user-result" role="status" hidden></p></form>`).join('');
    for (const form of $('accountUsers').querySelectorAll('form')) {
      const item = users.find(value => value.id === form.dataset.user);
      form.onsubmit = async event => {
        event.preventDefault();
        const button = form.querySelector('button'), note = form.querySelector('.account-user-result');
        const controls = [...form.querySelectorAll('input,select,button')];
        const payload = {role:form.elements.role.value,status:form.elements.status.value,serverAccess:form.elements.serverAccess.checked,revision:item.revision};
        controls.forEach(control => control.disabled = true); note.hidden = true;
        try {
          const result = await request('/admin/users/' + encodeURIComponent(item.id), 'PATCH', payload);
          if (result.user) Object.assign(item, result.user);
          note.textContent = '已保存'; note.classList.remove('is-error'); note.hidden = false;
          if (item.id === user.id) { channel?.postMessage({type:'permissions',userId:user.id}); invalidate(); }
        } catch (error) {
          note.textContent = error.message; note.classList.add('is-error'); note.hidden = false;
          if (error.status === 401) invalidate();
        } finally { controls.forEach(control => control.disabled = false); }
      };
    }
  }

  window.ShiYanAccount = {ready, get user(){return user;}, storageKey, openSettings, request, logout, invalidate};
  window.addEventListener('shiyan-settings-ready', mountSettingsEntry);
  $('app').inert = true;
  $('accountSendCode').onclick = async () => {
    if (busy || codeSending || Date.now() < codeResendAt || !$('accountEmail').reportValidity()) return;
    const email = $('accountEmail').value.trim();
    codeSending = true; showError(''); $('accountCodeStatus').textContent = ''; render();
    try {
      const result = await request('/auth/register-code', 'POST', {email});
      codeResendAt = Date.now() + result.resendAfter * 1000;
      $('accountCodeStatus').textContent = '验证码已发送，10 分钟内有效，请留意垃圾邮件。';
      clearInterval(codeTimer);
      codeTimer = setInterval(() => { if (Date.now() >= codeResendAt) clearInterval(codeTimer); if (!loaded) render(); }, 1000);
      $('accountVerificationCode').focus();
    } catch (error) { showError(error.message); }
    finally { codeSending = false; if (!loaded) render(); }
  };
  $('accountVerificationCode').addEventListener('input', () => { $('accountVerificationCode').value = $('accountVerificationCode').value.replace(/[^0-9]/g, '').slice(0, 6); });
  $('accountEmail').addEventListener('input', () => { $('accountVerificationCode').value = ''; $('accountCodeStatus').textContent = ''; });
  $('accountForm').addEventListener('submit', authenticate);
  $('accountSwitchButton').onclick = () => { if (busy) return; const register = mode === 'login'; stopQR(); rememberedMode = false; mode = register ? 'register' : 'login'; showError(''); if (register) render(); else if (hasRemembered) showAvatarLogin(); else startQR(); };
  $('accountReconnect').onclick = () => applicationStarted ? location.reload() : bootstrap();
  document.addEventListener('visibilitychange',async () => {
    if (!loaded || document.hidden || expiring) return;
    try {
      const result = await request('/auth/me');
      if (result.user?.id !== user.id || result.user?.revision !== user.revision) invalidate();
    } catch (error) { if ([401,403].includes(error.status)) invalidate(); }
  });
  window.addEventListener('shiyan-native', event => { if (!user?.serverAccess) event.stopImmediatePropagation(); }, true);
  bootstrap();
})();
