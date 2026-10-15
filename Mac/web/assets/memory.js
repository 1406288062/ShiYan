(() => {
  'use strict';
  const categories = {preference:'偏好', profile:'个人背景', project:'长期项目', context:'其他细节'};
  const scopes = {global:'所有会话', project:'当前项目', conversation:'当前会话'};
  const sources = {manual:'手动添加', chat:'聊天', dots:'Dots'};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  let root, elements, opened = false, loaded = false, loading = false, busy = false;
  let data = {enabled:true, memories:[], revision:0}, editing = null, conflict = null;
  let page = 'settings';
  let requestVersion = 0, restoreFocus, confirmAction = null, confirmFocus, inertElements = [];
  const api = (path, method, body) => window.shiyan.api(path, method, body);
  const date = value => {
    const parsed = new Date(value);
    return value && !Number.isNaN(parsed.valueOf()) ? parsed.toLocaleString('zh-CN', {year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '时间未知';
  };
  const message = error => error?.message || '暂时无法连接，请重试。';
  const isConflict = error => error?.status === 409 || /conflict|revision/i.test(error?.code || '');
  const isoDate = value => { const d = new Date(value || 0); return Number.isNaN(d.valueOf()) ? '' : d.toISOString(); };
  function status(text = '', error = false) {
    elements.notice.textContent = text;
    elements.notice.classList.toggle('is-error', error);
  }
  function refreshControls() {
    elements.enabled.checked = data.enabled;
    elements.enabled.disabled = busy || !loaded;
    elements.refresh.disabled = busy || loading;
    elements.add.disabled = busy || !loaded || !!editing;
    elements.clear.disabled = busy || !loaded || !data.memories.length;
    elements.save.disabled = busy || !elements.content.value.trim() || !!conflict;
    elements.cancel.disabled = busy;
    elements.back.disabled = busy;
    elements.content.readOnly = busy;
    elements.category.disabled = busy || !!editing?.id;
    elements.editor.setAttribute('aria-busy', String(busy));
    for (const button of elements.list.querySelectorAll('button')) button.disabled = busy;
    for (const button of elements.conflict.querySelectorAll('button')) button.disabled = busy || loading;
  }
  function renderList() {
    const query = elements.search.value.trim().toLocaleLowerCase();
    const entries = data.memories.filter(item => [item.content,categories[item.category],sources[item.source],scopes[item.scope] || item.scope].join(' ').toLocaleLowerCase().includes(query));
    elements.count.textContent = loaded ? `${data.memories.length} 条` : '';
    if (!loaded) {
      elements.list.innerHTML = '<li class="memory-empty">' + (loading ? '正在读取记忆…' : '无法读取记忆，请重试。') + '</li>';
    } else if (!entries.length) {
      elements.list.innerHTML = '<li class="memory-empty">' + (query ? '没有找到匹配的记忆。' : '还没有记忆。你可以手动添加，也可以在日常聊天中逐渐积累。') + '</li>';
    } else {
      elements.list.innerHTML = entries.map(item => '<li class="memory-item" data-memory-id="'+esc(item.id)+'"><div class="memory-item-heading"><span class="memory-category">'+esc(categories[item.category] || '其他细节')+'</span><div class="memory-item-actions"><button type="button" data-memory-edit="'+esc(item.id)+'" aria-label="编辑记忆：'+esc(item.content)+'">编辑</button><button type="button" data-memory-delete="'+esc(item.id)+'" class="memory-danger" aria-label="删除记忆：'+esc(item.content)+'">删除</button></div></div><p class="memory-content">'+esc(item.content)+'</p><p class="memory-meta"><span>'+esc(sources[item.source] || '其他来源')+'</span><span>'+esc(scopes[item.scope] || item.scope || '所有会话')+'</span><time datetime="'+esc(isoDate(item.updatedAt || item.createdAt))+'">更新于 '+esc(date(item.updatedAt || item.createdAt))+'</time></p></li>').join('');
    }
    refreshControls();
  }
  function clearConflict() {
    conflict = null;
    elements.conflict.hidden = true;
    elements.conflict.replaceChildren();
  }
  function showConflict(latest) {
    conflict = {latest};
    elements.conflict.hidden = false;
    if (latest === undefined) {
      elements.conflict.innerHTML = '<p>这条记忆已在其他设备更新。你的输入已保留，请先查看最新版本。</p><button type="button" data-memory-conflict="load">查看最新版本</button>';
    } else if (!latest) {
      elements.conflict.innerHTML = '<p>这条记忆已在其他设备删除。你的输入已保留，可以另存为一条新记忆。</p><button type="button" data-memory-conflict="new">另存为新记忆</button>';
    } else {
      elements.conflict.innerHTML = '<p>其他设备的最新内容：</p><blockquote>'+esc(latest.content)+'</blockquote><div class="memory-conflict-actions"><button type="button" data-memory-conflict="latest">使用最新内容</button><button type="button" data-memory-conflict="mine">保留我的修改继续编辑</button></div>';
    }
    refreshControls();
  }
  async function load(options = {}) {
    const version = ++requestVersion;
    loading = true;
    status('正在读取记忆…');
    renderList();
    try {
      const result = await api('/api/memory');
      if (version !== requestVersion) return false;
      data = {enabled: result.enabled !== false, memories: Array.isArray(result.memories) ? result.memories : [], revision: result.revision};
      loaded = true;
      if (options.conflict && editing?.id) showConflict(data.memories.find(item => item.id === editing.id) || null);
      status(options.success || '');
      renderList();
      return true;
    } catch (error) {
      if (version !== requestVersion) return false;
      status('读取失败：'+message(error), true);
      renderList();
      return false;
    } finally {
      if (version === requestVersion) { loading = false; refreshControls(); }
    }
  }
  function edit(item) {
    if (busy) return;
    editing = {id:item?.id || null, revision:item?.revision};
    clearConflict();
    elements.editor.hidden = false;
    elements.editorTitle.textContent = item ? '编辑记忆' : '添加记忆';
    elements.category.value = item?.category in categories ? item.category : 'preference';
    elements.content.value = item?.content || '';
    elements.editorError.textContent = '';
    refreshControls();
    elements.content.focus();
  }
  function cancelEdit() {
    editing = null;
    clearConflict();
    elements.editor.hidden = true;
    elements.content.value = '';
    elements.editorError.textContent = '';
    elements.add.focus();
  }
  async function save(event) {
    event.preventDefault();
    const content = elements.content.value.trim();
    if (busy || !editing || conflict || !content) return;
    const current = {...editing};
    busy = true;
    elements.editorError.textContent = '';
    refreshControls();
    try {
      if (current.id) await api('/api/memory/'+encodeURIComponent(current.id), 'PATCH', {content, revision:current.revision});
      else await api('/api/memory', 'POST', {content, category:elements.category.value});
      cancelEdit();
      await load({success:'记忆已保存。'});
    } catch (error) {
      if (current.id && error?.status === 404) showConflict(null);
      else if (isConflict(error)) showConflict();
      else elements.editorError.textContent = '保存失败：'+message(error)+' 输入已保留，可以重试。';
    } finally {
      busy = false; refreshControls();
      if (opened && page === 'memory') {
        if (!editing) elements.add.focus();
        else if (conflict) elements.conflict.querySelector('button')?.focus();
        else elements.content.focus();
      }
    }
  }
  function askConfirmation(title, detail, action) {
    if (busy) return;
    confirmAction = action;
    confirmFocus = document.activeElement;
    elements.confirmTitle.textContent = title;
    elements.confirmDescription.textContent = detail;
    elements.confirmError.textContent = '';
    elements.body.inert = true;
    elements.confirm.hidden = false;
    elements.confirmCancel.focus();
  }
  function cancelConfirmation() {
    if (busy) return;
    confirmAction = null;
    elements.confirm.hidden = true;
    elements.body.inert = false;
    if (confirmFocus?.isConnected) confirmFocus.focus();
  }
  async function confirm() {
    if (busy || !confirmAction) return;
    busy = true;
    elements.confirmAccept.disabled = elements.confirmCancel.disabled = true;
    refreshControls();
    try {
      await confirmAction();
      busy = false;
      cancelConfirmation();
      await load({success:'记忆已删除。'});
      if (!root.contains(document.activeElement)) elements.search.focus();
    } catch (error) {
      elements.confirmError.textContent = '删除失败：'+message(error)+' 可以重试。';
    } finally {
      busy = false;
      elements.confirmAccept.disabled = elements.confirmCancel.disabled = false;
      refreshControls();
      if (opened && page === 'memory' && !elements.confirm.hidden) elements.confirmAccept.focus();
    }
  }
  async function toggle() {
    if (busy || !loaded) return;
    const enabled = elements.enabled.checked;
    busy = true;
    refreshControls();
    status('正在保存…');
    try {
      await api('/api/memory/settings', 'PATCH', {enabled});
      data.enabled = enabled;
      await load({success:enabled ? '已开启记忆。' : '已关闭记忆，停止自动整理和用于回复。'});
    } catch (error) {
      status('设置未保存：'+message(error)+' 请重试。', true);
    } finally { busy = false; refreshControls(); if (opened && page === 'memory') elements.enabled.focus(); }
  }
  async function resolveConflict(action) {
    if (busy || !editing) return;
    if (action === 'load') { await load({conflict:true}); return; }
    if (action === 'new') {
      editing = {id:null};
      elements.editorTitle.textContent = '添加记忆';
    } else if (action === 'latest' && conflict?.latest) {
      const latest = conflict.latest;
      editing = {id:latest.id, revision:latest.revision};
      elements.content.value = latest.content;
      elements.category.value = latest.category;
    } else if (action === 'mine' && conflict?.latest) {
      editing.revision = conflict.latest.revision;
    } else return;
    clearConflict();
    refreshControls();
    elements.content.focus();
  }
  function focusable() {
    const area = elements.confirm.hidden ? elements.body : elements.confirm;
    return [...area.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter(el => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
  }
  function close() {
    if (!opened) return;
    if (!elements.confirm.hidden) { cancelConfirmation(); return; }
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
    elements.dialog.setAttribute('aria-describedby', 'memoryDescription');
    (elements.editor.hidden ? elements.search : elements.content).focus();
    load();
  }
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'memoryModal';
    root.className = 'memory-overlay';
    root.hidden = true;
    root.innerHTML = '<section class="memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memoryTitle" aria-describedby="memoryDescription"><div class="memory-body settings-layout"><aside class="settings-sidebar"><h2 id="settingsTitle">设置</h2><label class="settings-category-search"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 5 5" stroke="currentColor" stroke-width="1.7"/></svg><input type="search" placeholder="搜索设置" aria-label="搜索设置"></label><nav aria-label="设置分类"><h3>个人</h3><button type="button" data-settings-page="settings"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.7 1.7-.1 2.2-1.6 1.8 2 3.4 2.3-.7 1.9 1 .6 2.4h4l.6-2.4 2-1 2.2.7 2-3.4-1.6-1.8-.1-2.2 1.7-1.7-2-3.4-2.3.7-1.9-.9L15 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg><span>常规</span></button><button type="button" data-settings-page="memory"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 4h5a5 5 0 0 1 4 2 5 5 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 2 5 5 0 0 0-4-2H3zM12 6v15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg><span>记忆</span></button><p class="settings-category-empty" hidden>没有匹配的设置</p></nav></aside><main class="settings-content"><section class="settings-home"><header class="memory-header"><h2 id="settingsGeneralTitle">常规</h2><button type="button" class="icon-button memory-close" data-settings-close aria-label="关闭设置"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header><h3 class="settings-section-title">个性化</h3><button type="button" class="settings-memory-entry" data-settings-memory><span class="settings-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24"><rect x="5" y="5" width="14" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4M9 9h6v6H9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="settings-entry-copy"><strong>记忆</strong><span>管理偏好、个人背景和长期项目</span></span><svg class="settings-entry-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></section><section class="settings-memory-page" hidden><header class="memory-header"><button type="button" class="memory-back" data-memory-back aria-label="返回设置"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>设置</span></button><h2 id="memoryTitle">记忆</h2><button type="button" class="icon-button memory-close" data-memory-close aria-label="关闭记忆"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header><p id="memoryDescription" class="memory-description">拾燕会选择性记住偏好、背景和长期项目，并随聊天更新。</p><div class="memory-setting"><div><label for="memoryEnabled">使用记忆</label><p>关闭后，不再自动整理聊天，也不会使用记忆个性化回复。已有记忆可继续管理。</p></div><input id="memoryEnabled" type="checkbox" role="switch" aria-describedby="memoryDescription"></div><div class="memory-tools"><label class="memory-search"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 5 5" stroke="currentColor" stroke-width="1.7"/></svg><input type="search" placeholder="搜索记忆" aria-label="搜索记忆"></label><button type="button" data-memory-add class="memory-add">添加记忆</button><button type="button" data-memory-refresh aria-label="重新加载记忆">刷新</button></div><form class="memory-editor" hidden><h3></h3><label class="memory-category-label">分类<select aria-label="记忆分类">'+Object.entries(categories).map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('')+'</select></label><label for="memoryContent" class="memory-field-label">内容</label><textarea id="memoryContent" maxlength="1200" rows="3" required placeholder="例如：我喜欢简洁、直接的回答。"></textarea><div class="memory-conflict" role="status" hidden></div><p class="memory-editor-error" role="alert"></p><div class="memory-editor-actions"><button type="button" data-memory-cancel>取消</button><button type="submit" class="memory-save">保存</button></div></form><p class="memory-notice" role="status" aria-live="polite"></p><div class="memory-list-heading"><div><h3>已保存的记忆</h3><span data-memory-count></span></div><button type="button" data-memory-clear class="memory-danger">清空记忆</button></div><ul class="memory-list" aria-label="已保存的记忆"></ul></section></main></div><div class="memory-confirm" role="alertdialog" aria-modal="true" aria-labelledby="memoryConfirmTitle" aria-describedby="memoryConfirmDescription" hidden><section><h3 id="memoryConfirmTitle"></h3><p id="memoryConfirmDescription"></p><p class="memory-confirm-error" role="alert"></p><div><button type="button" data-memory-confirm-cancel>取消</button><button type="button" data-memory-confirm-accept class="memory-danger">删除</button></div></section></div></section>';
    document.body.append(root);
    const find = selector => root.querySelector(selector);
    elements = {
      body:find('.memory-body'),dialog:find('.memory-dialog'),navigation:find('.settings-sidebar nav'),settingsSearch:find('.settings-category-search input'),navigationEmpty:find('.settings-category-empty'),home:find('.settings-home'),memoryPage:find('.settings-memory-page'),memoryEntry:find('[data-settings-memory]'),back:find('[data-memory-back]'),enabled:find('#memoryEnabled'),refresh:find('[data-memory-refresh]'),add:find('[data-memory-add]'),clear:find('[data-memory-clear]'),search:find('.memory-search input'),list:find('.memory-list'),count:find('[data-memory-count]'),notice:find('.memory-notice'),editor:find('.memory-editor'),editorTitle:find('.memory-editor h3'),category:find('select'),content:find('textarea'),editorError:find('.memory-editor-error'),save:find('button[type=submit]'),cancel:find('[data-memory-cancel]'),conflict:find('.memory-conflict'),confirm:find('.memory-confirm'),confirmTitle:find('#memoryConfirmTitle'),confirmDescription:find('#memoryConfirmDescription'),confirmError:find('.memory-confirm-error'),confirmAccept:find('[data-memory-confirm-accept]'),confirmCancel:find('[data-memory-confirm-cancel]')
    };
    elements.settingsSearch.addEventListener('input', filterCategories);
    elements.navigation.addEventListener('click', event => {
      const button = event.target.closest('[data-settings-page]');
      if (!button) return;
      if (button.dataset.settingsPage === 'memory') showMemory();
      else showSettings();
    });
    elements.search.addEventListener('input', renderList);
    elements.content.addEventListener('input', refreshControls);
    elements.enabled.addEventListener('change', toggle);
    elements.refresh.addEventListener('click', () => load());
    elements.add.addEventListener('click', () => edit());
    elements.cancel.addEventListener('click', cancelEdit);
    elements.editor.addEventListener('submit', save);
    elements.clear.addEventListener('click', () => askConfirmation('清空所有记忆？', '这会删除已保存的全部记忆，所有设备都将停止使用这些内容。此操作无法撤销。', () => api('/api/memory', 'DELETE')));
    elements.confirmCancel.addEventListener('click', cancelConfirmation);
    elements.confirmAccept.addEventListener('click', confirm);
    find('[data-memory-close]').addEventListener('click', close);
    find('[data-settings-close]').addEventListener('click', close);
    elements.memoryEntry.addEventListener('click', showMemory);
    elements.back.addEventListener('click', showSettings);
    root.addEventListener('click', event => {
      if (event.target === root) { close(); return; }
      const editButton = event.target.closest('[data-memory-edit]');
      const deleteButton = event.target.closest('[data-memory-delete]');
      const conflictButton = event.target.closest('[data-memory-conflict]');
      if (editButton) edit(data.memories.find(item => item.id === editButton.dataset.memoryEdit));
      if (deleteButton) {
        const id = deleteButton.dataset.memoryDelete;
        askConfirmation('删除这条记忆？', data.memories.find(item => item.id === id)?.content || '', async () => {
          await api('/api/memory/'+encodeURIComponent(id), 'DELETE');
          if (editing?.id === id) cancelEdit();
        });
      }
      if (conflictButton) resolveConflict(conflictButton.dataset.memoryConflict);
    });
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
