(() => {
  'use strict';
  let root, elements, opened = false, loaded = false, loading = false, busy = false;
  let enabled = true, page = 'settings', restoreFocus, inertElements = [];
  let quotaLoading = false;
  const api = (path, method, body) => window.shiyan.api(path, method, body);
  const message = error => error?.message || '暂时无法连接，请重试。';
  function status(text = '', error = false) {
    elements.notice.textContent = text;
    elements.notice.classList.toggle('is-error', error);
    elements.feedback.hidden = !text;
  }
  function refreshControls() {
    elements.enabled.checked = enabled;
    elements.enabled.disabled = busy || loading || !loaded;
    elements.retry.disabled = busy || loading;
    elements.setting.setAttribute('aria-busy', String(busy || loading));
  }
  function readSettings(result) {
    if (!result || typeof result.enabled !== 'boolean') throw new Error('记忆设置暂时不可用。');
    enabled = result.enabled;
    loaded = true;
  }
  async function load() {
    if (loading || busy) return;
    loading = true;
    elements.retry.hidden = true;
    status('正在读取设置…');
    refreshControls();
    try {
      readSettings(await api('/api/memory/settings'));
      status();
    } catch (error) {
      loaded = false;
      status('读取失败：'+message(error), true);
      elements.retry.hidden = false;
    } finally {
      loading = false;
      refreshControls();
    }
  }
  async function toggle() {
    if (busy || loading || !loaded) { refreshControls(); return; }
    const previous = enabled, requested = elements.enabled.checked;
    const hadFocus = document.activeElement === elements.enabled;
    busy = true;
    enabled = requested;
    elements.retry.hidden = true;
    status('正在保存…');
    refreshControls();
    try {
      readSettings(await api('/api/memory/settings', 'PATCH', {enabled:requested}));
      status();
    } catch (error) {
      enabled = previous;
      status('设置未保存：'+message(error), true);
    } finally {
      busy = false;
      refreshControls();
      if (hadFocus && opened && page === 'memory' && document.activeElement === document.body) elements.enabled.focus();
    }
  }
  function focusable() {
    return [...elements.body.querySelectorAll('button,input,[tabindex="0"]')].filter(el => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
  }
  function close() {
    if (!opened) return;
    opened = false;
    root.hidden = true;
    for (const [element, inert] of inertElements) element.inert = inert;
    inertElements = [];
    if (restoreFocus?.isConnected && restoreFocus.getClientRects().length) restoreFocus.focus();
  }
  function selectCategory(selected) {
    for (const button of elements.navigation.querySelectorAll('[data-settings-page]')) {
      if (button.dataset.settingsPage === selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }
  function filterCategories() {
    const query = elements.settingsSearch.value.trim().toLocaleLowerCase();
    let found = 0;
    for (const button of elements.navigation.querySelectorAll('[data-settings-page]')) {
      button.hidden = !button.textContent.toLocaleLowerCase().includes(query);
      if (!button.hidden) found++;
    }
    elements.navigationEmpty.hidden = found > 0;
  }
  function fitSettings() {
    const rail = document.getElementById('activityRail');
    const edge = rail?.getClientRects().length ? rail.getBoundingClientRect().right : 0;
    root.style.setProperty('--settings-rail-width', window.innerWidth > 680 && edge < 130 ? Math.max(0, edge)+'px' : '0px');
  }
  function showSettings() {
    page = 'settings';
    selectCategory('settings');
    elements.dialog.classList.remove('is-memory-page');
    elements.home.hidden = false;
    elements.memoryPage.hidden = true;
    elements.codexPage.hidden = true;
    elements.dialog.setAttribute('aria-labelledby', 'settingsGeneralTitle');
    elements.dialog.removeAttribute('aria-describedby');
    elements.memoryEntry.focus();
  }
  function showMemory() {
    page = 'memory';
    selectCategory('memory');
    elements.dialog.classList.add('is-memory-page');
    elements.home.hidden = true;
    elements.memoryPage.hidden = false;
    elements.codexPage.hidden = true;
    elements.dialog.setAttribute('aria-labelledby', 'memoryTitle');
    elements.title.focus();
    load();
  }
  function codexText(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function quotaDate(value, seconds = true) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const date = new Date(value * (seconds ? 1000 : 1));
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString('zh-CN', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
  }
  function resetCardStatus(credit) {
    const status = typeof credit.status === 'string' ? credit.status.toLowerCase() : '';
    if (['used', 'consumed', 'redeemed'].includes(status)) return '已使用';
    if (['revoked', 'cancelled', 'canceled'].includes(status)) return '已撤销';
    if (status === 'expired' || (typeof credit.expiresAt === 'number' && Number.isFinite(credit.expiresAt) && credit.expiresAt * 1000 <= Date.now())) return '已过期';
    return new Map([['available','可用'], ['active','可用'], ['pending','待生效']]).get(status) || (status ? '状态：'+credit.status : '状态未提供');
  }
  function resetCardType(value) {
    const type = typeof value === 'string' ? value.toLowerCase() : '';
    return new Map([['codexratelimits','Codex 额度'], ['weekly','周额度重置卡'], ['week','周额度重置卡'], ['daily','日额度重置卡'], ['five_hour','5 小时额度重置卡'], ['primary','短期额度重置卡'], ['secondary','周额度重置卡']]).get(type) || (typeof value === 'string' && value ? value : '额度重置卡');
  }
  function renderCodexQuota(quota) {
    elements.codexContent.replaceChildren();
    const windows = Array.isArray(quota.windows) ? quota.windows.filter(window => window && typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)) : [];
    if (windows.length) {
      elements.codexContent.append(codexText('h3', '额度剩余', 'settings-section-title'));
      const list = codexText('div', '', 'settings-quota-windows');
      for (const window of windows) {
        const item = codexText('section', '', 'settings-quota-window');
        const remaining = Math.max(0, Math.min(100, window.remainingPercent));
        const label = [window.bucket || 'Codex', window.period || '当前周期'].join(' · ');
        const heading = codexText('div', '', 'settings-quota-window-heading');
        heading.append(codexText('span', label), codexText('strong', Math.round(remaining)+'%'));
        const progress = document.createElement('progress');
        progress.max = 100;
        progress.value = remaining;
        progress.setAttribute('aria-label', label+'剩余');
        const resetsAt = quotaDate(window.resetsAt);
        item.append(heading, progress, codexText('p', resetsAt ? '重置时间：'+resetsAt : '重置时间暂未提供', 'settings-quota-muted'));
        list.append(item);
      }
      elements.codexContent.append(list);
    }
    elements.codexContent.append(codexText('h3', '重置卡', 'settings-section-title'));
    const cards = codexText('section', '', 'settings-reset-cards');
    const reset = quota.resetCredits;
    if (!reset || !Number.isSafeInteger(reset.availableCount) || reset.availableCount < 0) {
      cards.append(codexText('p', '暂未获取到重置卡信息'), codexText('p', '账户暂未提供重置卡数据。', 'settings-quota-muted'));
    } else {
      const count = codexText('p', '', 'settings-reset-count');
      count.append(codexText('span', '当前可用'), codexText('strong', reset.availableCount+' 张'));
      cards.append(count);
      const credits = Array.isArray(reset.credits) ? reset.credits.filter(credit => credit && typeof credit === 'object' && !Array.isArray(credit)) : [];
      if (!credits.length) cards.append(codexText('p', reset.availableCount === 0 ? '当前没有可用的重置卡。' : '账户暂未提供逐张卡片明细。', 'settings-quota-muted'));
      else {
        const list = codexText('ul', '', 'settings-reset-list');
        for (const credit of credits) {
          const item = codexText('li', '', 'settings-reset-card');
          const heading = codexText('div', '', 'settings-reset-card-heading');
          heading.append(codexText('strong', credit.title || resetCardType(credit.resetType)), codexText('span', resetCardStatus(credit), 'settings-reset-status'));
          item.append(heading);
          if (credit.description) item.append(codexText('p', credit.description, 'settings-quota-muted'));
          if (credit.title && credit.resetType) item.append(codexText('p', '类型：'+resetCardType(credit.resetType), 'settings-quota-muted'));
          const granted = quotaDate(credit.grantedAt), expires = quotaDate(credit.expiresAt);
          if (granted) item.append(codexText('p', '获得时间：'+granted, 'settings-quota-muted'));
          item.append(codexText('p', expires ? '到期时间：'+expires : '到期时间暂未提供', 'settings-quota-muted'));
          list.append(item);
        }
        cards.append(list);
      }
    }
    elements.codexContent.append(cards);
    const fetchedAt = quotaDate(quota.fetchedAt, false);
    if (fetchedAt) elements.codexContent.append(codexText('p', '更新于 '+fetchedAt, 'settings-quota-updated settings-quota-muted'));
  }
  async function loadCodexQuota() {
    if (quotaLoading) return;
    quotaLoading = true;
    elements.codexPage.setAttribute('aria-busy', 'true');
    elements.codexContent.replaceChildren();
    elements.codexNotice.textContent = '正在读取 Codex 额度与重置卡…';
    elements.codexNotice.classList.remove('is-error');
    try {
      const result = await api('/api/account/quota');
      if (result?.ok === false || !result?.quota || result.quota.available === false) throw new Error('账户信息暂时不可用。');
      renderCodexQuota(result.quota);
      elements.codexNotice.textContent = '';
    } catch (error) {
      elements.codexNotice.textContent = '读取失败：'+message(error);
      elements.codexNotice.classList.add('is-error');
    } finally {
      quotaLoading = false;
      elements.codexPage.setAttribute('aria-busy', 'false');
    }
  }
  function showCodex() {
    page = 'codex';
    selectCategory('codex');
    elements.dialog.classList.remove('is-memory-page');
    elements.home.hidden = true;
    elements.memoryPage.hidden = true;
    elements.codexPage.hidden = false;
    elements.dialog.setAttribute('aria-labelledby', 'settingsCodexTitle');
    elements.dialog.removeAttribute('aria-describedby');
    elements.codexTitle.focus();
    loadCodexQuota();
  }
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'memoryModal';
    root.className = 'memory-overlay';
    root.hidden = true;
    root.innerHTML = '<section class="memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memoryTitle"><div class="memory-body settings-layout"><aside class="settings-sidebar"><h2 id="settingsTitle">设置</h2><label class="settings-category-search"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 5 5" stroke="currentColor" stroke-width="1.7"/></svg><input type="search" placeholder="搜索设置" aria-label="搜索设置"></label><nav aria-label="设置分类"><h3>个人</h3><button type="button" data-settings-page="settings"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.7 1.7-.1 2.2-1.6 1.8 2 3.4 2.3-.7 1.9 1 .6 2.4h4l.6-2.4 2-1 2.2.7 2-3.4-1.6-1.8-.1-2.2 1.7-1.7-2-3.4-2.3.7-1.9-.9L15 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg><span>常规</span></button><button type="button" data-settings-page="memory"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 4h5a5 5 0 0 1 4 2 5 5 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 2 5 5 0 0 0-4-2H3zM12 6v15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg><span>记忆</span></button><p class="settings-category-empty" hidden>没有匹配的设置</p></nav></aside><main class="settings-content"><section class="settings-home"><header class="memory-header"><h2 id="settingsGeneralTitle">常规</h2><button type="button" class="icon-button memory-close" data-settings-close aria-label="关闭设置"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header><h3 class="settings-section-title">个性化</h3><button type="button" class="settings-memory-entry" data-settings-memory><span class="settings-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24"><rect x="5" y="5" width="14" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4M9 9h6v6H9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="settings-entry-copy"><strong>记忆</strong><span>自动记住重要信息，个性化回复</span></span><svg class="settings-entry-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></section><section class="settings-memory-page" hidden><header class="memory-header"><button type="button" class="memory-back" data-memory-back aria-label="返回设置"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>设置</span></button><h2 id="memoryTitle" tabindex="-1">记忆</h2><button type="button" class="icon-button memory-close" data-memory-close aria-label="关闭记忆"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header><div class="memory-setting"><div><label for="memoryEnabled">使用记忆</label><p>关闭后，不再自动保存或使用记忆。已有记忆会保留。</p></div><input id="memoryEnabled" type="checkbox" role="switch"></div><div class="memory-feedback" hidden><p class="memory-notice" role="status" aria-live="polite"></p><button type="button" data-memory-retry hidden>重试</button></div></section></main></div></section>';
    document.body.append(root);
    const find = selector => root.querySelector(selector);
    elements = {
      body:find('.memory-body'),dialog:find('.memory-dialog'),navigation:find('.settings-sidebar nav'),settingsSearch:find('.settings-category-search input'),navigationEmpty:find('.settings-category-empty'),home:find('.settings-home'),memoryPage:find('.settings-memory-page'),memoryEntry:find('[data-settings-memory]'),back:find('[data-memory-back]'),title:find('#memoryTitle'),setting:find('.memory-setting'),enabled:find('#memoryEnabled'),notice:find('.memory-notice'),feedback:find('.memory-feedback'),retry:find('[data-memory-retry]')
    };
    const codexNavigation = document.createElement('button');
    codexNavigation.type = 'button';
    codexNavigation.dataset.settingsPage = 'codex';
    codexNavigation.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18m-14 5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span>Codex 额度与重置卡</span>';
    elements.navigation.insertBefore(codexNavigation, elements.navigationEmpty);
    const codexEntry = document.createElement('button');
    codexEntry.type = 'button';
    codexEntry.className = 'settings-memory-entry';
    codexEntry.dataset.settingsCodex = '';
    codexEntry.innerHTML = '<span class="settings-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18m-14 5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span><span class="settings-entry-copy"><strong>Codex 额度与重置卡</strong><span>查看额度剩余、重置时间与可用重置卡</span></span><svg class="settings-entry-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    elements.home.append(codexText('h3', '账户', 'settings-section-title'), codexEntry);
    const codexPage = document.createElement('section');
    codexPage.className = 'settings-codex-page';
    codexPage.hidden = true;
    codexPage.innerHTML = '<header class="memory-header"><h2 id="settingsCodexTitle" tabindex="-1">Codex 额度与重置卡</h2><button type="button" class="icon-button memory-close" data-codex-close aria-label="关闭设置"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header><div class="settings-quota-toolbar"><p>查看当前账户的额度与重置卡信息</p></div><p class="memory-notice" data-codex-notice role="status" aria-live="polite"></p><div data-codex-content></div>';
    find('.settings-content').append(codexPage);
    Object.assign(elements, {codexPage, codexTitle:find('#settingsCodexTitle'), codexNotice:find('[data-codex-notice]'), codexContent:find('[data-codex-content]')});
    codexEntry.addEventListener('click', showCodex);
    find('[data-codex-close]').addEventListener('click', close);
    elements.settingsSearch.addEventListener('input', filterCategories);
    elements.navigation.addEventListener('click', event => {
      const button = event.target.closest('[data-settings-page]');
      if (!button) return;
      if (button.dataset.settingsPage === 'memory') showMemory();
      else if (button.dataset.settingsPage === 'codex') showCodex();
      else showSettings();
    });
    elements.enabled.addEventListener('change', toggle);
    elements.retry.addEventListener('click', load);
    find('[data-memory-close]').addEventListener('click', close);
    find('[data-settings-close]').addEventListener('click', close);
    elements.memoryEntry.addEventListener('click', showMemory);
    elements.back.addEventListener('click', showSettings);
    root.addEventListener('click', event => { if (event.target === root) close(); });
    root.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const all = focusable(), first = all[0], last = all.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !all.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && (document.activeElement === last || !all.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    });
    refreshControls();
  }
  function open(initialPage = 'memory') {
    build();
    if (opened) {
      if (initialPage !== page) initialPage === 'settings' ? showSettings() : showMemory();
      return;
    }
    restoreFocus = document.getElementById('railAvatar') || document.activeElement;
    const quota = document.getElementById('avatarQuotaCard');
    if (quota) quota.hidden = true;
    document.getElementById('railAvatar')?.setAttribute('aria-expanded', 'false');
    opened = true;
    root.hidden = false;
    fitSettings();
    inertElements = [...document.body.children].filter(element => element !== root && !['SCRIPT','STYLE','LINK'].includes(element.tagName)).map(element => [element, element.inert]);
    for (const [element] of inertElements) element.inert = true;
    if (initialPage === 'settings') showSettings();
    else showMemory();
  }
  function install() {
    const attach = () => {
      const avatar = document.getElementById('railAvatar');
      const footer = document.querySelector('#avatarQuotaCard footer');
      if (!footer || !avatar) return false;
      document.getElementById('railSettings')?.remove();
      avatar.title = '个人菜单';
      avatar.setAttribute('aria-label', '个人菜单');
      document.getElementById('avatarQuotaCard').setAttribute('aria-label', '个人菜单');
      if (!footer.querySelector('[data-open-settings]')) {
        const button = document.createElement('button');
        button.id = 'avatarSettings';
        button.type = 'button';
        button.dataset.openSettings = '';
        button.setAttribute('aria-haspopup', 'dialog');
        button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.7 1.7-.1 2.2-1.6 1.8 2 3.4 2.3-.7 1.9 1 .6 2.4h4l.6-2.4 2-1 2.2.7 2-3.4-1.6-1.8-.1-2.2 1.7-1.7-2-3.4-2.3.7-1.9-.9L15 3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><span>设置</span><kbd>⌘,</kbd>';
        button.addEventListener('click', () => open('settings'));
        footer.append(button);
      }
      return true;
    };
    if (!attach()) {
      const observer = new MutationObserver(() => { if (attach()) observer.disconnect(); });
      observer.observe(document.body, {childList:true, subtree:true});
    }
    window.addEventListener('resize', () => { if (opened) fitSettings(); });
    document.addEventListener('keydown', event => {
      if (event.metaKey && event.key === ',' && !event.altKey && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        open('settings');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
  window.ShiYanMemory = {open:() => open('memory'), close};
  window.ShiYanSettings = {open:() => open('settings'), close};
})();
