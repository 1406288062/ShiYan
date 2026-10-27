/* Web-only adapter for the shared workbench. It deliberately does not own a
 * file tree, editor, diff view, terminal, or browser pane. */
(() => {
  'use strict';
  if (window.ShiYanPlatform?.mode !== 'web') return;

  const WEB_ROOT = '/api/web-workspace';
  const REMOTE_ID = /^web-device-[A-Za-z0-9-]+$/;
  const REMOTE_FILE_ROUTES = new Set([
    '/directory-details', '/files/search', '/files/read', '/files/save-text', '/files/changes'
  ]);
  const BLOCKED_TOOLS = new Set(['browser', 'terminal', 'temporary', 'history', 'bookmarks', 'downloads', 'settings']);
  const documentTypes = new Set(['pdf', 'docx']);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const id = value => String(value || '');
  const uuid = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const accountId = () => window.ShiYanAccount?.user?.id || null;
  const isRemoteProjectId = value => REMOTE_ID.test(id(value));
  const extension = value => id(value?.filename || value?.name || value).split('.').pop().toLowerCase();
  const routePath = path => {
    try { return new URL(path, location.href).pathname; }
    catch { return String(path || '').split('?')[0]; }
  };
  const isRemoteFileRoute = path => REMOTE_FILE_ROUTES.has(routePath(path));

  function safePreviewURL(file) {
    const raw = file?.previewUrl || (file?.assetId ? `${WEB_ROOT}/preview/${encodeURIComponent(file.assetId)}` : '');
    if (!raw) throw Error('服务器没有提供文件预览地址');
    let url;
    try { url = new URL(raw, location.origin); } catch { throw Error('文件预览地址无效'); }
    if (url.origin !== location.origin || !url.pathname.startsWith(`${WEB_ROOT}/`)) throw Error('文件预览地址无效');
    return url.href;
  }

  function accountRequest(path, method = 'GET', body) {
    const request = window.ShiYanAccount?.request;
    if (typeof request !== 'function') return Promise.reject(Error('账户连接未就绪，请重新登录后重试'));
    return request(WEB_ROOT.replace('/api', '') + path, method, body);
  }

  function queryProjectId(path) {
    try { return new URL(path, location.origin).searchParams.get('projectId') || ''; }
    catch { return ''; }
  }

  function remoteRequest(path, method, body, files) {
    if (!isRemoteFileRoute(path)) return null;
    const projectId = id(body?.projectId) || queryProjectId(path) || id(body?.fileId && files.get(body.fileId)?.projectId);
    if (!isRemoteProjectId(projectId)) return null;
    let payload = body;
    if (body && body.fileId && !body.projectId) {
      const reference = files.get(body.fileId);
      if (reference) payload = {...body, projectId:reference.projectId, path:body.path || reference.path};
    }
    if (routePath(path) === '/files/save-text') payload = {...(payload || {}), requestId:payload?.requestId || uuid()};
    return accountRequest(path, method, payload);
  }

  class WebWorkspace {
    constructor(C) {
      this.C = C;
      this.files = new Map();
      this.remoteFiles = new Map();
      this.projects = [];
      this.devices = [];
      this.connected = false;
      this.error = '';
      this.loading = false;
      this.generation = 0;
      this.owner = accountId();
      this.refreshPromise = null;
      this.tabSignature = '';
      this.reconcileQueued = false;
      this.formTarget = null;
    }

    valid(generation, owner = this.owner) {
      return generation === this.generation && owner === accountId() && owner === this.owner;
    }

    notify(error) { window.shiyan?.toast?.(error?.message || String(error)); }

    installContext() {
      // Start the web surface collapsed; tabs can restore without reserving space.
      this.C.prefs.rightOpen = false;
      const C = this.C, originalApi = C.api, originalOpen = C.openTab;
      const originalClose = C.closeTab, originalSelectProject = C.selectProject;
      const originalTool = C.workspaceTool;
      C.api = (path, method = 'GET', body) => {
        const result = remoteRequest(path, method, body, this.remoteFiles);
        if (result) {
          const owner = this.owner;
          return result.then(data => {
            if (owner !== this.owner || owner !== accountId()) throw new DOMException('账户会话已更改','AbortError');
            const file = data?.file;
            const projectId = id(body?.projectId) || queryProjectId(path) || id(body?.fileId && this.remoteFiles.get(body.fileId)?.projectId);
            if (file && isRemoteProjectId(projectId)) {
              const fileId = id(file.fileId || file.id);
              if (fileId) this.remoteFiles.set(fileId, {projectId, path:file.path || body?.path || this.remoteFiles.get(fileId)?.path || ''});
            }
            return data;
          });
        }
        return originalApi(path, method, body);
      };
      // These operations are intentionally scoped to the workbench context.
      // The shared fetch/bootstrap/preferences/API remain untouched.
      C.native = () => false;
      C.nativeAvailable = () => false;
      C.pick = () => Promise.reject(Error('请在远程项目的目录选择器中选择文件夹，或手动填写路径'));
      C.openTab = (options = {}, reuse = false) => {
        if (!options.type) options = {type:'files', title:'项目文件', webDevicePane:true, ...options};
        if (BLOCKED_TOOLS.has(options.type)) return null;
        if (options.type === 'execution' || options.type === 'changes') {
          const existing = C.tabs?.find(tab => tab.type === options.type);
          if (existing) {
            Object.assign(existing, options);
            C.selectTab(existing.id);
            return existing;
          }
        }
        if (options.webAttachment) {
          const existing = C.tabs?.find(tab => tab.webAttachment);
          if (existing) {
            Object.assign(existing, {title:options.title || existing.title, assetId:options.assetId, webAttachment:true});
            C.selectTab(existing.id);
            return existing;
          }
        }
        const tab = originalOpen(options, reuse);
        if (tab && (tab.type === 'files' || tab.type === 'file')) queueMicrotask(() => this.decorateTab(tab.id));
        return tab;
      };
      C.closeTab = async idValue => {
        try { return await originalClose(idValue); }
        finally {
          this.disposeFile(idValue);
          this.scheduleReconcile();
        }
      };
      C.selectProject = async (...args) => {
        const active = C.tabs?.find(tab => tab.id === C.activeTab);
        const preservedId = active && isRemoteProjectId(active.projectId) && (active.type === 'files' || active.type === 'file') ? active.id : '';
        const result = await originalSelectProject(...args);
        if (preservedId && C.tabs?.some(tab => tab.id === preservedId)) C.selectTab(preservedId);
        return result;
      };
      C.workspaceTool = type => {
        if (BLOCKED_TOOLS.has(type)) return null;
        if (type === 'files') { this.ensureFilesTab(); const tab=C.tabs.find(t=>t.webDevicePane || isRemoteProjectId(t.projectId)); if(tab)C.selectTab(tab.id); return tab; }
        return originalTool(type);
      };
    }

    attach(result) {
      if (!result) return result;
      const originalInit = result.initFile;
      result.initFile = (tab, pane) => {
        if (isRemoteProjectId(tab.projectId)) { tab.webDevicePane=true;tab.webDeviceId=this.project(tab.projectId)?.deviceId; }
        const asset = tab.assetId ? (window.shiyan?.getState()?.conversations || []).flatMap(c=>(c.messages || []).flatMap(m=>m.assets || [])).find(a=>a.id===tab.assetId) : null;
        const restoredDocument = tab.assetId && documentTypes.has(extension(asset?.filename || tab.assetName || tab.title));
        if (restoredDocument) { tab.webAttachment=true;tab.projectId=undefined;tab.path=undefined;tab.selectedPath=undefined;tab.fileId=undefined; }
        const isolateSelectedProject = !tab.projectId;
        if (this.files.has(tab.id)) this.disposeFile(tab.id);
        const previousProject = isolateSelectedProject ? this.C.prefs.selectedProjectId : undefined;
        let f;
        try {
          if (isolateSelectedProject) this.C.prefs.selectedProjectId = null;
          f = originalInit(tab, pane);
        } finally {
          if (isolateSelectedProject) this.C.prefs.selectedProjectId = previousProject;
        }
        this.attachFile(f);
        if (restoredDocument) {
          const name=asset?.filename || tab.assetName || tab.title;
          f.selected={kind:'web-document',documentType:extension(name),name,path:name,assetId:tab.assetId,previewUrl:`${WEB_ROOT}/preview/${encodeURIComponent(tab.assetId)}`};
          f.readRevision+=1;f.tab.file=f.selected;f.breadcrumb.textContent=name;f.tree.replaceChildren();
          f.__webRenderDocument?.();this.addDownloadControl(f,asset || {id:tab.assetId,filename:name});
        }
        return f;
      };
      const originalAsset = result.openAsset;
      result.openAsset = asset => this.openAsset(asset, originalAsset);
      const originalAfterBoot = result.afterBoot;
      result.afterBoot = async () => {
        this.C.prefs.rightOpen = false;
        result.layout?.();
        this.startTabObserver();
        await originalAfterBoot?.();
        await this.refreshProjects();
        const savedActive = this.C.tabs.find(t=>t.id===this.C.activeTab);
        this.ensureFilesTab();
        const filesTab = this.C.tabs.find(t => t.webDevicePane || isRemoteProjectId(t.projectId));
        if (!this.C.tabs.some(t => t.type === 'execution')) this.C.openTab({type:'execution',title:'执行过程',conversationId:window.shiyan?.getState()?.selectedConversationId},true);
        const keepActive = savedActive && (isRemoteProjectId(savedActive.projectId) || savedActive.assetId || ['execution','changes'].includes(savedActive.type));
        if (keepActive && this.C.tabs.some(t=>t.id===savedActive.id)) this.C.selectTab(savedActive.id);
        else if (filesTab) this.C.selectTab(filesTab.id);
        if (window.workbench) window.workbench.openTool = this.C.workspaceTool;
        this.C.prefs.rightOpen = false;
        this.C.persist();
        result.layout?.();
        this.scheduleReconcile();
      };
      for (const tab of this.C.tabs || []) this.decorateTab(tab.id);
      this.bindAccountEvents();
      this.bindBrowserShortcut();
      this.result = result;
      this.startTabObserver();
      this.refreshProjects();
      return result;
    }

    startTabObserver() {
      if (this.tabObserver || typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
      const strip = document.getElementById('workspaceTabs');
      if (!strip) return;
      this.tabObserver = new MutationObserver(() => this.scheduleReconcile());
      this.tabObserver.observe(strip, {childList:true});
      const workspace = document.getElementById('rightWorkspace');
      if (workspace && typeof ResizeObserver === 'function') {
        this.tabSizeObserver = new ResizeObserver(() => {
          // A collapsed pane measures zero; size tabs again when it becomes visible.
          if (workspace.clientWidth > 0) window.ShiYanV22?.adaptTabs?.(this.C);
        });
        this.tabSizeObserver.observe(workspace);
      }
      this.scheduleReconcile();
    }

    scheduleReconcile() {
      if (this.reconcileQueued) return;
      this.reconcileQueued = true;
      queueMicrotask(() => {
        this.reconcileQueued = false;
        this.reconcileTabs();
      });
    }

    reconcileTabs() {
      const tabs = [...(this.C.tabs || [])];
      const signature = JSON.stringify(tabs.map(tab => [tab.id,tab.type,tab.projectId || '',tab.webDeviceId || '',!!tab.webAttachment,tab.assetId || '']));
      if (signature === this.tabSignature) return;
      this.tabSignature = signature;
      // The desktop shell can create its default browser tab through a private
      // closure. Remove only unsupported tool tabs; never change left projects.
      for (const tab of tabs) if (BLOCKED_TOOLS.has(tab.type) || !tab.type) {
        this.C.closeTab(tab.id).catch(error => this.notify(error));
      }
      const add = typeof document !== 'undefined' ? document.getElementById('addWorkspaceTab') : null;
      if (add) { add.hidden = true; add.setAttribute('aria-hidden','true'); }
      const live = new Set(tabs.map(tab => tab.id));
      for (const idValue of this.files.keys()) if (!live.has(idValue)) this.disposeFile(idValue);
      for (const tab of tabs) this.decorateTab(tab.id);
    }

    bindAccountEvents() {
      if (this.eventsBound) return;
      this.eventsBound = true;
      this.accountChanging = () => this.accountChanged();
      this.stateChanged = () => {
        if (this.owner !== accountId()) this.accountChanged();
        this.renderAllControls();
      };
      this.pageHidden = () => {
        this.generation += 1;
        this.tabObserver?.disconnect();
        this.tabSizeObserver?.disconnect();
        for (const idValue of this.files.keys()) this.disposeFile(idValue);
        window.removeEventListener('shiyan-account-changing', this.accountChanging);
        window.removeEventListener('shiyan-state', this.stateChanged);
      };
      window.addEventListener('shiyan-account-changing', this.accountChanging);
      window.addEventListener('shiyan-state', this.stateChanged);
      window.addEventListener('pagehide', this.pageHidden, {once:true});
    }

    bindBrowserShortcut() {
      if (this.browserShortcutBound || typeof window === 'undefined') return;
      this.browserShortcutBound = true;
      this.browserShortcut = event => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
        if (event.key.toLowerCase() === 'l') event.stopImmediatePropagation();
        if (event.key.toLowerCase() === 'o') { event.preventDefault();event.stopImmediatePropagation();this.C.workspaceTool('files'); }
      };
      window.addEventListener('keydown', this.browserShortcut, true);
      this.removeBrowserShortcut = () => window.removeEventListener('keydown', this.browserShortcut, true);
      window.addEventListener('pagehide', this.removeBrowserShortcut, {once:true});
    }

    accountChanged() {
      this.owner = accountId();
      this.generation += 1;
      this.loading = false;
      this.refreshPromise = null;
      this.loadedFor = null;
      this.projects = [];
      this.devices = [];
      this.connected = false;
      this.error = '';
      this.remoteFiles.clear();
      if (this.modal) this.modal.hidden = true;
      this.formTarget = null;
      this.renderAllControls();
    }

    async refreshProjects(force = false) {
      if (this.loading && this.refreshPromise) return this.refreshPromise;
      if (!force && this.loadedFor === this.owner && Date.now() - this.loadedAt < 15000) return;
      if (this.owner !== accountId()) this.accountChanged();
      const generation = ++this.generation, owner = this.owner;
      this.loading = true;
      this.error = '';
      this.renderAllControls();
      const promise = accountRequest('/projects').then(data => {
        if (!this.valid(generation, owner)) return;
        this.projects = Array.isArray(data.projects) ? data.projects.filter(project => isRemoteProjectId(project.id)) : [];
        this.devices = Array.isArray(data.devices) ? data.devices : [];
        this.connected = data.connected === true;
        this.loadedFor = owner;
        this.loadedAt = Date.now();
        this.renderAllControls();
      }).catch(error => {
        if (!this.valid(generation, owner)) return;
        this.error = error.message || '远程项目暂时不可用';
        this.projects = [];
        this.devices = [];
        this.connected = false;
        this.renderAllControls();
        if (error?.name !== 'AbortError') this.notify(error);
      }).finally(() => {
        if (this.valid(generation, owner)) {
          this.loading = false;
          this.refreshPromise = null;
          this.renderAllControls();
        }
      });
      this.refreshPromise = promise;
      return promise;
    }

    project(projectId) { return this.projects.find(project => project.id === projectId) || null; }
    device(deviceId) { return this.devices.find(device => device.deviceId === deviceId) || null; }
    online(deviceId) { const device = this.device(deviceId); return !!device && device.online === true && device.ready !== false; }
    availableDevice() { return this.connected ? this.devices.find(device => this.online(device.deviceId)) || null : null; }

    ensureFilesTab() {
      if (!this.C.tabs) return;
      if (this.C.tabs.some(tab => (tab.type === 'files' || tab.type === 'file') && (tab.webDevicePane || tab.webDeviceId || isRemoteProjectId(tab.projectId)))) return;
      const project = this.projects.find(item => this.online(item.deviceId));
      this.C.openTab({type:'files', title:project?.name || '设备文件', webDevicePane:true, ...(project ? {projectId:project.id, webDeviceId:project.deviceId} : {})}, false);
    }

    decorateTab(tabId) {
      const tab = (this.C.tabs || []).find(item => item.id === tabId);
      if (!tab || (tab.type !== 'files' && tab.type !== 'file')) return;
      const f = this.files.get(tabId);
      if (f) this.attachFile(f);
    }

    disposeFile(tabId) {
      const f = this.files.get(tabId);
      if (!f) return;
      f.disposed = true;
      f.__webDocumentObserver?.disconnect();
      if (f.__webEmptyClick) f.pane?.removeEventListener('click', f.__webEmptyClick, true);
      this.files.delete(tabId);
      if (this.formTarget === f) {
        this.formTarget = null;
        if (this.modal) this.modal.hidden = true;
      }
    }

    attachFile(f) {
      if (!f || f.__webWorkspaceAttached) return;
      f.__webWorkspaceAttached = true;
      this.files.set(f.tab.id, f);
      const directory = f.pane?.querySelector('.v2-file-directory');
      if (!directory) return;
      const controls = document.createElement('section');
      controls.className = 'web-remote-controls';
      controls.setAttribute('aria-label', '远程设备项目');
      controls.innerHTML = `<div class="web-project-bar"><select data-web-project aria-label="远程项目"></select><button type="button" class="wb-text-button web-project-add" data-web-add aria-label="添加远程项目" title="添加远程项目">+</button><details class="web-project-menu"><summary aria-label="项目操作" title="项目操作">···</summary><div class="web-project-menu-body"><label class="web-control-field">筛选设备<select data-web-device aria-label="远程设备"></select></label><button type="button" class="wb-text-button" data-web-refresh>刷新设备</button><button type="button" class="wb-text-button" data-web-rename>重命名项目</button><button type="button" class="wb-text-button web-danger" data-web-delete>移除项目关联</button><a href="https://mcp.yandot.ai/account" target="_blank" rel="noopener noreferrer">管理绑定设备</a></div></details><button type="button" data-web-open hidden>打开</button></div><p class="web-remote-state" data-web-state role="status" hidden></p>`;
      directory.prepend(controls);
      f.__webControls = controls;
      const refresh = () => this.renderControls(f);
      controls.querySelector('[data-web-refresh]').onclick = () => this.refreshProjects(true).catch(this.notify.bind(this));
      controls.querySelector('[data-web-device]').onchange = refresh;
      controls.querySelector('[data-web-project]').onchange = event => this.openProject(event.target.value);
      controls.querySelector('[data-web-open]').onclick = () => this.openProject(controls.querySelector('[data-web-project]').value);
      controls.querySelector('[data-web-add]').onclick = () => this.showProjectForm(f, 'add');
      controls.querySelector('[data-web-rename]').onclick = () => this.showProjectForm(f, 'rename');
      controls.querySelector('[data-web-delete]').onclick = () => this.removeProject(f).catch(this.notify.bind(this));
      this.disableExternalEditor(f);
      this.bindEmptyPane(f);
      this.installDocumentBridge(f);
      this.renderControls(f);
    }

    bindEmptyPane(f) {
      if (!f.pane || f.__webEmptyClick) return;
      f.__webEmptyClick = event => {
        const button = event.target?.closest?.('[data-open-project],[data-open-file]');
        if (!button || !f.pane.contains(button)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.hasAttribute('data-open-project')) this.showProjectForm(f, 'add');
        else { button.hidden = true; button.setAttribute('aria-hidden', 'true'); }
      };
      f.pane.addEventListener('click', f.__webEmptyClick, true);
      const standalone = f.pane.querySelector('[data-open-file]');
      if (standalone) { standalone.hidden = true; standalone.setAttribute('aria-hidden', 'true'); }
    }

    disableExternalEditor(f) {
      const button = f.pane?.querySelector('.v2-open-editor');
      if (button) { button.disabled = true; button.hidden = true; button.setAttribute('aria-hidden', 'true'); }
    }

    installDocumentBridge(f) {
      if (f.__webDocumentObserver || typeof MutationObserver !== 'function') return;
      const render = () => this.renderWebDocument(f);
      f.__webDocumentObserver = new MutationObserver(render);
      f.__webDocumentObserver.observe(f.preview, {childList:true, subtree:true});
      f.__webRenderDocument = render;
      render();
    }

    renderWebDocument(f, explicitFile) {
      const file = explicitFile || f.selected;
      if (f.disposed || !file || file.kind !== 'web-document' || !f.preview?.isConnected) return;
      let url;
      try { url = safePreviewURL(file); }
      catch (error) { f.preview.innerHTML = `<div class="v2-file-empty"><strong>无法预览文件</strong><span>${esc(error.message)}</span></div>`; return; }
      const revision = f.readRevision, selected = file;
      queueMicrotask(() => {
        if (f.disposed || f.readRevision !== revision || f.selected !== selected || !f.preview?.isConnected) return;
        const existing = f.preview.querySelector('iframe[data-web-document-preview]');
        if (existing?.src === url) return;
        const frame = document.createElement('iframe');
        frame.className = 'file-pdf-reader web-document-reader';
        frame.dataset.webDocumentPreview = 'true';
        frame.title = `文件预览：${file.name || '文件'}`;
        frame.referrerPolicy = 'no-referrer';
        if (file.documentType === 'docx' || extension(file.name) === 'docx') frame.setAttribute('sandbox', 'allow-scripts');
        frame.src = url;
        f.preview.replaceChildren(frame);
        this.addDownloadControl(f, file.assetId ? {id:file.assetId, filename:file.name} : null);
      });
    }

    addDownloadControl(f, asset) {
      const actions = f.pane?.querySelector('.v2-file-actions');
      if (!actions || !asset?.id) return;
      let button = actions.querySelector('[data-web-download]');
      if (!button) { button = document.createElement('button'); button.type = 'button'; button.className = 'wb-text-button'; button.dataset.webDownload = 'true'; button.textContent = '下载'; actions.appendChild(button); }
      button.onclick = () => window.shiyan.saveAsset(asset).catch(this.notify.bind(this));
    }

    renderAllControls() { for (const f of this.files.values()) this.renderControls(f); }

    renderControls(f) {
      const box = f?.__webControls;
      if (!box?.isConnected || f.disposed) return;
      const deviceSelect = box.querySelector('[data-web-device]'), projectSelect = box.querySelector('[data-web-project]');
      const priorDevice = deviceSelect.value || (isRemoteProjectId(f.projectId) ? this.project(f.projectId)?.deviceId : '');
      const deviceOptions = this.devices.map(device => [device.deviceId, `${device.name || device.deviceId}${this.online(device.deviceId) ? ' · 在线' : ' · 离线'}`]);
      const filter = this.device(priorDevice) ? priorDevice : '';
      const visible = this.projects.filter(project => !filter || project.deviceId === filter);
      const stateText = this.loading ? '正在读取设备…' : this.error ? this.error : !this.devices.length ? '当前拾燕账号尚无绑定设备' : !this.connected ? '设备离线' : isRemoteProjectId(f.projectId) && !this.online(this.project(f.projectId)?.deviceId) ? '当前项目所在设备离线' : '';
      const signature = JSON.stringify([deviceOptions,visible.map(project => [project.id,project.name,project.deviceId]),priorDevice,f.projectId || '',stateText,this.connected,this.loading]);
      if (box.dataset.renderSignature === signature) { this.renderModal(); return; }
      box.dataset.renderSignature = signature;
      deviceSelect.innerHTML = '<option value="">全部设备</option>' + deviceOptions.map(([value,label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
      deviceSelect.value = filter;
      projectSelect.innerHTML = '<option value="">选择远程项目…</option>' + visible.map(project => `<option value="${esc(project.id)}" ${project.id === f.projectId ? 'selected' : ''} ${this.online(project.deviceId) ? '' : 'disabled'}>${esc(project.name)}${this.online(project.deviceId) ? '' : ' · 离线'}</option>`).join('');
      if (isRemoteProjectId(f.projectId) && visible.some(project => project.id === f.projectId)) projectSelect.value = f.projectId;
      const status = box.querySelector('[data-web-state]');
      status.textContent = stateText;
      status.hidden = !stateText;
      status.title = !this.devices.length && !this.error && !this.loading ? '请在拾燕设置的海绵宝宝中连接，并使用拾燕账号绑定设备；ChatGPT 插件账号的设备不会自动共享。' : stateText;
      projectSelect.title = projectSelect.selectedOptions?.[0]?.textContent || '选择远程项目';
      const selected = this.project(f.projectId), hasProject = !!selected;
      box.querySelector('[data-web-open]').disabled = !projectSelect.value;
      box.querySelector('[data-web-rename]').disabled = !hasProject;
      box.querySelector('[data-web-delete]').disabled = !hasProject;
      box.querySelector('[data-web-add]').disabled = !this.availableDevice();
      this.renderModal();
    }

    ensureProjectModal() {
      if (this.modal?.isConnected) return this.modal;
      if (typeof document === 'undefined') return null;
      const modal = document.createElement('div');
      modal.id = 'webProjectModal';
      modal.className = 'wb-modal web-project-modal';
      modal.hidden = true;
      modal.innerHTML = `<form class="wb-dialog web-project-form" data-web-project-form aria-label="远程项目设置"><header><h2 data-web-form-title>添加远程项目</h2><button type="button" class="wb-icon-button" data-web-cancel aria-label="取消" title="取消">×</button></header><label>设备<select data-web-form-device required aria-label="远程项目设备"></select></label><label>名称<input data-web-form-name maxlength="100" required autocomplete="off"></label><label>目录<div class="path-picker web-path-field"><input data-web-form-path required placeholder="/Users/… 或 /workspace/…" autocomplete="off"><button type="button" class="wb-text-button" data-web-pick>选择…</button></div></label><p class="web-remote-form-error" data-web-form-error role="alert" hidden></p><footer><button type="button" class="wb-secondary" data-web-cancel>取消</button><button type="submit" class="wb-primary" data-web-submit>添加项目</button></footer></form>`;
      (document.body || document.documentElement).appendChild(modal);
      const form = modal.querySelector('[data-web-project-form]');
      form.addEventListener('submit', event => { event.preventDefault(); this.submitProject().catch(error => this.formError(error)); });
      modal.querySelectorAll('[data-web-cancel]').forEach(button => button.onclick = () => { modal.hidden = true; this.formTarget = null; });
      modal.querySelector('[data-web-pick]').onclick = () => this.pickDirectory().catch(error => this.formError(error));
      modal.addEventListener('click', event => { if (event.target === modal) { modal.hidden = true; this.formTarget = null; } });
      this.modal = modal;
      return modal;
    }

    renderModal() {
      const modal = this.modal, f = this.formTarget;
      if (!modal || !f || modal.hidden || f.disposed) return;
      const formDevice = modal.querySelector('[data-web-form-device]');
      formDevice.innerHTML = this.devices.map(device => `<option value="${esc(device.deviceId)}" ${this.online(device.deviceId) ? '' : 'disabled'}>${esc(device.name || device.deviceId)}${this.online(device.deviceId) ? '' : ' · 离线'}</option>`).join('');
      const project = this.project(f.projectId), mode = modal.querySelector('[data-web-project-form]').dataset.mode || 'add';
      if (project && mode === 'rename') formDevice.value = project.deviceId;
    }

    openProject(projectId) {
      const project = this.project(projectId);
      if (!project) return;
      let tab = this.C.tabs.find(item => (item.type === 'files' || item.type === 'file') && !item.webAttachment && (item.webDevicePane || item.webDeviceId));
      if (tab) {
        tab.type = 'files'; tab.title = project.name; tab.projectId = project.id; tab.webDeviceId = project.deviceId; tab.webDevicePane = true;
        tab.selectedPath = undefined; tab.path = undefined; tab.fileId = undefined; tab.file = undefined; tab.directoryPath = '';
        const pane = this.C.panes.get(tab.id);
        if (pane && this.result?.initFile) this.result.initFile(tab, pane);
        this.C.renderTabs();
      } else tab = this.C.openTab({type:'files', title:project.name, projectId:project.id, webDeviceId:project.deviceId, webDevicePane:true}, true);
      if (tab) this.C.selectTab(tab.id);
    }

    showProjectForm(f, mode) {
      const modal = this.ensureProjectModal();
      if (!modal) return;
      const form = modal.querySelector('[data-web-project-form]'), project = this.project(f.projectId);
      this.formTarget = f;
      form.dataset.mode = mode;
      form.hidden = false;
      modal.querySelector('[data-web-form-title]').textContent = mode === 'rename' ? '重命名远程项目' : '添加远程项目';
      modal.querySelector('[data-web-form-name]').value = mode === 'rename' ? project?.name || '' : '';
      modal.querySelector('[data-web-form-path]').value = mode === 'rename' ? project?.path || '' : '';
      modal.querySelector('[data-web-form-device]').value = mode === 'rename' ? project?.deviceId || '' : (this.availableDevice()?.deviceId || this.devices[0]?.deviceId || '');
      modal.querySelector('[data-web-form-path]').disabled = mode === 'rename';
      modal.querySelector('[data-web-pick]').hidden = mode === 'rename';
      modal.querySelector('[data-web-submit]').textContent = mode === 'rename' ? '保存名称' : '添加项目';
      modal.querySelector('[data-web-form-error]').hidden = true;
      modal.hidden = false;
      this.renderModal();
      modal.querySelector('[data-web-form-name]').focus();
    }

    async pickDirectory() {
      const modal = this.modal, deviceId = modal?.querySelector('[data-web-form-device]')?.value;
      if (!deviceId) throw Error('请选择设备');
      const button = modal.querySelector('[data-web-pick]');
      if (button.disabled) return;
      const owner = this.owner, target = this.formTarget;
      // Device-list refreshes change generation, but do not invalidate this selection.
      const current = () => owner === this.owner && owner === accountId() && this.formTarget === target && !modal.hidden && modal.querySelector('[data-web-form-device]').value === deviceId;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = '选择中…';
      modal.querySelector('[data-web-form-error]').hidden = true;
      const device = this.devices.find(item => item.deviceId === deviceId);
      window.shiyan?.toast?.(`请在「${device?.name || '所选设备'}」上选择目录`);
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('选择目录等待超时，请检查所选设备上的窗口，或手动填写目录')), 150000);
        });
        const result = await Promise.race([accountRequest('/pick', 'POST', {deviceId}), timeout]);
        if (!current()) return;
        if (!result?.cancelled && result?.path) modal.querySelector('[data-web-form-path]').value = result.path;
      } catch (error) {
        if (current()) this.formError(error);
      } finally {
        clearTimeout(timer);
        button.disabled = false;
        button.textContent = label;
      }
    }

    formError(error) {
      const target = this.modal?.querySelector('[data-web-form-error]');
      if (target) { target.textContent = error.message || String(error); target.hidden = false; }
    }

    async submitProject() {
      const f = this.formTarget, modal = this.modal;
      if (!f || !modal) return;
      const form = modal.querySelector('[data-web-project-form]'), mode = form.dataset.mode || 'add';
      const deviceId = modal.querySelector('[data-web-form-device]').value, name = modal.querySelector('[data-web-form-name]').value.trim(), path = modal.querySelector('[data-web-form-path]').value.trim();
      if (!deviceId || !name || (mode === 'add' && !path)) throw Error('请填写设备、项目名称和目录');
      const button = modal.querySelector('[data-web-submit]'); button.disabled = true;
      const generation = this.generation, owner = this.owner;
      try {
        const data = mode === 'rename' ? await accountRequest(`/projects/${encodeURIComponent(f.projectId)}`, 'PATCH', {name}) : await accountRequest('/projects', 'POST', {deviceId, path, name});
        if (!this.valid(generation, owner)) return;
        this.projects = Array.isArray(data.projects) ? data.projects.filter(project => isRemoteProjectId(project.id)) : (data.project ? [data.project] : this.projects);
        const project = data.project || this.projects.find(item => item.name === name && item.deviceId === deviceId);
        if (mode === 'rename' && project) for (const tab of this.C.tabs || []) if (tab.projectId === f.projectId) tab.title = name;
        modal.hidden = true; this.formTarget = null; this.renderAllControls(); this.C.renderTabs();
        if (mode === 'add' && project) this.openProject(project.id);
      } finally { button.disabled = false; }
    }

    async removeProject(f) {
      const project = this.project(f.projectId); if (!project) return;
      if (!(await window.shiyan.confirmAction('移除远程项目？', `仅移除拾燕中的「${project.name}」记录，不删除设备文件。`, '移除'))) return;
      const generation = this.generation, owner = this.owner;
      const data = await accountRequest(`/projects/${encodeURIComponent(project.id)}`, 'DELETE');
      if (!this.valid(generation, owner)) return;
      this.projects = Array.isArray(data.projects) ? data.projects.filter(item => isRemoteProjectId(item.id)) : this.projects.filter(item => item.id !== project.id);
      for (const tab of this.C.tabs || []) if (tab.projectId === project.id) {
        Object.assign(tab,{projectId:undefined,webDeviceId:undefined,webDevicePane:true,title:'项目文件',selectedPath:undefined,path:undefined,fileId:undefined,directoryPath:''});
        const pane=this.C.panes.get(tab.id);if(pane)this.result?.initFile(tab,pane);
      }
      this.C.renderTabs();this.C.persist();this.renderAllControls();
    }

    async openAsset(asset, original) {
      const type = extension(asset), mime = id(asset?.mimeType).toLowerCase();
      const isDocument = documentTypes.has(type) || mime === 'application/pdf' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (!isDocument) return original?.(asset);
      if (!asset?.id) throw Error('文件附件不存在');
      let tab = (this.C.tabs || []).find(item => item.webAttachment);
      if (!tab) tab = this.C.openTab({type:'files', title:asset.filename || '文件', assetId:asset.id, webAttachment:true}, false);
      if (!tab) throw Error('无法打开文件面板');
      Object.assign(tab,{assetId:asset.id,assetName:asset.filename,title:asset.filename || '文件',webAttachment:true});
      this.C.selectTab(tab.id);
      let f = this.files.get(tab.id);
      if (!f) { await new Promise(resolve => requestAnimationFrame(resolve)); f = this.files.get(tab.id); }
      if (!f) throw Error('文件面板尚未准备好');
      f.projectId = null; f.tab.projectId = undefined; f.tab.selectedPath = undefined; f.tab.fileId = undefined;
      f.selected = {kind:'web-document', documentType:type === 'docx' ? 'docx' : 'pdf', name:asset.filename || '文件', path:asset.filename || '文件', assetId:asset.id, previewUrl:`${WEB_ROOT}/preview/${encodeURIComponent(asset.id)}`};
      f.tab.file = f.selected; f.readRevision += 1;
      f.preview.__shiyanFile = {file:f.selected, reference:{}, reload:() => this.openAsset(asset)};
      f.breadcrumb.textContent = f.selected.name;
      f.tree.replaceChildren();
      f.__webRenderDocument?.();
      this.addDownloadControl(f, asset);
      this.C.persist();
      return tab;
    }
  }

  function hookV2() {
    const api = window.ShiYanV2;
    if (!api?.install || api.install.__webWorkspaceHook) return !!api?.install;
    const original = api.install;
    const wrapped = function(context) {
      const adapter = new WebWorkspace(context);
      adapter.installContext();
      const result = original.call(this, context);
      return adapter.attach(result);
    };
    wrapped.__webWorkspaceHook = true;
    api.install = wrapped;
    window.ShiYanWebWorkspace = {isRemoteProjectId, safePreviewURL, blockedTools:[...BLOCKED_TOOLS], requestId:uuid, remoteFileRoutes:[...REMOTE_FILE_ROUTES]};
    return true;
  }

  // workspace.js is injected after V2/V22 and immediately before workbench.js.
  hookV2();
})();
