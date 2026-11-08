 
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    home:'M3 10 12 3l9 7v10H15v-6H9v6H3Z',
    enhance:'M4 8V4h4m8 0h4v4m0 8v4h-4M8 20H4v-4M12 7l1.4 3.6L17 12l-3.6 1.4L12 17l-1.4-3.6L7 12l3.6-1.4Z',
    execution:'M8 5h13M8 12h13M8 19h13M2 5l1.5 1.5L6 3M2 12l1.5 1.5L6 10M2 19l1.5 1.5L6 17',
    history:'M3 10a9 9 0 1 1 2 8M3 4v6h6m3-3v5l3 2',
    file:'M6 3h8l4 4v14H6Zm8 0v5h4M9 12h6m-6 4h6',
    folder:'M3 6h7l2 2h9v12H3Zm0 0V4h7l2 2h9v2',
    terminal:'m5 6 6 6-6 6m8 0h6',
    globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
    left:'M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM8 3.5v17', leftCollapsed:'M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM7 8v8', right:'M4 4h16v16H4Zm11 0v16',
    plus:'M12 5v14M5 12h14', close:'m6 6 12 12M18 6 6 18',
    back:'m14 5-7 7 7 7', forward:'m10 5 7 7-7 7', refresh:'M20 9a8 8 0 1 0 0 6m0-12v6h-6',
    sideChat:'M20.5 16.5 21 21l-4.5-1a9 9 0 1 1 4-3.5ZM12 7v10M7 12h10',
    newChat:'M10 4H4v16h16v-6M9 15l1-5 9-9 4 4-9 9Z',
    down:'m6 9 6 6 6-6', star:'m12 3 2.8 5.7L21 9.6l-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
    download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Zm7 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    more:'M4 12h.01M12 12h.01M20 12h.01', copy:'M8 8h12v13H8ZM4 16H2V3h12v2',
    arrow:'M4 12h15m-6-6 6 6-6 6', search:'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM15.7 15.7 21 21'
  };
  const iosSymbols = {newChat:"square.and.pencil",folder:"folder",folderOpen:"folder.fill",copy:"reply-copy"};
  const icon = (name, extra='') => iosSymbols[name] ? `<span class="wb-icon wb-ios-icon ${extra}" style="--ios-symbol:url('/assets/symbols/${iosSymbols[name]}.png')" aria-hidden="true"></span>` : `<svg class="wb-icon ${extra} ${name==='search'?'wb-search-icon':''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"></path></svg>`;
   
  const toolbarGlyphs = {
    search:{box:'-1.7 -1.7 26.4 26.4',path:paths.search},
    left:{box:'0 0 24 24',path:paths.left},
    leftCollapsed:{box:'0 0 24 24',path:paths.leftCollapsed},
    pane:{box:'0 0 24 24',path:'M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM14 3.5v17'},
    addPanel:{box:'0 0 24 24',path:'M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM12 8v8M8 12h8'},
    tasks:{box:'1.7 1.7 20.6 20.6',body:'<circle cx="6" cy="7" r="2.2"/><path d="M12 7h7"/><circle cx="6" cy="17" r="2.2"/><path d="M12 17h7"/>'},
    more:{box:'0 0 24 24',body:'<circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="20" cy="12" r="1.2" fill="currentColor" stroke="none"/>'},
    expand:{box:'3.25 3.25 17.5 17.5',path:'M14 6h4v4M6 14v4h4'},
    contract:{box:'3.25 3.25 17.5 17.5',path:'M18 10h-4V6M6 14h4v4'},
    plus:{box:'2 2 20 20',path:'M12 5v14M5 12h14'}
  };
  const toolbarIcon = name => {
    const glyph=toolbarGlyphs[name==='right'?'addPanel':name];
    if(!glyph)return icon(name);
    return `<svg class="wb-icon toolbar-glyph ${name==='search'?'wb-search-icon':''}" viewBox="${glyph.box}" aria-hidden="true">${glyph.body || '<path d="'+glyph.path+'"></path>'}</svg>`;
  };
  const rightWorkspaceEnabled=window.ShiYanPlatform?.get('ui.rightWorkspace',true)!==false;
  const toolbarButtonIds=new Set(['sidebarSearch','toggleLeftSidebar','toggleRightWorkspace','addWorkspaceTab']);
  const button = (id, name, title, extra='') => `<button id="${id}" class="wb-icon-button ${extra}" type="button" title="${esc(title)}" aria-label="${esc(title)}">${toolbarButtonIds.has(id)?toolbarIcon(name):icon(name)}</button>`;
  const uuid = () => crypto.randomUUID();
  let token = '', projects = [], prefs = {leftOpen:true,rightOpen:false,leftWidth:window.ShiYanPlatform?.mode==='web'?248:262,rightWidth:460,groups:{pinned:true,projects:true,recent:true}}, tabs = [], activeTab = '', defaultDirectory = '', lastSelected = '';
  let browserState = {tabs:[],history:[],bookmarks:[],downloads:[],searchEngine:'bing'};
  let ready = false, saveTimer, resizeRAF, loading = true;
   
  let compactPane = 'left', wasCompact = false;
  let v2 = null;
  const panes = new Map(), sessions = new Map(), openedBrowsers = new Set(), pickerRequests = new Map();
  const nativeAvailable = () => !!window.ShiYanAccount?.user?.serverAccess && (window.ShiYanPlatform?.adapter('native')?.available?.() ?? !!window.webkit?.messageHandlers?.native);
  function native(op, data={}) {
    if(!nativeAvailable() || !window.ShiYanAccount?.user?.serverAccess) return false;
    if(window.ShiYanPlatform)return window.ShiYanPlatform.postNative('workbench',{op,...data});
    window.webkit.messageHandlers.native.postMessage({action:'workbench',op,...data});
    return true;
  }
  function notify(text) { window.shiyan?.toast?.(String(text)); }
  async function api(path, method='GET', body) {
    const headers = {'X-Shiyan-Local':'1'};
    if(token) headers['X-Shiyan-Workspace'] = token;
    if(body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch('/api/workspace'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const data = await r.json().catch(()=>({error:'本地工作区连接失败'}));
    if(!r.ok || data.ok===false) throw Error(data.error || data.detail || `请求失败 (${r.status})`);
    return data;
  }
  function persist() {
    if(!ready) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(()=>api('/preferences','PATCH',{...prefs,tabs:tabs.map(({id,type,title,url,projectId,path,fileId,selectedPath,directoryOpen,directoryPath,cwd,conversationId,messageId,assetId,assetName})=>({id,type,title,url,projectId,path,fileId,selectedPath,directoryOpen,directoryPath,cwd,conversationId,messageId,assetId,assetName})),activeTab}).catch(e=>notify(e.message)),180);
  }
  function createShell() {
    document.body.classList.add('desktop-workbench');
    const shell = document.createElement('div'); shell.id='desktopLayout';
    shell.innerHTML = `<nav id="activityRail" class="activity-rail" aria-label="功能导航">
      ${button('railHome','home','AI Coding 首页','is-active')}
      ${button('railEnhance','enhance','变清晰')}
      ${button('railHistory','history','历史记录')}
      <div class="rail-spacer"></div>
    </nav><div id="leftContainer" class="left-container"></div>
    <div id="mainWorkspace" class="main-workspace"><header id="desktopToolbar" class="desktop-toolbar">
      ${button('toggleLeftSidebar','left','隐藏左侧栏')}<span id="workspaceTitle">聊天</span><span class="toolbar-spacer"></span>${button('toggleRightWorkspace','right','隐藏右侧工作区')}
    </header><div id="centerContent" class="center-content"></div></div>
    <aside id="rightWorkspace" class="right-workspace" aria-label="浏览器与文件工作区">
      <div class="workspace-tabbar"><div id="workspaceTabs" role="tablist" aria-label="工作区标签"></div>${button('addWorkspaceTab','plus','新建标签页')}</div>
      <div id="browserAddressBar" class="browser-address-bar"><div class="browser-navigation">${button('browserBack','back','后退')}${button('browserForward','forward','前进')}${button('browserReload','refresh','刷新')}</div>
        <form id="addressForm"><input id="browserAddress" autocomplete="off" spellcheck="false" aria-label="网址或搜索内容" placeholder="搜索或输入网址"></form>
        ${button('bookmarkPage','star','收藏当前网页')}${button('browserTools','more','浏览器工具与设置')}
      </div><div id="rightContent" class="right-content"></div>
    </aside>`;
    $('app').prepend(shell);
    ['homeView','agentView','searchView','historyView'].forEach(id=>$('centerContent').appendChild($(id)));
    $('mainWorkspace').appendChild($('connectionBanner'));
    const side=$('agentSidebar'); $('leftContainer').appendChild(side);
    const sidebarHeader=side.querySelector('.sidebar-header');
    sidebarHeader.innerHTML=`<img class="sidebar-logo" src="/assets/logo.png?v=20261107-cache-v1" alt="" width="30" height="30"><h2>拾燕</h2>${button('sidebarSearch','search','搜索聊天')}`;
    side.querySelector('.workspace-navigation')?.remove();
    const newChat=$('newConversationButton');
    newChat.className='sidebar-new-chat';newChat.title='新聊天';newChat.setAttribute('aria-label','新聊天');
    newChat.innerHTML=icon('newChat')+'<span>新聊天</span>';
    sidebarHeader.after(newChat);
    const pins=$('pinnedSessions'), recents=$('recentSessions');
    const scroller=$('sidebarScroller');
    scroller.innerHTML=`<details id="pinnedGroup" class="sidebar-group" open><summary>${icon('down')}<span>置顶</span></summary><section id="pinnedSection"></section></details>
      <details id="projectsGroup" class="sidebar-group" open><summary>${icon('down')}<span>项目</span><button id="addProjectButton" type="button" class="group-add" title="添加项目" aria-label="添加项目">${icon('plus')}</button></summary><div id="projectList"></div></details>
      <details id="recentGroup" class="sidebar-group" open><summary>${icon('down')}<span>最近</span></summary><div id="recentContainer"></div></details>`;
    $('pinnedSection').appendChild(pins);$('recentContainer').appendChild(recents);
    $('historyButton')?.remove();
    $('closeAgentButton').hidden=true;
    $('openSidebarButton').hidden=true;
    $('closeSidebarButton').hidden=true;
     
    $('chatPanel').querySelector('.chat-toolbar').hidden=true;
    $('emptyConversation').querySelector('h2').textContent='我们从哪里开始？';
    const surface=$('composerSurface'),actions=surface.querySelector('.composer-actions');
    const input=$('messageInput'), spacer=actions.querySelector('.composer-spacer');
    if(spacer){spacer.before(input);spacer.remove();}else if(!actions.contains(input)){actions.appendChild(input);}
    input.placeholder='询问拾燕';
    const modal=document.createElement('div');modal.id='workbenchModal';modal.className='wb-modal';modal.hidden=true;
    modal.innerHTML=`<form id="projectForm" class="wb-dialog" aria-label="项目设置"><header><h2 id="projectDialogTitle">打开项目</h2>${button('cancelProject','close','取消')}</header>
      <div class="project-type-switch"><button type="button" id="importProjectMode" class="selected">打开已有项目</button><button type="button" id="createProjectMode">新建项目</button></div>
      <label>项目名称<input id="projectName" required maxlength="100" placeholder="项目名称"></label>
      <label><span id="projectPathLabel">项目目录</span><div class="path-picker"><input id="projectPath" required placeholder="选择本地目录"><button id="chooseProjectDirectory" type="button">选择…</button></div></label>
      <p id="projectFormError" class="wb-error" hidden></p><footer><button id="submitProject" class="wb-primary" type="submit">打开项目</button></footer></form>`;
    $('app').appendChild(modal);
    const leftHandle=document.createElement('div');leftHandle.id='leftResizeHandle';leftHandle.className='wb-resizer left-resizer';leftHandle.setAttribute('role','separator');leftHandle.setAttribute('aria-label','调整会话栏宽度');leftHandle.setAttribute('aria-orientation','vertical');$('leftContainer').appendChild(leftHandle);
    const rightHandle=document.createElement('div');rightHandle.id='rightResizeHandle';rightHandle.className='wb-resizer right-resizer';rightHandle.setAttribute('role','separator');rightHandle.setAttribute('aria-label','调整工作区宽度');rightHandle.setAttribute('aria-orientation','vertical');$('rightWorkspace').appendChild(rightHandle);
  }
  function layout() {
    if(v2)return v2.layout();
    const width=window.innerWidth, rail=50;
    const compact=width<1140;
    if(compact && !wasCompact)compactPane='left';
    wasCompact=compact;
    const leftVisible=!!prefs.leftOpen && (!compact || compactPane==='left');
    const rightVisible=rightWorkspaceEnabled&&!!prefs.rightOpen && (!compact || compactPane==='right');
    const minCenter=compact?Math.max(400,Math.min(540,width*.55)):Math.max(520,Math.min(620,width*.45));
    let left=leftVisible?Math.min(prefs.leftWidth||262,compact?Math.max(195,width*.30):Math.max(225,width*.32)):0;
    let right=rightVisible?Math.min(prefs.rightWidth||460,width*.60):0;
    const available=Math.max(0,width-rail-minCenter);
    if(left+right>available && right)right=Math.max(0,Math.min(right,available-left));
    if(left+right>available && left)left=Math.max(0,Math.min(left,available-right));
    $('desktopLayout').style.setProperty('--left-width',left+'px');
    $('desktopLayout').style.setProperty('--right-width',right+'px');
    $('desktopLayout').dataset.compact=String(compact);
    $('leftContainer').hidden=!leftVisible;
    $('rightWorkspace').hidden=!rightVisible;
    const l=$('toggleLeftSidebar'),r=$('toggleRightWorkspace');
    l.setAttribute('aria-expanded',String(leftVisible));r.setAttribute('aria-expanded',String(rightVisible));
    l.title=l.ariaLabel=leftVisible?'隐藏左侧栏':'显示左侧栏';
    r.title=r.ariaLabel=rightVisible?'隐藏右侧工作区':'显示右侧工作区';
    scheduleNative();fitTerminals();
  }
  function scheduleNative() {cancelAnimationFrame(resizeRAF);resizeRAF=requestAnimationFrame(syncNative);}
  function syncNative() {
    if(v2)return v2.syncNative();
    const tab=tabs.find(t=>t.id===activeTab),pane=tab&&panes.get(tab.id);
    const modal=!!document.querySelector('.modal-overlay:not([hidden]),.wb-modal:not([hidden]),.preview-overlay:not([hidden])');
    const visible=!!(!$('rightWorkspace').hidden && tab?.type==='browser' && tab.url && pane && !modal && nativeAvailable());
    const box=pane?.getBoundingClientRect();
    native('show',{tabId:tab?.id||'',visible,rect:box?{x:box.x,y:box.y,width:box.width,height:box.height}:undefined});
  }
  function renderState(state) {
    if(!state) return;
    if(Array.isArray(state.projects)) projects=state.projects;
    const current=state.conversations?.find(c=>c.id===state.selectedConversationId);
    if(current && current.id!==lastSelected) {
      lastSelected=current.id;
      prefs.selectedProjectId=current.projectId||null;
      if(ready) persist();
    }
    const project=projects.find(p=>p.id===prefs.selectedProjectId);
    $('workspaceTitle').innerHTML=icon('folder')+'<span data-workspace-title-text></span>';$('workspaceTitle').querySelector('[data-workspace-title-text]').textContent=current?.title||'新聊天';
    $('agentView').classList.toggle('is-empty',!current?.messages?.length);
    renderProjects();
    $('pinnedSection').hidden=false;
    const view=window.shiyan?.getView();
    $('railHome').classList.toggle('is-active',view==='agent'||view==='search');
    $('railEnhance').classList.toggle('is-active',view==='home');
    $('railHistory').classList.toggle('is-active',view==='history');
    v2?.renderState(state);
    scheduleNative();
  }
  function renderProjects() {
    if(v2)return v2.renderProjects();
    const list=$('projectList');if(!list)return;
    list.innerHTML=projects.map(p=>`<button type="button" class="project-row ${p.id===prefs.selectedProjectId?'selected':''}" data-project="${esc(p.id)}" title="${esc(p.path)}">${icon('folder')}<span>${esc(p.name)}</span></button>`).join('');
  }
  let createProject=false;
  function projectDialog(create=false) {
    if(v2)return v2.openProjectDialog();
    createProject=create;$('workbenchModal').hidden=false;$('projectFormError').hidden=true;
    $('projectName').value='';$('projectPath').value=defaultDirectory;
    setProjectMode(create);scheduleNative();$('projectName').focus();
  }
  function setProjectMode(create) {
    createProject=create;
    $('projectDialogTitle').textContent=create?'新建项目':'打开项目';
    $('projectPathLabel').textContent=create?'创建位置（在此目录下新建项目文件夹）':'项目目录';
    $('submitProject').textContent=create?'创建项目':'打开项目';
    $('createProjectMode').classList.toggle('selected',create);$('importProjectMode').classList.toggle('selected',!create);
  }
  function pick(op,path='') {
    if(!window.ShiYanAccount?.user?.serverAccess) return Promise.reject(Error('请在项目目录中填写自己的工作区路径，例如 /workspace'));
    if(!nativeAvailable()) return Promise.reject(Error('请在桌面应用中选择文件；本机网页可直接填写项目路径'));
    return new Promise(resolve=>{const id=uuid();pickerRequests.set(id,resolve);native(op,{id,path});});
  }
  async function selectProject(id) {
    await api('/projects/'+encodeURIComponent(id)+'/select','POST',{});
    prefs.selectedProjectId=id;persist();renderProjects();
    window.shiyan.navigate('agent');
    openTab({type:'files',title:'文件',projectId:id},true);
  }
  function normalizeAddress(raw) {
    raw=String(raw||'').trim();if(!raw)return '';
    if(/^https?:\/\//i.test(raw)) {const u=new URL(raw);if(u.username||u.password)throw Error('地址不能包含账号或密码');return u.href;}
    if(/^[a-z][a-z\d+.-]*:/i.test(raw)&&!/^localhost:\d/i.test(raw)&&!/^\d+\.\d+\.\d+\.\d+:\d/.test(raw))throw Error('仅支持 HTTP 或 HTTPS 网页');
    if(!/\s/.test(raw) && /^(localhost(?::\d+)?|[\w.-]+\.[a-z\d.-]+|\d+\.\d+\.\d+\.\d+)(?::\d+)?(?:[/?#]|$)/i.test(raw)) {
      return new URL((/^(localhost|127\.|10\.|192\.168\.)/.test(raw)?'http://':'https://')+raw).href;
    }
    const base={bing:'https://www.bing.com/search?q=',baidu:'https://www.baidu.com/s?wd=',duckduckgo:'https://duckduckgo.com/?q='}[browserState.searchEngine]||'https://www.bing.com/search?q=';
    return base+encodeURIComponent(raw);
  }
  function openTab(options={type:'browser',title:'新标签页',url:''},reuse=false) {
    if(reuse) {
      const existing=tabs.find(t=>t.type===options.type&&(options.type==='files'?t.projectId===options.projectId:options.type==='file'?t.path===options.path&&t.projectId===options.projectId&&t.fileId===options.fileId:true));
      if(existing){selectTab(existing.id);return existing;}
    }
    if(tabs.length>=30){notify('最多保留 30 个标签，请先关闭不需要的标签');return null;}
    const tab={id:uuid(),...options};tabs.push(tab);prefs.rightOpen=true;selectTab(tab.id);return tab;
  }
  function selectTab(id) { activeTab=id;prefs.rightOpen=true;v2?.revealRight();if(window.innerWidth<1140)compactPane='right';renderTabs();layout();persist(); }
  async function closeTab(id) {
    v2?.onCloseTab(id);
    const term=sessions.get(id);
    if(term){try{if(term.sessionId)await api('/terminals/'+term.sessionId,'DELETE');}catch(e){notify('终端关闭未确认：'+e.message);}term.controller?.abort();term.observer?.disconnect();term.term?.dispose();sessions.delete(id);}
    native('close',{tabId:id});openedBrowsers.delete(id);
    const index=tabs.findIndex(t=>t.id===id);tabs=tabs.filter(t=>t.id!==id);panes.get(id)?.remove();panes.delete(id);
    if(activeTab===id)activeTab=tabs[Math.min(index,tabs.length-1)]?.id||'';
    if(v2?.closeEmptyWorkspace()||!tabs.length)prefs.rightOpen=false;
    renderTabs();persist();layout();
  }
  function renderTabs() {
    $('workspaceTabs').innerHTML=tabs.map(t=>`<div class="workspace-tab ${t.id===activeTab?'selected':''}" role="tab" tabindex="0" aria-selected="${t.id===activeTab}" data-tab="${esc(t.id)}" title="${esc(t.title)}">${icon(t.type==='temporary'?'sideChat':t.type==='browser'?'globe':t.type==='terminal'?'terminal':t.type==='files'?'folder':t.type==='file'||t.type==='changes'?'file':t.type==='history'?'history':t.type==='bookmarks'?'star':t.type==='downloads'?'download':'settings')}<span>${esc(t.title||'新标签页')}</span><button type="button" data-close-tab="${esc(t.id)}" aria-label="关闭 ${esc(t.title||'标签')}" title="关闭标签">${icon('close')}</button></div>`).join('');
    const tab=tabs.find(t=>t.id===activeTab);
    for(const [id,pane]of panes)pane.hidden=id!==activeTab;
    if(!tab){$('browserAddressBar').hidden=true;v2?.decorateTabs();scheduleNative();return;}
    let pane=panes.get(tab.id);
    if(!pane){pane=document.createElement('section');pane.className='workspace-pane';pane.dataset.tabPane=tab.id;$('rightContent').appendChild(pane);panes.set(tab.id,pane);initPane(tab,pane);}
    pane.hidden=false;
    $('browserAddressBar').hidden=tab.type!=='browser';
    if(tab.type==='browser'){
      if(document.activeElement!==$('browserAddress'))$('browserAddress').value=tab.url||'';
      const state=browserState.tabs.find(s=>s.id===tab.id)||{};
      $('browserBack').disabled=!state.canBack;$('browserForward').disabled=!state.canForward;
      $('bookmarkPage').disabled=!tab.url;
      $('bookmarkPage').classList.toggle('bookmarked',browserState.bookmarks.some(b=>b.url===tab.url));
      $('browserReload').classList.toggle('loading',!!state.loading);
      if(tab.url&&!openedBrowsers.has(tab.id)&&nativeAvailable()){openedBrowsers.add(tab.id);native('navigate',{tabId:tab.id,url:tab.url});}
      renderBrowserPane(tab,pane);
    } else if(tab.type==='temporary')window.ShiYanV22?.renderTemporaryPane(tab,pane);
    else if(tab.type==='execution')window.ShiYanExecution?.renderPane(tab,pane);
    else if(['history','bookmarks','downloads','settings'].includes(tab.type))renderManager(tab,pane);
    v2?.decorateTabs();
    requestAnimationFrame(()=>{$('workspaceTabs').querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});fitTerminals();scheduleNative();});
  }
  function initPane(tab,pane) {
    if(tab.type==='temporary'){window.ShiYanV22?.renderTemporaryPane(tab,pane);return;}
    if(tab.type==='execution'){window.ShiYanExecution?.renderPane(tab,pane);return;}
    if(tab.type==='changes'){window.ShiYanChanges?.renderPane(tab,pane);return;}
    if(v2 && ['files','file'].includes(tab.type)){v2.initFile(tab,pane);return;}
    if(tab.type==='browser')renderBrowserPane(tab,pane);
    else if(tab.type==='files')renderFiles(tab,pane);
    else if(tab.type==='file')readFileTab(tab,pane);
    else if(tab.type==='terminal'){
      pane.classList.add('terminal-pane');
      pane.innerHTML=`<div class="terminal-heading"><span>${esc(projects.find(p=>p.id===tab.projectId)?.name||'本地终端')}</span><span class="terminal-status">未启动</span></div><div class="terminal-host"></div><div class="terminal-launch"><button class="wb-primary" type="button">启动终端</button></div>`;
      pane.querySelector('.terminal-launch button').onclick=()=>startTerminal(tab).catch(e=>notify(e.message));
      v2?.decorateTerminal(tab,pane);
    } else renderManager(tab,pane);
  }
  function renderBrowserPane(tab,pane) {
    const state=browserState.tabs.find(s=>s.id===tab.id)||{};
    if(tab.url){
      const error=state.error||(!nativeAvailable()?'网页标签请在拾燕桌面应用中打开':'');
      if(pane.dataset.mode!==`page:${error}`){pane.dataset.mode=`page:${error}`;pane.innerHTML=error?`<div class="browser-error">${icon('globe')}<h3>网页暂时无法打开</h3><p>${esc(error)}</p><button type="button" class="wb-secondary" data-browser-retry>重试</button></div>`:'';}
      return;
    }
    if(pane.dataset.mode==='start')return;pane.dataset.mode='start';
    pane.innerHTML=`<div class="browser-start"><h3>工具</h3><div class="browser-tool-grid"><button type="button" data-workspace-tool="files">${icon('folder')}<span>文件</span><kbd>⌘O</kbd></button><div class="v21-terminal-tool"><button type="button" data-workspace-tool="terminal">${icon('terminal')}<span>终端</span></button><button type="button" data-tool-terminal-more aria-label="终端更多选项" title="终端更多">${icon('more')}</button></div><button type="button" data-workspace-temporary>${icon('newChat')}<span>临时聊天</span></button><button type="button" data-workspace-tool="execution">${icon('execution')}<span>执行过程</span></button></div><h3>浏览器</h3><div class="browser-shortcuts"><button type="button" data-workspace-tool="history">${icon('history')}<span>历史记录</span></button><button type="button" data-workspace-tool="bookmarks">${icon('star')}<span>书签</span></button><button type="button" data-workspace-tool="downloads">${icon('download')}<span>下载</span></button><button type="button" data-workspace-tool="settings">${icon('settings')}<span>设置</span></button></div></div>`;
  }
  function renderManager(tab,pane) {
    if(tab.type==='settings'){
      pane.innerHTML=`<div class="browser-manager"><h2>浏览器设置</h2><div class="manager-tool-links"><button data-workspace-tool="files">${icon('folder')}文件</button><button data-workspace-tool="terminal">${icon('terminal')}终端</button><button data-workspace-tool="history">${icon('history')}历史记录</button><button data-workspace-tool="bookmarks">${icon('star')}书签</button><button data-workspace-tool="downloads">${icon('download')}下载</button></div>
        <label class="settings-row">默认搜索引擎<select id="searchEngineSelect"><option value="bing">Bing</option><option value="baidu">百度</option><option value="duckduckgo">DuckDuckGo</option></select></label>
        <div class="settings-row"><span>浏览记录</span><button class="wb-secondary" data-clear-history>清除历史记录</button></div><div class="settings-row"><span>网站数据</span><button class="wb-secondary" data-clear-browser-data>清除 Cookie 和缓存</button></div>
        <p class="settings-note">浏览器记录、聊天记录、图片历史分开保存。</p></div>`;
      $('searchEngineSelect').value=browserState.searchEngine||'bing';
      $('searchEngineSelect').onchange=e=>native('searchEngine',{value:e.target.value});
      return;
    }
    const rows=browserState[tab.type]||[], title={history:'浏览历史',bookmarks:'书签',downloads:'下载记录'}[tab.type];
    pane.innerHTML=`<div class="browser-manager"><header><h2>${title}</h2>${tab.type==='history'?'<button type="button" class="wb-text-button" data-clear-history>清除</button>':tab.type==='downloads'?'<button type="button" class="wb-text-button" data-clear-downloads>清除记录</button>':''}</header>
      ${rows.length?rows.map(row=>tab.type==='downloads'?`<div class="browser-list-item"><div>${icon('download')}<span><strong>${esc(row.name)}</strong><small>${esc(({downloading:'正在下载',completed:'已完成',failed:'下载失败',interrupted:'已中断'})[row.status]||row.status)}</small></span></div>${row.status==='completed'?`<button class="wb-text-button" type="button" data-reveal-download="${esc(row.id)}">在 Finder 中显示</button>`:''}</div>`:`<div class="browser-list-item"><button class="browser-history-link" type="button" data-open-url="${esc(row.url)}">${icon(tab.type==='bookmarks'?'star':'globe')}<span><strong>${esc(row.title||row.url)}</strong><small>${esc(row.url)}</small></span></button>${tab.type==='bookmarks'?`<button class="wb-icon-button" type="button" data-delete-bookmark="${esc(row.url)}" aria-label="删除书签">${icon('close')}</button>`:''}</div>`).join(''):`<p class="wb-empty">暂无${title}</p>`}</div>`;
  }
  async function renderFiles(tab,pane) {
    pane.innerHTML=`<div class="files-toolbar"><span>文件</span><span class="toolbar-spacer"></span><button class="wb-text-button" type="button" data-open-file>打开文件</button><button class="wb-text-button" type="button" data-open-project>打开项目</button></div><div class="file-tree"></div>`;
    const tree=pane.querySelector('.file-tree');
    const project=projects.find(p=>p.id===(tab.projectId||prefs.selectedProjectId));
    if(!project){tree.innerHTML='<div class="wb-empty">选择项目后浏览文件。<button type="button" class="wb-text-button" data-open-project>打开本地项目</button></div>';return;}
    tab.projectId=project.id;
    const heading=document.createElement('div');heading.className='tree-project';heading.textContent=project.name;heading.title=project.path;tree.appendChild(heading);
    const root=document.createElement('div');tree.appendChild(root);
    try{await loadDirectory(root,project.id,'');}catch(e){root.innerHTML=`<p class="wb-error">${esc(e.message)}</p>`;}
  }
  async function loadDirectory(container,projectId,path) {
    const result=await api('/directory?projectId='+encodeURIComponent(projectId)+'&path='+encodeURIComponent(path));
    container.innerHTML='';
    for(const entry of result.entries){
      const node=document.createElement('div');node.className='tree-node';
      const b=document.createElement('button');b.type='button';b.className='file-tree-row';b.title=entry.blocked?'此链接位于项目之外':entry.path;b.disabled=entry.blocked;
      b.innerHTML=(entry.directory?icon('forward','tree-chevron'):'<span class="tree-indent"></span>')+icon(entry.directory?'folder':'file')+`<span>${esc(entry.name)}</span>`;
      node.appendChild(b);container.appendChild(node);
      if(entry.directory){const child=document.createElement('div');child.className='tree-children';child.hidden=true;node.appendChild(child);let loaded=false;b.onclick=async()=>{child.hidden=!child.hidden;b.classList.toggle('expanded',!child.hidden);if(!child.hidden&&!loaded){try{await loadDirectory(child,projectId,entry.path);loaded=true;}catch(e){child.innerHTML=`<p class="wb-error">${esc(e.message)}</p>`;}}};}
      else b.onclick=()=>openTab({type:'file',title:entry.name,projectId,path:entry.path},true);
    }
    if(result.truncated){const p=document.createElement('p');p.className='wb-empty';p.textContent='此目录仅显示前 600 项。';container.appendChild(p);}
    if(!result.entries.length)container.innerHTML='<p class="wb-empty tree-empty">空目录</p>';
  }
  function highlight(source) {
    const rx=/(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|async|await|return|if|else|for|while|class|import|from|export|default|def|self|try|except|catch|throw|new|public|private|static|void|int|String|struct|enum|final|guard|case|switch|break|continue|in|of|true|false|None|null|True|False)\b|\b\d+(?:\.\d+)?\b)/g;
    let out='',index=0;for(const match of source.matchAll(rx)){out+=esc(source.slice(index,match.index));const t=match[0],kind=/^(\/\/|\/\*|#)/.test(t)?'comment':/^['"`]/.test(t)?'string':/^\d/.test(t)?'number':'keyword';out+=`<span class="syntax-${kind}">${esc(t)}</span>`;index=match.index+t.length;}
    return out+esc(source.slice(index));
  }
  async function readFileTab(tab,pane) {
    pane.innerHTML='<p class="wb-empty">正在读取文件…</p>';
    try{
      const {file}=await api('/files/read','POST',tab.fileId?{fileId:tab.fileId}:{projectId:tab.projectId,path:tab.path});
      displayFile(tab,pane,file);
    }catch(e){pane.innerHTML=`<p class="wb-error file-error">${esc(e.message)}</p>`;}
  }
  function displayFile(tab,pane,file) {
    tab.title=file.name;tab.file=file;
    pane.innerHTML=`<div class="file-preview-toolbar"><span title="${esc(file.path)}">${esc(file.name)}</span><span class="toolbar-spacer"></span>${file.kind==='text'?'<button type="button" class="wb-text-button" data-copy-file>复制</button><button type="button" class="wb-text-button" data-context-file>加入对话</button>':''}</div>`;
    if(file.kind==='image'){pane.insertAdjacentHTML('beforeend',`<div class="file-image-stage"><img alt="${esc(file.name)}" src="${esc(file.dataUrl)}"></div>`);}
    else if(file.kind==='text'){
      const lines=file.text.split('\n'),limited=lines.slice(0,4000),code=document.createElement('div');code.className='code-reader';
      code.innerHTML=`<pre class="line-numbers" aria-hidden="true">${limited.map((_,i)=>i+1).join('\n')}</pre><pre class="source-code"><code>${highlight(limited.join('\n'))}</code></pre>`;pane.appendChild(code);
      if(lines.length>4000)pane.insertAdjacentHTML('beforeend','<p class="file-preview-note">预览前 4000 行；复制按钮可复制完整已读取文本。</p>');
      pane.querySelector('[data-copy-file]').onclick=()=>window.shiyan.copyText(file.text);
      const context=pane.querySelector('[data-context-file]');context.disabled=!!file.sensitive;context.title=file.sensitive?'可能含凭证，不能直接加入云端对话':'把文件内容加入草稿，由你确认后发送';
      context.onclick=async()=>{
        const max=30000,text=file.text.slice(0,max);await window.shiyan.addContext(`参考文件：${file.path}\n\n\`\`\`${file.language||''}\n${text}\n\`\`\`${file.text.length>max?'\n（内容较长，只加入前 30000 字符）':''}`);
        notify('文件内容已加入草稿，尚未发送');
      };
    } else pane.insertAdjacentHTML('beforeend',`<p class="wb-empty">${esc(file.message||'暂不支持预览此文件')}</p>`);
     
    const label=$('workspaceTabs').querySelector(`[data-tab="${tab.id}"] > span`);if(label)label.textContent=file.name;persist();
  }
  async function chooseFile() {
    if(v2)return v2.chooseFile();
    const selected=await pick('chooseFile');if(!selected||selected.cancelled)return;
    const {file}=await api('/files/open','POST',{path:selected.path});
    const tab=openTab({type:'file',title:file.name,path:file.path,fileId:file.fileId},true);
    if(tab)displayFile(tab,panes.get(tab.id),file);
  }
  async function startTerminal(tab) {
    let session=sessions.get(tab.id);if(session?.sessionId&&!session.exited)return;
    if(!window.Terminal||!window.FitAddon)throw Error('终端组件未加载，请重新打开应用');
    const pane=panes.get(tab.id);pane.querySelector('.terminal-launch').hidden=true;
    const status=pane.querySelector('.terminal-status');status.textContent='正在连接';
    let terminal;try{({terminal}=await api('/terminals','POST',{projectId:tab.projectId||null,tabId:tab.id,...(tab.cwd?{cwd:tab.cwd}:{})}));}catch(error){pane.querySelector('.terminal-launch').hidden=false;status.textContent='连接失败';throw error;}
    if(session){session.term?.dispose();session.observer?.disconnect();}
    const host=pane.querySelector('.terminal-host');host.innerHTML='';
    const term=new Terminal({cursorBlink:true,fontFamily:'SFMono-Regular, Menlo, monospace',fontSize:13,scrollback:3000,theme:window.ShiYanV22.terminalTheme(),allowProposedApi:false});
    const fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(host);
    const controller=new AbortController();session={term,fit,controller,sessionId:terminal.id,pid:terminal.pid,cwd:terminal.cwd,exited:false,writeQueue:Promise.resolve(),input:''};sessions.set(tab.id,session);
    term.parser.registerOscHandler(7,value=>{try{const url=new URL(value);if(url.protocol==='file:'){session.cwd=decodeURIComponent(url.pathname);tab.cwd=session.cwd;status.title=session.cwd;window.dispatchEvent(new CustomEvent('shiyan-terminal'));persist();}}catch(_){}return true;});
    tab.cwd=terminal.cwd;status.textContent='已连接';status.title=terminal.cwd;
    window.dispatchEvent(new CustomEvent('shiyan-terminal',{detail:{tabId:tab.id}}));
    term.onData(data=>{session.input+=data;if(!session.inputTimer)session.inputTimer=setTimeout(()=>{session.inputTimer=null;const input=session.input;session.input='';session.writeQueue=session.writeQueue.then(()=>api('/terminals/'+session.sessionId+'/input','POST',{data:input})).catch(e=>{status.textContent=e.message;});},12);});
    term.onResize(({cols,rows})=>{if(!session.exited)api('/terminals/'+session.sessionId+'/resize','POST',{cols:Math.max(20,Math.min(500,cols)),rows:Math.max(5,Math.min(200,rows))}).catch(()=>{});});
    session.observer=new ResizeObserver(()=>{if(!pane.hidden&&!$('rightWorkspace').hidden)try{fit.fit();}catch(_){}});session.observer.observe(host);
    requestAnimationFrame(()=>{try{fit.fit();term.focus();}catch(_){}});
    readTerminal(session,status,pane).catch(e=>{if(e.name!=='AbortError'){status.textContent='连接中断';notify('终端连接中断：'+e.message);}});
  }
  async function readTerminal(session,status,pane) {
    const response=await fetch('/api/workspace/terminals/'+session.sessionId+'/events',{headers:{'X-Shiyan-Workspace':token},signal:session.controller.signal});
    if(!response.ok)throw Error('终端订阅被拒绝 ('+response.status+')');
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
    while(true){
      const {done,value}=await reader.read();if(done)break;
      pending+=decoder.decode(value,{stream:true});let end;
      while((end=pending.indexOf('\n\n'))>=0){
        const block=pending.slice(0,end);pending=pending.slice(end+2);const line=block.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;
        const item=JSON.parse(line.slice(6));
        if(item.type==='data'){const bytes=Uint8Array.from(atob(item.data),c=>c.charCodeAt(0));await new Promise(resolve=>session.term.write(bytes,resolve));}
        else if(item.type==='exit'){session.exited=true;session.term.options.disableStdin=true;status.textContent='已退出'+(item.code!=null?' · '+item.code:'');pane.querySelector('.terminal-launch').hidden=false;}
      }
    }
    if(!session.exited&&!session.controller.signal.aborted){session.exited=true;status.textContent='连接已结束';pane.querySelector('.terminal-launch').hidden=false;}
  }
  function fitTerminals(){if(v2)return v2.fitTerminals();for(const[id,s]of sessions){if(id===activeTab&&!$('rightWorkspace').hidden)requestAnimationFrame(()=>{try{s.fit.fit();}catch(_){}});}}
  let chatSearchModal=null,chatSearchOrigin=null,chatSearchComposing=false;
  function closeChatSearch(restore=true){
    if(!chatSearchModal)return;
    chatSearchModal.hidden=true;
    $('sidebarSearch').setAttribute('aria-expanded','false');
    scheduleNative();
    if(restore&&chatSearchOrigin?.isConnected)chatSearchOrigin.focus({preventScroll:true});
  }
  function renderChatSearch(){
    if(!chatSearchModal||chatSearchModal.hidden||chatSearchComposing)return;
    const term=$('wbChatSearchInput').value.trim().toLocaleLowerCase();
    const all=window.shiyan.getState()?.conversations||[];
    const matches=all.filter(c=>(c.messages||[]).some(m=>m.role==='user') && (!term||[c.title,projects.find(p=>p.id===c.projectId)?.name,...(c.messages||[]).map(m=>m.text)].some(v=>String(v||'').toLocaleLowerCase().includes(term))))
      .sort((a,b)=>new Date(b.lastOpenedAt||b.updatedAt||0)-new Date(a.lastOpenedAt||a.updatedAt||0));
    const results=matches.slice(0,term?50:12);
    $('wbChatSearchResults').innerHTML=results.length?results.map(c=>{
      const project=projects.find(p=>p.id===c.projectId);
      return `<button type="button" class="wb-chat-search-row" data-chat-search-id="${esc(c.id)}"><span class="wb-chat-search-title">${esc(c.title||'新聊天')}</span><span class="wb-chat-search-project" title="${esc(project?.name||'')}">${esc(project?.name||'')}</span></button>`;
    }).join(''):`<p class="wb-chat-search-empty">${term?'没有找到相关聊天':'还没有聊天记录'}</p>`;
  }
  function openChatSearch(){
    if(!chatSearchModal){
      chatSearchModal=document.createElement('div');chatSearchModal.id='wbChatSearch';chatSearchModal.className='wb-modal';chatSearchModal.hidden=true;
      chatSearchModal.innerHTML='<section class="wb-chat-search-card" role="dialog" aria-modal="true" aria-label="搜索聊天"><input id="wbChatSearchInput" type="search" placeholder="搜索聊天" aria-label="搜索聊天" autocomplete="off" spellcheck="false"><h3>聊天</h3><div id="wbChatSearchResults"></div></section>';
      document.body.appendChild(chatSearchModal);
      const input=$('wbChatSearchInput');input.addEventListener('input',renderChatSearch);
      input.addEventListener('compositionstart',()=>{chatSearchComposing=true});
      input.addEventListener('compositionend',()=>{chatSearchComposing=false;renderChatSearch()});
      chatSearchModal.addEventListener('click',async e=>{
        if(e.target===chatSearchModal){closeChatSearch();return;}
        const row=e.target.closest('[data-chat-search-id]');if(!row||row.disabled)return;
        row.disabled=true;
        try{await window.shiyan.selectConversation(row.dataset.chatSearchId);closeChatSearch(false);}
        catch(error){window.shiyan.toast(error.message);if(row.isConnected)row.disabled=false;}
      });
      chatSearchModal.addEventListener('keydown',e=>{
        if(e.isComposing||e.keyCode===229)return;
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeChatSearch();return;}
        if(e.key==='Tab'){
          const controls=[input,...chatSearchModal.querySelectorAll('button:not(:disabled)')];
          const first=controls[0],last=controls[controls.length-1];
          if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
          else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
        }
      });
      window.addEventListener('shiyan-state',renderChatSearch);
    }
    chatSearchOrigin=document.activeElement;chatSearchComposing=false;
    chatSearchModal.hidden=false;$('wbChatSearchInput').value='';
    $('sidebarSearch').setAttribute('aria-expanded','true');renderChatSearch();scheduleNative();
    $('wbChatSearchInput').focus({preventScroll:true});
  }
  function workspaceTool(type) {
    if(type==='execution'){window.ShiYanExecution?.openLatest();return;}
    const title={files:'文件',terminal:'终端',history:'浏览历史',bookmarks:'书签',downloads:'下载记录',settings:'浏览器设置'}[type];
    const tab=openTab({type,title,projectId:['files','terminal'].includes(type)?prefs.selectedProjectId||undefined:undefined},type!=='terminal');
    if(type==='terminal'&&tab)startTerminal(tab).catch(e=>notify(e.message));
  }
  function bind() {
    $('railHome').onclick=()=>window.shiyan.navigate('agent');
    $('railEnhance').onclick=()=>window.shiyan.navigate('home');
    $('railHistory').onclick=()=>window.shiyan.showHistory();
    $('sidebarSearch').setAttribute('aria-haspopup','dialog');$('sidebarSearch').setAttribute('aria-expanded','false');$('sidebarSearch').onclick=openChatSearch;
    $('toggleLeftSidebar').onclick=()=>{
      if(window.innerWidth<1140){
        if(!$('leftContainer').hidden)prefs.leftOpen=false;
        else {prefs.leftOpen=true;compactPane='left';}
      }else prefs.leftOpen=!prefs.leftOpen;
      layout();persist();
    };
    $('toggleRightWorkspace').onclick=()=>{
      if(window.innerWidth<1140){
        if(!$('rightWorkspace').hidden){prefs.rightOpen=false;compactPane='left';}
        else {prefs.rightOpen=true;compactPane='right';}
      }else prefs.rightOpen=!prefs.rightOpen;
      layout();persist();
    };
    for(const[name,id]of Object.entries({pinned:'pinnedGroup',projects:'projectsGroup',recent:'recentGroup'}))$(id).addEventListener('toggle',()=>{prefs.groups={...prefs.groups,[name]:$(id).open};persist();});
    $('addProjectButton').onclick=e=>{e.preventDefault();e.stopPropagation();projectDialog(false);};
    $('cancelProject').onclick=()=>{$('workbenchModal').hidden=true;scheduleNative();};
    $('importProjectMode').onclick=()=>setProjectMode(false);$('createProjectMode').onclick=()=>setProjectMode(true);
    $('chooseProjectDirectory').onclick=async()=>{try{const result=await pick('chooseDirectory',$('projectPath').value);if(result&&!result.cancelled){$('projectPath').value=result.path;if(!$('projectName').value&&!createProject)$('projectName').value=result.path.split('/').filter(Boolean).pop();}}catch(e){notify(e.message);}};
    $('projectForm').onsubmit=async e=>{
      e.preventDefault();$('submitProject').disabled=true;$('projectFormError').hidden=true;
      try{const result=await api('/projects','POST',{name:$('projectName').value,path:$('projectPath').value,create:createProject});projects=result.projects;renderProjects();$('workbenchModal').hidden=true;await selectProject(result.project.id);}
      catch(error){$('projectFormError').textContent=error.message;$('projectFormError').hidden=false;}
      finally{$('submitProject').disabled=false;scheduleNative();}
    };
    $('projectList').onclick=e=>{const p=e.target.closest('[data-project]');if(p)selectProject(p.dataset.project).catch(error=>notify(error.message));};
    $('addWorkspaceTab').onclick=()=>openTab();
    $('workspaceTabs').onclick=e=>{const close=e.target.closest('[data-close-tab]');if(close){e.stopPropagation();closeTab(close.dataset.closeTab);return;}const t=e.target.closest('[data-tab]');if(t)selectTab(t.dataset.tab);};
    $('workspaceTabs').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){const t=e.target.closest('[data-tab]');if(t){e.preventDefault();selectTab(t.dataset.tab);}}};
    $('addressForm').onsubmit=e=>{e.preventDefault();try{const t=tabs.find(t=>t.id===activeTab);if(t?.type!=='browser')return;const url=normalizeAddress($('browserAddress').value);if(!url)return;t.url=url;t.title=new URL(url).hostname;openedBrowsers.add(t.id);native('navigate',{tabId:t.id,url});renderTabs();persist();}catch(error){notify(error.message);}};
    $('browserBack').onclick=()=>native('back',{tabId:activeTab});$('browserForward').onclick=()=>native('forward',{tabId:activeTab});
    $('browserReload').onclick=()=>{const tab=tabs.find(t=>t.id===activeTab);native('reload',{tabId:activeTab,url:tab?.url});};
    $('browserTools').onclick=()=>workspaceTool('settings');
    $('bookmarkPage').onclick=()=>{const t=tabs.find(t=>t.id===activeTab);if(t?.url)native('bookmark',{url:t.url,title:t.title});};
    $('rightContent').addEventListener('click',async e=>{
      const b=e.target.closest('button');if(!b)return;
      try{
        if(b.dataset.workspaceTool)workspaceTool(b.dataset.workspaceTool);
        else if(b.hasAttribute('data-open-file'))await chooseFile();
        else if(b.hasAttribute('data-open-project'))projectDialog(false);
        else if(b.dataset.openUrl)openTab({type:'browser',title:'网页',url:b.dataset.openUrl});
        else if(b.dataset.deleteBookmark)native('bookmark',{url:b.dataset.deleteBookmark});
        else if(b.dataset.revealDownload)native('revealDownload',{downloadId:b.dataset.revealDownload});
        else if(b.hasAttribute('data-browser-retry')){$('browserReload').click();}
        else if(b.hasAttribute('data-clear-history')){if(await window.shiyan.confirmAction('清除浏览历史？','只清除浏览器记录，不影响聊天记录或图片作品。','清除'))native('clearHistory');}
        else if(b.hasAttribute('data-clear-downloads')){if(await window.shiyan.confirmAction('清除下载记录？','已保存的文件不会被删除。','清除'))native('clearDownloads');}
        else if(b.hasAttribute('data-clear-browser-data')){if(await window.shiyan.confirmAction('清除网站数据？','会清除浏览器 Cookie 和缓存，网站可能需要重新登录。','清除'))native('clearWebsiteData');}
      }catch(error){notify(error.message);}
    });
    window.addEventListener('shiyan-state',e=>renderState(e.detail));
    window.addEventListener('shiyan-view',()=>renderState(window.shiyan?.getState()));
    document.addEventListener('click',event=>{
      const link=event.target.closest?.('#dotsView a.message-reference[href]');
      if(!link||event.defaultPrevented||event.button>0)return;
      let url;try{url=new URL(link.getAttribute('href'),location.href);}catch{return;}
      if(!['http:','https:'].includes(url.protocol))return;
      // Web browsers: let the anchor (target=_blank) open in the user's own browser. The right toolbar is desktop-only.
      if(!window.webkit?.messageHandlers?.native)return;
      // Route Dots links directly; do not depend on WKWebView target=_blank forwarding.
      event.preventDefault();
      openTab({type:'browser',title:url.hostname,url:url.href});
    });
    window.addEventListener('shiyan-native',event=>{
      const d=event.detail||{};
      if(d.type==='workspacePicked'){pickerRequests.get(d.id)?.(d);pickerRequests.delete(d.id);scheduleNative();}
      else if(d.type==='workbenchNotice')notify(d.message);
      else if(d.type==='browserNewTab')openTab({type:'browser',title:'网页',url:d.url});
      else if(d.type==='browserState'){
        browserState=d;
        for(const b of d.tabs||[]){const t=tabs.find(t=>t.id===b.id);if(t&&t.type==='browser'){if(b.url)t.url=b.url;if(b.title)t.title=b.title;}}
        renderTabs();persist();
      }
    });
    new MutationObserver(scheduleNative).observe($('app'),{attributes:true,subtree:true,attributeFilter:['hidden']});
    window.addEventListener('resize',layout);
    for(const[id,which]of [['leftResizeHandle','left'],['rightResizeHandle','right']]){
      let drag=null;const handle=$(id);
      handle.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,value:prefs[which+'Width']};handle.setPointerCapture(e.pointerId);document.body.classList.add('resizing-workbench');};
      handle.onpointermove=e=>{if(!drag)return;const amount=(e.clientX-drag.x)*(which==='right'?-1:1);prefs[which+'Width']=Math.max(which==='left'?210:280,Math.min(which==='left'?350:900,drag.value+amount));layout();};
      handle.onpointerup=handle.onpointercancel=()=>{if(drag){drag=null;document.body.classList.remove('resizing-workbench');persist();}};
    }
    document.addEventListener('keydown',e=>{
      if(!rightWorkspaceEnabled&&(e.metaKey||e.ctrlKey)&&['o','l'].includes(e.key.toLowerCase()))return;
      if((e.metaKey||e.ctrlKey)&&!e.altKey&&e.key.toLowerCase()==='o'){e.preventDefault();e.stopImmediatePropagation();workspaceTool('files');return;}
      if((e.metaKey||e.ctrlKey)&&!e.altKey&&e.key.toLowerCase()==='o'){e.preventDefault();e.stopImmediatePropagation();workspaceTool('files');return;}
      if(e.key==='Escape'&&!$('workbenchModal').hidden){e.preventDefault();e.stopImmediatePropagation();$('workbenchModal').hidden=true;scheduleNative();}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='l'&&prefs.rightOpen){e.preventDefault();if(tabs.find(t=>t.id===activeTab)?.type!=='browser')openTab();$('browserAddress').focus();$('browserAddress').select();}
    },true);
    window.addEventListener('pagehide',()=>{
      for(const session of sessions.values())if(session.sessionId)fetch('/api/workspace/terminals/'+session.sessionId,{method:'DELETE',headers:{'X-Shiyan-Local':'1','X-Shiyan-Workspace':token},keepalive:true}).catch(()=>{});
    });
  }
  async function start() {
    createShell();bind();
    v2=window.ShiYanV2.install({
      rightWorkspaceEnabled,
      get prefs(){return prefs;},get projects(){return projects;},get tabs(){return tabs;},
      get activeTab(){return activeTab;},get browserState(){return browserState;},
      get defaultDirectory(){return defaultDirectory;},get ready(){return ready;},
      panes,sessions,icon,toolbarIcon,api,native,nativeAvailable,persist,scheduleNative,
      selectProject,openTab,selectTab,closeTab,renderTabs,startTerminal,workspaceTool,highlight,pick,
      setActiveId:value=>{activeTab=value;},setProjects:value=>{projects=value;}
    });
    layout();
    window.workbench={get ready(){return ready&&!!v2?.inspect().booted;},selectedProjectId:()=>prefs.selectedProjectId||null,openTool:workspaceTool,openAsset:asset=>v2.openAsset(asset),
      refreshOverlays:scheduleNative,revealConversationProject:(id,projectId)=>{if(window.shiyan.getState()?.selectedConversationId===id){prefs.selectedProjectId=projectId;persist();}v2?.revealConversationProject(projectId);},
      getLayout:()=>({...v2?.inspect(),leftOpen:prefs.leftOpen,rightOpen:prefs.rightOpen,groups:{...prefs.groups},tabCount:tabs.length,activeTab,nativeBrowser:nativeAvailable(),projects:projects.map(p=>({id:p.id,name:p.name,path:p.path})),terminals:[...sessions.values()].map(s=>({id:s.sessionId,pid:s.pid,exited:!!s.exited})),rects:Object.fromEntries(['activityRail','leftContainer','mainWorkspace','rightWorkspace'].map(id=>{const r=$(id).getBoundingClientRect();return[id,{x:r.x,y:r.y,width:r.width,height:r.height}];}))})};
    try{
      const data=await api('/bootstrap','POST',{});token=data.token;projects=data.projects||[];defaultDirectory=data.defaultDirectory;
      prefs={...prefs,...data.preferences,groups:{...prefs.groups,...data.preferences?.groups}};
      prefs.rightOpen=false; // 每次打开都不显示右侧工作区，需要时再展开。
      // Apply the web sidebar width before rendering restored tabs or layout.
      if(window.ShiYanPlatform?.mode==='web')prefs.leftWidth=248;
       
      if(Number(data.preferences?.rightWidth)===590){prefs.rightWidth=460;persist();}
      tabs=(data.preferences?.tabs||[]).filter(t=>t.id&&t.type&&t.type!=='temporary').map(t=>({...t}));
      activeTab=data.preferences?.activeTab||tabs[0]?.id||'';
      ready=true;loading=false;lastSelected='';
      for(const[name,id]of Object.entries({pinned:'pinnedGroup',projects:'projectsGroup',recent:'recentGroup'}))$(id).open=prefs.groups[name]!==false;
      if(!tabs.length){if(rightWorkspaceEnabled&&prefs.rightOpen)openTab();else renderTabs();}else{if(!tabs.some(t=>t.id===activeTab))activeTab=tabs[0].id;renderTabs();}
      if(window.innerWidth<1140)compactPane='left';
      renderState(window.shiyan?.getState());await v2?.afterBoot();layout();native('state');
    }catch(error){notify(error.message);$('rightContent').innerHTML=`<p class="wb-error">${esc(error.message)}</p>`;}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
