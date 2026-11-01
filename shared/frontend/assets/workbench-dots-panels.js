 
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icons = {
    copy:'<rect x="8" y="3" width="13" height="13" rx="3"/><rect x="3" y="8" width="13" height="13" rx="3"/>',
    read:'<path d="M11 4 6 8H3v8h3l5 4V4Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14"/>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
    chat:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2v-7A8.5 8.5 0 1 1 21 11.5Z"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    file:'<path d="M14 2H5v20h14V7Z M14 2v5h5"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 6-6 12 11"/>',
    forward:'<path d="m10 5 7 7-7 7"/>',
    back:'<path d="m14 5-7 7 7 7"/>', close:'<path d="m6 6 12 12M18 6 6 18"/>',
    more:'<path d="m6 9 6 6 6-6"/>', add:'<path d="M12 4v16M4 12h16"/>',
    download:'<path d="M12 2v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
  };
  const icon = kind => kind === 'copy' ? '<span class="symbol dots-panel-icon" data-symbol="dots-copy" style="--symbol:url(\'/assets/symbols/dots-copy.png\')" aria-hidden="true"></span>' : '<svg class="dots-panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(icons[kind] || icons.file)+'</svg>';
  const colors = ['#bdc4d5','#00b4ef','#ffd139','#d469da','#bada10','#ed729c','#f79557','#7293f1'];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let C, profile = {}, pets = [], cataloguePromise, snapshot = {}, activities = [], outputs = [];
  let loading = false, activityError = '', expanded = false, outputExpanded = false, lastActivityFetch = 0, refreshTimer;
  let profileDraft, profileDialog, conversationDialog, scheduleDialog, outputDialog, returnFocus;
  let currentConversation, conversationFull = false, conversationVersion = 0, scheduleValue, scheduleBusy = false;
  let conversationTimer, conversationPolling = false;
  let readSession=null, readingIndex=-1, readUtterance=null;
  let floatingPet=null;
  let currentModal, savedSignature = '', activitySignature = '', lastOpen = false, outputRaw = '';
  const api = (route, method = 'GET', data) => C.api(route, method, data);
  const rejected = error => [400,403,404,422].includes(error.status) && error.code !== 'action_uncertain';
  const name = () => profile.name || 'Dots';
  const petById = id => pets.find(p => p.id === id) || pets.find(p => p.is_active) || pets[0];
  const imageURL = pet => pet ? (reduced.matches ? pet.thumbnail_url : pet.preview_url).replace('/static/dots-pets/','/assets/dots-pets/') : '';
  const petImage = (id, cls = '', size = '') => {
    const pet = petById(id);
    return pet ? '<img class="dots-pet '+cls+'" data-dots-pet="'+esc(pet.id)+'" src="'+esc(imageURL(pet))+'" alt="'+esc(pet.name)+'"'+size+'>' : '<span class="dots-pet dots-pet-empty" aria-hidden="true">'+icon('chat')+'</span>';
  };
  const avatar = () => petById(profile.petId) ? petImage(profile.petId,'dots-nav-pet') : '';
  // Native minimised-window presentation reads the same identity and sprite;
  // it never clones or moves the live canvas used inside the web workspace.
  function voiceCallIdentity() {
    const pet=petById(profile.petId);
    if(!pet || !pet.sprite_url || !Number.isInteger(pet.cell_width) || pet.cell_width<1 || !Number.isInteger(pet.cell_height) || pet.cell_height<1)return {name:name(),pet:null};
    const states=(Array.isArray(pet.states)?pet.states:[]).filter(s=>typeof s.name==='string'&&Number.isInteger(s.row)&&s.row>=0&&Number.isInteger(s.frames)&&s.frames>0&&Number.isFinite(s.fps)&&s.fps>0).map(s=>({name:s.name,row:s.row,frames:s.frames,fps:s.fps}));
    return {name:name(),pet:{id:pet.id,spriteURL:pet.sprite_url.replace('/static/dots-pets/','/assets/dots-pets/'),cellWidth:pet.cell_width,cellHeight:pet.cell_height,spriteVersion:pet.sprite_version||1,states}};
  }
  const time = value => value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
  const ago = value => {
    if (!value) return '尚无活动';
    const stamp = value < 1e12 ? value * 1000 : value, minutes = Math.max(0, Math.floor((Date.now() - stamp) / 60000));
    return minutes < 1 ? '刚刚' : minutes < 60 ? minutes+'分钟前' : minutes < 1440 ? Math.floor(minutes/60)+'小时前' : time(stamp);
  };
  const localURL = value => String(value || '').replace(/^\/(?:shiyan\/)?v1\/dots\//, '/api/dots/');
  function getCatalogue() {
    if (!cataloguePromise) cataloguePromise = Promise.all([api('/profile'),api('/pets')]).then(([p, list]) => {
      profile = p.profile || {}; pets = list.pets || [];
      if (!profile.petId && list.active_pet_id) profile.petId = list.active_pet_id;
      document.documentElement.style.setProperty('--dots-profile-accent',profile.accent || colors[0]); C.nameChanged(); renderPanel(); return list;
    }).catch(error => { cataloguePromise = null; throw error; });
    return cataloguePromise;
  }
  function identityStatus(value = snapshot) {
    const tasks = (value.tasks || []).filter(t => t.legacyImported !== true);
    if (value.notice) return value.notice;
    if (value.connection && !['已连接','定时同步'].includes(value.connection)) return value.connection;
    if (value.uploading) return '正在上传…';
    if (value.busy) return '正在发送…';
    if (value.pendingMessage) return '发送结果未知，请重试';
    if (value.manager?.status === 'paused') return '已暂停';
    if (value.manager?.status === 'cancelled') return '已停止';
    const approvalTasks=tasks.filter(t=>['waiting_approval','awaiting_approval'].includes(t.status));
    const approvals=approvalTasks.flatMap(task=>(value.details?.[String(task.id)]?.approvals||[]).map(approval=>({approval,state:C.approvalState?.(task.id,approval.id)||{}})));
    const pending=approvals.filter(item=>isPendingApproval(item.approval));
    if (pending.some(item=>!item.state.busy&&!item.state.pending)) return '需要你批准操作';
    if (approvals.some(item=>item.approval.status==='executing')) return '正在执行已批准的操作…';
    if (pending.some(item=>item.state.busy)) return '正在提交你的决定…';
    if (pending.some(item=>item.state.pending)) return '操作决定结果未知，请重试';
    if (approvalTasks.length) return approvals.length?'正在更新操作状态…':'需要你批准操作';
    if (value.messages?.at(-1)?.role==='assistant'&&value.messages.at(-1).deliveryState==='streaming') return '正在回复…';
    if (Number(value.manager?.runningWorkers) > 0 || tasks.some(t => t.status === 'running')) return '正在处理事项…';
    if (tasks.some(t => t.status === 'done' && t.acceptanceStatus === 'pending')) return '正在验收…';
    if (tasks.some(t => ['active','pending','queued'].includes(t.status))) return '等待执行';
    if (tasks[0]?.status === 'failed') return '处理失败';
    if (value.loading && !value.messages?.length) return '正在加载…';
    if (value.messages?.at(-1)?.role === 'user') return '正在回复…';
    return '';
  }
  // A persistent pet keeps its animation frame while travelling between anchors.
  function positionPet() {
    const floating = floatingPet, area = $('mainWorkspace') || $('dotsView');
    if (!floating || !area) return;
    const panel = $('dotsActivity'), call = $('dotsVoiceCard'), avatar = call?.querySelector('.dots-call-avatar');
    const pet = petById(profile.petId), inCall = !!pet && !!call && !call.hidden && !!avatar;
    const visible = !!pet && (inCall || (window.shiyan.getView() === 'dots' && !conversationVisible()));
    const revealing = floating.hidden && visible;
    if (revealing) floating.classList.remove('is-placed');
    floating.hidden = !visible;
    avatar?.classList.toggle('has-live-pet',inCall);
    // Move the same canvas into the call identity, never clone a static avatar.
    // Keeping it inside the card also makes viewport dragging exact and avoids
    // lagging fixed-position pet overlays during panel changes.
    if(inCall){if(floating.parentElement!==avatar)avatar.appendChild(floating);}
    else if(floating.parentElement!==document.body)document.body.appendChild(floating);
    floating.classList.toggle('is-in-call',inCall);
    if (!visible) return;
    if (floating.dataset.petId !== pet.id) {
      floating.dataset.petId = pet.id;
      floating.innerHTML = '<div class="dots-floating-art">'+petImage(pet.id, 'dots-profile-pet')+'</div><div class="dots-floating-status" role="status" aria-live="polite" aria-atomic="true"></div>';
    }
    floating.classList.toggle('is-docked',!inCall && !!snapshot.drawerOpen);
    const panelBadge = panel?.querySelector('.dots-panel-status');
    if (panelBadge) { const status = identityStatus(); panelBadge.textContent = status; panelBadge.title = status; panelBadge.hidden = !status; }
    const badge = floating.querySelector('.dots-floating-status');
    if (badge) { const status = identityStatus(); badge.textContent = status || name(); badge.classList.toggle('is-working',!!status); }
    if(inCall){floating.style.removeProperty('transform');return;}
    const bounds = area.getBoundingClientRect(), header = $('desktopToolbar').getBoundingClientRect();
    const slot = panel?.querySelector('.dots-pet-anchor');
    const docked = snapshot.drawerOpen && !panel?.hidden;
    const panelBounds = docked ? panel.getBoundingClientRect() : null;
    const target = docked ? (slot?.getClientRects().length ? slot.getBoundingClientRect() :
      {left:panelBounds.left + 18,top:panelBounds.top + 18}) : null;
    const left = target ? target.left : bounds.left + (bounds.width - 66) / 2;
    const top = target ? target.top : Math.max(0, header.top + 2);
    floating.style.transform = `translate3d(${left}px,${top}px,0)`;
    if (revealing) floating.getBoundingClientRect();
    if (!floating.classList.contains('is-placed')) requestAnimationFrame(() => floating.classList.add('is-placed'));
  }
  function positionPanel() {
    const panel = $('dotsActivity'), button = $('dotsTasksButton');
    if (!panel || !button || panel.hidden) { positionPet(); return; }
    const rect = button.getBoundingClientRect(), width = Math.min(368, innerWidth - 24);
    const conversation=$('dotsView'),bounds=$('mainWorkspace')?.getBoundingClientRect();
    const panelGap=10;
    const rightLimit=Math.min(innerWidth,bounds&&bounds.width>0?bounds.right:innerWidth)-panelGap;
    const left=Math.max(panelGap,rightLimit-width);
    panel.style.width = width+'px';
    panel.style.left = left+'px';
    panel.style.top = Math.min(rect.bottom + panelGap, innerHeight - 180)+'px';
    panel.style.maxHeight = Math.max(160, innerHeight - rect.bottom - 26)+'px';
    if(previewOpen()){
      const voice=$('dotsVoiceCard'),style=getComputedStyle(panel);
      const inset=['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((sum,key)=>sum+(parseFloat(style[key])||0),0);
      const voiceStyle=voice&&!voice.hidden?getComputedStyle(voice):null;
      const reserve=voiceStyle?voice.offsetHeight+(parseFloat(voiceStyle.marginTop)||0)+(parseFloat(voiceStyle.marginBottom)||0):0;
      conversationDialog.style.height=Math.max(160,parseFloat(panel.style.maxHeight)-inset-reserve)+'px';
    }
    if(conversation){const area=conversation.getBoundingClientRect();conversation.style.setProperty('--dots-activity-reserved',area.width>=760?Math.max(0,area.right-left+16)+'px':'0px');}
    positionPet();
  }
  async function loadActivity(force = false) {
    if (loading || (!force && Date.now() - lastActivityFetch < 1800)) return;
    loading = true; activityError = ''; renderPanel();
    try {
      await getCatalogue();
      const result = await api('/activity');
      activities = result.activities || []; outputs = result.outputs || []; lastActivityFetch = Date.now();
    } catch (error) { activityError = error.message || String(error); }
    finally { loading = false; savedSignature = ''; renderPanel(); }
  }
  function renderPanel() {
    const panel = $('dotsActivity'); if (!panel || panel.hidden) { positionPet(); return; }
    if(previewOpen()){positionPanel();C.voiceUpdated?.();return;}
    const recent = expanded ? activities : activities.slice(0, 5), files = outputExpanded ? outputs : outputs.slice(0, 3);
    const newest = Math.max(0, ...activities.map(a => a.updatedAt || a.createdAt || 0));
    const signature = JSON.stringify([name(),profile.petId,profile.accent,recent,files,loading,activityError,expanded,outputExpanded,profile.seenActivities]);
    if (savedSignature === signature) { positionPanel(); C.voiceUpdated?.(); return; }
    const top = panel.scrollTop, voiceFocus = $('dotsVoiceCard')?.contains(document.activeElement) ? document.activeElement : null; savedSignature = signature;
    panel.innerHTML = '<div class="dots-profile-identity">'+'<span class="dots-pet-anchor" aria-hidden="true"></span>'+'<div><strong>'+esc(name())+'</strong><span>上次活跃：'+esc(ago(newest))+'</span><div class="dots-panel-status" role="status" aria-live="polite" hidden></div></div></div>'+
      '<section class="dots-panel-section"><header><h3>最近活动</h3><button type="button" class="dots-mini-button" data-dots-new-schedule aria-label="新建定时任务" title="新建定时任务">'+icon('add')+'</button></header><div class="dots-activity-rows">'+
      recent.map(a => {
        const isSchedule = a.type === 'schedule', id = isSchedule ? (a.scheduleId || a.schedule?.id || String(a.id).replace(/^schedule:/,'')) : (a.taskId || a.id);
        const key = a.type+':'+id, unread = (a.updatedAt || a.createdAt || 0) > (profile.seenActivities?.[key] || 0);
        return '<button type="button" class="dots-activity-row" '+(isSchedule?'data-dots-schedule':'data-dots-task')+'="'+esc(id)+'" title="'+esc(a.title)+'">'+icon(isSchedule?'clock':'chat')+'<span><strong>'+esc(a.title || '未命名任务')+'</strong>'+(isSchedule?'<small>'+esc(a.schedule?.enabled === false ? '已暂停' : scheduleDescription(a.schedule || a))+'</small>':'')+'</span>'+(unread?'<i class="dots-unread-dot" aria-label="有更新"></i>':'')+'</button>';
      }).join('')+(recent.length?'':'<p class="dots-panel-empty">'+(loading?'正在读取…':'还没有活动')+'</p>')+'</div>'+
      (activities.length>5?'<button class="dots-show-more" type="button" data-dots-show-more>'+icon('more')+(expanded?'收起':'显示更多')+'</button>':'')+'</section>'+
      '<section class="dots-panel-section dots-output-section"><header><h3>输出内容</h3></header>'+files.map(o=>'<button type="button" class="dots-activity-row dots-output-row" data-dots-panel-output="'+esc(o.id)+'" title="'+esc(o.filename || o.title || o.summary || '')+'">'+icon(String(o.mimeType || '').startsWith('image/')?'image':'file')+'<span><strong>'+esc(o.filename || o.title || '任务结果')+'</strong></span></button>').join('')+(files.length?'':'<p class="dots-panel-empty">任务产出会显示在这里</p>')+(outputs.length>3?'<button class="dots-show-more" type="button" data-dots-show-outputs>'+icon('more')+(outputExpanded?'收起':'显示更多')+'</button>':'')+'</section>'+
      (activityError?'<p class="dots-dialog-error" role="alert">'+esc(activityError)+'</p>':'');
    panel.scrollTop = top; positionPanel(); C.voiceUpdated?.(voiceFocus);
  }
  function scheduleDescription(s) {
    const repeats = {once:'仅一次',daily:'每天',weekdays:'工作日',weekly:'每周',monthly:'每月'};
    return (repeats[s.repeat] || '定时任务')+(s.time?' · '+s.time:'');
  }
  function render(value) {
    snapshot = value;
    const panel = $('dotsActivity'), button = $('dotsTasksButton'); if (!panel) return;
    $('dotsView')?.classList.toggle('has-activity-panel',!!value.drawerOpen);
    if(!value.drawerOpen&&previewOpen())closeDialog();
    panel.hidden = !value.drawerOpen; button?.setAttribute('aria-expanded', String(value.drawerOpen)); button?.classList.toggle('is-selected', !!value.drawerOpen);
    if (value.drawerOpen) {
      const sig = JSON.stringify([value.manager?.activityCursor,value.tasks]);
      if (!lastOpen || sig !== activitySignature) { activitySignature = sig; loadActivity(!lastOpen); }
      renderPanel();
      if (!refreshTimer) refreshTimer = setInterval(() => { if (snapshot.drawerOpen && !document.hidden) loadActivity(true); }, 10000);
    } else { clearInterval(refreshTimer); refreshTimer = null; savedSignature = ''; }
    positionPet();
    lastOpen = !!value.drawerOpen;
  }
  function makeDialog(id, cls) {
    let node = $(id); if (node) return node;
    node = document.createElement('div'); node.id = id; node.hidden = true; node.className = 'wb-modal dots-dialog-overlay '+cls;
    document.body.appendChild(node); return node;
  }
  function showDialog(dialog, target) {
    if(dialog!==conversationDialog){stopReading();clearInterval(conversationTimer);conversationTimer=null;}
    if (currentModal && currentModal !== dialog) currentModal.hidden = true;
    else if (!currentModal) { const focused=document.activeElement;returnFocus=focused?.closest('.dots-menu')?.querySelector('[data-dots-more]') || (focused?.getClientRects().length?focused:$('dotsTasksButton')); }
    currentModal = dialog; dialog.hidden = false; dialog.tabIndex=-1; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true');
    C.scheduleNative?.(); requestAnimationFrame(() => (target || dialog.querySelector('input,button,textarea,select') || dialog)?.focus({preventScroll:true}));
    positionPet();
  }
  function closeDialog() {
    if (!currentModal && previewOpen()) {
      stopReading();conversationDialog.hidden=true;conversationDialog.classList.remove('is-inline');document.body.appendChild(conversationDialog);
      $('dotsActivity')?.classList.remove('is-conversation-preview');conversationVersion++;
      clearInterval(conversationTimer);conversationTimer=null;savedSignature='';renderPanel();C.scheduleNative?.();$('dotsTasksButton')?.focus({preventScroll:true});return;
    }
    if (!currentModal) return;
    if (scheduleBusy) return;
    if(currentModal===conversationDialog)stopReading();
    currentModal.hidden = true; currentModal = null; conversationVersion++;
    clearInterval(conversationTimer);conversationTimer=null;
    if(previewOpen()){clearInterval(conversationTimer);conversationTimer=setInterval(refreshConversation,4000);}
    C.scheduleNative?.();const target=returnFocus?.isConnected&&returnFocus.getClientRects().length?returnFocus:$('dotsTasksButton');target?.focus({preventScroll:true});
    positionPet();
  }
  // 连接器与事件订阅共用同一套列表样式：图标 · 名称 · 一行说明 · 右侧状态或操作。
  const connectorGlyph={mail:'M4 6h16v12H4zM4 7l8 6 8-6',calendar:'M5 6h14v13H5zM5 10h14M9 4v4M15 4v4',dev:'M9 8l-4 4 4 4M15 8l4 4-4 4',feeds:'M5 19a1 1 0 1 0 0-.01M5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14',devices:'M4 5h16v11H4zM9 20h6M12 16v4',messaging:'M5 5h14v10H9l-4 4z',docs:'M7 4h7l4 4v12H7zM14 4v4h4',custom:'M10 4h4v3a2 2 0 0 0 4 0V4h2v6h-3a2 2 0 0 0 0 4h3v6h-6v-3a2 2 0 0 0-4 0v3H4v-6h3a2 2 0 0 0 0-4H4V4z',builtin:'M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z'};
  const glyph=c=>'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(connectorGlyph[c]||connectorGlyph.builtin)+'"/></svg>';
  const providerCategory={github:'dev',email:'mail','google-calendar':'calendar',rss:'feeds'};
  const sourceRow=({id,icon,name,line,side,more,open,state})=>'<li class="dots-src'+(state?' is-'+state:'')+(open?' is-open':'')+'"'+(id?' data-src="'+esc(id)+'"':'')+'><div class="dots-src-row"'+(more!==undefined?' data-src-toggle role="button" tabindex="0" aria-expanded="'+!!open+'"':'')+'>'+(String(icon||'').startsWith('logo:')?'<span class="dots-src-icon dots-src-logo"><img src="/assets/connector-logos/'+esc(icon.slice(5))+'.png" alt="" loading="lazy"></span>':'<span class="dots-src-icon">'+glyph(icon)+'</span>')+'<span class="dots-src-text"><strong>'+esc(name)+'</strong>'+(line?'<small>'+esc(line)+'</small>':'')+'</span><span class="dots-src-side">'+side+'</span></div>'+(open&&more?'<div class="dots-src-more">'+more+'</div>':'')+'</li>';
  const stateLabel=(text,state)=>'<span class="dots-src-state is-'+esc(state)+'"><i></i>'+esc(text)+'</span>';
  // 事件订阅：只列出已订阅的来源；新增订阅在 Dots 对话里完成。
  async function openSubscriptions() {
    try {
      const result = await api('/subscriptions');
      const labels = {github:'GitHub',email:'邮箱','google-calendar':'Google 日历',rss:'RSS'};
      const statusOf = s => !s.enabled ? ['已暂停','paused'] : ['backoff','error','failed','waiting_authorization'].includes(s.status) ? ['需要处理','error'] : ['接收中','connected'];
      const detail = s => s.repository || s.address || (Array.isArray(s.feeds) ? s.feeds.length+' 个源' : '') || (s.calendarId && s.calendarId !== 'primary' ? s.calendarId : '');
      const dialog = makeDialog('dotsSubscriptionsDialog','dots-conversation-overlay');
      dialog.innerHTML = '<section class="dots-conversation-card dots-sources-card"><header><div><h2>事件订阅</h2><small>在对话里告诉 Dots 想订阅什么</small></div><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header><div data-subscription-list></div><p role="alert" class="dots-dialog-error" data-subscription-error hidden></p></section>';
      showDialog(dialog, dialog);
      let subscriptions = result.subscriptions || [];
      const draw = () => {
        const list = dialog.querySelector('[data-subscription-list]'), active = subscriptions.filter(s => s.configured);
        list.innerHTML = active.length ? '<ul class="dots-src-list">'+active.map(s => { const [text,state]=statusOf(s); return sourceRow({icon:providerCategory[s.provider],name:labels[s.provider]||s.provider,line:detail(s),state,side:stateLabel(text,state)+'<button type="button" class="dots-src-button" data-remove-subscription="'+esc(s.provider)+'">取消</button>'}); }).join('')+'</ul>' : '<p class="dots-src-empty">还没有订阅</p>';
        list.querySelectorAll('[data-remove-subscription]').forEach(button => {
          button.onclick = async () => {
            if (!await window.shiyan.confirmAction('取消这项订阅？','之后可以随时重新订阅。','取消订阅')) return;
            const error = dialog.querySelector('[data-subscription-error]'); error.hidden = true; button.disabled = true;
            try { subscriptions = (await api('/subscriptions/'+button.dataset.removeSubscription,'DELETE')).subscriptions || []; draw(); }
            catch (cause) { error.textContent = cause.message; error.hidden = false; button.disabled = false; }
          };
        });
      };
      draw();
    } catch(error) { C.showError(error); }
  }
  // 连接器：微信 + MCP（常用插件一键授权，或手动填写地址绑定）。目录和状态由服务器给出，三端一致。
  async function openConnectors(focusId) {
    const dialog = makeDialog('dotsConnectorsDialog','dots-conversation-overlay');
    dialog.innerHTML = '<section class="dots-conversation-card dots-sources-card"><header><div><h2>连接器</h2><small data-connectors-summary>正在读取…</small></div><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header><p class="dots-src-notice" data-connector-notice hidden></p><div class="dots-src-body" data-connector-body><div class="dots-src-skeleton"></div><div class="dots-src-skeleton"></div><div class="dots-src-skeleton"></div></div><p role="alert" class="dots-dialog-error" data-connector-error hidden></p></section>';
    showDialog(dialog, dialog);
    let data, expanded = focusId || '', adding = false, busy = '', pollTimer = null, pollUntil = 0, confirming = '', showTools = '', noticeTimer = null;
    let spongeStatus = null, spongeBusy = false, spongeError = '', spongeFallback = '', spongePendingUntil = 0, spongePollTimer = null, spongeConfirm = false;
    const errorBox = dialog.querySelector('[data-connector-error]'), noticeBox = dialog.querySelector('[data-connector-notice]');
    const fail = cause => { errorBox.textContent = cause?.message || String(cause); errorBox.hidden = false; };
    const notice = (html, autoHide) => { clearTimeout(noticeTimer); noticeBox.innerHTML = html || ''; noticeBox.hidden = !html; if (html && autoHide) noticeTimer = setTimeout(() => notice(''), 5000); };
    const chevron = '<svg class="dots-src-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
    const hues = [212,262,152,24,338,190,45,290];
    const mono = name => { let h = 0; for (const ch of String(name)) h = (h*31 + ch.codePointAt(0)) >>> 0; return '<span class="dots-src-icon dots-src-mono" style="--mono-hue:'+hues[h % hues.length]+'">'+esc(String(name).trim().charAt(0).toUpperCase())+'</span>'; };
    // 每个插件点开都先说明：连上后 Dots 能做什么、怎么连接（去官网授权 / 需要 Key / 直接可用），再给出连接或断开操作。
    const aboutHTML = (abilities, example) => (abilities||[]).length ? '<p class="dots-src-label">连上后，Dots 可以</p><ul class="dots-src-abilities">'+abilities.map(a=>'<li>'+esc(a)+'</li>').join('')+'</ul>'+(example?'<p class="dots-src-example">比如对 Dots 说：“'+esc(example)+'”</p>':'') : '';
    const spaced = name => (/^[A-Za-z0-9]/.test(name)?' ':'')+name+(/[A-Za-z0-9]$/.test(name)?' ':'');
    const confirmHTML = (name, act) => '<div class="dots-src-confirm" role="group" aria-label="确认断开"><span>断开后 Dots 就不能再用'+esc(spaced(name))+'了，之后可以随时重新连接。</span><div class="dots-src-actions"><button type="button" class="dots-src-button" data-confirm-cancel>取消</button><button type="button" class="dots-src-button is-danger" '+act+'>确定断开</button></div></div>';
    const mcpRow = (c, entry) => {
      const id = entry ? entry.id : c.id, conn = entry ? entry.connector : c, state = entry ? entry.state : c.state, name = entry ? entry.name : c.name;
      const open = expanded === id;
      const line = state === 'connected' ? (conn?.toolCount ? '已连接 · 可用 '+conn.toolCount+' 个工具' : '已连接') : state === 'error' ? (conn?.error || '连接异常，需要重新连接') : state === 'authorizing' ? '等待你在浏览器里完成授权' : entry ? entry.summary : (c.url || '');
      let side = '';
      if (busy === id) side = '<span class="dots-src-state"><i></i>'+(state==='connected'?'正在处理…':'连接中…')+'</span>';
      else if (state === 'connected') side = stateLabel('已连接','connected')+chevron;
      else if (state === 'error') side = stateLabel('需要重连','error')+chevron;
      else if (state === 'authorizing') side = stateLabel('待授权','paused')+chevron;
      else side = open ? chevron : '<button type="button" class="dots-src-button is-primary" data-mcp-act="open">连接</button>';
      let more = '';
      if (open) {
        more = entry ? aboutHTML(entry.abilities, entry.example) : '';
        if (state === 'connected') {
          const tools = conn?.tools || [];
          more += '<p class="dots-src-status">'+(tools.length?'Dots 现在可以使用它的 '+tools.length+' 个工具。'+(showTools===id?'':'<button type="button" class="dots-src-link" data-mcp-act="tools">查看工具名</button>'):'已连接。')+'</p>'
            + (showTools===id&&tools.length?'<div class="dots-src-tools">'+tools.slice(0,60).map(t=>'<code>'+esc(t)+'</code>').join('')+'</div>':'')
            + (!entry&&c.url?'<p class="dots-src-url">'+esc(c.url)+'</p>':'')
            + (confirming===id ? confirmHTML(name,'data-mcp-act="remove"') : '<div class="dots-src-actions"><button type="button" class="dots-src-button" data-mcp-act="refresh">重新检查</button><button type="button" class="dots-src-button is-danger" data-mcp-act="ask-remove">断开连接</button></div>');
        } else if (entry) {
          more += '<p class="dots-src-label">怎么连接</p><p class="dots-src-howto">'+esc(entry.howto||entry.tokenHint||'')+'</p>';
          if (entry.auth === 'token') more += '<form class="dots-mcp-form" data-mcp-token><input name="token" type="password" autocomplete="off" placeholder="'+(entry.tokenLabel?'粘贴'+entry.tokenLabel:(entry.tokenParam?'粘贴 Key':'粘贴访问令牌'))+'" required><div class="dots-src-actions"><button type="button" class="dots-src-button" data-mcp-act="collapse">取消</button><button type="submit" class="dots-src-button is-primary">连接</button></div></form>';
          else more += '<div class="dots-src-actions"><button type="button" class="dots-src-button" data-mcp-act="collapse">取消</button><button type="button" class="dots-src-button is-primary" data-mcp-act="connect">'+(entry.auth==='oauth'?(state==='authorizing'?'重新打开授权页':'去授权'):'连接')+'</button></div>';
          if (state === 'error' || state === 'authorizing') more += confirming===id ? confirmHTML(name,'data-mcp-act="remove"') : '<div class="dots-src-actions is-secondary"><button type="button" class="dots-src-link is-danger" data-mcp-act="ask-remove">移除这个连接</button></div>';
        } else {
          more += (c.url?'<p class="dots-src-url">'+esc(c.url)+'</p>':'') + (confirming===id ? confirmHTML(name,'data-mcp-act="remove"') : '<div class="dots-src-actions"><button type="button" class="dots-src-button is-primary" data-mcp-act="connect">重新连接</button><button type="button" class="dots-src-button is-danger" data-mcp-act="ask-remove">移除</button></div>');
        }
      }
      return '<li class="dots-src is-'+esc(state)+(open?' is-open':'')+'" data-mcp="'+esc(id)+'"'+(entry?' data-mcp-catalog="1"':'')+'><div class="dots-src-row" data-src-toggle role="button" tabindex="0" aria-expanded="'+open+'">'+(entry?(entry.logo===false?mono(name):'<span class="dots-src-icon dots-src-logo"><img src="/assets/connector-logos/'+esc(id)+'.png" alt="" loading="lazy"></span>'):mono(name))+'<span class="dots-src-text"><strong>'+esc(name)+'</strong><small>'+esc(line)+'</small></span><span class="dots-src-side">'+side+'</span></div>'+(more?'<div class="dots-src-more">'+more+'</div>':'')+'</li>';
    };
    const weixinRow = c => {
      const open = expanded === c.id, connected = c.state !== 'available';
      let more = aboutHTML(c.abilities);
      if (!connected) more += '<p class="dots-src-label">怎么连接</p><p class="dots-src-howto">'+esc(c.howto||c.detail||'')+'</p><div class="dots-src-actions"><button type="button" class="dots-src-button" data-mcp-act="collapse">取消</button><button type="button" class="dots-src-button is-primary" data-weixin-act="connect">扫码连接</button></div>';
      else {
        const acts = (c.actions||[]).map(a=>({push_on:'<button type="button" class="dots-src-button" data-weixin-act="push_on">提醒推送到微信</button>',push_off:'<button type="button" class="dots-src-button" data-weixin-act="push_off">停止推送提醒</button>'})[a]||'').join('');
        more += (c.state==='error'?'<p class="dots-src-status">微信登录已失效，需要重新扫码。</p>':'')
          + (confirming===c.id ? confirmHTML('微信','data-weixin-act="disconnect"').replace('断开后 Dots 就不能再用微信了','解绑后就不能在微信里和 Dots 对话了').replace('确定断开','确定解绑') : '<div class="dots-src-actions">'+(c.state==='error'?'<button type="button" class="dots-src-button is-primary" data-weixin-act="connect">重新扫码</button>':'')+acts+'<button type="button" class="dots-src-button is-danger" data-weixin-act="ask-disconnect">解绑</button></div>');
      }
      return sourceRow({id:c.id,icon:'logo:wechat',name:c.name,line:connected?(c.status||c.summary):c.summary,state:connected?c.state:'',open,more,side:connected?stateLabel(c.status,c.state)+chevron:(open?chevron:'<button type="button" class="dots-src-button is-primary" data-weixin-act="open">连接</button>')});
    };
    const addForm = () => adding ? '<form class="dots-mcp-form dots-mcp-add" data-mcp-add><label><span>名称</span><input name="name" maxlength="40" placeholder="比如：公司知识库" required></label><label><span>地址</span><input name="url" type="url" placeholder="https://example.com/mcp" required></label><label><span>访问令牌（可选）</span><input name="token" type="password" autocomplete="off" placeholder="需要授权的服务会自动打开授权页面"></label><div class="dots-src-actions"><button type="button" class="dots-src-button" data-mcp-cancel>取消</button><button type="submit" class="dots-src-button is-primary">连接</button></div></form>' : '<button type="button" class="dots-src-add" data-mcp-add-open>'+icon('add')+'<span>添加 MCP</span></button>';
    const spongeRow = () => {
      const connected = spongeStatus?.connected === true;
      const pending = spongePendingUntil > Date.now();
      const line = connected ? (spongeStatus?.needsPairing ? '已连接 · 等待设备绑定' : '已连接') : pending ? '等待完成授权…' : spongeStatus ? '尚未连接' : '正在读取连接状态…';
      const open = expanded === 'sponge';
      const actions = connected
        ? '<button type="button" class="dots-src-button is-primary" data-sponge-act="manage">打开海绵宝宝</button><button type="button" class="dots-src-button" data-sponge-act="refresh">刷新状态</button><button type="button" class="dots-src-button is-danger" data-sponge-act="ask-disconnect">断开连接</button>'
        : '<button type="button" class="dots-src-button is-primary" data-sponge-act="connect">连接海绵宝宝</button><button type="button" class="dots-src-button" data-sponge-act="refresh">刷新状态</button>';
      const confirm = spongeConfirm ? '<div class="dots-src-confirm" role="group" aria-label="确认断开"><span>断开后，拾燕将无法再访问已授权的设备。</span><div class="dots-src-actions"><button type="button" class="dots-src-button" data-sponge-act="cancel">取消</button><button type="button" class="dots-src-button is-danger" data-sponge-act="disconnect">确定断开</button></div></div>' : '';
      const more = open ? '<p class="dots-src-label">插件功能</p><p class="dots-src-howto">连接后，Dots 可以通过海绵宝宝访问你授权的电脑和设备。</p><div class="dots-src-actions">'+(spongeBusy?'<span class="dots-src-state"><i></i>正在处理…</span>':actions)+'</div>'+(spongeError?'<p class="dots-sponge-error" role="alert">'+esc(spongeError)+'</p>':'')+(spongeFallback?'<p class="dots-sponge-fallback"><a href="'+esc(spongeFallback)+'" data-sponge-fallback target="_blank" rel="noopener noreferrer">继续授权</a></p>':'')+confirm : '';
      return '<li class="dots-src is-'+(connected?'connected':'available')+(open?' is-open':'')+'" data-src="sponge"><div class="dots-src-row" data-src-toggle role="button" tabindex="0" aria-expanded="'+open+'"><span class="dots-src-icon dots-src-logo"><img src="/assets/connector-logos/sponge.svg" alt="" loading="lazy"></span><span class="dots-src-text"><strong>海绵宝宝</strong><small>'+esc(line)+'</small></span><span class="dots-src-side">'+(connected?stateLabel('已连接','connected')+chevron:open?chevron:'<button type="button" class="dots-src-button is-primary" data-sponge-act="open">连接</button>')+'</span></div>'+(more?'<div class="dots-src-more">'+more+'</div>':'')+'</li>';
    };
    const draw = () => {
      const plugins = data.plugins||[], custom = data.custom||[], weixin = data.connectors||[];
      const count = (data.summary?.connected)||0;
      dialog.querySelector('[data-connectors-summary]').textContent = count ? '已连接 '+count+' 个' : '让 Dots 使用你的应用和工具';
      const sorted = [...plugins].sort((a,b)=>(b.state==='connected')-(a.state==='connected'));
      const groups = new Map();
      const pluginCategory = plugin => {
        const supplied = String(plugin.category || plugin.group || '').trim();
        if (supplied) return supplied;
        const name = String(plugin.name || plugin.id || '').toLowerCase();
        if (/微信|飞书|钉钉|企业微信|slack|discord|telegram|邮件|邮箱/.test(name)) return '沟通协作';
        if (/腾讯文档|文档|表格|notion|语雀|石墨|drive|dropbox|网盘|日历|calendar/.test(name)) return '办公与知识管理';
        if (/github|gitee|gitlab|代码|git|开发|终端|服务器/.test(name)) return '开发与运维';
        if (/高德|地图|搜索|浏览器|网页|搜索引擎|天气/.test(name)) return '搜索与信息';
        if (/支付|财务|发票|银行|订单|电商|淘宝|京东/.test(name)) return '业务与数据';
        return '其他插件';
      };
      for (const plugin of sorted) {
        const category = pluginCategory(plugin);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(plugin);
      }
      const categorized = [...groups].map(([category, entries]) => '<h3>'+esc(category)+'</h3><ul class="dots-src-list">'+entries.map(p=>mcpRow(null,p)).join('')+'</ul>').join('');
      const body = dialog.querySelector('[data-connector-body]');
      const html = (weixin.length?'<h3>聊天与通讯</h3><ul class="dots-src-list">'+weixin.map(weixinRow).join('')+'</ul>':'')+
        '<h3>设备与远程控制</h3><ul class="dots-src-list">'+spongeRow()+'</ul>'+
        categorized+
        '<h3>自定义插件</h3>'+(custom.length?'<ul class="dots-src-list">'+custom.map(c=>mcpRow(c,null)).join('')+'</ul>':'')+addForm();
      // 状态轮询可能每 3 秒触发一次 draw；内容未变化时不要重建整个列表，
      // 否则所有 img 都会被销毁并重新加载，表现为插件图标高频闪烁。
      if (body.__connectorHTML !== html) { body.innerHTML = html; body.__connectorHTML = html; }
      dialog.querySelector('[data-mcp-add] input[name=name]')?.focus();
      const authorizing = plugins.some(p=>p.state==='authorizing') || custom.some(c=>c.state==='authorizing');
      clearTimeout(pollTimer);
      if (authorizing && Date.now() < pollUntil && dialog.isConnected && !dialog.hidden) pollTimer = setTimeout(() => load().catch(()=>{}), 3000);
    };
    const scheduleSpongePoll = () => {
      clearTimeout(spongePollTimer); spongePollTimer = null;
      if (spongePendingUntil <= Date.now() || !dialog.isConnected || dialog.hidden) return;
      spongePollTimer = setTimeout(() => refreshSponge(), 3000);
    };
    const refreshSponge = async () => {
      try {
        const service = window.ShiYanSpongeIntegration;
        if (!service) throw new Error('海绵宝宝插件尚未加载，请重新打开连接器。');
        spongeStatus = await service.status();
        spongeError = '';
        if (spongeStatus?.connected === true) { spongePendingUntil = 0; spongeFallback = ''; }
      } catch (cause) { spongeError = cause?.message || '读取设备状态失败，请重试。'; }
      draw(); scheduleSpongePoll();
    };
    const load = async () => { data = await api('/connectors'); draw(); await refreshSponge(); };
    const openAuth = (url, popup) => {
      const native = !!window.webkit?.messageHandlers?.native;
      if (native) window.ShiYanPlatform?.postNative?.('openExternal',{url});
      else if (popup && !popup.closed) popup.location.href = url;
      else window.open(url, '_blank', 'noopener');
      notice('已在浏览器打开授权页面，完成后回到这里。<a href="'+esc(url)+'" target="_blank" rel="noopener">没有打开？点这里</a>');
      pollUntil = Date.now() + 5*60_000;
    };
    const connect = async (payload, id, oauthLikely) => {
      let popup = null;
      if (oauthLikely && !window.webkit?.messageHandlers?.native) { try { popup = window.open('about:blank','_blank'); if (popup) popup.opener = null; } catch {} }
      busy = id; errorBox.hidden = true; draw();
      try {
        const result = await api('/connectors/mcp','POST',payload);
        if (result.authorizeUrl) openAuth(result.authorizeUrl, popup); else { popup?.close(); notice(''); }
        adding = false; expanded = result.state === 'connected' ? id : expanded;
      } catch (cause) { popup?.close(); fail(cause); }
      finally { busy = ''; await load().catch(fail); }
    };
    const toggle = row => { const id = row.closest('[data-mcp],[data-src]'); const key = id?.dataset.mcp || id?.dataset.src; if (!key) return; expanded = expanded === key ? '' : key; confirming = ''; showTools = ''; draw(); };
    dialog.addEventListener('keydown', event => { const row = event.target.closest('[data-src-toggle]'); if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(row); } });
    dialog.addEventListener('submit', async event => {
      event.preventDefault(); const form = event.target;
      if (form.matches('[data-mcp-add]')) { const f = new FormData(form); const name = String(f.get('name')||'').trim(); await connect({name,url:String(f.get('url')||'').trim(),token:String(f.get('token')||'').trim()}, 'mcp-'+name.toLowerCase(), !String(f.get('token')||'').trim()); }
      if (form.matches('[data-mcp-token]')) { const id = form.closest('[data-mcp]').dataset.mcp; await connect({catalogId:id,token:String(new FormData(form).get('token')||'').trim()}, id, false); }
    });
    dialog.addEventListener('click', async event => {
      if (event.target.closest('[data-mcp-add-open]')) { adding = true; draw(); return; }
      if (event.target.closest('[data-mcp-cancel]')) { adding = false; draw(); return; }
      if (event.target.closest('[data-confirm-cancel]')) { confirming = ''; draw(); return; }
      const weixinAct = event.target.closest('[data-weixin-act]')?.dataset.weixinAct;
      const spongeAct = event.target.closest('[data-sponge-act]')?.dataset.spongeAct;
      const spongeFallbackLink = event.target.closest('[data-sponge-fallback]');
      const mcpItem = event.target.closest('[data-mcp]'), mcpAct = event.target.closest('[data-mcp-act]')?.dataset.mcpAct;
      try {
        if (spongeFallbackLink) {
          const service = window.ShiYanSpongeIntegration;
          if (!service?.openAuthorization(spongeFallbackLink.href)) throw new Error('暂时无法打开海绵宝宝授权页面。');
          event.preventDefault(); return;
        }
        if (spongeAct) {
          const service = window.ShiYanSpongeIntegration;
          if (!service) throw new Error('海绵宝宝插件尚未加载，请重新打开连接器。');
          if (spongeAct === 'cancel') { spongeConfirm = false; draw(); return; }
          if (spongeAct === 'ask-disconnect') { spongeConfirm = true; draw(); return; }
          if (spongeAct === 'manage' || spongeAct === 'open') { if (!service.manage()) throw new Error('暂时无法打开海绵宝宝页面。'); return; }
          if (spongeAct === 'refresh') { spongeBusy = true; spongeError = ''; draw(); await refreshSponge(); spongeBusy = false; draw(); return; }
          if (spongeAct === 'connect') {
            spongeBusy = true; spongeError = ''; spongeFallback = ''; draw();
            try {
              const result = await service.connect();
              spongeFallback = result.fallbackUrl || '';
              spongePendingUntil = Date.now() + 5*60_000;
              spongeError = result.opened ? '请在新页面登录海绵宝宝并完成设备绑定。' : '浏览器阻止了自动打开，请使用下方链接继续。';
            } finally { spongeBusy = false; }
            await refreshSponge(); return;
          }
          if (spongeAct === 'disconnect') {
            spongeBusy = true; spongeError = ''; draw();
            try { await service.disconnect(); spongeStatus = {connected:false,devices:[]}; spongePendingUntil = 0; spongeFallback = ''; spongeConfirm = false; }
            finally { spongeBusy = false; }
            draw(); return;
          }
        }
        if (weixinAct) {
          errorBox.hidden = true;
          if (weixinAct === 'open') { expanded = 'wechat'; confirming = ''; draw(); return; }
          if (weixinAct === 'ask-disconnect') { confirming = 'wechat'; draw(); return; }
          if (weixinAct === 'connect') { closeDialog(); await openWeixinLogin(() => {}); return; }
          if (weixinAct === 'disconnect') { busy = 'wechat'; await api('/weixin','DELETE'); busy = ''; confirming = ''; expanded = ''; notice('已解绑微信。想再用时，点微信右边的「连接」重新扫码即可。', true); }
          if (weixinAct === 'push_on' || weixinAct === 'push_off') await api('/weixin','PATCH',{enabled:weixinAct==='push_on'});
          await load(); return;
        }
        if (mcpItem && mcpAct) {
          const id = mcpItem.dataset.mcp, catalog = mcpItem.hasAttribute('data-mcp-catalog'), entry = catalog ? data.plugins.find(p=>p.id===id) : null, custom = catalog ? null : data.custom.find(c=>c.id===id);
          errorBox.hidden = true;
          if (mcpAct === 'collapse') { expanded = ''; confirming = ''; draw(); return; }
          if (mcpAct === 'open') { expanded = id; confirming = ''; showTools = ''; draw(); dialog.querySelector('[data-mcp="'+CSS.escape(id)+'"] [data-mcp-token] input')?.focus(); return; }
          if (mcpAct === 'tools') { showTools = id; draw(); return; }
          if (mcpAct === 'ask-remove') { confirming = id; draw(); dialog.querySelector('[data-mcp="'+CSS.escape(id)+'"] [data-confirm-cancel]')?.focus(); return; }
          if (mcpAct === 'connect') {
            if (entry?.auth === 'token') { expanded = id; draw(); dialog.querySelector('[data-mcp-token] input')?.focus(); return; }
            if (custom) { adding = true; draw(); const form = dialog.querySelector('[data-mcp-add]'); form.name.value = custom.name; form.url.value = custom.url; return; }
            await connect({catalogId:id}, id, entry?.auth === 'oauth'); return;
          }
          if (mcpAct === 'remove') { const name = entry?.name || custom?.name || id; busy = id; draw(); try { await api('/connectors/mcp/'+encodeURIComponent(id),'DELETE'); } finally { busy = ''; } confirming = ''; expanded = ''; notice('已断开'+esc(spaced(name).replace(/ $/,''))+'。想再用时，点它右边的「连接」即可。', true); }
          if (mcpAct === 'refresh') { busy = id; draw(); try { const r = await api('/connectors/mcp/'+encodeURIComponent(id)+'/refresh','POST',{}); notice(r.connector?.state === 'connected' ? '连接正常，可用 '+(r.connector.toolCount||0)+' 个工具。' : '连接有问题：'+esc(r.connector?.error||'请重新连接'), true); } finally { busy = ''; } }
          await load(); return;
        }
        const toggleRow = event.target.closest('[data-src-toggle]'); if (toggleRow) toggle(toggleRow);
      } catch (cause) { fail(cause); }
    });
    // 连接器窗口关掉后（包括转去扫码连接微信时）不再在后台刷新列表。
    const refocus = () => { if (document.visibilityState === 'visible' && dialog.isConnected && !dialog.hidden && data) { pollUntil = Math.max(pollUntil, Date.now() + 60_000); load().catch(()=>{}); } };
    document.addEventListener('visibilitychange', refocus); window.addEventListener('focus', refocus);
    try { await load(); } catch (cause) { fail(cause); dialog.querySelector('[data-connector-body]').innerHTML=''; }
  }
  // 微信扫码绑定：二维码由服务器生成，状态每 2 秒轮询一次。
  async function openWeixinLogin(onDone) {
    const dialog = makeDialog('dotsWeixinDialog','dots-conversation-overlay');
    let timer = null, closed = false, last = '';
    const stop = () => { closed = true; clearTimeout(timer); };
    const text = s => s.state === 'connected' ? '绑定成功' : s.state === 'login_expired' ? (s.message || '二维码已过期') :
      s.loginStatus === 'scaned' || s.loginStatus === 'scaned_but_redirect' ? '已扫码，请在手机微信上点“确认”' :
      s.needsVerifyCode ? '请输入手机微信上显示的数字' : '用手机微信扫一扫';
    const draw = s => {
      const key = JSON.stringify([s.state, s.loginStatus, s.needsVerifyCode, s.message, (s.qrSvg || '').length]); if (key === last) return; last = key;
      const done = s.state === 'connected', expired = s.state === 'login_expired';
      dialog.innerHTML = '<section class="dots-conversation-card dots-weixin-card'+(done?' is-done':'')+'"><header><h2>连接微信</h2><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header><div class="dots-weixin-body">'
        + '<div class="dots-weixin-qr'+(done?' is-done':expired?' is-expired':s.loginStatus==='scaned'?' is-scanned':'')+'">'
        + (done ? '<div class="dots-weixin-ok"><svg viewBox="0 0 24 24"><path d="M5.5 12.5l4 4 9-9"/></svg></div>' : expired ? '<div class="dots-weixin-expired-state"><strong>二维码已过期</strong><button type="button" class="dots-white-button" data-weixin-refresh>重新获取</button></div>' : (s.qrSvg || ''))
        + '</div>'
        + (expired ? '' : '<p class="dots-weixin-status" role="status">'+esc(text(s))+(s.message && !done ? '<small>'+esc(s.message)+'</small>' : '')+'</p>')
        + (s.needsVerifyCode ? '<form class="dots-weixin-verify" data-weixin-verify><input inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="one-time-code" aria-label="验证数字" placeholder="手机上显示的数字" required><button type="submit" class="dots-white-button">确定</button></form>' : '')
        + (done ? '<p class="dots-weixin-tip">现在可以在微信里直接给 '+esc(name())+' 发消息了，文字、语音、图片和文件都可以。<br>简报和提醒也会同步到微信，可以在连接器里关闭。</p><button type="button" class="dots-white-button dots-weixin-done" data-dots-close-dialog>完成</button>'
                : '<ol class="dots-weixin-steps"><li>打开手机微信，扫描上方二维码</li><li>在手机上点“确认”授权</li><li>绑定后在微信里直接和 Dots 对话</li></ol><p class="dots-weixin-tip">需要微信 8.0.70 及以上版本。只有你本人能和它对话，不能拉进群。</p>')
        + '</div></section>';
      dialog.querySelector('[data-weixin-verify] input')?.focus();
    };
    const poll = async () => {
      if (closed || dialog.hidden || !dialog.isConnected) return stop();
      try { const s = await api('/weixin'); draw(s); if (s.state === 'connected') { stop(); onDone?.(); return; } if (s.state === 'login_expired') return; }
      catch {}
      timer = setTimeout(poll, 2000);
    };
    const start = async () => { last = ''; draw({state:'login',loginStatus:'wait',qrSvg:'<div class="dots-weixin-loading"></div>'}); draw(await api('/weixin/login','POST',{})); clearTimeout(timer); timer = setTimeout(poll, 1500); };
    dialog.addEventListener('click', async event => {
      if (event.target.closest('[data-dots-close-dialog]')) stop();
      if (event.target.closest('[data-weixin-refresh]')) { closed = false; try { await start(); } catch (cause) { C.showError(cause); } }
    });
    dialog.addEventListener('submit', async event => {
      if (!event.target.matches('[data-weixin-verify]')) return; event.preventDefault();
      try { draw(await api('/weixin/verify','POST',{code:event.target.querySelector('input').value.trim()})); } catch (cause) { C.showError(cause); }
    });
    showDialog(dialog, dialog);
    try { await start(); } catch (cause) { stop(); C.showError(cause); }
  }
  // Dots 权限审批：审批方式与已授权的操作。
  async function openDotsSettings() {
    const dialog = makeDialog('dotsSettingsDialog','dots-conversation-overlay');
    const modes = [['smart','智能审批','只有删除、提权、重启、推送代码等高风险操作才需要你批准，其余自动执行。'],['auto','全部自动','除提权和灾难性命令外全部自动执行，最少打扰。'],['ask','每次都问','每个需要审批的操作都等你确认。']];
    let settings, grants = [];
    const scopeText = grant => grant.scope==='always'?'一直允许':grant.scope==='task'?'仅限这个任务':grant.expiresAt?'到 '+new Date(grant.expiresAt*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
    const grantsHTML = () => grants.length ? '<ul class="dots-grant-list">'+grants.map(g=>'<li><span><strong>'+esc((g.labels||g.signatures||[]).join('、'))+'</strong><small>'+esc(scopeText(g))+(g.uses?' · 已自动执行 '+g.uses+' 次':'')+'</small></span><button type="button" data-revoke-grant="'+Number(g.id)+'">撤销</button></li>').join('')+'</ul>' : '<p class="dots-settings-empty">还没有授权过的操作。</p>';
    const draw = () => {
      dialog.innerHTML = '<section class="dots-conversation-card dots-settings-card"><header><h2>Dots 权限审批</h2><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header><div class="dots-settings-grid"><div class="dots-settings-col"><h3>审批方式</h3><div class="dots-choice-list" role="radiogroup" aria-label="审批方式">'+modes.map(([id,name,desc])=>'<button type="button" role="radio" aria-checked="'+(settings.approvalMode===id)+'" class="dots-choice'+(settings.approvalMode===id?' is-selected':'')+'" data-approval-mode="'+id+'"><i></i><span><strong>'+name+'</strong><small>'+desc+'</small></span></button>').join('')+'</div></div><div class="dots-settings-col"><h3>已授权的操作</h3>'+grantsHTML()+'</div></div><p role="alert" class="dots-dialog-error" data-settings-error hidden></p></section>';
    };
    const save = async patch => {
      const before = settings; settings = {...settings, ...patch}; draw();
      try { settings = (await api('/settings','PATCH',patch)).settings || settings; draw(); }
      catch (cause) { settings = before; draw(); const box = dialog.querySelector('[data-settings-error]'); box.textContent = cause.message; box.hidden = false; }
    };
    dialog.addEventListener('click', async event => {
      const mode = event.target.closest('[data-approval-mode]'); if (mode && mode.dataset.approvalMode !== settings.approvalMode) save({approvalMode: mode.dataset.approvalMode});
      const revoke = event.target.closest('[data-revoke-grant]');
      if (revoke) { revoke.disabled = true; try { await api('/approval-grants/'+revoke.dataset.revokeGrant,'DELETE'); grants = grants.filter(g => String(g.id) !== revoke.dataset.revokeGrant); draw(); } catch (cause) { revoke.disabled = false; C.showError(cause); } }
      if (event.target.closest('[data-open-audit]')) openAudit();
    });
    dialog.addEventListener('change', event => {
      if (event.target.matches('[data-daily-brief]')) save({dailyBrief: event.target.checked});
      if (event.target.matches('[data-daily-brief-time]') && /^\d\d:\d\d$/.test(event.target.value)) save({dailyBriefTime: event.target.value});
    });
    try { const [s, g] = await Promise.all([api('/settings'), api('/approval-grants').catch(() => ({grants: []}))]); settings = s.settings; grants = g.grants || []; draw(); showDialog(dialog, dialog); } catch (cause) { C.showError(cause); }
  }
  // 长期目标：Dots 拆成里程碑，并按你选的频率主动来问进展。
  async function openLifeGoals() {
    const dialog = makeDialog('dotsGoalsDialog','dots-conversation-overlay');
    const cadences = [['daily','每天'],['weekly','每周'],['biweekly','每两周'],['monthly','每月']];
    let goals = [], creating = false, busy = false, error = '', poll = null, adding = null;
    const when = at => at ? new Date(at*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit'}) : '';
    const shortDay = d => d ? d.slice(5).replace('-','/') : '';
    const statusText = {active:'进行中',paused:'已暂停',done:'已达成'};
    const goalHTML = g => {
      const plan = g.planState==='planning' ? '<div class="dots-goal-planning"><span></span><span></span><span></span><em>Dots 正在拟计划…</em></div>'
        : g.planState==='failed' ? '<div class="dots-goal-failed">计划没能生成。<button type="button" data-goal-replan="'+g.id+'">重试</button></div>'
        : '<ul class="dots-goal-milestones">'+g.milestones.map(m=>'<li class="'+(m.done?'is-done':'')+'"><button type="button" class="dots-goal-check" role="checkbox" aria-checked="'+!!m.done+'" data-goal-toggle="'+g.id+'" data-milestone="'+esc(m.id)+'" aria-label="'+(m.done?'标记为未完成':'标记为完成')+'"></button><span>'+esc(m.title)+'</span>'+(m.due?'<time>'+shortDay(m.due)+'</time>':'')+'<button type="button" class="dots-goal-remove" data-goal-remove-milestone="'+g.id+'" data-milestone="'+esc(m.id)+'" aria-label="删除里程碑">×</button></li>').join('')+'</ul>'+(adding===g.id?'<form class="dots-goal-add" data-goal-add="'+g.id+'"><input name="title" maxlength="120" placeholder="新的里程碑" required><input name="due" type="date"><button type="submit">添加</button></form>':'<button type="button" class="dots-goal-link" data-goal-adding="'+g.id+'">＋ 添加里程碑</button>');
      return '<article class="dots-goal is-'+esc(g.status)+'"><header><div><h3>'+esc(g.title)+'</h3>'+(g.why?'<p>'+esc(g.why)+'</p>':'')+'</div><span class="dots-goal-status">'+(statusText[g.status]||'')+'</span></header>'
        +(g.planState==='ready'?'<div class="dots-goal-progress"><progress max="100" value="'+g.progress+'" aria-label="完成度"></progress><strong>'+g.progress+'%</strong></div>':'')
        +'<p class="dots-goal-meta">'+[g.targetDate?'目标日期 '+esc(g.targetDate):'',esc(g.cadenceName)+' '+esc(g.checkinTime)+' 检查',g.nextCheckinAt?'下次：'+when(g.nextCheckinAt):''].filter(Boolean).join(' · ')+'</p>'
        +(g.planSummary&&g.planState==='ready'?'<p class="dots-goal-summary">'+esc(g.planSummary)+'</p>':'')+plan
        +'<footer>'+(g.status==='active'?'<button type="button" data-goal-status="paused" data-goal="'+g.id+'">暂停</button><button type="button" data-goal-status="done" data-goal="'+g.id+'">标记达成</button>':g.status==='paused'?'<button type="button" data-goal-status="active" data-goal="'+g.id+'">恢复</button>':'<button type="button" data-goal-status="archived" data-goal="'+g.id+'">归档</button>')+(g.planState==='ready'?'<button type="button" data-goal-replan="'+g.id+'">重新规划</button>':'')+'<button type="button" class="is-danger" data-goal-delete="'+g.id+'">删除</button></footer></article>';
    };
    const draw = () => {
      const form = creating ? '<form class="dots-goal-form" data-goal-create><label><span>目标</span><input name="title" maxlength="120" required placeholder="比如：明年 6 月前日语过 N3"></label><label><span>为什么（可选）</span><textarea name="why" maxlength="500" rows="2" placeholder="Dots 会用它来鼓励你、调整计划"></textarea></label><div class="dots-goal-form-row"><label><span>目标日期</span><input name="targetDate" type="date"></label><label><span>检查频率</span><select name="cadence">'+cadences.map(([v,l])=>'<option value="'+v+'"'+(v==='weekly'?' selected':'')+'>'+l+'</option>').join('')+'</select></label><label><span>时间</span><input name="checkinTime" type="time" value="20:00" required></label></div><div class="dots-goal-form-actions"><button type="button" data-goal-cancel>取消</button><button type="submit" class="is-primary"'+(busy?' disabled':'')+'>'+(busy?'正在创建…':'创建并让 Dots 拟计划')+'</button></div></form>' : '<button type="button" class="dots-goal-new" data-goal-new>＋ 新目标</button>';
      dialog.innerHTML = '<section class="dots-conversation-card dots-goals-card"><header><h2>目标</h2><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header>'+form+(error?'<p class="dots-dialog-error" role="alert">'+esc(error)+'</p>':'')+'<div class="dots-goal-list">'+goals.map(goalHTML).join('')+'</div>'+(!goals.length&&!creating?'<p class="dots-settings-empty">还没有目标。</p>':'')+'</section>';
      if (creating) dialog.querySelector('[data-goal-create] input[name=title]')?.focus();
      if (adding) dialog.querySelector('[data-goal-add] input[name=title]')?.focus();
    };
    const schedulePoll = () => { clearTimeout(poll); if (goals.some(g => g.planState === 'planning') && dialog.isConnected) poll = setTimeout(() => load().catch(() => {}), 3000); };
    const load = async () => { goals = (await api('/life-goals')).goals || []; draw(); schedulePoll(); };
    const replace = goal => { goals = goals.map(g => g.id === goal.id ? goal : g); draw(); schedulePoll(); };
    const act = async fn => { error = ''; try { await fn(); } catch (cause) { error = cause.message || '操作失败'; draw(); } };
    dialog.addEventListener('click', event => {
      const t = event.target.closest('button'); if (!t) return;
      if (t.matches('[data-goal-new]')) { creating = true; draw(); }
      else if (t.matches('[data-goal-cancel]')) { creating = false; draw(); }
      else if (t.matches('[data-goal-adding]')) { adding = Number(t.dataset.goalAdding); draw(); }
      else if (t.matches('[data-goal-toggle]')) act(async () => { const g = goals.find(x => x.id === Number(t.dataset.goalToggle)), m = g.milestones.find(x => x.id === t.dataset.milestone); replace((await api('/life-goals/'+g.id+'/milestones','POST',{milestoneId:m.id,done:!m.done})).goal); });
      else if (t.matches('[data-goal-remove-milestone]')) act(async () => replace((await api('/life-goals/'+t.dataset.goalRemoveMilestone+'/milestones','POST',{remove:t.dataset.milestone})).goal));
      else if (t.matches('[data-goal-status]')) act(async () => { const result = await api('/life-goals/'+t.dataset.goal,'PATCH',{status:t.dataset.goalStatus}); if (t.dataset.goalStatus === 'archived') { goals = goals.filter(g => g.id !== result.goal.id); draw(); } else replace(result.goal); });
      else if (t.matches('[data-goal-replan]')) act(async () => replace((await api('/life-goals/'+t.dataset.goalReplan+'/replan','POST',{})).goal));
      else if (t.matches('[data-goal-delete]')) { if (!confirmDelete(t)) return; act(async () => { await api('/life-goals/'+t.dataset.goalDelete,'DELETE'); goals = goals.filter(g => g.id !== Number(t.dataset.goalDelete)); draw(); }); }
    });
    // 删除需要第二次点击确认（不弹系统对话框）。
    const confirmDelete = button => { if (button.dataset.confirm) return true; button.dataset.confirm = '1'; button.textContent = '再点一次删除'; setTimeout(() => { if (button.isConnected) { delete button.dataset.confirm; button.textContent = '删除'; } }, 3000); return false; };
    dialog.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target, data = Object.fromEntries(new FormData(form));
      if (form.matches('[data-goal-create]')) act(async () => { busy = true; draw(); try { const goal = (await api('/life-goals','POST',{title:data.title,why:data.why||'',targetDate:data.targetDate||null,cadence:data.cadence,checkinTime:data.checkinTime})).goal; goals = [goal, ...goals]; creating = false; } finally { busy = false; draw(); schedulePoll(); } });
      if (form.matches('[data-goal-add]')) act(async () => { const goal = (await api('/life-goals/'+form.dataset.goalAdd+'/milestones','POST',{add:data.title,due:data.due||null})).goal; adding = null; replace(goal); });
    });
    draw(); showDialog(dialog, dialog);
    try { await load(); } catch (cause) { error = cause.message; draw(); }
  }
  // 「做过的事」：Dots 以你的名义实际做过的事，按天分组，可筛选、可加载更早。
  async function openAudit() {
    const dialog = makeDialog('dotsAuditDialog','dots-conversation-overlay');
    const filters = [['','全部'],['action','操作'],['message','消息']];
    const glyph = {action:'⌘',message:'✉',change:'⚙'};
    let category = '', items = [], next = null, loading = false, error = '';
    const day = at => { const d = new Date(at*1000), t = new Date(); const y = new Date(t); y.setDate(t.getDate()-1); return d.toDateString()===t.toDateString()?'今天':d.toDateString()===y.toDateString()?'昨天':d.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'}); };
    const draw = () => {
      let last = '', rows = '';
      for (const item of items) {
        const label = day(item.at); if (label !== last) { rows += '<li class="dots-audit-day">'+esc(label)+'</li>'; last = label; }
        rows += '<li class="dots-audit-item is-'+esc(item.category)+(item.ok===false?' is-failed':'')+'"><i aria-hidden="true">'+(glyph[item.category]||'•')+'</i><div><p><strong>'+esc(item.title)+'</strong>'+(item.ok===false?'<em>失败</em>':'')+'<time>'+new Date(item.at*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})+'</time></p>'+(item.summary?'<small>'+esc(item.summary)+'</small>':'')+(item.detail?'<code>'+esc(item.detail)+'</code>':'')+(item.goalTitle?'<small class="dots-audit-goal">任务：'+esc(item.goalTitle)+'</small>':'')+(item.error?'<small class="dots-audit-error">'+esc(item.error)+'</small>':'')+'</div></li>';
      }
      dialog.innerHTML = '<section class="dots-conversation-card dots-audit-card"><header><h2>做过的事</h2><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header><div class="dots-audit-filters" role="tablist">'+filters.map(([value,label])=>'<button type="button" role="tab" aria-selected="'+(category===value)+'" class="'+(category===value?'is-selected':'')+'" data-audit-filter="'+value+'">'+label+'</button>').join('')+'</div>'+(error?'<p class="dots-dialog-error" role="alert">'+esc(error)+'</p>':'')+'<ul class="dots-audit-list">'+rows+'</ul>'+(!items.length&&!loading&&!error?'<p class="dots-settings-empty">这里还没有记录。</p>':'')+(loading?'<p class="dots-settings-empty">正在读取…</p>':next?'<button type="button" class="dots-settings-link" data-audit-more>加载更早的记录</button>':'')+'</section>';
    };
    const load = async more => {
      if (loading) return; loading = true; error = ''; if (!more) { items = []; next = null; } draw();
      try { const data = await api('/audit?limit=50'+(category?'&category='+category:'')+(more&&next?'&before='+next:'')); items = more ? items.concat(data.items||[]) : (data.items||[]); next = data.nextBefore || null; }
      catch (cause) { error = cause.message || '暂时无法读取'; }
      finally { loading = false; draw(); }
    };
    dialog.addEventListener('click', event => {
      const filter = event.target.closest('[data-audit-filter]'); if (filter && filter.dataset.auditFilter !== category) { category = filter.dataset.auditFilter; load(false); }
      if (event.target.closest('[data-audit-more]')) load(true);
    });
    dialog.addEventListener('change', event => { const select = event.target.closest('[data-dots-approval-scope]'); if (select) event.stopPropagation(); });
    draw(); showDialog(dialog, dialog); await load(false);
  }
  async function openProfile() {
    try {
      await getCatalogue();
      profileDraft = {...profile, petId:petById(profile.petId)?.id, accent:profile.accent || colors[0]};
      profileDialog = makeDialog('dotsProfileDialog','dots-profile-overlay');
      renderProfile(); showDialog(profileDialog, profileDialog);
    } catch (error) { C.showError(error); }
  }
  function petChoices(custom) {
    return pets.filter(p=>!!p.is_custom===custom).map(p=>'<button type="button" class="dots-pet-option '+(p.id===profileDraft.petId?'is-selected':'')+'" data-dots-select-pet="'+esc(p.id)+'" aria-label="'+esc(p.name)+'" aria-pressed="'+String(p.id===profileDraft.petId)+'" title="'+esc(p.name)+'">'+petImage(p.id)+'</button>').join('');
  }
  function profileSectionTitle(label) {
    return '<div class="dots-choice-header"><h3>'+label+'</h3><div class="dots-choice-arrows"><button type="button" data-dots-scroll="-1" aria-label="'+label+'向左">'+icon('back')+'</button><button type="button" data-dots-scroll="1" aria-label="'+label+'向右">'+icon('forward')+'</button></div></div>';
  }
  function renderProfile() {
    const offsets=Array.from(profileDialog.querySelectorAll('.dots-color-options,.dots-pet-options'),row=>row.scrollLeft);
    profileDialog.innerHTML = '<form class="dots-profile-card" id="dotsProfileForm"><div class="dots-profile-options"><h2>自定义你的 Dot</h2>'+
      '<section>'+profileSectionTitle('颜色')+'<div class="dots-color-options">'+colors.map(color=>'<button type="button" class="dots-color-option '+(color===profileDraft.accent?'is-selected':'')+'" data-dots-select-color="'+color+'" style="--pet-color:'+color+'" aria-label="选择颜色 '+color+'" aria-pressed="'+String(color===profileDraft.accent)+'"></button>').join('')+'</div></section>'+
      '<section>'+profileSectionTitle('角色')+'<div class="dots-pet-options">'+petChoices(false)+'</div></section><section>'+profileSectionTitle('虚拟宠物')+'<div class="dots-pet-options">'+petChoices(true)+'</div></section></div>'+
      '<div class="dots-profile-preview" style="--profile-accent:'+profileDraft.accent+'"><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button><input id="dotsProfileName" type="text" value="'+esc(profileDraft.name || name())+'" aria-label="名称" maxlength="40" autocomplete="off" required><div class="dots-large-pet">'+petImage(profileDraft.petId)+'</div><p class="dots-dialog-error" data-profile-error role="alert" hidden></p><button type="submit" class="dots-white-button" data-dots-profile-save>保存</button></div></form>';
    profileDialog.querySelectorAll('.dots-color-options,.dots-pet-options').forEach((row,i)=>{row.scrollLeft=offsets[i]||0;});
    profileDialog.querySelectorAll('.dots-color-options,.dots-pet-options').forEach(row => {
      const buttons = row.closest('section').querySelectorAll('[data-dots-scroll]');
      const update = () => {
        const end = Math.max(0, row.scrollWidth - row.clientWidth);
        buttons[0].disabled = row.scrollLeft <= 1;
        buttons[1].disabled = row.scrollLeft >= end - 1;
      };
      row.addEventListener('scroll', update, {passive:true});
      const observer = new ResizeObserver(() => { if (row.isConnected) update(); else observer.disconnect(); });
      observer.observe(row);
      buttons.forEach(button => button.onclick = () => row.scrollBy({
        left:Number(button.dataset.dotsScroll)*Math.max(100,row.clientWidth*.65),
        behavior:reduced.matches?'instant':'smooth'
      }));
      requestAnimationFrame(update);
    });
    $('dotsProfileName').oninput = e => { profileDraft.name = e.target.value; };
    $('dotsProfileForm').onsubmit = async e => {
      e.preventDefault(); const button = profileDialog.querySelector('[data-dots-profile-save]'), error = profileDialog.querySelector('[data-profile-error]');
      const value = {name:$('dotsProfileName').value.trim(),accent:profileDraft.accent,petId:profileDraft.petId};
      if (!value.name) { error.textContent='请输入名称';error.hidden=false;return; }
      button.disabled = true;
      try { const result = await api('/profile','PATCH',value);profile={...profile,...result.profile};document.documentElement.style.setProperty('--dots-profile-accent',profile.accent || colors[0]);C.nameChanged();savedSignature='';renderPanel();closeDialog(); }
      catch (cause) { error.textContent=cause.message;error.hidden=false; }
      finally { button.disabled=false; }
    };
  }
  async function markSeen(type,id) {
    const item = activities.find(a => a.type===type && String(type==='schedule'?(a.scheduleId||a.schedule?.id||String(a.id).replace(/^schedule:/,'')):(a.taskId||a.id))===String(id));
    const seen = {...profile.seenActivities,[type+':'+id]:item?.updatedAt || Date.now()};
    const limited = Object.fromEntries(Object.entries(seen).sort((a,b)=>b[1]-a[1]).slice(0,500));
    profile.seenActivities=limited;savedSignature='';renderPanel();
    try { await api('/profile','PATCH',{seenActivities:limited}); } catch (error) { C.showError(error); }
  }
  function previewOpen() { return !!conversationDialog && !conversationDialog.hidden && conversationDialog.classList.contains('is-inline'); }
  function conversationVisible() { return !!conversationDialog && !conversationDialog.hidden && (previewOpen() || currentModal===conversationDialog); }
  function messageTime(value) {
    let stamp=Number(value);if(!Number.isFinite(stamp))stamp=Date.parse(value);
    if(!stamp)return '';if(stamp<1e12)stamp*=1000;
    return new Date(stamp).toLocaleString('zh-CN',{weekday:'long',hour:'2-digit',minute:'2-digit',hour12:false});
  }
  function messageTools(message,index) {
    const stamp=messageTime(message.createdAt);
    return '<div class="dots-message-tools"><button type="button" data-dots-copy-message="'+index+'" aria-label="复制消息" title="复制">'+icon('copy')+'</button>'+
      (message.role==='assistant'?'<button type="button" data-dots-read-message="'+index+'" aria-label="朗读消息" aria-pressed="false" title="朗读">'+icon('read')+'</button>':'')+
      (stamp?'<time>'+esc(stamp)+'</time>':'')+'</div>';
  }
  function syncReadButtons() {
    conversationDialog?.querySelectorAll('[data-dots-read-message]').forEach(button=>{
      const active=!!readSession && readingIndex===Number(button.dataset.dotsReadMessage);
      button.classList.toggle('is-reading',active);button.setAttribute('aria-pressed',String(active));
      button.setAttribute('aria-label',active?'停止朗读':'朗读消息');button.title=active?'停止朗读':'朗读';
      button.innerHTML=icon(active?'stop':'read');
    });
  }
  function stopReading() {
    const session=readSession;readSession=null;readingIndex=-1;
    if(session){
      if(window.ShiYanPlatform?.mode==='web')window.ShiYanPlatform.adapter('voice')?.post('stopMessageReading',{sessionId:session});
      else window.webkit?.messageHandlers?.native?.postMessage({action:'stopMessageReading',sessionId:session});
    }
    if(readUtterance){window.speechSynthesis?.cancel();readUtterance=null;}
    syncReadButtons();
  }
  function readError(error) {
    stopReading();const label=conversationDialog?.querySelector('.dots-read-error');
    if(label){label.textContent=error.message||String(error);label.hidden=false;}else C.showError(error);
  }
  function readMessage(index) {
    if(readSession && readingIndex===index){stopReading();return;}
    const message=currentConversation?.messages?.[index];if(message?.role!=='assistant')return;
    const call=$('dotsVoiceCard');if(call&&!call.hidden){readError(Error('请结束语音通话后再朗读消息'));return;}
    const body=conversationDialog?.querySelector('[data-dots-message-index="'+index+'"] .message-body');
    const text=body?.innerText?.trim() || String(message.content || message.text || '').trim();if(!text)return;
    if(text.length>20000){readError(Error('这条消息过长，暂时无法完整朗读'));return;}
    stopReading();readSession=crypto.randomUUID();readingIndex=index;
    const label=conversationDialog?.querySelector('.dots-read-error');if(label)label.hidden=true;
    if(window.ShiYanPlatform?.mode==='web'){
      if(!window.ShiYanPlatform.adapter('voice')?.post('readMessage',{sessionId:readSession,text}))readError(Error('当前浏览器不支持语音播放，请更换浏览器后重试。'));
      syncReadButtons();return;
    }
    const bridge=window.webkit?.messageHandlers?.native;
    if(bridge){bridge.postMessage({action:'readMessage',sessionId:readSession,text});syncReadButtons();return;}
    if(!window.speechSynthesis || !window.SpeechSynthesisUtterance){readError(Error('当前环境不支持朗读，请使用拾燕桌面应用'));return;}
    const utterance=new SpeechSynthesisUtterance(text),session=readSession;
    utterance.lang='zh-CN';utterance.voice=speechSynthesis.getVoices().find(v=>v.lang==='zh-CN') || null;
    utterance.onend=()=>{if(readSession===session){readSession=null;readingIndex=-1;readUtterance=null;syncReadButtons();}};
    utterance.onerror=event=>{if(readSession===session)readError(Error(event.error==='not-allowed'?'请允许浏览器播放语音':'朗读未能完成，请重试'));};
    readUtterance=utterance;speechSynthesis.speak(utterance);syncReadButtons();
  }
  async function openConversation(id, full = false) {
    stopReading();clearInterval(conversationTimer);conversationTimer=null;
    if(currentModal&&currentModal===conversationDialog){currentModal.hidden=true;currentModal=null;}
    conversationFull=full;const version=++conversationVersion;
    conversationDialog=makeDialog('dotsConversationDialog','dots-conversation-overlay');
    const panel=$('dotsActivity');
    conversationDialog.classList.toggle('is-inline',!full);if(full)conversationDialog.style.height='';
    panel?.classList.toggle('is-conversation-preview',!full);
    conversationDialog.innerHTML='<section class="dots-conversation-card"><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button><p class="dots-panel-empty">正在读取对话…</p></section>';
    if(full){
      document.body.appendChild(conversationDialog);savedSignature='';renderPanel();showDialog(conversationDialog);
    }else{
      panel.appendChild(conversationDialog);conversationDialog.hidden=false;conversationDialog.tabIndex=-1;
      conversationDialog.setAttribute('role','region');conversationDialog.setAttribute('aria-label','任务对话预览');conversationDialog.removeAttribute('aria-modal');
      positionPanel();C.scheduleNative?.();
    }
    try {
      const [record,detail]=await Promise.all([api('/goals/'+id+'/conversation'),api('/goals/'+id)]);
      if(version!==conversationVersion)return;
      currentConversation={...record,goal:{...record.goal,...detail.goal},id};renderConversation();
      requestAnimationFrame(()=>conversationDialog.querySelector(full?'textarea':'button')?.focus({preventScroll:true}));markSeen('conversation',id);
      clearInterval(conversationTimer);conversationTimer=setInterval(refreshConversation,4000);
    }catch(error){
      if(version!==conversationVersion)return;
      conversationDialog.innerHTML='<section class="dots-conversation-card"><button class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button><p class="dots-dialog-error">'+esc(error.message)+'</p></section>';
    }
  }
  function conversationBody(data) {
    const goal=data.goal || {}, rows=data.messages || [];
    const messages=conversationFull?rows:rows.slice(-8);
    const offset=conversationFull?0:Math.max(0,rows.length-8);
    return messages.map((m,i)=>{
      const index=offset+i;
      return '<article class="dots-child-message '+(m.role==='user'?'is-user':'is-assistant')+'" data-dots-message-index="'+index+'">'+
        (m.role==='assistant'&&m.source==='worker_summary'?'<small class="dots-message-source">任务结果</small>':'')+
        '<div class="message-body">'+(m.role==='user'?'<p>'+esc(m.content || m.text || '').replace(/\n/g,'<br>')+'</p>':C.markdown(m.content || m.text || ''))+'</div>'+messageTools(m,index)+'</article>';
    }).join('')+(messages.length?'':'<p class="dots-panel-empty">任务还没有回复</p>')+(conversationFull?renderTaskActions(goal):'')+approvalCards(goal)+
      (window.ShiYanSteps?'<button type="button" class="dots-process-link" data-dots-process><span>执行过程</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>':'');
  }
  // 执行过程：和对话的执行过程页同一套样式，覆盖在任务对话卡片上，可返回。
  function showProcess() {
    const card=conversationDialog?.querySelector('.dots-conversation-card'),goal=currentConversation?.goal;if(!card||!goal)return;
    card.querySelector('.dots-process-view')?.remove();
    const view=document.createElement('div');view.className='dots-process-view';
    view.innerHTML='<header><button type="button" class="dots-conversation-back" data-dots-process-close>'+icon('back')+'<strong>执行过程</strong></button></header><div class="dots-process-host"></div>';
    card.appendChild(view);
    const status=['done','completed'].includes(goal.status)?'done':['failed','blocked','cancelled'].includes(goal.status)?'failed':['needs_approval','waiting_approval','awaiting_approval'].includes(goal.status)?'waiting':'running';
    const outputs=goal.outputs||[];
    window.ShiYanSteps.render(view.querySelector('.dots-process-host'),{status,title:goal.title||'任务',time:goal.updated_at,result:outputs.at(-1)?.summary||goal.last_summary||'',prompt:goal.title||'',steps:window.ShiYanSteps.fromTimeline(goal.timeline)});
    view.querySelector('[data-dots-process-close]').focus({preventScroll:true});
  }
  async function refreshConversation() {
    if(conversationPolling||!conversationVisible()||document.hidden||!currentConversation)return;
    const version=conversationVersion,id=currentConversation.id;conversationPolling=true;
    try{
      const [record,detail]=await Promise.all([api('/goals/'+id+'/conversation'),api('/goals/'+id)]);
      if(version!==conversationVersion||!conversationVisible())return;
      const next={...record,goal:{...record.goal,...detail.goal},id};
      const signature=data=>JSON.stringify([data.messages,data.goal.status,data.goal.approvals]);
      if(signature(next)===signature(currentConversation))return;
      currentConversation=next;
      const box=conversationDialog.querySelector('.dots-conversation-messages'),follow=box.scrollHeight-box.clientHeight-box.scrollTop<70,top=box.scrollTop;
      box.innerHTML=conversationBody(next);box.scrollTop=follow?box.scrollHeight:top;syncReadButtons();
      const input=conversationDialog.querySelector('textarea');if(input)input.placeholder=['done','completed','cancelled','failed'].includes(next.goal.status)?'补充要求…':'发送消息…';
    }catch(_){ }
    finally{conversationPolling=false;}
  }
  function renderConversation() {
    const data=currentConversation, goal=data.goal || {}, ended=['done','completed','cancelled','failed'].includes(goal.status);
    conversationDialog.classList.toggle('is-full',conversationFull);
    conversationDialog.innerHTML='<section class="dots-conversation-card"><header><button type="button" class="dots-conversation-back" '+(conversationFull?'data-dots-preview-chat':'data-dots-close-dialog')+'>'+icon('back')+'<strong>'+esc(goal.title || '任务对话')+'</strong></button><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header><p class="dots-dialog-error dots-read-error" role="alert" hidden></p><div class="dots-conversation-messages">'+
      conversationBody(data)+'</div>'+
      (conversationFull?'<form class="dots-child-composer" id="dotsChildComposer"><textarea rows="1" maxlength="16000" placeholder="'+(ended?'补充要求…':'发送消息…')+'" aria-label="给任务发送消息" required></textarea><button type="submit" class="send-button" aria-label="发送">↑</button><p class="dots-dialog-error" role="alert" hidden></p></form>':'<button type="button" class="dots-white-button" data-dots-open-chat>'+icon('chat')+'打开聊天</button>')+'</section>';
    if(conversationFull) {
      const form=$('dotsChildComposer');form.onsubmit=submitChildMessage;
      const pending=C.pending()['dotsChild:'+data.id];
      if(pending){form.querySelector('textarea').value=pending.message;form.querySelector('textarea').readOnly=true;form.querySelector('button').setAttribute('aria-label','重试发送');}
    }
    syncReadButtons();positionPanel();
    requestAnimationFrame(()=>{const scroller=conversationDialog.querySelector('.dots-conversation-messages');if(scroller)scroller.scrollTop=scroller.scrollHeight;});
  }
  const isPendingApproval=approval=>['pending','awaiting_approval','requested'].includes(approval?.status);
  const canApprove=command=>typeof command==='string'&&!!command.trim()&&!/\bssh\b[^\n]*<[^>]+>/i.test(command);
  // 批准范围：仅这次 / 这个任务 / 1 小时 / 24 小时 / 一直允许（按动作类型授权）。选择在重新渲染之间保留。
  const SCOPES=[['once','仅这一次'],['task','这个任务内都允许'],['hour','1 小时内都允许'],['day','24 小时内都允许'],['always','以后一直允许']];
  const scopeChoices=new Map();
  document.addEventListener('change',event=>{const select=event.target.closest?.('[data-dots-approval-scope]');const card=select?.closest('[data-dots-approval]');if(!card)return;scopeChoices.set(Number(card.dataset.dotsApprovalGoal)+':'+Number(card.dataset.dotsApproval),select.value);});
  const approvalScope=(goalId,id)=>scopeChoices.get(goalId+':'+id)||'once';
  function scopeRow(goalId,id,approval,disabled){
    const labels=Array.isArray(approval.grant_labels)?approval.grant_labels.filter(Boolean):[];
    if(!labels.length)return '';
    const current=approvalScope(goalId,id);
    return '<div class="dots-approval-scope"><label><span>批准范围</span><select data-dots-approval-scope'+(disabled?' disabled':'')+'>'+SCOPES.map(([value,label])=>'<option value="'+value+'"'+(value===current?' selected':'')+'>'+label+'</option>').join('')+'</select></label><small>'+(current==='once'?'只执行上面这条命令。':'同类操作（'+esc(labels.join('、'))+'）之后自动执行，可在 Dots 设置里随时撤销。')+'</small></div>';
  }
  function approvalCards(goal) {
    return (goal.approvals||[]).filter(isPendingApproval).map(approval=>{
      const id=Number(approval.id),goalId=Number(goal.id);if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(goalId)||goalId<1)return '';
      const state=C.approvalState?.(goalId,id)||{},prior=state.pending,valid=canApprove(approval.command);
      const button=(decision,label)=>'<button type="button" data-dots-decision="'+decision+'"'+(state.busy||(decision==='approve'&&!valid)||(prior&&prior.decision!==decision)?' disabled':'')+'>'+esc(state.busy?'正在提交…':prior?.decision===decision?'重试'+label:label)+'</button>';
      return '<section class="dots-child-approval" data-dots-approval="'+id+'" data-dots-approval-goal="'+goalId+'" data-dots-approval-command="'+esc(encodeURIComponent(String(approval.command??'')))+'"><h3>'+esc(goal.title||'待批准操作')+'</h3><p>'+esc(approval.reason||'请核对以下实际命令后决定是否执行')+'</p><pre><code>'+esc(approval.command||'')+'</code></pre>'+(!valid?'<p class="dots-approval-note">命令尚未完整，无法批准；可以拒绝并让 Dots 重新评估。</p>':'')+scopeRow(goalId,id,approval,state.busy||!valid||!!prior)+'<div>'+button('approve','批准此命令')+button('reject','拒绝')+'</div></section>';
    }).join('');
  }
  function syncApprovalState(){
    positionPet();
    if(!currentConversation||!conversationVisible())return;
    const box=conversationDialog.querySelector('.dots-conversation-messages');if(!box)return;
    box.querySelectorAll('[data-dots-approval]').forEach(card=>{
      const goal=C.snapshot().details[String(currentConversation.id)]||currentConversation.goal,approval=goal?.approvals?.find(a=>String(a.id)===card.dataset.dotsApproval);
      const replacement=document.createElement('div');replacement.innerHTML=approval?approvalCards({...goal,approvals:[approval]}):'';
      if(replacement.firstElementChild)card.replaceWith(replacement.firstElementChild);else card.remove();
    });
  }
  function renderTaskActions(goal) {
    const ended=['done','completed','cancelled','failed'].includes(goal.status);
    return ended?'':'<div class="dots-child-actions"><button type="button" data-dots-child-control="'+(['paused','blocked'].includes(goal.status)?'resume':'pause')+'">'+(['paused','blocked'].includes(goal.status)?'继续任务':'暂停任务')+'</button><button type="button" data-dots-child-control="cancel">停止任务</button></div>';
  }
  async function submitChildMessage(e) {
    e.preventDefault();const form=e.target,input=form.querySelector('textarea'),button=form.querySelector('button'),error=form.querySelector('.dots-dialog-error');const message=input.value.trim();if(!message)return;
    const id=currentConversation.id,slot='dotsChild:'+id,prior=C.pending()[slot],ended=prior?!!prior.taskId:['done','completed','cancelled','failed'].includes(currentConversation.goal.status),route=ended?'/manager/messages':'/goals/'+id+'/instruct';
    const payload=C.request(slot,ended?{message,taskId:Number(id),host:'shiyan_desktop'}:{message});button.disabled=true;input.readOnly=true;error.hidden=true;
    try { await C.persist();await api(route,'POST',payload);await C.releaseRequest(slot);input.value='';await C.refresh();await openConversation(id,true); }
    catch(cause){if(rejected(cause))await C.releaseRequest(slot);error.textContent=cause.message;error.hidden=false;}
    finally{button.disabled=false;input.readOnly=!!C.pending()[slot];button.setAttribute('aria-label',input.readOnly?'重试发送':'发送');}
  }
  function today() { const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
  async function openSchedule(id) {
    try {
      scheduleValue=id?(await api('/schedules/'+id)).schedule:{title:'',instruction:'',enabled:true,repeat:'daily',time:'21:00',timezone:'Asia/Shanghai',startDate:today(),endDate:null};
      scheduleDialog=makeDialog('dotsScheduleDialog','dots-schedule-overlay');renderSchedule();showDialog(scheduleDialog,$('dotsScheduleTitle'));if(id)markSeen('schedule',id);
    } catch(error){C.showError(error);}
  }
  function renderSchedule() {
    const s={...scheduleValue,...C.pending()['dotsSchedule:'+(scheduleValue.id||'new')]};const selected=(a,b)=>a===b?' selected':'';const recurring=s.repeat!=='once';
    scheduleDialog.innerHTML='<form class="dots-schedule-card" id="dotsScheduleForm"><header><h2>'+(s.id?'编辑任务':'新建定时任务')+'</h2><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header><input id="dotsScheduleTitle" class="dots-schedule-title" aria-label="任务名称" value="'+esc(s.title)+'" placeholder="任务名称" maxlength="120" required><textarea id="dotsSchedulePrompt" aria-label="任务要求" rows="5" placeholder="你希望 Dots 在这个时间做什么？" maxlength="16000" required>'+esc(s.instruction)+'</textarea>'+
      '<div class="dots-schedule-settings"><label class="dots-setting-row"><span>重复执行任务</span><input id="dotsScheduleRepeating" type="checkbox" role="switch"'+(recurring?' checked':'')+'></label><label class="dots-setting-row" id="dotsRepeatRow"><span>重复</span><select id="dotsScheduleRepeat" aria-label="重复频率">'+[['daily','每天'],['weekdays','工作日'],['weekly','每周'],['monthly','每月']].map(([v,l])=>'<option value="'+v+'"'+selected(s.repeat,v)+'>'+l+'</option>').join('')+'</select></label><div class="dots-setting-row"><label for="dotsScheduleTime">时间</label><div class="dots-time-controls"><select id="dotsScheduleTimezone" aria-label="时区">'+Array.from(new Set(['Asia/Shanghai','Asia/Singapore','UTC',s.timezone])).map(tz=>'<option value="'+tz+'"'+selected(s.timezone,tz)+'>'+esc({'Asia/Shanghai':'北京时间','Asia/Singapore':'新加坡时间',UTC:'UTC'}[tz]||tz)+'</option>').join('')+'</select><input id="dotsScheduleTime" type="time" value="'+esc(s.time)+'" required aria-label="执行时间"></div></div><label class="dots-setting-row" id="dotsEndRow"><span>结束重复</span><select id="dotsScheduleEnd" aria-label="结束重复"><option value="never"'+(!s.endDate?' selected':'')+'>永不</option><option value="date"'+(s.endDate?' selected':'')+'>指定日期</option></select></label><label class="dots-setting-row" id="dotsEndDateRow"'+(!s.endDate?' hidden':'')+'><span>结束日期</span><input id="dotsScheduleEndDate" type="date" value="'+esc(s.endDate || '')+'" aria-label="结束日期"></label></div>'+
      '<details class="dots-schedule-advanced"><summary>高级 '+icon('more')+'</summary><label class="dots-setting-row"><span>开始日期</span><input id="dotsScheduleStart" type="date" value="'+esc(s.startDate || today())+'" required aria-label="开始日期"></label>'+(s.nextRunAt?'<p>下次执行：'+esc(time(s.nextRunAt))+'</p>':'')+'<label class="dots-setting-row"><span>启用任务</span><input id="dotsScheduleEnabled" type="checkbox" role="switch"'+(s.enabled?' checked':'')+'></label></details><p class="dots-dialog-error" id="dotsScheduleError" role="alert" hidden></p><footer>'+(s.id?'<button type="button" class="dots-secondary-button" data-dots-schedule-pause>'+(s.enabled?'暂停':'继续')+'</button>':'')+'<button type="submit" class="dots-white-button" data-dots-schedule-save>保存</button></footer></form>';
    const toggle=()=>{$('dotsRepeatRow').hidden=!$('dotsScheduleRepeating').checked;$('dotsEndRow').hidden=!$('dotsScheduleRepeating').checked;$('dotsEndDateRow').hidden=!$('dotsScheduleRepeating').checked||$('dotsScheduleEnd').value==='never';};toggle();
    $('dotsScheduleRepeating').onchange=toggle;$('dotsScheduleEnd').onchange=toggle;
    $('dotsScheduleForm').onsubmit=saveSchedule;
    syncSchedulePending();
  }
  function syncSchedulePending() {
    const saving=!!C.pending()['dotsSchedule:'+(scheduleValue.id||'new')],controlling=!!C.pending()['dotsScheduleControl:'+scheduleValue.id];
    scheduleDialog.querySelectorAll('input,textarea,select').forEach(field=>{field.disabled=saving||controlling||scheduleBusy;});
    const save=scheduleDialog.querySelector('[data-dots-schedule-save]'),control=scheduleDialog.querySelector('[data-dots-schedule-pause]');
    save.disabled=scheduleBusy||controlling;save.textContent=saving?'重试保存':'保存';
    if(control){control.disabled=scheduleBusy||saving;control.textContent=controlling?'重试'+(C.pending()['dotsScheduleControl:'+scheduleValue.id].action==='pause'?'暂停':'继续'):(scheduleValue.enabled?'暂停':'继续');}
  }
  async function saveSchedule(e) {
    e.preventDefault();if(scheduleBusy)return;
    const id=scheduleValue.id,slot='dotsSchedule:'+(id||'new'),fields={title:$('dotsScheduleTitle').value.trim(),instruction:$('dotsSchedulePrompt').value.trim(),enabled:$('dotsScheduleEnabled').checked,repeat:$('dotsScheduleRepeating').checked?$('dotsScheduleRepeat').value:'once',time:$('dotsScheduleTime').value,timezone:$('dotsScheduleTimezone').value,startDate:$('dotsScheduleStart').value,endDate:$('dotsScheduleRepeating').checked&&$('dotsScheduleEnd').value==='date'?$('dotsScheduleEndDate').value:null};
    const payload=C.request(slot,fields),error=$('dotsScheduleError');scheduleBusy=true;syncSchedulePending();error.hidden=true;
    try{await C.persist();await api('/schedules'+(id?'/'+id:''),id?'PATCH':'POST',payload);await C.releaseRequest(slot);scheduleBusy=false;closeDialog();await loadActivity(true);}
    catch(cause){if(rejected(cause))await C.releaseRequest(slot);error.textContent=cause.message;error.hidden=false;}
    finally{scheduleBusy=false;if(currentModal===scheduleDialog)syncSchedulePending();}
  }
  async function controlSchedule() {
    if(scheduleBusy||!scheduleValue.id)return;const slot='dotsScheduleControl:'+scheduleValue.id,payload=C.request(slot,{action:scheduleValue.enabled?'pause':'resume'}),button=scheduleDialog.querySelector('[data-dots-schedule-pause]');scheduleBusy=true;syncSchedulePending();
    try{await C.persist();const result=await api('/schedules/'+scheduleValue.id+'/control','POST',payload);await C.releaseRequest(slot);scheduleValue.enabled=result.schedule.enabled;$('dotsScheduleEnabled').checked=scheduleValue.enabled;button.textContent=scheduleValue.enabled?'暂停':'继续';await loadActivity(true);}
    catch(cause){if(rejected(cause))await C.releaseRequest(slot);$('dotsScheduleError').textContent=cause.message;$('dotsScheduleError').hidden=false;}
    finally{scheduleBusy=false;syncSchedulePending();}
  }
  async function openOutput(id) {
    const output=outputs.find(o=>String(o.id)===String(id));if(!output)return;
    outputDialog=makeDialog('dotsOutputDialog','dots-output-overlay');
    let content='',error='';outputRaw='';const url=localURL(output.downloadPath || output.downloadUrl || output.url || '/api/dots/outputs/'+id+'/file');
    try {
      if(String(output.mimeType || '').startsWith('image/'))content='<img class="dots-output-image" src="'+esc(url)+'" alt="'+esc(output.filename || '任务作品')+'">';
      else if(output.outputId || /^\d+$/.test(String(id))){
        const result=await api('/outputs/'+(output.outputId || id)),value=result.output || {};
        outputRaw=value.raw_result || value.notification || value.summary || output.summary || '';
        if(typeof outputRaw!=='string')outputRaw=JSON.stringify(outputRaw,null,2);
        let readable=outputRaw;
        try{const parsed=JSON.parse(outputRaw);readable=parsed.result || parsed.message || parsed.summary || JSON.stringify(parsed,null,2);}catch{}
        content=C.markdown(typeof readable==='string'?readable:JSON.stringify(readable,null,2));
        const preview=outputRaw.length>12000?outputRaw.slice(0,8000)+'\n… 可复制完整结果 …\n'+outputRaw.slice(-4000):outputRaw;
        content+='<details class="dots-raw-result"><summary>原始结果</summary><pre><code>'+esc(preview)+'</code></pre><button type="button" data-dots-panel-copy-output>复制完整结果</button></details>';
      }
      else content='<p>'+esc(output.summary || output.title || output.filename || '文件已生成')+'</p>';
    } catch(cause){error=cause.message;}
    outputDialog.innerHTML='<section class="dots-output-card"><header><h2>'+esc(output.filename || output.title || '任务结果')+'</h2><button type="button" class="dots-modal-close" data-dots-close-dialog aria-label="关闭">'+icon('close')+'</button></header><div class="dots-output-body message-body">'+content+(error?'<p class="dots-dialog-error">'+esc(error)+'</p>':'')+'</div><a class="dots-white-button" download href="'+esc(url)+'">'+icon('download')+'保存文件</a></section>';showDialog(outputDialog);
  }
  async function handle(e) {
    const target=e.target.closest('button');if(!target)return;
    try {
      if(target.hasAttribute('data-dots-copy-message')){const m=currentConversation?.messages?.[Number(target.dataset.dotsCopyMessage)];if(m){await window.shiyan.copyText(m.content || m.text || '');target.title='已复制';}}
      else if(target.hasAttribute('data-dots-read-message'))readMessage(Number(target.dataset.dotsReadMessage));
      else if(target.hasAttribute('data-dots-close-panel')){e.stopPropagation();C.closePanel();}
      else if(target.hasAttribute('data-dots-show-more')){e.stopPropagation();expanded=!expanded;savedSignature='';renderPanel();}
      else if(target.hasAttribute('data-dots-show-outputs')){e.stopPropagation();outputExpanded=!outputExpanded;savedSignature='';renderPanel();}
      else if(target.hasAttribute('data-dots-new-schedule')){e.stopPropagation();await openSchedule();}
      else if(target.hasAttribute('data-dots-schedule')){e.stopPropagation();await openSchedule(target.dataset.dotsSchedule);}
      else if(target.hasAttribute('data-dots-task')){e.stopPropagation();await openConversation(target.dataset.dotsTask);}
      else if(target.hasAttribute('data-dots-panel-output')){e.stopPropagation();await openOutput(target.dataset.dotsPanelOutput);}
      else if(target.hasAttribute('data-dots-panel-copy-output')){await window.shiyan.copyText(outputRaw);target.textContent='已复制';}
      else if(target.hasAttribute('data-dots-process')){e.stopPropagation();showProcess();}
      else if(target.hasAttribute('data-dots-process-close')){e.stopPropagation();target.closest('.dots-process-view')?.remove();}
      else if(target.hasAttribute('data-dots-close-dialog'))closeDialog();
      else if(target.hasAttribute('data-dots-select-pet')){profileDraft.name=$('dotsProfileName').value;profileDraft.petId=target.dataset.dotsSelectPet;renderProfile();profileDialog.querySelector('[data-dots-select-pet="'+CSS.escape(profileDraft.petId)+'"]').focus();}
      else if(target.hasAttribute('data-dots-select-color')){profileDraft.name=$('dotsProfileName').value;profileDraft.accent=target.dataset.dotsSelectColor;renderProfile();profileDialog.querySelector('[data-dots-select-color="'+profileDraft.accent+'"]').focus();}
      else if(target.hasAttribute('data-dots-open-chat'))await openConversation(currentConversation.id,true);
      else if(target.hasAttribute('data-dots-preview-chat'))await openConversation(currentConversation.id,false);
      else if(target.hasAttribute('data-dots-schedule-pause'))await controlSchedule();
      else if(target.hasAttribute('data-dots-child-control')){await api('/goals/'+currentConversation.id+'/control','POST',{requestId:crypto.randomUUID(),action:target.dataset.dotsChildControl});await openConversation(currentConversation.id,true);await C.refresh();}
      else if(target.hasAttribute('data-dots-decision')){e.stopPropagation();const card=target.closest('[data-dots-approval]'),id=Number(card.dataset.dotsApprovalGoal),full=conversationFull;await C.decideApproval(id,card.dataset.dotsApproval,target.dataset.dotsDecision,decodeURIComponent(card.dataset.dotsApprovalCommand),approvalScope(id,Number(card.dataset.dotsApproval)));if(currentConversation?.id==id)await openConversation(id,full);}
    } catch(error){if(target.hasAttribute('data-dots-decision')){const label=conversationDialog?.querySelector('.dots-read-error');if(label){label.textContent=error.message||String(error);label.hidden=false;}}C.showError(error);}
  }
  const spriteImages=new Map();let pointer=null,petFrame=0;
  function animatePanelPet(now) {
    petFrame=0;
    if(!document.hidden&&floatingPet&&!floatingPet.hidden&&floatingPet.isConnected) {
      const panel=floatingPet,pet=petById(profile.petId);
      if(pet&&panel&&!reduced.matches) {
        let image=spriteImages.get(pet.id);
        if(!image){image=new Image();image.src=pet.sprite_url.replace('/static/dots-pets/','/assets/dots-pets/');spriteImages.set(pet.id,image);}
        if(image.complete&&image.naturalWidth) {
          let canvas=panel.querySelector('canvas.dots-profile-pet');
          if(!canvas){const original=panel.querySelector('.dots-profile-pet');if(original){canvas=document.createElement('canvas');canvas.className='dots-pet dots-profile-pet';canvas.width=pet.cell_width;canvas.height=pet.cell_height;canvas.setAttribute('aria-label',pet.name);canvas.setAttribute('role','img');canvas.dataset.dotsPet=pet.id;original.replaceWith(canvas);}}
          if(canvas) {
            let row=0,col=0;const box=canvas.getBoundingClientRect();
            const dx=pointer?pointer.x-(box.left+box.width/2):0,dy=pointer?pointer.y-(box.top+box.height/2):0;
            if(pointer&&pet.sprite_version>=2&&Math.hypot(dx,dy)>16){const direction=Math.round(((Math.atan2(dx,-dy)*180/Math.PI+360)%360)/22.5)%16;row=9+Math.floor(direction/8);col=direction%8;}
            else {const state=pet.states.find(s=>s.name===((snapshot.busy||(snapshot.manager?.runningWorkers||0)>0)?'running':snapshot.manager?.status==='paused'?'waiting':'idle'))||pet.states[0];row=state.row;col=Math.floor(now/1000*state.fps)%state.frames;}
            const context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(image,col*pet.cell_width,row*pet.cell_height,pet.cell_width,pet.cell_height,0,0,canvas.width,canvas.height);
          }
        }
      }
    }
    petFrame=requestAnimationFrame(animatePanelPet);
  }
  // 主设置里的「Dots」分组：连接器、Dots 权限审批（从 Dots 菜单移过来）。常规页和左侧「Dots」页各一份入口，点了先关设置，再打开对应面板。
  function mountSettingsEntries() {
    const home = document.querySelector('.settings-home');
    if (!home || home.querySelector('[data-settings-dots]')) return;
    const chevron = '<svg class="settings-entry-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const entry = (key, symbol, title, detail) => '<button type="button" class="settings-memory-entry" data-settings-dots="'+key+'"><span class="settings-entry-icon" aria-hidden="true"><span class="wb-icon wb-ios-icon" style="--ios-symbol:url(\'/assets/symbols/'+symbol+'.png\')"></span></span><span class="settings-entry-copy"><strong>'+title+'</strong><span>'+detail+'</span></span>'+chevron+'</button>';
    const heading = document.createElement('h3'); heading.className = 'settings-section-title'; heading.textContent = 'Dots';
    const group = document.createElement('div'); group.className = 'settings-dots-entries';
    const entries = entry('connectors','point.3.connected.trianglepath.dotted','连接器','微信、常用插件和自定义 MCP')+entry('settings','checkmark.circle','Dots 权限审批','审批方式和已授权的操作');
    group.innerHTML = entries;
    const account = home.querySelector('.settings-section-title'), first = [...home.querySelectorAll('.settings-section-title')].find(h => h.textContent === '账户');
    if (first) home.insertBefore(heading, first); else home.append(heading);
    heading.after(group);
    const open = async event => {
      const button = event.target.closest('[data-settings-dots]'); if (!button) return;
      window.ShiYanSettings?.close?.(false);
      if (button.dataset.settingsDots === 'connectors') await openConnectors(); else await openDotsSettings();
    };
    group.addEventListener('click', open);
    const navigation = document.querySelector('.settings-sidebar nav');
    if (navigation && window.ShiYanSettings?.registerPage && !navigation.querySelector('[data-settings-page="dots"]')) {
      const category = document.createElement('button');
      category.type = 'button'; category.dataset.settingsPage = 'dots';
      category.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="15.5" cy="12" r="1.3" fill="currentColor"/></svg><span>Dots</span>';
      navigation.querySelector('.settings-category-empty')?.before(category);
      const page = document.createElement('section');
      page.className = 'settings-dots-page'; page.hidden = true;
      page.innerHTML = '<header class="memory-header"><h2 id="settingsDotsTitle" tabindex="-1">Dots</h2></header><div class="settings-dots-entries">'+entries+'</div>';
      page.addEventListener('click', open);
      window.ShiYanSettings.registerPage('dots', {element:page, titleId:'settingsDotsTitle'});
    }
  }
  window.addEventListener('shiyan-settings-ready', mountSettingsEntries);
  function install(context) {
    C=context;
    mountSettingsEntries();
    const floating = floatingPet = document.createElement('div');
    floating.id = 'dotsFloatingPet'; floating.hidden = true;
    document.body.appendChild(floating);
    $('dotsActivity').addEventListener('scroll',positionPet,{passive:true});
    document.addEventListener('pointermove',event=>{if(event.pointerType!=='touch')pointer={x:event.clientX,y:event.clientY};},{passive:true});
    document.addEventListener('pointerleave',()=>{pointer=null;});window.addEventListener('blur',()=>{pointer=null;});
    petFrame=requestAnimationFrame(animatePanelPet);
     
    $('app').appendChild($('dotsActivity'));
    $('desktopToolbar').appendChild($('dotsToolbar'));
    const alignToolbar=()=>{
      const toolbar=$('dotsToolbar'),header=$('desktopToolbar'),toggle=$('toggleRightWorkspace');if(!toolbar||!header||!toggle)return;
      const bounds=header.getBoundingClientRect(),button=toggle.getBoundingClientRect();
      const toggleVisible=toggle.getClientRects().length>0&&button.width>0;
      toolbar.style.right=(toggleVisible?Math.max(4,bounds.right-button.left+8):12)+'px';
      toolbar.querySelector('.dots-toolbar-divider').style.visibility=!toggleVisible||toggle.getAttribute('aria-expanded')==='true'?'hidden':'visible';
      positionPanel();
    };
    new ResizeObserver(alignToolbar).observe($('desktopToolbar'));
    new MutationObserver(alignToolbar).observe($('toggleRightWorkspace'),{attributes:true,attributeFilter:['aria-expanded','hidden']});
    window.addEventListener('resize',alignToolbar);requestAnimationFrame(alignToolbar);
     
    $('dotsActivity').classList.add('v2-popup');
    window.addEventListener('shiyan-view',()=>{
      positionPet();
      if(window.shiyan.getView()!=='dots'){
        C.closePanel();
        if(currentModal)closeDialog();
      }
    });
    $('dotsActivity').addEventListener('click',e=>{if(!e.target.closest('.dots-dialog-overlay'))handle(e);});
    $('toggleRightWorkspace').addEventListener('click',()=>{
      if(snapshot.drawerOpen&&$('toggleRightWorkspace').getAttribute('aria-expanded')!=='true')C.closePanel();
    },true);
    document.addEventListener('click',e=>{
      if(e.target.closest('.dots-dialog-overlay'))handle(e);
      if(currentModal&&e.target===currentModal)closeDialog();
       

    });
    document.addEventListener('keydown',e=>{
      if(currentModal || previewOpen()){
        if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeDialog();return;}
        if(currentModal&&e.key==='Tab'){
          const controls=Array.from(currentModal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary')).filter(x=>x.getClientRects().length);
          const first=controls[0],last=controls.at(-1);if(e.shiftKey&&(document.activeElement===first||!currentModal.contains(document.activeElement))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||!currentModal.contains(document.activeElement))){e.preventDefault();first?.focus();}
        }
      }
    },true);
    window.addEventListener('resize',positionPanel);
    if($('mainWorkspace'))new ResizeObserver(positionPanel).observe($('mainWorkspace'));
    window.addEventListener('shiyan-view',()=>{if(window.shiyan.getView()!=='dots'){C.closePanel();closeDialog();}});
    reduced.addEventListener('change',()=>{const floating=$('dotsFloatingPet');if(floating){delete floating.dataset.petId;positionPet();}document.querySelectorAll('img[data-dots-pet]').forEach(img=>{const pet=petById(img.dataset.dotsPet);if(pet)img.src=imageURL(pet);});});
    window.addEventListener('shiyan-native',event=>{
      const d=event.detail || {};if(d.type!=='voicePlaybackState' || d.sessionId!==readSession)return;
      if(d.state==='error'||d.state==='failed'){readError(Error(d.message || '朗读未能完成，请重试'));return;}
      if(['finished','cancelled'].includes(d.state)){readSession=null;readingIndex=-1;syncReadButtons();}
    });
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopReading();});
    window.addEventListener('pagehide',stopReading);
    getCatalogue().catch(C.showError);
  }
  window.ShiYanDotsPanels={install,render,name,avatar,voiceCallIdentity,openProfile,openSubscriptions,openConnectors,openDotsSettings,openAudit,openLifeGoals,approvalScope,setApprovalScope:(goalId,id,value)=>{scopeChoices.set(goalId+':'+id,value);},approvalCards,isPendingApproval,canApprove,syncApprovalState,syncVoiceLayout:positionPet};
})();
