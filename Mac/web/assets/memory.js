(() => {
  'use strict';
  let root, elements, opened = false, loaded = false, loading = false, busy = false;
  let enabled = true, page = 'settings', restoreFocus, inertElements = [];
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
    elements.dialog.setAttribute('aria-labelledby', 'memoryTitle');
    elements.title.focus();
    load();
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
    elements.settingsSearch.addEventListener('input', filterCategories);
    elements.navigation.addEventListener('click', event => {
      const button = event.target.closest('[data-settings-page]');
      if (!button) return;
      if (button.dataset.settingsPage === 'memory') showMemory();
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
