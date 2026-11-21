 
(() => {
 'use strict';
 const $=(id: string): any=>document.getElementById(id);
 const esc=v=>String(v??'').replace(/[&<>"']/g,x=>(({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string, string>)[x] || ''));
 const extraPaths={
  archive:'M3 8h18v13H3zM3 8V4h7l3 4M12 8v13M10 11h4M10 15h4M10 19h4',
  gallery:'M3 4h8v8H3zM14 4h7v8h-7zM3 15h8v5H3zM14 15h7v5h-7z',
  folderOpen:'M2 8h7l2 2h10l-2 10H2zM3 8V5h6l2 2h8v3',
  spark:'M12 3l2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3ZM20 2v5M17.5 4.5h5',
  addPanel:'M4 4h16v16H4ZM12 8v8M8 12h8',book:'M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15',
  expand:'M14 6h4v4M6 14v4h4',
  contract:'M18 10h-4V6M6 14h4v4',
  folders:'M3 8h6l2 2h8v11H3ZM7 5V2h6l2 2h7v12h-2',image:'M3 3h18v18H3ZM3 17l6-7 5 5 3-3 4 5M18 7h.01',
  check:'m5 12 4 4L19 6',zoom:'M15 15l6 6M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM10 6v8M6 10h8',
  dock:'M3 3h18v18H3Zm0 12h18',undock:'M3 3h18v18H3Zm10 0v18',editor:'M9 7l-5 5 5 5m6-10 5 5-5 5',
  share:'M12 16V2m-5 5 5-5 5 5M5 11H3v10h18V11h-2',trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7'
 };
 function install(C){
  const rightWorkspaceEnabled=C.rightWorkspaceEnabled!==false;
  const S={full:false,compactSide:'left',compact:false,bottomId: null as any,bottomIds: [] as any[],bottomShown:false,booted:false,bottomHeight:230,menuCallbacks:new Map(),closedProjects:new Set(),spaceSelection:new Set(),spaceQuery:'',spaceColumns:0,lastSpaceSignature:'',photoSignature:'',compare:{zoom:1,x:0,y:0},overlayCompare:false,files:new Map(),animationUntil:0,animationFrame:0,dragging: null as any,lastView:'agent',spaceSidebarOpen:true,enhanceSidebarOpen:true,lastEnhanceSignature:'',photoInput: null as any, photoOutput: null as any,nativeLayoutSignature:'', bindingProjectId: null as any, lastConversationId: null as any, addTab: null as any, reasoningAnchorGeometry: null as any, photoError:'', enhanceQuery:'', enhanceCollapsed: null as any, spaceSelecting:false};
  function icon(name){if(['rename','pin','unpin','project'].includes(name))return window.shiyan.sessionMenuIcon(name);if(name==="folderOpen")return C.icon(name);return extraPaths[name]?`<svg class="wb-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${extraPaths[name]}"></path></svg>`:C.icon(name);}
  const button=(id,name,label,cls='')=>`<button type="button" ${id?'id="'+id+'"':''} class="wb-icon-button ${cls}" aria-label="${esc(label)}" title="${esc(label)}">${['spaceSearchToggle','enhanceSearchToggle'].includes(id)?C.toolbarIcon('search'):icon(name)}</button>`;
  const action=(label: any, run: any, name?: any)=>({label,run,icon:name});
  const state=()=>window.shiyan?.getState();
  const isCoding=()=>['agent','search','dots'].includes(window.shiyan?.getView()||'agent');
  const isVisible=el=>!!el&&!el.hidden&&el.getBoundingClientRect().width>1&&el.getBoundingClientRect().height>1;
  const notify=text=>window.shiyan?.toast(String(text));
  const handleError=e=>notify(e?.message||String(e));
  const assetURL=a=>a?.url||(a?.id?'/api/assets/'+encodeURIComponent(a.id)+'/file':'');
  const thumbnailURL=a=>a?.id?'/api/assets/'+encodeURIComponent(a.id)+'/thumbnail':assetURL(a);
  const persist=()=>C.persist();
  function closePopup(){const box=$('v2Popup');if(box){box.hidden=true;box.innerHTML='';box.classList.remove('v23-directory-popup');}S.menuCallbacks.clear();C.scheduleNative();}
  function positionPopup(box,r,width){box.style.left=Math.max(8,Math.min(r.left,innerWidth-width-8))+'px';box.style.top=Math.max(8,Math.min(r.bottom+6,innerHeight-box.getBoundingClientRect().height-8))+'px';}
  function menu(anchor,items,{width=184,html=false}={}){
   closePopup();const id=crypto.randomUUID(),handlers=new Map();
   function prepare(list){return list.map(e=>{if(e.separator)return {separator:true};const key=crypto.randomUUID();if(e.run)handlers.set(key,e.run);return {id:key,label:e.label,enabled:e.disabled!==true,checked:!!e.checked,children:e.children?prepare(e.children):undefined};});}
   const data=prepare(items);S.menuCallbacks.set(id,handlers);const r=anchor?.getBoundingClientRect()||{left:innerWidth/2,right:innerWidth/2,bottom:100};
   if(!html&&C.nativeAvailable()){C.native('menu',{menuId:id,x:Math.min(r.left,innerWidth-width-8),y:r.bottom+5,items:data});return;}
   const box=$('v2Popup');box.classList.toggle('v2-project-options',!!anchor?.matches('[data-project-more]'));box.hidden=false;box.style.width=width+'px';
   for(const item of items){if(item.separator){box.appendChild(document.createElement('hr'));continue;}const b=document.createElement('button');b.type='button';b.disabled=item.disabled===true;b.className=item.danger?'danger':'';b.innerHTML=(item.icon?icon(item.icon):'')+`<span>${esc(item.label)}</span>`+(item.checked?icon('check'):item.children?C.icon('forward'):'');
    b.onclick=async e=>{e.stopPropagation();if(item.children){menu(b,item.children,{width,html:true});return;}closePopup();try{await item.run?.();}catch(err){handleError(err);}};box.appendChild(b);}
   positionPopup(box,r,width);box.querySelector('button:not(:disabled)')?.focus({preventScroll:true});C.scheduleNative();
  }
  function animateLayout(){if(matchMedia('(prefers-reduced-motion: reduce)').matches){layout();return;}S.animationUntil=performance.now()+235;layout();if(S.animationFrame)return;const step=()=>{S.animationFrame=0;syncNative();positionReasoning();fitTerminals();if(performance.now()<S.animationUntil)S.animationFrame=requestAnimationFrame(step);};S.animationFrame=requestAnimationFrame(step);}
  function layout(){
   if(!rightWorkspaceEnabled)S.full=false;
   const width=innerWidth,height=innerHeight,rail=50,view=window.shiyan?.getView()||'agent',photo=view==='home',space=view==='history',coding=!photo&&!space;
   const compact=width<1060;if(compact&&!S.compact)S.compactSide='left';S.compact=compact;
   let showLeft=coding?!!C.prefs.leftOpen&&(!compact||S.compactSide==='left'):space?S.spaceSidebarOpen:photo&&S.enhanceSidebarOpen;
   let showRight=rightWorkspaceEnabled&&coding&&!!C.prefs.rightOpen&&(!compact||S.compactSide==='right'||S.full);
   if(S.full&&coding){showRight=true;showLeft=false;}
   const preferredLeft=Math.min(Math.max(190,Math.min(Number(C.prefs.leftWidth)||250,350)),compact?Math.max(190,width*.28):350);
   let left=showLeft?preferredLeft:0;
   let right=showRight?Math.max(240,Number(C.prefs.rightWidth)||460):0;
   if(compact&&left)left=Math.min(left,Math.max(190,width*.28));
   const centerMin=photo||space?0:S.full?0:Math.min(360,Math.max(280,width*.34));
   if(right)right=Math.min(right,Math.max(0,width-rail-left-centerMin));
   if(S.full&&coding)right=Math.max(0,width-rail-left);
   if(!S.full&&showRight&&right<220&&showLeft){left=0;showLeft=false;right=Math.min(C.prefs.rightWidth||460,width-rail-centerMin);}
   const bottom=!!S.bottomId&&S.bottomShown&&coding,bh=bottom?Math.min(Math.max(150,S.bottomHeight),Math.max(150,height*.50)):0;
   const shell=$('desktopLayout');
   shell.style.setProperty('--shiyan-sidebar-width',preferredLeft+'px');
   const titleStyle=getComputedStyle($('agentSidebar').querySelector('.sidebar-header h2'));
   shell.style.setProperty('--shiyan-sidebar-title-size',titleStyle.fontSize);
   shell.style.setProperty('--shiyan-sidebar-title-color',titleStyle.color);
   shell.dataset.rightWorkspace=String(rightWorkspaceEnabled);
   shell.dataset.view=view;shell.dataset.full=String(S.full&&coding);shell.dataset.compact=String(compact);shell.dataset.bottom=String(bottom);
   shell.classList.toggle('v2-left-open',showLeft);shell.classList.toggle('v2-right-open',showRight);shell.style.setProperty('--left-width',left+'px');shell.style.setProperty('--right-width',right+'px');shell.style.setProperty('--bottom-height',bh+'px');
   $('leftContainer').hidden=false;$('rightWorkspace').hidden=!rightWorkspaceEnabled;$('mainWorkspace').inert=S.full&&coding;$('leftContainer').inert=!showLeft;$('rightWorkspace').inert=!showRight;
   $('leftContainer').setAttribute('aria-hidden',String(!showLeft));$('rightWorkspace').setAttribute('aria-hidden',String(!showRight));
   $('agentSidebar').hidden=!coding;$('spaceSidebar').hidden=!space;if($('enhanceSidebar'))$('enhanceSidebar').hidden=!photo;$('desktopToolbar').hidden=photo||space;$('bottomTerminal').hidden=!bottom;
   const toggle=$('toggleLeftSidebar');toggle.hidden=!(coding||space||photo);toggle.style.left=(showLeft?rail+left-43:rail+11)+'px';toggle.setAttribute('aria-expanded',String(showLeft));const sidebarGlyph=showLeft?'left':'leftCollapsed';if(toggle.dataset.sidebarGlyph!==sidebarGlyph){toggle.innerHTML=C.toolbarIcon(sidebarGlyph);toggle.dataset.sidebarGlyph=sidebarGlyph;}toggle.title=toggle.ariaLabel=showLeft?'隐藏左侧栏':'显示左侧栏';
   $('toggleRightWorkspace').hidden=!rightWorkspaceEnabled||!coding;$('toggleRightWorkspace').innerHTML=C.toolbarIcon(showRight?'pane':'addPanel');$('toggleRightWorkspace').setAttribute('aria-expanded',String(showRight));$('toggleRightWorkspace').title=$('toggleRightWorkspace').ariaLabel=showRight?'隐藏右侧工作区':'打开右侧工作区';
   $('toggleFullWorkspace').hidden=!coding||!showRight;$('toggleFullWorkspace').innerHTML=C.toolbarIcon(S.full?'contract':'expand');$('toggleFullWorkspace').title=$('toggleFullWorkspace').ariaLabel=S.full?'退出完整视图':'进入完整视图';$('toggleFullWorkspace').setAttribute('aria-pressed',String(S.full));shell.classList.toggle('v2-left-visible',showLeft);
   $('leftResizeHandle').hidden=!coding||!showLeft;$('rightResizeHandle').hidden=!coding||!showRight||S.full;$('leftResizeHandle').style.left=(rail+left-5)+'px';$('rightResizeHandle').style.left=(width-right-5)+'px';$('bottomResizeHandle').hidden=!bottom;
   window.ShiYanSchedules?.layout?.();
   renderCompare();positionReasoning();C.scheduleNative();fitTerminals();
  }
  function syncNative(){
   const tab=C.tabs.find(t=>t.id===C.activeTab),pane=tab&&C.panes.get(tab.id),rect=pane?.getBoundingClientRect();
   const modal=!!document.querySelector('.modal-overlay:not([hidden]),.wb-modal:not([hidden]),.preview-overlay:not([hidden]),.v2-popup:not([hidden]),#comparePreview:not([hidden]),#v22TextEditor:not([hidden]),#v23FileChanges:not([hidden]),#sessionMenu:not([hidden]),#sessionProjectMenu:not([hidden])');
   const visible=isCoding()&&isVisible($('rightWorkspace'))&&$('rightWorkspace').getAttribute('aria-hidden')!=='true'&&tab?.type==='browser'&&!!tab.url&&!modal;
   const show={tabId:tab?.id||'',visible:!!visible,rect:rect?{x:rect.x+6,y:rect.y,width:Math.max(0,rect.width-6),height:rect.height}:undefined};
   const dividers={items:['leftResizeHandle','rightResizeHandle','bottomResizeHandle'].map(id=>{const el=$(id),r=el.getBoundingClientRect();return {id,visible:!el.hidden&&r.width>0&&r.height>0&&!modal,axis:id==='bottomResizeHandle'?'y':'x',rect:{x:r.x,y:r.y,width:r.width,height:r.height}};})};
   const signature=JSON.stringify([show,dividers]);if(S.nativeLayoutSignature===signature)return;
   C.native('show',show);C.native('dividers',dividers);S.nativeLayoutSignature=signature;
  }
  function toggleLeft(){closePopup();const shown=$('toggleLeftSidebar').getAttribute('aria-expanded')==='true';const currentView=window.shiyan?.getView();if(currentView==='history')S.spaceSidebarOpen=!shown;else if(currentView==='home')S.enhanceSidebarOpen=!shown;else C.prefs.leftOpen=!shown;S.compactSide='left';animateLayout();persist();}
  function revealRight(){if(!rightWorkspaceEnabled)return;C.prefs.rightOpen=true;S.compactSide='right';}
  function closeEmptyWorkspace(){if(C.tabs.some(t=>!S.bottomIds.includes(t.id)))return false;C.prefs.rightOpen=false;S.full=false;S.compactSide='left';return true;}
  function toggleRight(){if(!rightWorkspaceEnabled)return;closePopup();const shown=$('toggleRightWorkspace').getAttribute('aria-expanded')==='true';C.prefs.rightOpen=!shown;if(shown){S.full=false;S.compactSide='left';}else {S.compactSide='right';if(!C.tabs.some(t=>!S.bottomIds.includes(t.id)))C.openTab();}animateLayout();persist();}
  function dragStart(id,x,y){closePopup();document.getSelection()?.removeAllRanges();window.getSelection()?.removeAllRanges();S.dragging={id,x,y,left:$('leftContainer').getBoundingClientRect().width,right:$('rightWorkspace').getBoundingClientRect().width,bottom:S.bottomHeight};document.body.classList.add('v2-dragging');document.body.classList.toggle('v2-drag-y',id==='bottomResizeHandle');}
  function dragMove(x,y){const d=S.dragging;if(!d)return;const dx=x-d.x;if(d.id==='leftResizeHandle')C.prefs.leftWidth=Math.max(190,Math.min(350,d.left+dx,innerWidth-50-($('rightWorkspace').getAttribute('aria-hidden')==='false'?240:0)-280));else if(d.id==='rightResizeHandle')C.prefs.rightWidth=Math.max(240,Math.min(innerWidth-50-$('leftContainer').getBoundingClientRect().width-280,d.right-dx));else S.bottomHeight=Math.max(150,Math.min(innerHeight*.5,d.bottom-(y-d.y)));layout();}
  function dragEnd(){if(!S.dragging)return;S.dragging=null;document.body.classList.remove('v2-dragging','v2-drag-y');persist();C.scheduleNative();}
  function renderProjects(){
   const list=$('projectList');if(!list)return;const conversations=state()?.conversations||[];
   const ordered=[...C.projects].sort((a,b)=>Number(!!b.isPinned)-Number(!!a.isPinned)||new Date(a.createdAt||0).getTime()-new Date(b.createdAt||0).getTime());
   const html=ordered.map(p=>{
    const closed=S.closedProjects.has(p.id),chats=conversations.filter(c=>c.projectId===p.id && (c.messages || []).some(m=>m.role==='user')).sort((a,b)=>new Date(b.updatedAt).getTime()-new Date(a.updatedAt).getTime());
    return `<section class="project-group" data-project-group="${esc(p.id)}"><div data-project-fold="${esc(p.id)}" class="v2-project-header ${p.id===C.prefs.selectedProjectId?'selected':''}">
     <button type="button" class="v21-project-folder" data-project-fold="${esc(p.id)}" aria-expanded="${!closed}" aria-label="${closed?'展开':'收起'} ${esc(p.name)}" title="${closed?'展开项目会话':'收起项目会话'}">${icon(closed?'folder':'folderOpen')}</button>
     <button type="button" class="project-row" data-project="${esc(p.id)}" aria-expanded="${!closed}" title="${closed?'展开项目会话':'收起项目会话'} · ${esc(p.path)}"><span>${esc(p.name)}</span></button>
     <span class="v2-project-actions"><button type="button" data-project-more="${esc(p.id)}" aria-label="${esc(p.name)} 项目选项" title="项目选项">${C.toolbarIcon('more')}</button><button type="button" data-project-new="${esc(p.id)}" aria-label="在 ${esc(p.name)} 下新建会话" title="新建会话">${C.icon('plus')}</button></span></div>
     <div class="v2-project-chats" ${closed?'hidden':''}>${chats.map(c=>window.shiyan.sessionHTML(c)).join('')}</div></section>`;
   }).join('');
   if(list.innerHTML!==html)list.innerHTML=html;
  }
  async function projectNew(id){S.closedProjects.delete(id);S.full=false;await window.shiyan.newConversation(id);renderProjects();animateLayout();}
  function projectMenu(id,anchor){
   const p=C.projects.find(x=>x.id===id);if(!p)return;
   menu(anchor,[
    action(p.path?'打开项目文件':'关联 Mac 本地目录',()=>p.path?C.selectProject(id):showProjectBinding(p),'folder'),
    action(p.isPinned?'取消置顶':'置顶',async()=>{const r=await C.api('/projects/'+encodeURIComponent(id),'PATCH',{isPinned:!p.isPinned});C.setProjects(r.projects);renderProjects();},p.isPinned?'unpin':'pin'),
    action('编辑项目',()=>showProjectEditor(p),'rename'),{separator:true},
    action('移除项目',async()=>{
     if(!await window.shiyan.confirmAction('移除项目？','仅取消拾燕中的项目关联。Mac 文件夹和原有会话都会保留，相关会话移入最近。','移除'))return;
     const r=await C.api('/projects/'+encodeURIComponent(id),'DELETE');C.setProjects(r.projects);
     if(C.prefs.selectedProjectId===id)C.prefs.selectedProjectId=null;
     for(const t of [...C.tabs])if(t.projectId===id){
      if(t.type==='files'||t.type==='file')await C.closeTab(t.id);
      else t.projectId=undefined;
     }
     S.closedProjects.delete(id);renderProjects();C.persist();
    },'trash')
   ],{width:160});
  }
  function showProjectBinding(p){closePopup();S.bindingProjectId=p.id;$('workbenchModal').hidden=false;$('projectDialogTitle').textContent='关联 Mac 本地目录';$('projectName').value=p.name;$('projectName').readOnly=true;$('projectPath').value='';$('projectFormError').hidden=true;$('openProjectSubmit').textContent='关联目录';$('createProjectSubmit').hidden=true;$('projectPath').focus();C.scheduleNative();}
  function showProjectEditor(p){
   closePopup();const dialog=$('v21ProjectEditor');dialog.hidden=false;dialog.dataset.projectId=p.id;
   $('v21ProjectName').value=p.name;$('v21ProjectError').hidden=true;
   C.scheduleNative();$('v21ProjectName').focus();$('v21ProjectName').select();
  }
  function renderState(next){if(!next)return;if(S.lastConversationId!==next.selectedConversationId){S.lastConversationId=next.selectedConversationId;if(S.full){S.full=false;layout();}}renderProjects();renderSpace();renderEnhanceHistory();renderCompare();const view=window.shiyan?.getView()||'agent';if(view!==S.lastView){S.lastView=view;closePopup();layout();}$('railHistory').title=$('railHistory').ariaLabel='空间';}
  function decorateTabs(){
   const tabs=$('workspaceTabs');if(!tabs)return;tabs.after(S.addTab);
   for(const id of S.bottomIds){tabs.querySelector(`[data-tab="${id}"]`)?.setAttribute('hidden','');const pane=C.panes.get(id);if(pane)pane.hidden=id!==S.bottomId||!S.bottomShown;}
   renderBottomTabs();window.ShiYanV22?.adaptTabs(C,S.bottomIds);C.scheduleNative();
  }
  function renderBottomTabs(){
   const list=$('bottomTerminalTabs');if(!list)return;
   list.innerHTML=S.bottomIds.map(id=>{const tab=C.tabs.find(t=>t.id===id),session=C.sessions.get(id),project=C.projects.find(p=>p.id===tab?.projectId),cwd=session?.cwd||project?.path||C.defaultDirectory,label=project?.name||String(cwd||'').replace(/\/+$/,'').split('/').pop()||'终端';return `<div class="v28-bottom-tab" role="tab" tabindex="0" data-bottom-tab="${esc(id)}" aria-selected="${id===S.bottomId}" title="${esc(label)}">${icon('terminal')}<span>${esc(label)}</span><button type="button" data-close-bottom-tab="${esc(id)}" aria-label="关闭终端 ${esc(label)}" title="关闭终端">${icon('close')}</button></div>`;}).join('');
   if(S.booted){C.prefs.bottomTerminalIds=[...S.bottomIds];C.prefs.bottomTerminalId=S.bottomId;C.prefs.bottomTerminalVisible=S.bottomShown;}
  }
  async function afterBoot(){
   const savedRightOpen=C.prefs.rightOpen,savedActiveTab=C.activeTab;
   if(innerWidth<1060)S.compactSide='left';for(const tab of C.tabs)if(tab.type==='file'){tab.type='files';tab.selectedPath=tab.path;}
   const saved=(C.prefs.bottomTerminalIds||[]).filter(id=>C.tabs.some(t=>t.id===id&&t.type==='terminal'));
   for(const id of saved){const tab=C.tabs.find(t=>t.id===id);C.selectTab(id);const pane=C.panes.get(id);pane.classList.add('v2-docked-terminal');$('bottomTerminalHost').appendChild(pane);S.bottomIds.push(id);await C.startTerminal(tab).catch(handleError);}
   S.bottomId=saved.includes(C.prefs.bottomTerminalId)?C.prefs.bottomTerminalId:saved[0]||null;S.bottomShown=!!C.prefs.bottomTerminalVisible;
   const regular=C.tabs.find(t=>t.id===savedActiveTab&&!saved.includes(t.id))||C.tabs.find(t=>!saved.includes(t.id));if(regular)C.selectTab(regular.id);else if(saved.length&&savedRightOpen)C.openTab();
   C.prefs.rightOpen=savedRightOpen;
   S.booted=true;decorateTabs();persist();layout();renderState(state());
  }
  function positionReasoning(){
   const panel=$('reasoningPanel'),anchor=$('reasoningButton');if(!panel||panel.hidden||!anchor){S.reasoningAnchorGeometry=null;return;}
   const r=anchor.getBoundingClientRect();if(!r.width)return;
   // Keep this opening anchored while model labels change; follow real layout changes.
   if(!S.reasoningAnchorGeometry||S.reasoningAnchorGeometry.viewport!==innerWidth||Math.abs(S.reasoningAnchorGeometry.right-r.right)>0.5){
    const labels=[...anchor.querySelectorAll('.v23-composer-model,.v22-strength-label')].map(node=>node.getBoundingClientRect()).filter(rect=>rect.width>0);
    const center=labels.length?(Math.min(...labels.map(rect=>rect.left))+Math.max(...labels.map(rect=>rect.right)))/2:r.left+r.width/2;
    S.reasoningAnchorGeometry={center,right:r.right,viewport:innerWidth};
   }
   const center=S.reasoningAnchorGeometry.center,w=panel.getBoundingClientRect().width||320,h=panel.getBoundingClientRect().height||154;
   panel.style.left=Math.max(8,Math.min(innerWidth-w-8,center-w/2))+'px';panel.style.top=Math.max(8,r.top-h-10)+'px';panel.style.right='auto';panel.style.bottom='auto';
  }
  function browserMenu(anchor){const engine=C.browserState.searchEngine||'bing';menu(anchor,[action('文件',()=>C.workspaceTool('files'),'folder'),action('终端',()=>C.workspaceTool('terminal'),'terminal'),action('临时聊天',()=>window.ShiYanV22.openTemporary(),'newChat'),{separator:true},action('历史记录',()=>C.workspaceTool('history'),'history'),action('书签',()=>C.workspaceTool('bookmarks'),'star'),action('下载记录',()=>C.workspaceTool('downloads'),'download'),{separator:true},{label:'搜索引擎',children:[['bing','Bing'],['baidu','百度'],['duckduckgo','DuckDuckGo']].map(([value,label])=>({label,checked:value===engine,run:()=>C.native('searchEngine',{value})}))},action('清除浏览历史',async()=>{if(await window.shiyan.confirmAction('清除浏览历史？','不影响聊天、作品和下载文件。','清除'))C.native('clearHistory');}),action('清除网站数据',async()=>{if(await window.shiyan.confirmAction('清除网站数据？','清除 Cookie 和缓存后，网站可能需要重新登录。','清除'))C.native('clearWebsiteData');})],{width:194});}

   
  function makeFileTool(tab,pane){
   const previous=S.files.get(tab.id);if(previous){previous.disposed=true;S.files.delete(tab.id);}tab.type='files';
   const f={tab,pane,projectId:tab.projectId||C.prefs.selectedProjectId||null,selected: null as any, preview: null as any, tree: null as any, matches: null as any, breadcrumb: null as any,baselines:new Map(),readRevision:0,filterRevision:0,expanded:new Set(),disposed:false,dirOpen:tab.directoryOpen!==false,browsePath:tab.directoryPath||''};S.files.set(tab.id,f);pane.classList.add('v2-file-pane');
   pane.innerHTML=`<header class="v2-file-header"><nav class="v2-breadcrumb" aria-label="文件目录层级"></nav><span class="toolbar-spacer"></span><div class="v2-file-actions">${button('','more','文件操作','v2-file-more')}${button('','folders','显示或隐藏文件目录','v2-directory-toggle')}<button type="button" class="v2-open-editor" aria-label="选择打开方式">打开${C.icon('down')}</button></div></header><div class="v2-file-body"><section class="v2-file-preview"><div class="v2-file-empty">${icon('folders')}<strong>打开文件</strong><span>从工作区目录树中选择文件</span></div></section><aside class="v2-file-directory" aria-label="文件目录"><label class="v2-file-filter">${C.icon('search')}<input type="search" placeholder="筛选文件…" aria-label="筛选文件" autocomplete="off" spellcheck="false"></label><div class="v2-tree-root"></div><div class="v2-file-matches" hidden></div></aside></div>`;
   f.preview=pane.querySelector('.v2-file-preview');f.tree=pane.querySelector('.v2-tree-root');f.matches=pane.querySelector('.v2-file-matches');f.breadcrumb=pane.querySelector('.v2-breadcrumb');
   pane.querySelector('.v2-file-more').onclick=e=>menu(e.currentTarget,[{...action('复制',()=>window.shiyan.copyText(f.selected.text),'copy'),disabled:f.selected?.kind!=='text'},{...action('加入对话',()=>addFileContext(f),'newChat'),disabled:f.selected?.kind!=='text'||!!f.selected?.sensitive}]);
   pane.querySelector('.v2-directory-toggle').onclick=()=>{f.dirOpen=!f.dirOpen;f.tab.directoryOpen=f.dirOpen;applyDirectoryVisibility(f);persist();};
   pane.querySelector('.v2-open-editor').onclick=async e=>{const anchor=e.currentTarget;if(!f.selected)return;try{const result=await C.api('/editors');menu(anchor,result.editors.length?result.editors.map(editor=>action(editor.name,async()=>{const result=await C.api('/files/open-editor','POST',{...fileReference(f),editorId:editor.id});notify('已通过 '+result.editor+' 打开');},'editor')):[{label:'未找到可用的编辑器',disabled:true}],{width:220});}catch(err){handleError(err);}};
   let timer: any = 0;const input=pane.querySelector('input[type="search"]');input.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>filterFiles(f,input.value),140);};
   applyDirectoryVisibility(f);updateBreadcrumb(f);loadFileTree(f,f.browsePath).catch(err=>{if(!f.disposed)f.tree.innerHTML=`<p class="wb-error">${esc((err as any).message)}</p>`;});
   const selected=tab.selectedPath||tab.path;if(tab.fileId)openFile(f,null,tab.fileId);else if(selected)openFile(f,selected);return f;
  }
  function fileReference(f){return f.selected?.fileId?{fileId:f.selected.fileId}:{projectId:f.projectId,path:f.tab.selectedPath};}
  function fileType(name,directory=false){
   if(directory)return {kind:'folder',icon:'folder'};const n=name.toLowerCase(),ext=n.split('.').pop();
   if(['js','mjs','cjs','jsx'].includes(ext))return {kind:'js',label:'JS'};
   if(['ts','tsx','mts','cts'].includes(ext))return {kind:'ts',label:'TS'};
   if(['json','jsonl'].includes(ext))return {kind:'json',label:'{}'};
   if(['zip','gz','tgz','tar','bz2','xz','7z','rar'].includes(ext))return {kind:'archive',icon:'archive'};
   if(ext==='py')return {kind:'python',label:'Py'};
   if(ext==='swift')return {kind:'swift',label:'Sw'};
   if(ext==='java')return {kind:'java',label:'J'};
   if(['md','mdx'].includes(ext))return {kind:'markdown',label:'M↓'};
   if(['png','jpg','jpeg','gif','heic','webp','svg'].includes(ext))return {kind:'image',icon:'image'};
   if(['css','scss','less'].includes(ext))return {kind:'css',label:'#'};
   if(['html','htm','vue','svelte','xml'].includes(ext))return {kind:'markup',label:'<>'};
   if(['sh','command','zsh','bash'].includes(ext))return {kind:'shell',icon:'terminal'};
   if(n.startsWith('.git'))return {kind:'git',label:'G'};return {kind:'text',icon:'file'};
  }
  function fileIcon(name,directory=false){if(directory)return '';const t=fileType(name,directory);return `<span class="v2-file-type type-${t.kind}" data-file-type="${t.kind}" aria-hidden="true">${t.icon?icon(t.icon):esc(t.label)}</span>`;}
  async function loadFileTree(f,path=''){
   if(f.disposed)return;
   if(!f.projectId){f.tree.innerHTML='<div class="wb-empty">选择项目后浏览文件。<button type="button" class="wb-text-button" data-open-project>打开本地项目</button><button type="button" class="wb-text-button" data-open-file>打开文件</button></div>';return;}
   f.browsePath=path;f.tab.directoryPath=path;const project=C.projects.find(p=>p.id===f.projectId);
   f.tree.innerHTML='<div class="v2-tree-entries"></div>';
   await loadBranch(f,f.tree.querySelector('.v2-tree-entries'),path);
  }
  async function loadBranch(f,container,path,offset=0){
   const result=await C.api('/directory-details?projectId='+encodeURIComponent(f.projectId)+'&path='+encodeURIComponent(path)+'&offset='+offset);
   if(f.disposed||!container.isConnected)return;container.querySelector(':scope > .v2-load-more')?.remove();
   for(const entry of result.entries){const node=document.createElement('div');node.className='v2-tree-node';const b=document.createElement('button');b.type='button';b.className='v2-file-row';b.dataset.filePath=entry.path;b.dataset.directory=String(entry.directory);b.disabled=entry.blocked;b.title=entry.blocked?'目录外链接，已阻止访问':entry.path;b.innerHTML=(entry.directory?C.icon('forward'):'<span class="v2-tree-indent"></span>')+fileIcon(entry.name,entry.directory)+`<span class="v2-filename">${esc(entry.name)}</span>`;node.appendChild(b);container.appendChild(node);
    if(entry.directory){b.setAttribute('aria-expanded',String(f.expanded.has(entry.path)));const sub=document.createElement('div');sub.className='v2-tree-children';sub.hidden=true;node.appendChild(sub);let loaded=false;b.onclick=async()=>{sub.hidden=!sub.hidden;b.classList.toggle('expanded',!sub.hidden);b.setAttribute('aria-expanded',String(!sub.hidden));if(sub.hidden)f.expanded.delete(entry.path);else f.expanded.add(entry.path);if(!sub.hidden&&!loaded)try{await loadBranch(f,sub,entry.path);loaded=true;}catch(err){sub.innerHTML=`<p class="wb-error">${esc((err as any).message)}</p>`;}};if(f.expanded.has(entry.path)){sub.hidden=false;b.classList.add('expanded');loadBranch(f,sub,entry.path).then(()=>loaded=true).catch(handleError);}}
    else b.onclick=()=>openFile(f,entry.path);
   }
   if(result.nextOffset!==null){const b=document.createElement('button');b.type='button';b.className='v2-load-more wb-text-button';b.textContent='继续显示（共 '+result.total+' 项）';b.onclick=()=>loadBranch(f,container,path,result.nextOffset).catch(handleError);container.appendChild(b);}
   if(result.truncated&&result.nextOffset===null)container.insertAdjacentHTML('beforeend','<p class="v2-filter-note">目录内容较多，当前仅显示服务器已返回的部分。</p>');
   if(!result.total)container.innerHTML='<p class="wb-empty">空目录</p>';markSelectedFile(f);
  }
  function markSelectedFile(f){for(const row of f.pane.querySelectorAll('[data-file-path]'))row.classList.toggle('selected',row.dataset.filePath===f.tab.selectedPath&&row.dataset.directory!=='true');}
  async function filterFiles(f,query){
   const rev=++f.filterRevision;query=query.trim();if(!query){f.tree.hidden=false;f.matches.hidden=true;return;}f.tree.hidden=true;f.matches.hidden=false;
   if(!f.projectId){f.matches.innerHTML='<p class="wb-empty">请先选择项目</p>';return;}f.matches.innerHTML='<p class="wb-empty">筛选中…</p>';
   try{const data=await C.api('/files/search?projectId='+encodeURIComponent(f.projectId)+'&q='+encodeURIComponent(query));if(f.disposed||rev!==f.filterRevision)return;f.matches.innerHTML='';
    for(const entry of data.entries){const b=document.createElement('button');b.type='button';b.className='v2-file-row v2-filter-result';b.disabled=entry.blocked;b.dataset.filePath=entry.path;b.dataset.directory=String(entry.directory);b.title=entry.path;b.innerHTML=fileIcon(entry.name,entry.directory)+`<span><span class="v2-filename">${esc(entry.name)}</span><small>${esc(entry.path)}</small></span>`;b.onclick=()=>entry.directory?loadFileTree(f,entry.path).then(()=>{f.pane.querySelector('input[type="search"]').value='';filterFiles(f,'');}):openFile(f,entry.path);f.matches.appendChild(b);}
    if(!data.entries.length)f.matches.innerHTML='<p class="wb-empty">没有匹配的文件</p>';if(data.truncated)f.matches.insertAdjacentHTML('beforeend','<p class="v2-filter-note">结果较多，请继续输入以缩小范围。</p>');f.matches.insertAdjacentHTML('beforeend','<p class="v2-filter-note">筛选略过依赖和构建缓存目录。</p>');markSelectedFile(f);
   }catch(err){if(rev===f.filterRevision)f.matches.innerHTML=`<p class="wb-error">${esc((err as any).message)}</p>`;}
  }
  async function openFile(f?: any, path?: any, fileId?: any){
   const rev=++f.readRevision;
   if(window.ShiYanPlatform?.mode==='web')f.preview.innerHTML=`<div class="v2-file-empty" role="status" aria-live="polite"><strong>${esc((path||f.tab.assetName||f.tab.title||'文件').split('/').pop())}</strong><span>正在读取文件内容…</span></div>`;
   try{const result=await C.api('/files/read','POST',fileId?{fileId}:{projectId:f.projectId,path});if(f.disposed||rev!==f.readRevision)return;if(f.tab.assetName)result.file.name=f.tab.assetName;f.selected=result.file;f.tab.file=result.file;f.tab.selectedPath=path||null;f.tab.fileId=fileId||undefined;f.tab.title=result.file.name;f.tab.path=path||undefined;f.preview.innerHTML='';f.preview.__shiyanFile={file:result.file,reference:fileReference(f),reload:()=>openFile(f,f.tab.selectedPath,f.tab.fileId)};const file=result.file;if(file.kind==='text'&&!f.baselines.has(file.path))f.baselines.set(file.path,file.text);
    if(file.kind==='text'){const lines=file.text.split('\n'),limited=lines.slice(0,4000),code=document.createElement('div');code.className='code-reader';code.innerHTML=`<pre class="line-numbers" aria-hidden="true">${limited.map((_,i)=>i+1).join('\n')}</pre><pre class="source-code"><code>${C.highlight(limited.join('\n'))}</code></pre>`;f.preview.appendChild(code);if(lines.length>4000)f.preview.insertAdjacentHTML('beforeend','<p class="file-preview-note">当前预览前 4000 行；复制保留全部已读取文本。</p>');}
    else if(file.kind==='pdf'){
     f.preview.innerHTML='<div class="v2-file-empty" role="status"><span>正在加载 PDF…</span></div>';
     const result=await C.api('/files/pdf','POST',fileId?{fileId}:{projectId:f.projectId,path});
     if(f.disposed||rev!==f.readRevision)return;
     if(!/^\/api\/workspace\/files\/pdf\/[A-Za-z0-9_-]+$/.test(result.previewUrl))throw Error('PDF 预览地址无效');
     const frame=document.createElement('iframe');frame.className='file-pdf-reader';frame.title='PDF 预览：'+file.name;frame.referrerPolicy='no-referrer';frame.src=result.previewUrl+'#view=FitH';
     f.preview.replaceChildren(frame);
    }
    else if(file.kind==='image')f.preview.innerHTML=`<div class="file-image-stage"><img src="${esc(file.dataUrl)}" alt="${esc(file.name)}"></div>`;
    else f.preview.innerHTML=`<div class="v2-file-empty">${icon('file')}<strong>${esc(file.name)}</strong><span>${esc(file.message||'请在编辑器中打开')}</span></div>`;
    updateBreadcrumb(f);markSelectedFile(f);C.renderTabs();persist();
   }catch(err){if(!f.disposed&&rev===f.readRevision)f.preview.innerHTML=`<div class="v2-file-empty"><strong>无法读取文件</strong><span>${esc((err as any).message)}</span></div>`;}
  }
  function updateBreadcrumb(f){
   const project=C.projects.find(p=>p.id===f.projectId),relative=f.tab.selectedPath||'',pieces=relative?relative.split('/').filter(Boolean):[];f.breadcrumb.innerHTML='';
   if(project){const b=document.createElement('button');b.type='button';b.textContent=project.name;b.title=project.path;b.onclick=e=>directoryPopup(f,'',e.currentTarget);f.breadcrumb.appendChild(b);}
   pieces.forEach((piece,i)=>{const sep=document.createElement('span');sep.className='v2-crumb-separator';sep.textContent='>';f.breadcrumb.appendChild(sep);if(i===pieces.length-1){const strong=document.createElement('strong');strong.textContent=piece;strong.title=f.selected?.path||relative;f.breadcrumb.appendChild(strong);}else{const b=document.createElement('button');b.type='button';b.textContent=piece;b.title=pieces.slice(0,i+1).join('/');b.onclick=e=>directoryPopup(f,pieces.slice(0,i+1).join('/'),e.currentTarget);f.breadcrumb.appendChild(b);}});
   if(!project){const strong=document.createElement('strong');strong.textContent=f.selected?.name||'文件';strong.title=f.selected?.path||'';f.breadcrumb.appendChild(strong);}
   if(!relative&&f.tab.fileId&&f.selected?.path){
    const full=f.selected.path,parts=full.split('/').filter(Boolean);f.breadcrumb.innerHTML='';f.breadcrumb.title=full;f.breadcrumb.dataset.fullPath=full;
    const root=document.createElement('span');root.textContent='/';f.breadcrumb.appendChild(root);
    parts.forEach((part,i)=>{if(i){const sep=document.createElement('span');sep.className='v2-crumb-separator';sep.textContent='›';f.breadcrumb.appendChild(sep);}const label=document.createElement(i===parts.length-1?'strong':'span');label.textContent=i===parts.length-1?(f.selected.name||part):part;f.breadcrumb.appendChild(label);});
    requestAnimationFrame(()=>{f.breadcrumb.scrollLeft=f.breadcrumb.scrollWidth;});
   }
   f.pane.querySelector('.v2-file-more').disabled=!f.selected;f.pane.querySelector('.v2-open-editor').disabled=!f.selected;
  }
  async function directoryPopup(f,path,anchor){
   try{
    closePopup();const box=$('v2Popup'),project=C.projects.find(p=>p.id===f.projectId);
    const name=(path||project?.path||'').split('/').filter(Boolean).pop()||project?.name||'项目';
    box.style.width='380px';box.classList.add('v23-directory-popup');box.hidden=false;
    box.innerHTML=`<button type="button" class="v23-directory-root" aria-expanded="true" aria-controls="v23DirectoryEntries" title="${esc(project?.path||'')}${path?'/'+esc(path):''}">${C.icon('forward')}<span>${esc(name)}</span></button><div id="v23DirectoryEntries" class="v2-directory-info-list v23-directory-tree" aria-label="目录树"></div>`;
    const root=box.querySelector('.v23-directory-root'),tree=box.querySelector('.v23-directory-tree');
    root.onclick=()=>{tree.hidden=!tree.hidden;root.setAttribute('aria-expanded',String(!tree.hidden));C.scheduleNative();};
    tree.addEventListener('click',e=>{if(e.target.closest('[data-directory="false"]'))closePopup();});
    positionPopup(box,anchor.getBoundingClientRect(),380);
    await loadBranch({...f,expanded:new Set()},tree,path);
    if(box.hidden||!tree.isConnected)return;
    positionPopup(box,anchor.getBoundingClientRect(),380);root.focus({preventScroll:true});C.scheduleNative();
   }catch(err){handleError(err);}
  }
  function applyDirectoryVisibility(f){f.pane.classList.toggle('v2-directory-hidden',!f.dirOpen);const b=f.pane.querySelector('.v2-directory-toggle');b.setAttribute('aria-expanded',String(f.dirOpen));b.classList.toggle('selected',f.dirOpen);f.pane.querySelector('.v2-file-directory').inert=!f.dirOpen;}
  async function addFileContext(f){const file=f.selected;if(!file||file.kind!=='text'||file.sensitive)return;const text=file.text.slice(0,30000);if(S.full){S.full=false;layout();}await window.shiyan.addContext(`参考文件：${file.path}\n\n\`\`\`${file.language||''}\n${text}\n\`\`\`${file.text.length>30000?'\n（仅加入前 30000 字符）':''}`);notify('文件内容已加入草稿，尚未发送');}
  async function openAsset(asset){
   if(!asset?.id)throw Error('文件附件不存在');
   const {file}=await C.api('/files/asset','POST',{assetId:asset.id});
   let tab=C.tabs.find(t=>t.assetId===asset.id);
   if(tab)C.selectTab(tab.id);
   else tab=C.openTab({type:'file',title:asset.filename||file.name,fileId:file.fileId,assetId:asset.id,assetName:asset.filename||file.name},true);
   if(!tab)throw Error('无法打开文件工具');
   S.full=false;revealRight();layout();
   const f=S.files.get(tab.id)||makeFileTool(tab,C.panes.get(tab.id));
   await openFile(f,null,file.fileId);
  }
  async function chooseFile(){const selected=await C.pick('chooseFile');if(!selected||selected.cancelled)return;const {file}=await C.api('/files/open','POST',{path:selected.path});let tab=C.tabs.find(t=>t.id===C.activeTab&&t.type==='files');if(!tab)tab=C.openTab({type:'files',title:'文件',projectId:C.prefs.selectedProjectId||undefined},true);if(!tab)return;const f=S.files.get(tab.id)||makeFileTool(tab,C.panes.get(tab.id));await openFile(f,null,file.fileId);}
  function decorateTerminal(tab,pane){const heading=pane.querySelector('.terminal-heading');if(!heading)return;heading.querySelector('span:first-child')?.remove();const status=heading.querySelector('.terminal-status');if(status){const update=()=>{status.hidden=['','本地终端','已连接','未启动','正在连接'].includes(status.textContent||'');};new MutationObserver(update).observe(status,{childList:true,characterData:true,subtree:true});update();}}
  function terminalMenu(anchor){
   menu(anchor,[action('打开底部终端',async()=>{
    const projectId=C.prefs.selectedProjectId||null;
    let tab=C.tabs.find(t=>t.type==='terminal'&&(t.projectId||null)===projectId);
    if(!tab)tab=C.openTab({type:'terminal',title:'终端',projectId});
    if(tab)await dockTerminal(tab);
   },'dock')],{width:155});
  }
  async function dockTerminal(tab){
   if(!C.sessions.has(tab.id))await C.startTerminal(tab);const pane=C.panes.get(tab.id);if(!pane)return;
   if(!S.bottomIds.includes(tab.id))S.bottomIds.push(tab.id);S.bottomId=tab.id;S.bottomShown=true;
   pane.classList.add('v2-docked-terminal');$('bottomTerminalHost').appendChild(pane);
   const other=C.tabs.find(t=>!S.bottomIds.includes(t.id));if(other)C.setActiveId(other.id);else C.openTab();
   C.renderTabs();animateLayout();fitTerminals();persist();
  }
  async function newBottomTerminal(){const tab=C.openTab({type:'terminal',title:'终端',projectId:C.prefs.selectedProjectId||undefined});if(tab)await dockTerminal(tab);}
  function selectBottomTerminal(id){if(!S.bottomIds.includes(id))return;S.bottomId=id;S.bottomShown=true;decorateTabs();layout();persist();C.sessions.get(id)?.term.focus();}
  function undockTerminal(activate=true){const id=S.bottomId;if(!id)return;S.bottomIds=S.bottomIds.filter(x=>x!==id);S.bottomId=S.bottomIds[0]||null;S.bottomShown=!!S.bottomId;const pane=C.panes.get(id);if(pane){pane.classList.remove('v2-docked-terminal');$('rightContent').appendChild(pane);}if(activate){revealRight();C.selectTab(id);}else C.renderTabs();animateLayout();fitTerminals();persist();}
  function onCloseTab(id){if(S.bottomIds.includes(id)){S.bottomIds=S.bottomIds.filter(x=>x!==id);if(S.bottomId===id)S.bottomId=S.bottomIds[0]||null;S.bottomShown=!!S.bottomId;renderBottomTabs();layout();}const f=S.files.get(id);if(f){f.disposed=true;S.files.delete(id);}}
  function fitTerminals(){for(const [id,s]of C.sessions){const p=C.panes.get(id);if(p&&isVisible(p)&&((id===S.bottomId&&S.bottomShown&&isCoding())||(id===C.activeTab&&$('rightWorkspace').getAttribute('aria-hidden')==='false')))requestAnimationFrame(()=>{if(isVisible(p))try{s.fit.fit();}catch(_){}});}}

  function buildCompare(){
   const home=$('homeView'),old=document.createElement('div');old.className='v2-legacy-photo';while(home.firstChild)old.appendChild(home.firstChild);home.appendChild(old);
   const area=document.createElement('div');area.id='compareWorkbench';area.className='v2-compare-workbench';area.innerHTML=`<div class="v2-enhance-toolbar"><div class="v2-compare-inputs"><button type="button" id="chooseCompareImage" class="v2-choose-photo">${C.icon('plus')}<span>选择图片</span></button><div id="compareModes"></div></div><div class="v2-compare-zoom"><button type="button" data-zoom-minus aria-label="缩小">−</button><button type="button" data-zoom-reset title="恢复适应窗口">100%</button><button type="button" data-zoom-plus aria-label="放大">＋</button></div><div id="compareActions"></div></div><div id="compareMain" class="v2-compare-pair"></div>`;home.appendChild(area);
   $('compareModes').appendChild($('modelSelector'));const actions=$('compareActions'),actionSlot=document.createElement('div');actionSlot.className='v2-photo-action-slot';actions.append($('processButton'),actionSlot,$('photoSelectionCount'));actionSlot.append($('saveResultButton'),$('cancelProcessButton'));$('saveResultButton').innerHTML=C.icon('download');$('saveResultButton').title='保存结果';(area as any).querySelector('.v2-enhance-toolbar').insertBefore((area as any).querySelector('.v2-compare-zoom'),actions);$('chooseCompareImage').onclick=()=>$('homeFileInput').click();$('compareMain').innerHTML=comparePair();bindCompareStage($('compareMain'),false);
   const overlay=document.createElement('div');overlay.id='comparePreview';overlay.className='v2-compare-preview';overlay.hidden=true;overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','原图与增强图同步预览');overlay.innerHTML=`<header><span>原图与增强图</span><span class="toolbar-spacer"></span><button type="button" data-zoom-reset>适应窗口</button>${button('closeComparePreview','close','关闭图片对比预览')}</header><div class="v2-compare-pair">${comparePair()}</div><footer class="v2-compare-zoom"><button type="button" data-zoom-minus aria-label="缩小">−</button><button type="button" data-zoom-reset>100%</button><button type="button" data-zoom-plus aria-label="放大">＋</button></footer>`;$('app').appendChild(overlay);bindCompareStage(overlay.querySelector('.v2-compare-pair'),true);$('closeComparePreview').onclick=closeCompare;
   for(const parent of [area,overlay])parent.addEventListener('click',e=>{
    const action=(e.target as any)?.closest('[data-photo-previous],[data-photo-next],[data-photo-remove]');
    if(action){e.preventDefault();e.stopPropagation();if(action.disabled)return;
      if(action.hasAttribute('data-photo-previous'))window.shiyan.previousPhoto();else if(action.hasAttribute('data-photo-next'))window.shiyan.nextPhoto();else window.shiyan.removePhoto();return;}
    if((e.target as any)?.closest('[data-zoom-minus]'))zoomCompare(S.compare.zoom/1.25);else if((e.target as any)?.closest('[data-zoom-plus]'))zoomCompare(S.compare.zoom*1.25);else if((e.target as any)?.closest('[data-zoom-reset]')){S.compare={zoom:1,x:0,y:0};renderCompareTransform();}});
  }
  function comparePair(){
   return ['original','result'].map((type,i)=>`<section class="v2-compare-card" data-compare="${type}"><div class="v2-compare-label"><span>${i?'增强后':'原图'}</span><span class="v2-compare-dimensions"></span></div><div class="v2-compare-stage" tabindex="0" role="button" aria-label="${i?'放大增强图':'选择或放大原图'}"><img draggable="false" alt="${i?'增强图':'原图'}" hidden><div class="v2-compare-empty">${icon(i?'spark':'image')}<span>${i?'增强结果显示在这里':'选择或拖入图片'}</span></div></div>${i?'':`<button type="button" class="photo-switch photo-switch-previous" data-photo-previous aria-label="上一张图片" title="上一张图片" hidden><svg class="wb-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="photo-switch photo-switch-next" data-photo-next aria-label="下一张图片" title="下一张图片" hidden><svg class="wb-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="photo-remove-current" data-photo-remove aria-label="移除当前图片" title="移除当前图片" hidden>${icon('close')}</button>`}</section>`).join('');
  }
  function bindCompareStage(pair,preview){
   for(const stage of pair.querySelectorAll('.v2-compare-stage')){let drag: any = null, moved=false;
    stage.addEventListener('wheel',e=>{if(!S.photoInput)return;e.preventDefault();zoomCompare(S.compare.zoom*Math.exp(-e.deltaY*.002));},{passive:false});
    let gestureZoom=1;stage.addEventListener('gesturestart',e=>{if(!S.photoInput)return;e.preventDefault();gestureZoom=S.compare.zoom;},{passive:false});stage.addEventListener('gesturechange',e=>{if(!S.photoInput||!Number.isFinite(e.scale))return;e.preventDefault();zoomCompare(gestureZoom*e.scale);},{passive:false});stage.addEventListener('gestureend',e=>e.preventDefault(),{passive:false});
    stage.onpointerdown=e=>{if(e.button!==0||S.compare.zoom<=1)return;drag={x:e.clientX,y:e.clientY,panX:S.compare.x,panY:S.compare.y};moved=false;stage.setPointerCapture(e.pointerId);};
    stage.onpointermove=e=>{if(!drag)return;const r=stage.getBoundingClientRect(),dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>4)moved=true;S.compare.x=drag.panX+dx/Math.max(1,r.width);S.compare.y=drag.panY+dy/Math.max(1,r.height);renderCompareTransform();};stage.onpointerup=()=>drag=null;stage.onpointercancel=()=>drag=null;
    stage.onclick=()=>{if(moved){moved=false;return;}if(!S.photoInput){$('homeFileInput').click();return;}if(!preview){S.overlayCompare=true;$('comparePreview').hidden=false;renderCompare();$('closeComparePreview').focus();C.scheduleNative();}};
    stage.ondblclick=()=>{S.compare={zoom:1,x:0,y:0};renderCompareTransform();};stage.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();stage.click();}};
   }
   if(!preview){pair.ondragover=e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();pair.classList.add('is-drop-target');}};pair.ondragleave=()=>pair.classList.remove('is-drop-target');pair.ondrop=()=>pair.classList.remove('is-drop-target');}
  }
  function zoomCompare(value){S.compare.zoom=Math.max(1,Math.min(6,value));if(S.compare.zoom===1)S.compare.x=S.compare.y=0;renderCompareTransform();}
  function renderCompareTransform(){for(const stage of document.querySelectorAll('.v2-compare-stage')){const img=stage.querySelector('img');if(!img)continue;img.style.transform=`translate(${S.compare.x*100}%,${S.compare.y*100}%) scale(${S.compare.zoom})`;stage.classList.toggle('can-pan',S.compare.zoom>1);}for(const b of document.querySelectorAll('.v2-compare-zoom [data-zoom-reset]'))b.textContent=Math.round(S.compare.zoom*100)+'%';}
  function closeCompare(){S.overlayCompare=false;$('comparePreview').hidden=true;C.scheduleNative();}
  function renderCompareImage(card,asset){
   const img=card.querySelector('img'),dimensions=card.querySelector('.v2-compare-dimensions');
   img.hidden=!asset;card.querySelector('.v2-compare-empty').hidden=!!asset;
   if(!asset){img.onload=null;img.removeAttribute('src');delete img.dataset.loadedUrl;dimensions.textContent='';return;}
   const url=assetURL(asset);
   const updateDimensions=()=>{const decoded=img.dataset.loadedUrl===url,width=asset.width||(decoded?img.naturalWidth:0),height=asset.height||(decoded?img.naturalHeight:0);dimensions.textContent=width&&height?width+' × '+height:'';};
   img.onload=()=>{if(img.getAttribute('src')!==url)return;img.dataset.loadedUrl=url;updateDimensions();};
   if(window.ShiYanPlatform?.mode==='web')img.crossOrigin='anonymous';
   if(img.getAttribute('src')!==url){delete img.dataset.loadedUrl;img.src=url;}
   updateDimensions();
  }
  function renderCompare(){
   if(!$('compareWorkbench'))return;const p=window.shiyan?.getPhotoState?.();if(!p)return;const signature=(p.input?.id||'')+':'+(p.result?.id||'');if(signature!==S.photoSignature){S.photoSignature=signature;S.compare={zoom:1,x:0,y:0};}S.photoInput=p.input;S.photoOutput=p.result;
   for(const card of document.querySelectorAll('[data-compare]')){
    const result=(card as any).dataset.compare==='result',a=result?p.result:p.input, empty: any = card.querySelector('.v2-compare-empty');renderCompareImage(card,a);
    if(result){
      let detail=p.error||p.label||'增强结果显示在这里';
      if(p.itemState==='running'&&!p.itemUploading&&!p.submitting){
        const raw=Number(p.progress);
        if(Number.isFinite(raw))detail+=' · '+Math.round(Math.min(100,Math.max(0,raw>1?raw:raw*100)))+'%';
      }
      empty.querySelector('span').textContent=detail;
    }
    card.classList.toggle('is-processing',(p.itemBusy??p.busy)&&result);
   }
   const selection=p.selection||{index:0,total:p.input?1:0};
   for(const button of document.querySelectorAll('[data-photo-previous]') as any){button.hidden=selection.total<2;button.disabled=selection.index===0||p.exporting||p.restoring;}
   for(const button of document.querySelectorAll('[data-photo-next]') as any){button.hidden=selection.total<2;button.disabled=selection.index>=selection.total-1||p.exporting||p.restoring;}
   for(const button of document.querySelectorAll('[data-photo-remove]') as any){button.hidden=!selection.total;button.disabled=p.busy||p.exporting||p.restoring;button.title=button.disabled?'处理完成后可移除':'移除当前图片';}
   if(!p.input&&S.overlayCompare)closeCompare();
   $('compareWorkbench').dataset.model=p.model||'general';$('chooseCompareImage').disabled=p.busy;if(p.error&&p.error!==S.photoError)window.shiyan?.toast?.(p.error);S.photoError=p.error||'';renderCompareTransform();
  }
  // 变清晰左侧面板：每次增强的记录，可查看、下载。桌面端和网页端共用（保存 / 预览走 window.shiyan，两端各自处理）。
  function buildEnhanceHistory(){
   const sidebar=document.createElement('aside');sidebar.id='enhanceSidebar';sidebar.className='v2-space-sidebar v2-enhance-sidebar';sidebar.hidden=true;sidebar.setAttribute('aria-label','变清晰');
   sidebar.innerHTML=`<header><h2>变清晰</h2>${button('enhanceSearchToggle','search','搜索记录')}</header><label id="enhanceSearchField" class="schedule-search v2-sidebar-search" hidden><input id="enhanceSearchInput" type="search" aria-label="搜索变清晰记录" placeholder="搜索文件名或模型"></label><div id="enhanceHistoryList" class="v2-enhance-list" role="list"></div><div id="enhanceHistoryEmpty" class="v2-enhance-empty" hidden>${icon('image')}<span>增强后的图片会出现在这里</span></div>`;
   $('leftContainer').appendChild(sidebar);
   $('enhanceSearchInput').oninput=e=>{S.enhanceQuery=e.target.value;renderEnhanceHistory();};
   // 和定时任务、空间一样：点标题栏右侧的搜索图标，在标题下方展开搜索框；再点一次收起并清空。
   $('enhanceSearchToggle').onclick=()=>{const box=$('enhanceSearchField');box.hidden=!box.hidden;$('enhanceSearchToggle').setAttribute('aria-expanded',String(!box.hidden));if(!box.hidden)$('enhanceSearchInput').focus();else if(S.enhanceQuery){S.enhanceQuery='';$('enhanceSearchInput').value='';renderEnhanceHistory();}};
   $('enhanceHistoryList').onclick=e=>{
    const group=e.target.closest('[data-enhance-group]');
    if(group){const key=group.dataset.enhanceGroup;S.enhanceCollapsed||=new Set();if(S.enhanceCollapsed.has(key))S.enhanceCollapsed.delete(key);else S.enhanceCollapsed.add(key);renderEnhanceHistory();return;}
    const button=e.target.closest('[data-enhance-action]'),row=e.target.closest('[data-enhance-item]');if(!row)return;
    const h=state()?.history.find(x=>x.id===row.dataset.enhanceItem);if(!h?.asset)return;
    if(button?.dataset.enhanceAction==='download'){e.stopPropagation();window.shiyan.saveAsset(h.asset);return;}
    window.shiyan.openPreview(h.asset);
   };
   $('enhanceHistoryList').onkeydown=e=>{const row=e.target.closest('[data-enhance-item]');if(row&&e.target===row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();row.click();}};
  }
  function enhanceDay(value){
   const d=new Date(value);if(Number.isNaN(d.getTime()))return '更早';
   const today=new Date();today.setHours(0,0,0,0);const day=new Date(d);day.setHours(0,0,0,0);const diff=Math.round((today.getTime()-day.getTime())/86400000);
   return diff===0?'今天':diff===1?'昨天':diff<7?'近 7 天':d.toLocaleDateString('zh-CN',{year:d.getFullYear()===today.getFullYear()?undefined:'numeric',month:'long',day:'numeric'});
  }
  function enhanceOpLabel(h){
   const d=new Date(h.createdAt);
   const t=Number.isNaN(d.getTime())?'':d.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
   return [h.modelName||'增强',t].filter(Boolean).join(' · ');
  }
  function renderEnhanceHistory(){
   if(!$('enhanceHistoryList')||!state())return;
   const query=String(S.enhanceQuery||'').trim().toLowerCase(),collapsed=S.enhanceCollapsed||new Set();
   const all=(state().history||[]).filter(h=>h.asset&&(h.asset.mimeType||'image/').startsWith('image/')&&/增强/.test(h.modelName||''));
   const items=all.filter(h=>!query||[h.filename,h.asset.filename,h.modelName].some(v=>String(v||'').toLowerCase().includes(query)))
      .sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime()||String(b.id).localeCompare(String(a.id)));
   const signature=JSON.stringify([query,[...collapsed].sort(),items.map(h=>[h.id,h.asset.id,h.filename,h.modelName])]);
   if(signature===S.lastEnhanceSignature)return;S.lastEnhanceSignature=signature;
   const empty=$('enhanceHistoryEmpty');empty.hidden=!!items.length;empty.querySelector('span').textContent=query&&all.length?'没有找到相关记录':'增强后的图片会出现在这里';
   const groups: any[] = [];for(const h of items){const key=h.jobId||h.id;if(groups.at(-1)?.key!==key)groups.push({key,label:enhanceOpLabel(h),items:[]});groups.at(-1).items.push(h);}
   // 时间分组可以折叠；搜索时全部展开，方便看到结果。
   $('enhanceHistoryList').innerHTML=groups.map(g=>{
    const open=query||!collapsed.has(g.key);
    const rows=open?g.items.map(h=>{
     const a=h.asset,name=h.filename||a.filename||'图片',time=new Date(h.createdAt);
     const meta=[h.modelName||'增强',a.width&&a.height?a.width+'×'+a.height:'',Number.isNaN(time.getTime())?'':time.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})].filter(Boolean).join(' · ');
     return `<div class="v2-enhance-item" role="listitem" tabindex="0" data-enhance-item="${esc(h.id)}" title="查看 ${esc(name)}"><img src="${esc(thumbnailURL(a))}" alt="" loading="lazy" decoding="async"><span class="v2-enhance-text"><strong>${esc(name)}</strong><small>${esc(meta)}</small></span><button type="button" class="v2-enhance-download" data-enhance-action="download" aria-label="下载 ${esc(name)}" title="下载">${icon('download')}</button></div>`;
    }).join(''):'';
    return `<button type="button" class="v2-enhance-group" data-enhance-group="${esc(g.key)}" aria-expanded="${open?'true':'false'}"><svg class="v2-enhance-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${esc(g.label)}</span><small>${g.items.length}</small></button>`+rows;
   }).join('');
  }
  function buildSpace(){
   const sidebar=document.createElement('aside');sidebar.id='spaceSidebar';sidebar.className='v2-space-sidebar';sidebar.hidden=true;sidebar.innerHTML=`<header><h2>空间</h2>${button('spaceSearchToggle','search','搜索图像')}</header><label id="spaceSearchField" hidden><input id="spaceSearchInput" type="search" aria-label="搜索空间图像" placeholder="搜索图像…"></label><button type="button" class="v2-space-category selected">${icon('image')}<span>图像</span></button>`;$('leftContainer').appendChild(sidebar);
   const view=$('historyView'),legacy=document.createElement('div');legacy.className='v2-legacy-history';while(view.firstChild)legacy.appendChild(view.firstChild);view.appendChild(legacy);const space=document.createElement('div');space.id='spaceContent';space.className='v2-space-content';space.innerHTML=`<header class="v2-space-toolbar"><span id="spaceCount"></span><span class="toolbar-spacer"></span><button id="spaceSelectToggle" class="wb-text-button" type="button">选择</button></header><div class="v2-space-scroll"><div id="spaceGallery" class="v2-space-gallery"></div><div id="spaceEmpty" class="v2-space-empty" hidden>${icon('image')}<span>暂无图像</span></div></div><div id="spaceBatch" class="v2-space-batch" hidden><span id="spaceSelectionCount"></span><button id="spaceExport" type="button">${icon('download')}导出</button><button id="spaceShare" type="button">${icon('share')}分享</button><button id="spaceDelete" class="danger" type="button">${icon('trash')}删除记录</button></div>`;view.appendChild(space);
   $('spaceSearchToggle').onclick=()=>{$('spaceSearchField').hidden=!$('spaceSearchField').hidden;if(!$('spaceSearchField').hidden)$('spaceSearchInput').focus();};$('spaceSearchInput').oninput=e=>{S.spaceQuery=e.target.value;renderSpace();};$('spaceSelectToggle').onclick=()=>{S.spaceSelecting=!S.spaceSelecting;if(!S.spaceSelecting)S.spaceSelection.clear();renderSpace();};
   $('spaceGallery').onclick=e=>{const selector=e.target.closest('[data-space-select]');if(selector){e.stopPropagation();toggleSpaceSelection(selector.dataset.spaceSelect);return;}const more=e.target.closest('[data-space-more]');if(more){e.stopPropagation();spaceMenu(more.dataset.spaceMore,more);return;}const card=e.target.closest('[data-space-item]');if(card){if(S.spaceSelecting)toggleSpaceSelection(card.dataset.spaceItem);else{const h=state()?.history.find(h=>h.id===card.dataset.spaceItem);if(h?.asset)window.shiyan.openPreview(h.asset);}}};
   $('spaceExport').onclick=()=>exportSpace().catch(handleError);$('spaceShare').onclick=()=>window.shiyan.shareAssets(selectedSpace().map(h=>h.asset));$('spaceDelete').onclick=()=>deleteSpace().catch(handleError);
  }
  function selectedSpace(){return (state()?.history||[]).filter(h=>S.spaceSelection.has(h.id)&&h.asset);}
  function toggleSpaceSelection(id){S.spaceSelecting=true;if(S.spaceSelection.has(id))S.spaceSelection.delete(id);else S.spaceSelection.add(id);renderSpace();}
  function spaceMenu(id,anchor){const h=state()?.history.find(h=>h.id===id);if(!h?.asset)return;menu(anchor,[action('预览',()=>window.shiyan.openPreview(h.asset),'image'),action('保存图片',()=>window.shiyan.saveAsset(h.asset),'download'),action('分享',()=>window.shiyan.shareAssets([h.asset]),'share'),{separator:true},action(S.spaceSelection.has(id)?'取消选择':'选择',()=>toggleSpaceSelection(id),'check')]);}
  async function exportSpace(){if(window.ShiYanPlatform?.mode==='web')return window.shiyan.shareAssets(selectedSpace().map(h=>h.asset));const ids=selectedSpace().map(h=>h.id);if(!ids.length)return;const data=await window.shiyan.api('/api/history/export','POST',{ids});await window.shiyan.saveAsset(data.asset);}
  async function deleteSpace(){const ids=selectedSpace().map(h=>h.id);if(!ids.length)return;if(!await window.shiyan.confirmAction('删除所选记录？',`从空间移除 ${ids.length} 条作品记录。原始文件不会被删除。`,'删除'))return;await window.shiyan.api('/api/history/delete','POST',{ids});S.spaceSelection.clear();renderSpace();}
  function spaceColumnCount(){
   const gallery=$('spaceGallery');if(!gallery)return 1;
   const width=gallery.getBoundingClientRect().width||gallery.parentElement?.clientWidth||650;
   return Math.max(1,Math.min(7,Math.floor((width+16)/(222+16))));
  }
  function renderSpace(){
   if(!$('spaceGallery')||!state())return;
   const all=state().history.filter(h=>h.asset&&(h.asset.mimeType||'').startsWith('image/'))
      .sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime()||String(a.id).localeCompare(String(b.id)));
   const valid=new Set(all.map(h=>h.id));S.spaceSelection=new Set([...S.spaceSelection].filter(id=>valid.has(id)));
   const q=S.spaceQuery.trim().toLocaleLowerCase();
   const items=all.filter(h=>!q||[h.filename,h.asset.filename,h.modelName].join(' ').toLocaleLowerCase().includes(q));
   const count=spaceColumnCount();
   const signature=JSON.stringify([items.map(h=>[h.id,h.asset.id,h.asset.width,h.asset.height]),count]);
   if(signature!==S.lastSpaceSignature){
    S.lastSpaceSignature=signature;S.spaceColumns=count;
    const heights=new Array(count).fill(0), columns: any[][] = Array.from({length:count},()=>[]);
    const width=Math.max(120,(($('spaceGallery').getBoundingClientRect().width||750)-16*(count-1))/count);
    for(const h of items){
     const a=h.asset,name=h.filename||a.filename||'图片',selected=S.spaceSelection.has(h.id);
     const index=heights.indexOf(Math.min(...heights));
     const iw=Math.max(1,Number(a.width)||300),ih=Math.max(1,Number(a.height)||300);
     heights[index]+=width*ih/iw+16;
     columns[index].push(`<article class="v2-space-card ${selected?'selected':''}" data-space-item="${esc(h.id)}" tabindex="0" aria-label="${esc(name)}"><img src="${esc(thumbnailURL(a))}" alt="${esc(name)}" width="${iw}" height="${ih}" loading="lazy" decoding="async"><button class="v2-space-select" type="button" data-space-select="${esc(h.id)}" aria-label="${selected?'取消选择':'选择'} ${esc(name)}" aria-pressed="${selected}">${selected?icon('check'):''}</button><button class="v2-space-more" type="button" data-space-more="${esc(h.id)}" aria-label="${esc(name)} 更多操作">${C.icon('more')}</button></article>`);
    }
    $('spaceGallery').style.setProperty('--v21-space-columns',String(count));
    $('spaceGallery').innerHTML=columns.map(cards=>'<div class="v21-space-column">'+cards.join('')+'</div>').join('');
    for(const card of $('spaceGallery').querySelectorAll('article')){
     card.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===card){e.preventDefault();card.click();}};
    }
   }
   for(const card of $('spaceGallery').querySelectorAll('[data-space-item]')){
    const selected=S.spaceSelection.has(card.dataset.spaceItem),control=card.querySelector('[data-space-select]');
    card.classList.toggle('selected',selected);control.setAttribute('aria-pressed',String(selected));control.setAttribute('aria-label',(selected?'取消选择':'选择')+' '+card.querySelector('img').alt);
    if(control.dataset.selected!==String(selected)){control.innerHTML=selected?icon('check'):'';control.dataset.selected=String(selected);}
   }
   $('spaceGallery').classList.toggle('is-selecting',!!S.spaceSelecting);
   $('spaceEmpty').hidden=!!items.length;
   $('spaceEmpty').querySelector('span').textContent=q?'没有匹配的图像':'暂无图像';
   $('spaceCount').textContent=items.length+' 张图像';
   $('spaceSelectToggle').textContent=S.spaceSelecting?'完成':'选择';
   $('spaceBatch').hidden=!S.spaceSelection.size;
   $('spaceSelectionCount').textContent='已选择 '+S.spaceSelection.size+' 项';
  }
  function build(){
   document.body.classList.add('workbench-v2');$('railHome').onclick=()=>{S.full=false;window.shiyan.navigate('agent');animateLayout();};const shell=$('desktopLayout');S.addTab=$('addWorkspaceTab');$('railEnhance').innerHTML=icon('spark');$('railHistory').title=$('railHistory').ariaLabel='空间';$('railHistory').setAttribute('data-space-entry','true');$('railHistory').innerHTML=icon('gallery');$('railEnhance').after($('railHistory'));
   const editor=document.createElement('div');editor.id='v21ProjectEditor';editor.className='v21-edit-overlay';editor.hidden=true;
   editor.innerHTML='<form class="v21-edit-dialog" id="v21ProjectForm"><h2>编辑项目</h2><label>项目名称<input id="v21ProjectName" type="text" maxlength="100" required autocomplete="off"></label><p id="v21ProjectError" class="wb-error" hidden></p><footer><button type="button" class="wb-secondary" id="v21EditCancel">取消</button><button type="submit" class="wb-primary">保存</button></footer></form>';$('app').appendChild(editor);
   $('v21EditCancel').onclick=()=>{editor.hidden=true;C.scheduleNative();};
   editor.addEventListener('pointerdown',e=>{if(e.target===editor){editor.hidden=true;C.scheduleNative();}});
   $('v21ProjectForm').onsubmit=async e=>{e.preventDefault();const btn=e.currentTarget.querySelector('[type="submit"]');btn.disabled=true;
    try{const result=await C.api('/projects/'+encodeURIComponent(editor.dataset.projectId || ''),'PATCH',{name:$('v21ProjectName').value.trim()});
     C.setProjects(result.projects);editor.hidden=true;renderProjects();C.scheduleNative();
    }catch(err){$('v21ProjectError').textContent=(err as any).message;$('v21ProjectError').hidden=false;}
    finally{btn.disabled=false;}
   };
   const popup=document.createElement('div');popup.id='v2Popup';popup.className='v2-popup';popup.hidden=true;popup.setAttribute('role','menu');$('app').appendChild(popup);
   shell.appendChild($('toggleLeftSidebar'));shell.appendChild($('toggleRightWorkspace'));const full=document.createElement('button');full.id='toggleFullWorkspace';full.type='button';full.className='wb-icon-button';shell.appendChild(full);$('toggleLeftSidebar').classList.add('v2-floating-left-toggle');$('toggleRightWorkspace').classList.add('v2-floating-right-toggle');full.classList.add('v2-floating-full-toggle');$('toggleLeftSidebar').onclick=toggleLeft;$('toggleRightWorkspace').onclick=toggleRight;full.onclick=()=>{if(!rightWorkspaceEnabled)return;closePopup();S.full=!S.full;revealRight();animateLayout();};
   for(const id of ['sessionMenu','sessionDeletePopover','reasoningPanel','reasoningBackdrop'])$('app').appendChild($(id));
   const actions=$('composerSurface').querySelector('.composer-actions');$('composerSurface').insertBefore($('messageInput'),actions);$('composerSurface').insertBefore($('attachmentList'),$('messageInput'));const spacer=document.createElement('span');spacer.className='composer-spacer';$('addImageButton').after(spacer);
   $('projectDialogTitle').textContent='添加项目';$('projectForm').querySelector('.project-type-switch').hidden=true;$('projectPathLabel').textContent='项目目录或创建位置';$('projectForm').querySelector('footer').innerHTML='<button id="openProjectSubmit" class="wb-secondary" type="button">打开已有项目</button><button id="createProjectSubmit" class="wb-primary" type="submit">新建项目</button>';
   $('projectForm').onsubmit=e=>{e.preventDefault();submitProject(true);};$('openProjectSubmit').onclick=()=>submitProject(false);
   $('addProjectButton').onclick=e=>{e.preventDefault();e.stopPropagation();S.bindingProjectId=null;$('projectDialogTitle').textContent='添加项目';$('projectName').readOnly=false;$('openProjectSubmit').textContent='打开已有项目';$('createProjectSubmit').hidden=false;$('workbenchModal').hidden=false;$('projectName').value='';$('projectPath').value=C.defaultDirectory;$('projectFormError').hidden=true;$('projectName').required=false;$('projectName').focus();C.scheduleNative();};
   $('projectList').onclick=e=>{const more=e.target.closest('[data-project-more]');if(more){e.preventDefault();e.stopPropagation();projectMenu(more.dataset.projectMore,more);return;}const add=e.target.closest('[data-project-new]');if(add){e.preventDefault();e.stopPropagation();projectNew(add.dataset.projectNew).catch(handleError);return;}const fold=e.target.closest('[data-project-fold]');if(fold){const id=fold.dataset.projectFold;if(S.closedProjects.has(id))S.closedProjects.delete(id);else S.closedProjects.add(id);renderProjects();return;}};
   $('browserTools').onclick=e=>browserMenu(e.currentTarget);
   $('rightContent').addEventListener('click',e=>{
    const target=e.target.closest('[data-tool-terminal-more]');if(!target)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();terminalMenu(target);
   },true);
   const bottom=document.createElement('section');bottom.id='bottomTerminal';bottom.hidden=true;bottom.innerHTML=`<header class="v22-bottom-header"><div id="bottomTerminalTabs" role="tablist" aria-label="底部终端标签"></div>${button('addBottomTerminal','plus','新建独立终端')}<span class="toolbar-spacer"></span><div class="v2-bottom-actions">${button('restoreBottomTerminal','undock','返回右侧终端')}${button('closeBottomTerminal','down','收起底部终端')}</div></header><div id="bottomTerminalHost"></div>`;shell.appendChild(bottom);$('restoreBottomTerminal').onclick=()=>undockTerminal();$('closeBottomTerminal').onclick=()=>{S.bottomShown=false;decorateTabs();layout();persist();};$('addBottomTerminal').onclick=()=>newBottomTerminal().catch(handleError);$('bottomTerminalTabs').onclick=e=>{const close=e.target.closest('[data-close-bottom-tab]');if(close){e.stopPropagation();C.closeTab(close.dataset.closeBottomTab).catch(handleError);return;}const tab=e.target.closest('[data-bottom-tab]');if(tab)selectBottomTerminal(tab.dataset.bottomTab);};$('bottomTerminalTabs').onkeydown=e=>{if(e.target.closest('button'))return;if(['Enter',' '].includes(e.key)){const tab=e.target.closest('[data-bottom-tab]');if(tab){e.preventDefault();selectBottomTerminal(tab.dataset.bottomTab);}}};
   for(const id of ['leftResizeHandle','rightResizeHandle'])shell.appendChild($(id));const resize=document.createElement('div');resize.id='bottomResizeHandle';resize.className='wb-resizer v2-bottom-resizer';resize.setAttribute('role','separator');resize.setAttribute('aria-label','调整底部终端高度');resize.setAttribute('aria-orientation','horizontal');bottom.appendChild(resize);
   for(const id of ['leftResizeHandle','rightResizeHandle','bottomResizeHandle']){const handle=$(id);handle.tabIndex=0;handle.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();dragStart(id,e.clientX,e.clientY);handle.setPointerCapture(e.pointerId);};handle.onpointermove=e=>{if(S.dragging){e.preventDefault();dragMove(e.clientX,e.clientY);}};handle.onpointerup=handle.onpointercancel=()=>dragEnd();handle.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();dragStart(id,0,0);dragMove(e.key==='ArrowLeft'?-16:e.key==='ArrowRight'?16:0,e.key==='ArrowUp'?-16:e.key==='ArrowDown'?16:0);dragEnd();};}
   buildCompare();buildSpace();buildEnhanceHistory();$('historyView').setAttribute('aria-label','空间');
   document.addEventListener('pointerdown',e=>{if(!(e.target as any)?.closest('#v2Popup'))closePopup();},true);
   document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('v21ProjectEditor').hidden){e.preventDefault();e.stopImmediatePropagation();$('v21ProjectEditor').hidden=true;C.scheduleNative();return;}if(e.key==='Escape'){if(!$('comparePreview').hidden){e.preventDefault();e.stopImmediatePropagation();closeCompare();return;}if(!$('v2Popup').hidden){e.preventDefault();e.stopImmediatePropagation();closePopup();return;}dragEnd();}},true);
   window.addEventListener('shiyan-terminal',renderBottomTabs);window.addEventListener('blur',dragEnd);window.addEventListener('shiyan-photo',renderCompare);window.addEventListener('shiyan-reasoning',positionReasoning);
   window.addEventListener('shiyan-native',e=>{const d=(e as CustomEvent).detail||{};if(d.type==='workspaceMenuSelection'){const fn=S.menuCallbacks.get(d.menuId)?.get(d.itemId);S.menuCallbacks.delete(d.menuId);Promise.resolve().then(()=>fn?.()).catch(handleError);}else if(d.type==='workspaceMenuClosed')S.menuCallbacks.delete(d.menuId);else if(d.type==='workspaceDivider'){if(d.phase==='start')dragStart(d.id,d.x,d.y);else if(d.phase==='move')dragMove(d.x,d.y);else dragEnd();}});
   document.addEventListener('selectstart',e=>{if(S.dragging)e.preventDefault();},true);
   const gallery=$('spaceGallery');new ResizeObserver(()=>{if(S.spaceColumns!==spaceColumnCount())renderSpace();}).observe(gallery);
   new ResizeObserver(()=>{positionReasoning();C.scheduleNative();}).observe($('composerForm'));
  }
  async function submitProject(create){const name=$('projectName').value.trim(),path=$('projectPath').value.trim();if(create&&!name){$('projectFormError').textContent='请输入新项目名称';$('projectFormError').hidden=false;return;}$('openProjectSubmit').disabled=$('createProjectSubmit').disabled=true;$('projectFormError').hidden=true;try{const result=await C.api(S.bindingProjectId?'/projects/'+encodeURIComponent(S.bindingProjectId)+'/bind':'/projects','POST',S.bindingProjectId?{path}:{name,path,create});C.setProjects(result.projects);$('workbenchModal').hidden=true;await C.selectProject(result.project.id);}catch(err){$('projectFormError').textContent=(err as any).message;$('projectFormError').hidden=false;}finally{$('openProjectSubmit').disabled=$('createProjectSubmit').disabled=false;C.scheduleNative();}}
  build();
  window.ShiYanV22.install(C);
  return {layout,syncNative,renderProjects,renderState,decorateTabs,afterBoot,revealRight,revealConversationProject:projectId=>{if(projectId){S.closedProjects.delete(projectId);$('projectsGroup').open=true;}renderProjects();},openProjectDialog:()=>{$('addProjectButton').click();},initFile:makeFileTool,decorateTerminal,onCloseTab,closeEmptyWorkspace,fitTerminals,chooseFile,openAsset,
   inspect:()=>({v2:true,booted:S.booted,fullView:S.full,bottomTerminalId:S.bottomId,bottomTerminalIds:[...S.bottomIds],bottomTerminalVisible:S.bottomShown,bottomTerminalPID:C.sessions.get(S.bottomId)?.pid||null,actualLeftOpen:$('toggleLeftSidebar').getAttribute('aria-expanded')==='true',actualRightOpen:$('toggleRightWorkspace').getAttribute('aria-expanded')==='true',fileTools:[...S.files.values()].map(f=>({tabId:f.tab.id,path:f.tab.selectedPath,directoryOpen:f.dirOpen,projectId:f.projectId})),photoCompare:{...S.compare},spaceSelection:[...S.spaceSelection]})};
 }
 window.ShiYanV2={install};
})();
