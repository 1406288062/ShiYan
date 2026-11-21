(() => {
  'use strict';
  let root, elements, opened = false, loaded = false, loading = false, busy = false;
  let enabled = true, page = 'settings', restoreFocus, inertElements = [];
  let quotaLoading = false;
  let topics = [], topicsLoading = false, topicsBusy = false;
  const additionalPages = new Map();
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
    return [...elements.body.querySelectorAll('button,input,select,textarea,summary,a[href],[tabindex="0"]')].filter(el => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
  }
  function close(restore = true) {
    if (!opened) return;
    opened = false;
    root.hidden = true;
    for (const [element, inert] of inertElements) element.inert = inert;
    inertElements = [];
    if (restore && restoreFocus?.isConnected && restoreFocus.getClientRects().length) restoreFocus.focus();
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
    root.style.setProperty('--settings-rail-width', edge > 0 && edge < 130 ? Math.max(0, edge)+'px' : '0px');
  }
  function activatePage(selected, titleId) {
    page = selected;
    selectCategory(selected);
    elements.dialog.classList.toggle('is-memory-page', selected === 'memory');
    elements.home.hidden = selected !== 'settings';
    elements.memoryPage.hidden = selected !== 'memory';
    elements.codexPage.hidden = selected !== 'codex';
    for (const [id, entry] of additionalPages) entry.element.hidden = id !== selected;
    elements.dialog.setAttribute('aria-labelledby', titleId);
    elements.dialog.removeAttribute('aria-describedby');
  }
  function showPage(selected) {
    if (selected === 'memory') showMemory();
    else if (selected === 'codex') showCodex();
    else if (additionalPages.has(selected)) {
      const entry = additionalPages.get(selected);
      activatePage(selected, entry.titleId);
      document.getElementById(entry.titleId)?.focus();
      entry.onShow?.();
    } else showSettings();
  }
  // 左侧「个人」的顺序与常规页的分组顺序一致：常规 · 记忆 · Dots · 额度与重置卡 · 账户 · 设备连接。
  const navigationOrder = ['settings', 'memory', 'dots', 'codex', 'account', 'devices'];
  function orderNavigation() {
    const buttons = [...elements.navigation.querySelectorAll(':scope > [data-settings-page]')];
    const rank = button => { const index = navigationOrder.indexOf(button.dataset.settingsPage); return index < 0 ? navigationOrder.length : index; };
    const sorted = [...buttons].sort((a, b) => rank(a) - rank(b));
    if (sorted.every((button, index) => button === buttons[index])) return;
    for (const button of sorted) elements.navigation.insertBefore(button, elements.navigationEmpty);
  }
  function registerPage(id, entry) {
    if (additionalPages.has(id)) return;
    additionalPages.set(id, entry);
    elements.content.append(entry.element);
  }
  function showSettings() {
    activatePage('settings', 'settingsGeneralTitle');
    elements.memoryEntry.focus();
  }
  // 记忆：上面是按类别整理的摘要，下面可以管理全部条目。
  let entriesSection = null, entries = [], entriesQuery = '', editingId = '', entriesTimer = null;
  const escHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const categoryName = {profile:'关于你', preference:'偏好与习惯', project:'项目与工作', context:'近期在做'};
  const categoryOrder = ['profile','preference','project','context'];
  let summaryTimer = null, summaryTries = 0;
  function ensureEntries() {
    if (entriesSection?.isConnected) return entriesSection;
    entriesSection = document.createElement('section');
    entriesSection.className = 'memory-entries';
    entriesSection.innerHTML = '<header><h3>记忆摘要</h3><small data-memory-summary-state></small></header><div class="memory-summary" data-memory-summary></div><details class="memory-all"><summary><span>管理全部记忆</span><small data-memory-count></small></summary><input type="search" placeholder="搜索" aria-label="搜索记忆" data-memory-search><ul class="memory-entry-list" data-memory-list></ul></details><p class="memory-entry-status" role="status" data-memory-status></p>';
    elements.topicsSection.before(entriesSection);
    entriesSection.querySelector('[data-memory-search]').addEventListener('input', event => {
      clearTimeout(entriesTimer); entriesTimer = setTimeout(() => { entriesQuery = event.target.value.trim(); loadEntries(); }, 250);
    });
    entriesSection.addEventListener('click', async event => {
      const item = event.target.closest('[data-memory-id]'); if (!item) return;
      const id = item.dataset.memoryId, entry = entries.find(e => e.id === id); if (!entry) return;
      const status = entriesSection.querySelector('[data-memory-status]');
      try {
        if (event.target.closest('[data-memory-edit]')) { editingId = id; drawEntries(); item.isConnected && entriesSection.querySelector('[data-memory-id="'+CSS.escape(id)+'"] textarea')?.focus(); return; }
        if (event.target.closest('[data-memory-cancel]')) { editingId = ''; drawEntries(); return; }
        if (event.target.closest('[data-memory-save]')) {
          const content = entriesSection.querySelector('[data-memory-id="'+CSS.escape(id)+'"] textarea').value.trim();
          await api('/api/memory/'+encodeURIComponent(id), 'PATCH', {content, revision: entry.revision});
          editingId = ''; status.textContent = '已保存。'; await loadEntries(); return;
        }
        if (event.target.closest('[data-memory-delete]')) {
          if (window.shiyan?.confirmAction && !await window.shiyan.confirmAction('删除这条记忆？', entry.content.slice(0, 80), '删除')) return;
          await api('/api/memory/'+encodeURIComponent(id), 'DELETE', {});
          item.classList.add('is-removing'); status.textContent = '已删除。';
          setTimeout(() => loadEntries(), 180);
        }
      } catch (cause) { status.textContent = cause.message || '操作失败，请重试。'; }
    });
    return entriesSection;
  }
  function drawEntries() {
    const list = entriesSection.querySelector('[data-memory-list]');
    entriesSection.querySelector('[data-memory-count]').textContent = entries.length ? entries.length+' 条' : '';
    const sorted = [...entries].sort((a,b) => (categoryOrder.indexOf(a.category)+9)%9 - (categoryOrder.indexOf(b.category)+9)%9);
    let lastGroup = '';
    const group = e => { const name = categoryName[e.category] || '其他'; if (name === lastGroup) return ''; lastGroup = name; return '<li class="memory-entry-group">'+escHTML(name)+'</li>'; };
    list.innerHTML = entries.length ? sorted.map(e => group(e)+'<li data-memory-id="'+escHTML(e.id)+'">'+(editingId === e.id
      ? '<textarea rows="3" maxlength="1200">'+escHTML(e.content)+'</textarea><div class="memory-entry-actions"><button type="button" class="wb-secondary" data-memory-cancel>取消</button><button type="button" class="wb-primary" data-memory-save>保存</button></div>'
      : '<div class="memory-entry-text"><span>'+escHTML(e.content)+'</span><small>'+new Date(e.updatedAt).toLocaleDateString('zh-CN')+'</small></div><div class="memory-entry-actions"><button type="button" class="wb-text-button" data-memory-edit>修改</button><button type="button" class="wb-text-button is-destructive" data-memory-delete>删除</button></div>')+'</li>').join('')
      : '<li class="memory-entry-empty">'+(entriesQuery ? '没有找到相关记忆。' : '还没有记住任何内容。')+'</li>';
  }
  async function loadSummary() {
    ensureEntries(); clearTimeout(summaryTimer);
    const box = entriesSection.querySelector('[data-memory-summary]'), state = entriesSection.querySelector('[data-memory-summary-state]');
    try {
      const data = await api('/api/memory/summary');
      const sections = Array.isArray(data?.sections) ? data.sections : [];
      box.innerHTML = sections.length ? sections.map(s => '<section class="memory-summary-group"><h4>'+escHTML(s.title || categoryName[s.id] || '')+'<small>'+escHTML(data.counts?.[s.id] ? data.counts[s.id]+' 条' : '')+'</small></h4><ul>'+(s.points||[]).map(p => '<li>'+escHTML(p)+'</li>').join('')+'</ul></section>').join('') : '<p class="memory-summary-empty">还没有记住任何内容。在对话里说“记住……”即可。</p>';
      state.textContent = data?.state === 'generating' ? '正在整理…' : '';
      if (data?.state === 'generating' && summaryTries++ < 15) summaryTimer = setTimeout(loadSummary, 4000); else summaryTries = 0;
    } catch (cause) { box.innerHTML = ''; state.textContent = ''; }
  }
  async function loadEntries() {
    ensureEntries();
    if (!entriesQuery) loadSummary();
    try {
      const result = await api('/api/memory'+(entriesQuery ? '?query='+encodeURIComponent(entriesQuery) : ''));
      entries = Array.isArray(result?.memories) ? result.memories : [];
      drawEntries();
    } catch (cause) { entriesSection.querySelector('[data-memory-status]').textContent = cause.message || '记忆暂时不可用。'; }
  }
  function showMemory() {
    activatePage('memory', 'memoryTitle');
    elements.title.focus();
    load();
    if (elements.topicsSection) loadEntries();
  }
  function topicsStatus(text = '', error = false) {
    elements.topicsNotice.textContent = text;
    elements.topicsNotice.classList.toggle('is-error', error);
    elements.topicsRetry.hidden = !error;
  }
  function topicsControls() {
    const pending = topicsLoading || topicsBusy;
    elements.topicsSection.setAttribute('aria-busy', String(pending));
    elements.topicsSection.querySelectorAll('button,input,textarea').forEach(node => { node.disabled = pending; });
  }
  function readTopics(result) {
    if (result?.ok === false || !Array.isArray(result?.relationship?.topics)) throw new Error('共同话题暂时不可用。');
    topics = result.relationship.topics;
  }
  async function loadTopics() {
    if (topicsLoading || topicsBusy) return;
    topicsLoading = true;
    topicsStatus('正在读取共同话题…');
    topicsControls();
    try {
      readTopics(await api('/api/dots/relationship'));
      renderTopics();
      topicsStatus();
    } catch (error) { topicsStatus('读取失败：'+message(error), true); }
    finally { topicsLoading = false; topicsControls(); }
  }
  function renderTopics(openId) {
    elements.topicsList.replaceChildren();
    for (const topic of topics) {
      const item = document.createElement('details');
      item.className = 'memory-topic';
      item.dataset.memoryTopic = topic.id;
      item.open = topic.id === openId;
      item.append(codexText('summary', topic.title || '共同话题'));
      if (topic.needsReview) item.append(codexText('p', '请确认这段记忆', 'memory-notice'));
      const form = document.createElement('form');
      for (const [name, label, maximum, rows] of [['title','话题',200,0],['summary','记住的内容',4000,3],['openQuestion','尚未聊完',2000,2]]) {
        const field = codexText('label', label);
        const input = document.createElement(rows ? 'textarea' : 'input');
        input.name = name;
        input.value = topic[name] || '';
        input.maxLength = maximum;
        input.required = name !== 'openQuestion';
        if (rows) input.rows = rows;
        field.append(input);
        form.append(field);
      }
      const actions = codexText('div', '', 'memory-topic-actions');
      const remove = codexText('button', '删除话题');
      remove.type = 'button';
      remove.addEventListener('click', () => saveTopic(topic.id, 'DELETE'));
      const save = codexText('button', '保存修改');
      save.type = 'submit';
      actions.append(remove, save);
      form.append(actions);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const fields = new FormData(form);
        saveTopic(topic.id, 'PATCH', {title:String(fields.get('title')).trim(),summary:String(fields.get('summary')).trim(),openQuestion:String(fields.get('openQuestion')).trim(),revision:topic.revision});
      });
      item.append(form);
      elements.topicsList.append(item);
    }
    if (!topics.length) elements.topicsList.append(codexText('p', '暂时没有保存的共同话题。', 'memory-notice'));
  }
  async function saveTopic(id, method, data) {
    if (topicsLoading || topicsBusy) return;
    topicsBusy = true;
    topicsStatus();
    topicsControls();
    try {
      readTopics(await api('/api/dots/relationship/topics/'+encodeURIComponent(id), method, data));
      renderTopics(method === 'PATCH' ? id : undefined);
      topicsStatus(method === 'DELETE' ? '已删除话题。' : '已保存修改。');
      if (opened && page === 'memory') elements.topicsList.querySelector('[data-memory-topic="'+CSS.escape(id)+'"] summary')?.focus();
    } catch (error) { topicsStatus('未保存：'+message(error), true); }
    finally { topicsBusy = false; topicsControls(); }
  }
  function buildTopics() {
    const section = codexText('section', '', 'memory-topics');
    section.setAttribute('aria-labelledby', 'memoryTopicsTitle');
    const title = codexText('h3', '共同话题', 'settings-section-title');
    title.id = 'memoryTopicsTitle';
    const list = codexText('div', '', 'memory-topic-list');
    const feedback = codexText('div', '', 'memory-feedback');
    const notice = codexText('p', '', 'memory-notice');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    const retry = codexText('button', '重新读取');
    retry.type = 'button';
    retry.hidden = true;
    retry.addEventListener('click', loadTopics);
    feedback.append(notice, retry);
    section.append(title, list, feedback);
    elements.memoryPage.append(section);
    Object.assign(elements, {topicsSection:section, topicsList:list, topicsNotice:notice, topicsRetry:retry});
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
  function renderQuotaWindows(windows) {
    const list = codexText('div', '', 'settings-quota-windows');
    for (const window of windows) {
      const item = codexText('section', '', 'settings-quota-window');
      const remaining = Math.max(0, Math.min(100, window.remainingPercent));
      const label = window.period || '当前周期';
      const heading = codexText('div', '', 'settings-quota-window-heading');
      heading.append(codexText('span', label), codexText('strong', Math.round(remaining)+'%'));
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.value = remaining;
      progress.setAttribute('aria-label', (window.bucket || '')+label+'剩余');
      const resetsAt = quotaDate(window.resetsAt);
      item.append(heading, progress, codexText('p', resetsAt ? '重置时间：'+resetsAt : '重置时间暂未提供', 'settings-quota-muted'));
      list.append(item);
    }
    return list;
  }
  function validWindows(value) {
    return Array.isArray(value) ? value.filter(window => window && typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)) : [];
  }
  function renderClaudeQuota(claude) {
    if (!claude) return;
    const windows = validWindows(claude.windows);
    elements.codexContent.append(codexText('h3', claude.plan || 'Claude', 'settings-section-title'));
    if (claude.available && windows.length) elements.codexContent.append(renderQuotaWindows(windows));
    else elements.codexContent.append(codexText('p', claude.error || '暂时无法获取 Claude 额度', 'settings-quota-muted'));
    if (claude.extraUsage && typeof claude.extraUsage.utilization === 'number') elements.codexContent.append(codexText('p', '额外用量已使用 '+Math.round(claude.extraUsage.utilization)+'%', 'settings-quota-muted'));
  }
  function renderCodexQuota(quota) {
    elements.codexContent.replaceChildren();
    renderClaudeQuota(quota.claude);
    if (quota.available === false) {
      elements.codexContent.append(codexText('h3', 'Codex', 'settings-section-title'), codexText('p', quota.error || '暂时无法获取 Codex 额度', 'settings-quota-muted'));
      const fetched = quotaDate(quota.claude?.fetchedAt, false);
      if (fetched) elements.codexContent.append(codexText('p', '更新于 '+fetched, 'settings-quota-updated settings-quota-muted'));
      return;
    }
    const windows = Array.isArray(quota.windows) ? quota.windows.filter(window => window && typeof window.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)) : [];
    if (windows.length) {
      elements.codexContent.append(codexText('h3', 'Codex', 'settings-section-title'));
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
    elements.codexContent.append(codexText('h3', 'Codex 重置卡', 'settings-section-title'));
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
    elements.codexNotice.textContent = '正在读取 Claude 与 Codex 额度…';
    elements.codexNotice.classList.remove('is-error');
    try {
      const result = await api('/api/account/quota');
      if (result?.ok === false || !result?.quota || (result.quota.available === false && !result.quota.claude?.available)) throw new Error('账户信息暂时不可用。');
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
    activatePage('codex', 'settingsCodexTitle');
    elements.codexTitle.focus();
    loadCodexQuota();
  }
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'memoryModal';
    root.className = 'memory-overlay';
    root.hidden = true;
    root.innerHTML = '<section class="memory-dialog" role="region" aria-labelledby="memoryTitle"><div class="memory-body settings-layout"><aside class="settings-sidebar"><div class="settings-sidebar-heading"><h2 id="settingsTitle">设置</h2></div><label class="settings-category-search"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m16 16 5 5" stroke="currentColor" stroke-width="1.7"/></svg><input type="search" placeholder="搜索设置" aria-label="搜索设置"></label><nav aria-label="设置分类"><h3>个人</h3><button type="button" data-settings-page="settings"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.7 1.7-.1 2.2-1.6 1.8 2 3.4 2.3-.7 1.9 1 .6 2.4h4l.6-2.4 2-1 2.2.7 2-3.4-1.6-1.8-.1-2.2 1.7-1.7-2-3.4-2.3.7-1.9-.9L15 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg><span>常规</span></button><button type="button" data-settings-page="memory"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 4h5a5 5 0 0 1 4 2 5 5 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 2 5 5 0 0 0-4-2H3zM12 6v15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg><span>记忆</span></button><p class="settings-category-empty" hidden>没有匹配的设置</p></nav></aside><main class="settings-content"><section class="settings-home"><header class="memory-header"><h2 id="settingsGeneralTitle">常规</h2></header><h3 class="settings-section-title">个性化</h3><button type="button" class="settings-memory-entry" data-settings-memory><span class="settings-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24"><rect x="5" y="5" width="14" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4M9 9h6v6H9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="settings-entry-copy"><strong>记忆</strong><span>自动记住重要信息，个性化回复</span></span><svg class="settings-entry-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></section><section class="settings-memory-page" hidden><header class="memory-header"><button type="button" class="memory-back" data-memory-back aria-label="返回设置"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>设置</span></button><h2 id="memoryTitle" tabindex="-1">记忆</h2></header><div class="memory-setting"><div><label for="memoryEnabled">使用记忆</label><p>关闭后，不再自动保存或使用记忆。已有记忆会保留。</p></div><input id="memoryEnabled" type="checkbox" role="switch"></div><div class="memory-feedback" hidden><p class="memory-notice" role="status" aria-live="polite"></p><button type="button" data-memory-retry hidden>重试</button></div></section></main></div></section>';
    document.body.append(root);
    const find = selector => root.querySelector(selector);
    elements = {
      body:find('.memory-body'),content:find('.settings-content'),dialog:find('.memory-dialog'),navigation:find('.settings-sidebar nav'),settingsSearch:find('.settings-category-search input'),navigationEmpty:find('.settings-category-empty'),home:find('.settings-home'),memoryPage:find('.settings-memory-page'),memoryEntry:find('[data-settings-memory]'),back:find('[data-memory-back]'),title:find('#memoryTitle'),setting:find('.memory-setting'),enabled:find('#memoryEnabled'),notice:find('.memory-notice'),feedback:find('.memory-feedback'),retry:find('[data-memory-retry]')
    };
    const codexNavigation = document.createElement('button');
    codexNavigation.type = 'button';
    codexNavigation.dataset.settingsPage = 'codex';
    codexNavigation.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18m-14 5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span>额度与重置卡</span>';
    elements.navigation.insertBefore(codexNavigation, elements.navigationEmpty);
    const codexEntry = document.createElement('button');
    codexEntry.type = 'button';
    codexEntry.className = 'settings-memory-entry';
    codexEntry.dataset.settingsCodex = '';
    codexEntry.innerHTML = '<span class="settings-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18m-14 5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span><span class="settings-entry-copy"><strong>额度与重置卡</strong><span>查看额度剩余、重置时间与可用重置卡</span></span><svg class="settings-entry-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    elements.home.append(codexText('h3', '账户', 'settings-section-title'), codexEntry);
    const codexPage = document.createElement('section');
    codexPage.className = 'settings-codex-page';
    codexPage.hidden = true;
    codexPage.innerHTML = '<header class="memory-header"><h2 id="settingsCodexTitle" tabindex="-1">额度与重置卡</h2></header><div class="settings-quota-toolbar"><p>查看当前账户的额度与重置卡信息</p></div><p class="memory-notice" data-codex-notice role="status" aria-live="polite"></p><div data-codex-content></div>';
    find('.settings-content').append(codexPage);
    Object.assign(elements, {codexPage, codexTitle:find('#settingsCodexTitle'), codexNotice:find('[data-codex-notice]'), codexContent:find('[data-codex-content]')});
    codexEntry.addEventListener('click', showCodex);
    new MutationObserver(orderNavigation).observe(elements.navigation, {childList:true});
    orderNavigation();
    elements.settingsSearch.addEventListener('input', filterCategories);
    elements.navigation.addEventListener('click', event => {
      const button = event.target.closest('[data-settings-page]');
      if (!button) return;
      showPage(button.dataset.settingsPage);
    });
    elements.enabled.addEventListener('change', toggle);
    elements.retry.addEventListener('click', load);
    elements.memoryEntry.addEventListener('click', showMemory);
    elements.back.addEventListener('click', showSettings);
    root.addEventListener('click', event => { if (event.target === root) close(); });
    root.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }

    });
    refreshControls();
    window.dispatchEvent(new CustomEvent('shiyan-settings-ready'));
  }
  function open(initialPage = 'memory') {
    build();
    if (opened) {
      if (initialPage !== page) showPage(initialPage);
      return;
    }
    restoreFocus = document.getElementById('railAvatar') || document.activeElement;
    const quota = document.getElementById('avatarQuotaCard');
    if (quota) quota.hidden = true;
    document.getElementById('railAvatar')?.setAttribute('aria-expanded', 'false');
    opened = true;
    root.hidden = false;
    fitSettings();
    const rail = document.getElementById('activityRail');
    const collect = element => {
      if (element === root || element === rail || ['SCRIPT','STYLE','LINK'].includes(element.tagName)) return [];
      if (rail && element.contains(rail)) return [...element.children].flatMap(collect);
      return [[element, element.inert]];
    };
    inertElements = [...document.body.children].flatMap(collect);
    for (const [element] of inertElements) element.inert = true;
    showPage(initialPage);
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
      if (!footer.querySelector('[data-account-logout]')) {
        const button = document.createElement('button');
        button.id = 'avatarLogout';
        button.type = 'button';
        button.dataset.accountLogout = '';
        button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M9 12h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>退出登录</span>';
        button.addEventListener('click', () => window.ShiYanAccount.logout(button));
        footer.append(button);
      }
      return true;
    };
    if (!attach()) {
      const observer = new MutationObserver(() => { if (attach()) observer.disconnect(); });
      observer.observe(document.body, {childList:true, subtree:true});
    }
    // Keep the main navigation usable while settings occupies the content area.
    document.addEventListener('click', event => {
      if (opened && event.target.closest('#activityRail button')) close(false);
    }, true);
    window.addEventListener('resize', () => { if (opened) fitSettings(); });
    document.addEventListener('keydown', event => {
      if (event.metaKey && event.key === ',' && !event.altKey && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (opened) close(); else open('settings');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
  window.ShiYanMemory = {open:() => open('memory'), close};
  window.ShiYanSettings = {open:(selected = 'settings') => open(selected), close, registerPage};
})();
