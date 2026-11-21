 
(() => {
  'use strict';
  const $: any = (id: string): any => document.getElementById(id);
  const esc = (value: any): any => String(value ?? '').replace(/[&<>"']/g, (c: string): string => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string,string>)[c]));
  const paths = {
    clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 6v6l-3 2',
    play:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM10 8l6 4-6 4Z',
    pause:'M9 5v14M15 5v14', filter:'M4 6h16M7 12h10M10 18h4',
    check:'m5 12 4 4L19 6', share:'M12 16V2m-5 5 5-5 5 5M5 11H3v10h18V11h-2',
    trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
    send:'M12 19V4M5 11l7-7 7 7', retry:'M20 9a8 8 0 1 0 0 6m0-12v6h-6',
    completed:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 12l3 3 5-6'
  };
  const presets = [
    {icon:'💻',title:'ChatGPT Plus 套餐变化',instruction:'只要 Plus 的语音额度、价格或升级 Pro 规则有实质变化，就提醒我。'},
    {icon:'🤖',title:'aiagent 项目状态',instruction:'每周汇总 aiagent 的进展、回归风险和下一步，重点盯住关键链路。',repeat:'weekly'},
    {icon:'📚',title:'Agent 面试日练',instruction:'每天给我一组面试题，帮我按既定 Agent 学习路线逐步推进。'},
    {icon:'🥗',title:'每周饮食计划',instruction:'规划一周的餐食，并列出食材采购清单。',repeat:'weekly'},
    {icon:'😴',title:'睡眠指导',instruction:'跟踪我的睡眠质量，并帮助我改善生活习惯。'},
    {icon:'💰',title:'每周财务状况更新',instruction:'回顾我最近的支出，看看有什么需要注意。',repeat:'weekly'}
  ];
  let C: any, installed = false, active = false, tasks: any[] = [], selected: any = null, record: any = null;
  let query = '', expanded = false, filters = new Set(['enabled','paused','completed']);
  let loadVersion = 0, detailVersion = 0, refreshing = false, timer: any = null, popupAnchor = '';
  let dialogTask: any = null, dialogPendingKey = '', saving = false, sending = false, drafts: any = {}, replyOptions: any = {};
  let catalog: any = {local:{available:false,models:[]},cloud:{available:false,models:[]},defaults:{}}, catalogLoading: any = null;
  let pendingHydration: any, pendingReady=false, pendingChain=Promise.resolve();
  const pendingKey = window.ShiYanAccount.storageKey('shiyan.desktop.schedules.pending.v1');
  let pending: any = {};
  try { pending = JSON.parse(localStorage.getItem(pendingKey) || '{}'); } catch (_) {}
  const api = (path: any, method: any = 'GET', body?: any) => window.shiyan.api('/api/schedules' + path, method, body);
  const report = error => window.shiyan?.toast?.(error?.message || String(error));
  const notifyNative = () => C?.scheduleNative?.();
  function icon(name) {
    if (name === 'search') return C.toolbarIcon('search');
    if (name === 'rename') return window.shiyan?.sessionMenuIcon?.('rename') || C.icon('newChat');
    if (!paths[name]) return C.icon(name);
    return '<svg class="wb-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="'+paths[name]+'"></path></svg>';
  }
  const button = (action, name, label, extra = '') => '<button type="button" class="schedule-icon-button '+extra+'" data-schedule-action="'+action+'" aria-label="'+esc(label)+'" title="'+esc(label)+'">'+icon(name)+'</button>';
  function cachePending() {try{localStorage.setItem(pendingKey,JSON.stringify(pending));}catch(_){ }}
  function persistPending() {
    cachePending();const snapshot=JSON.parse(JSON.stringify(pending));
    const save=pendingChain.catch(()=>{}).then(()=>api('/pending','PUT',{pending:snapshot}));pendingChain=save;return save;
  }
  async function hydratePending() {
    const data=await api('/pending'),remote=data.pending || {};
    pending={...pending,...remote};if(Object.keys(pending).length)await persistPending();else cachePending();
    pendingReady=true;
  }
  function ensurePending() {
    if(pendingReady)return Promise.resolve();
    if(!pendingHydration)pendingHydration=hydratePending().catch(error=>{pendingHydration=null;throw error;});
    return pendingHydration;
  }
  function request(slot, fields) {
    if (!pending[slot]) { pending[slot] = {...fields,requestId:crypto.randomUUID()};cachePending(); }
    return pending[slot];
  }
  async function release(slot) {
    const previous=pending[slot];delete pending[slot];
    try{await persistPending();}catch(error){if(previous)pending[slot]=previous;cachePending();throw error;}
  }
  const rejected = error => Number(error?.status) >= 400 && Number(error?.status) < 500 && ![408,409,429].includes(Number((error as any).status));
  function timestamp(value) { return typeof value === 'number' ? value < 1e12 ? value * 1000 : value : value; }
  function dateText(value) {
    if (!value) return '';
    const d = new Date(timestamp(value));if (!Number.isFinite(d.getTime())) return '';
    const today = new Date();const yesterday = new Date();yesterday.setDate(today.getDate()-1);
    const hm = d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
    return (d.toDateString()===today.toDateString()?'今天 ':d.toDateString()===yesterday.toDateString()?'昨天 ':`${d.getMonth()+1}月${d.getDate()}日 `)+hm;
  }
  function taskStatus(task) {
    if (['completed','done','cancelled','canceled'].includes(task.status)) return 'completed';
    return task.enabled === false || ['paused','disabled'].includes(task.status) ? 'paused' : 'enabled';
  }
  function repeatText(task) {
    const names = {once:'自定义安排',daily:'每天',weekdays:'工作日',weekly:'每周',monthly:'每月',hourly:'每小时',monitor:'监控中'};
    if (task.intervalMinutes) return task.intervalMinutes===60?'每小时':`每 ${task.intervalMinutes} 分钟`;
    return (names[task.repeat] || task.repeat || '自定义安排')+(task.time && !['once','hourly','monitor'].includes(task.repeat)?' '+task.time:'');
  }
  function taskSubtitle(task) {
    const status = taskStatus(task);
    if (status === 'paused') return '已暂停 · '+repeatText(task);
    if (status === 'completed') return '已完成'+(task.lastRunAt || task.updatedAt?' · '+dateText(task.lastRunAt || task.updatedAt):'');
    if (task.running || task.isBusy) return '正在运行 · '+repeatText(task);
    return (task.nextRunAt?dateText(task.nextRunAt)+' · ':'')+repeatText(task);
  }
  function profileName() { return window.ShiYanDotsPanels?.name?.() || 'Dots'; }
  function profileIcon() { return window.ShiYanDotsPanels?.avatar?.() || icon('clock'); }
  function isDots(task) { return task.source === 'dots' || task.owner === 'dots' || !!task.dotsScheduleId; }
  function filteredTasks() {
    const text = query.trim().toLocaleLowerCase();
    return tasks.filter(task => filters.has(taskStatus(task)) && (!text || (task.title+' '+task.instruction).toLocaleLowerCase().includes(text)));
  }
  function taskRow(task) {
    const status = taskStatus(task), id = String(task.id);
    return '<div class="schedule-task-row '+(id===String(selected)?'is-selected ':'')+(status!=='enabled'?'is-inactive':'')+'" data-schedule-row="'+esc(id)+'">'+
      '<button type="button" class="schedule-task-link" data-schedule-open="'+esc(id)+'" title="'+esc(task.title || '未命名任务')+'"><strong>'+esc(task.title || '未命名任务')+'</strong><small>'+esc(taskSubtitle(task))+'</small></button>'+
      '<button type="button" class="schedule-task-more" data-schedule-more="'+esc(id)+'" aria-label="'+esc(task.title || '任务')+' 更多选项" title="更多">'+icon('more')+'</button>'+
      (status==='completed'?'<span class="schedule-task-complete" aria-label="已完成">'+icon('completed')+'</span>':'')+'</div>';
  }
  function renderSidebar() {
    const list = $('scheduledTaskList');if (!list) return;
    const all = filteredTasks();const limited = expanded || query?all:all.slice(0,10);
    const regular = limited.filter(task=>!isDots(task));const dots = limited.filter(isDots);
    list.innerHTML = regular.map(taskRow).join('')+(dots.length?'<div class="schedule-owner">'+profileIcon()+'<span>'+esc(profileName())+'</span></div>'+dots.map(taskRow).join(''):'')+
      (all.length>10 || expanded?'<button type="button" class="schedule-expand" data-schedule-action="expand">'+(expanded?'收起显示':'展开显示')+'</button>':'')+
      (!all.length?'<p class="schedule-list-empty">'+(query?'没有找到任务':tasks.length?'没有符合筛选条件的任务':'还没有定时任务')+'</p>':'');
  }
  function renderLanding() {
    const stage = $('scheduleConversation');
    stage.innerHTML = '<div class="schedule-landing"><div class="schedule-landing-clock" aria-hidden="true">🕘</div><h2>安排任务</h2><p>拾燕可以帮你处理持续性任务，让你不必亲自动手。</p><div class="schedule-presets">'+presets.map((p,index)=>'<button type="button" class="schedule-preset" data-schedule-preset="'+index+'"><span class="schedule-preset-icon" aria-hidden="true">'+p.icon+'</span><span><strong>'+esc(p.title)+'</strong><small>'+esc(p.instruction)+'</small></span></button>').join('')+'</div></div>';
  }
  function markdown(content) { return window.ShiYanOutput?.markdown?.(content,icon('copy')) || '<p>'+esc(content).replace(/\n/g,'<br>')+'</p>'; }
  function renderMessage(message) {
    const m = {...message,text:message.text ?? message.content ?? '',createdAt:timestamp(message.createdAt)};
    if (window.shiyan.renderMessage) {
      const template=document.createElement('template');template.innerHTML=window.shiyan.renderMessage(m);
      template.content.querySelectorAll('[data-edit-message],[data-retry-message]').forEach(button=>button.remove());
      return template.innerHTML;
    }
    return '<article class="message '+(m.role==='user'?'is-user':'is-assistant')+'" data-message-id="'+esc(m.id)+'"><div class="message-content"><div class="message-body">'+(m.role==='user'?'<p>'+esc(m.text).replace(/\n/g,'<br>')+'</p>':markdown(m.text))+'</div></div><div class="schedule-message-meta">'+(m.createdAt?'<time>'+esc(dateText(m.createdAt))+'</time>':'')+'<button type="button" data-schedule-copy-message="'+esc(m.id)+'" aria-label="复制消息">'+icon('copy')+'</button></div></article>';
  }
  function activeTask() { return tasks.find(task=>String(task.id)===String(selected)) || record?.task || null; }
  function renderConversation(force = false) {
    if (!active || !selected) return;
    const task = activeTask(), stage = $('scheduleConversation');if (!task) return;
    if (!stage.querySelector('#scheduleMessages')) {
      stage.innerHTML = '<header class="schedule-conversation-toolbar"><span></span><div>'+button('copy-task','copy','复制任务')+button('share-task','share','分享任务')+button('edit-task','rename','编辑任务')+'</div></header><div id="scheduleMessagesScroller" class="schedule-messages-scroller"><div id="scheduleMessages" class="schedule-messages"></div></div><form id="scheduleReplyForm" class="schedule-reply-form"><div class="schedule-reply-surface"><span class="schedule-reply-context" aria-hidden="true">'+icon('plus')+'</span><textarea id="scheduleReply" rows="1" maxlength="16000" placeholder="针对此任务回复…" aria-label="针对此任务回复"></textarea><button type="button" class="schedule-reply-model" data-schedule-action="reply-model"></button><button id="scheduleReplySend" type="submit" class="schedule-send" aria-label="发送">'+icon('send')+'</button></div><p id="scheduleReplyError" class="schedule-inline-error" role="alert" hidden></p></form>';
      $('scheduleReplyForm').onsubmit = sendMessage;
      $('scheduleReply').oninput = e=>{drafts[String(selected)]=(e as any).target.value;resizeInput();};
      $('scheduleReply').onkeydown = e=>{if(e.key==='Enter' && !e.shiftKey && !e.isComposing){e.preventDefault();sendMessage(e);}};
    }
    const list = $('scheduleMessages'),scroll = $('scheduleMessagesScroller');
    const follow = force || scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<80, top = scroll.scrollTop;
    const messages = record?.messages || [];
    let html = messages.map(renderMessage).join('');
    if (!messages.length) html = '<article class="message is-user"><div class="message-content"><div class="message-body"><p>'+esc(task.instruction || '').replace(/\n/g,'<br>')+'</p></div></div></article>';
    const card = '<section class="schedule-inline-card"><div class="schedule-card-clock">'+icon('clock')+'</div><div><strong>'+esc(task.title || '定时任务')+'</strong><small>'+esc(taskSubtitle(task))+'</small></div><button type="button" data-schedule-action="edit-task">打开</button></section>';
    html += '<div class="schedule-task-confirmation">'+(taskStatus(task)==='paused'?'此定时任务已暂停。':taskStatus(task)==='completed'?'此定时任务已完成。':task.nextRunAt?'你的任务已安排，下次运行时间为 '+esc(dateText(task.nextRunAt))+'。':'你的任务已安排。')+card+'</div>';
    if (list.__signature !== html) {list.__signature = html;list.innerHTML=html;scroll.scrollTop=follow?scroll.scrollHeight:top;}
    const input=$('scheduleReply'),slot='message:'+selected, waiting=pending[slot];
    if (document.activeElement!==input || force) input.value=waiting?.message ?? drafts[String(selected)] ?? '';
    input.readOnly=!!waiting;input.disabled=sending || !!task.running || !!record?.conversation?.isBusy;
    $('scheduleReplyForm').querySelector('.schedule-reply-model').disabled=!!waiting || sending;
    input.placeholder=task.running || record?.conversation?.isBusy?'任务正在回复…':waiting?'发送待确认，点击重试…':'针对此任务回复…';
    const settings=replySettings(task),model=models(task.runLocally).find(m=>m.id===settings.model);$('scheduleReplyForm').querySelector('.schedule-reply-model').textContent=(model?.displayName || model?.name || settings.model || '默认模型')+' '+effortLabel(settings.reasoning || 'medium')+' '+String.fromCharCode(8964);
    resizeInput();
  }
  function resizeInput() {
    const input=$('scheduleReply');if (!input) return;input.style.height='auto';input.style.height=Math.min(140,Math.max(28,input.scrollHeight))+'px';
    $('scheduleReplySend').disabled=sending || input.disabled || !input.value.trim();$('scheduleReplySend').setAttribute('aria-label',pending['message:'+selected]?'重试发送':'发送');
  }
  async function loadDetail(id, initial = false) {
    const version = ++detailVersion;
    try {
      const data = await api('/'+encodeURIComponent(id)+'/conversation');
      if (version!==detailVersion || String(selected)!==String(id)) return;
      record = {...data,task:data.task || data.schedule || activeTask(),messages:data.messages || data.conversation?.messages || []};
      renderConversation(initial);
    } catch (error) {if(version===detailVersion){$('scheduleReplyError')&&( $('scheduleReplyError').textContent=(error as any).message, $('scheduleReplyError').hidden=false );report(error);}}
  }
  function openTask(id) {
    closePopup();selected=String(id);record=null;detailVersion++;
    renderSidebar();$('scheduleConversation').innerHTML='';renderConversation(true);loadDetail(id,true);
  }
  async function refresh() {
    if (refreshing || !active || document.hidden) return;
    const version = ++loadVersion;refreshing=true;
    try {
      const data = await api('');if(version!==loadVersion) return;
      tasks = data.tasks || data.schedules || [];
      if (selected && !tasks.some(task=>String(task.id)===String(selected))) {selected=null;record=null;renderLanding();}
      renderSidebar();
      if(selected) await loadDetail(selected);$('scheduleLoadError').hidden=true;
    } catch(error) {if(version===loadVersion){$('scheduleLoadError').textContent=(error as any).message;$('scheduleLoadError').hidden=false;}}
    finally {refreshing=false;}
  }
  function closePopup() {const popup=$('schedulePopup');if(popup){popup.hidden=true;popup.replaceChildren();}popupAnchor='';notifyNative();}
  function openPopup(anchor, content, anchorKey, width = 190) {
    if(popupAnchor===anchorKey && !$('schedulePopup').hidden){closePopup();return;}
    closePopup();const popup=$('schedulePopup');popupAnchor=anchorKey;popup.innerHTML=content;popup.hidden=false;popup.style.width=width+'px';
    const r=anchor.getBoundingClientRect();popup.style.left=Math.max(8,Math.min(r.left,innerWidth-width-8))+'px';popup.style.top=Math.max(8,Math.min(r.bottom+5,innerHeight-popup.offsetHeight-8))+'px';notifyNative();
  }
  function menuItem(action,name,label,taskId,extra='') {return '<button type="button" class="'+extra+'" data-schedule-action="'+action+'"'+(taskId!==undefined?' data-schedule-id="'+esc(taskId)+'"':'')+'>'+icon(name)+'<span>'+esc(label)+'</span></button>';}
  function taskMenu(anchor,id) {
    const task=tasks.find(t=>String(t.id)===String(id));if(!task)return;
    const status=taskStatus(task), paused=status==='paused';
    const waiting=pending['control:'+id];
    openPopup(anchor,waiting?menuItem('retry-control','retry','重试'+({pause:'暂停',resume:'继续',run:'立即运行'}[waiting.action] || '操作'),id)+menuItem('share','share','分享',id):menuItem(paused?'resume':'pause',paused?'play':'pause',paused?'继续':'暂停',id)+menuItem('run','retry','立即运行',id)+menuItem('edit','rename','编辑',id)+menuItem('share','share','分享',id)+'<hr>'+menuItem('delete','trash','删除',id,'danger'),'task:'+id,190);
  }
  function filterMenu(anchor) {
    openPopup(anchor,'<h3>筛选依据</h3>'+[['enabled','已开启'],['paused','已暂停'],['completed','已完成']].map(([status,label])=>'<button type="button" class="'+(filters.has(status)?'is-checked':'')+'" data-schedule-filter="'+status+'"><span>'+label+'</span>'+(filters.has(status)?icon('check'):'')+'</button>').join(''),'filter',218);
  }
  async function loadCatalog() {
    if(catalogLoading)return catalogLoading;
    catalogLoading=api('/models').then(data=>{catalog=data;return data;}).catch(error=>{report(error);return catalog;}).finally(()=>{catalogLoading=null;});
    return catalogLoading;
  }
  function models(runLocally?: any) {
    const local=runLocally ?? $('scheduleRunLocally')?.checked ?? catalog.defaults?.runLocally ?? true;
    return (catalog[local?'local':'cloud']?.models || []).filter(m=>m.id);
  }
  // 多个模型提供方（GPT、Claude…）同时可用时，在名称前标出提供方。
  function modelLabel(m,choices) {
    const name=m.displayName || m.name || m.id;
    return new Set(choices.map(x=>x.provider||'')).size>1&&m.providerLabel?m.providerLabel+' · '+name:name;
  }
  function replySettings(task) {
    return replyOptions[String(task.id)] || {model:task.model,reasoning:task.reasoning || 'medium'};
  }
  function replyModelMenu(anchor) {
    const task=activeTask();if(!task)return;
    const settings=replySettings(task),choices=models(task.runLocally),model=choices.find(m=>m.id===settings.model) || choices[0];
    const efforts=model?.reasoningEfforts || ['medium'];
    openPopup(anchor,'<h3>模型</h3>'+choices.map(m=>'<button type="button" data-schedule-reply-model="'+esc(m.id)+'"><span>'+esc(modelLabel(m,choices))+'</span>'+(m.id===settings.model?icon('check'):'')+'</button>').join('')+'<hr><h3>强度</h3>'+efforts.map(e=>'<button type="button" data-schedule-reply-effort="'+esc(e)+'"><span>'+esc(effortLabel(e))+'</span>'+(e===settings.reasoning?icon('check'):'')+'</button>').join(''),'reply-model',218);
  }
  const effortLabel = effort => ({none:'关闭',minimal:'极轻',low:'轻度',medium:'中',high:'高',xhigh:'极高',max:'最高',ultra:'最高',default:'默认'}[effort] || effort);
  function today() {const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);}
  function option(value,label,selected) {return '<option value="'+esc(value)+'"'+(value===selected?' selected':'')+'>'+esc(label)+'</option>';}
  function selectField(id,label,choices,current) {return '<label class="schedule-setting-row"><span>'+label+'</span><span class="schedule-select-wrap"><select id="'+id+'" aria-label="'+label+'">'+choices.map(([value,text])=>option(value,text,current)).join('')+'</select>'+icon('down')+'</span></label>';}
  function toggleField(id,label,checked) {return '<label class="schedule-setting-row"><span>'+label+'</span><span class="schedule-toggle"><input id="'+id+'" type="checkbox" role="switch"'+(checked?' checked':'')+'><span aria-hidden="true"></span></span></label>';}
  function openEditor(task: any = null, preset: any = null) {
    if(!pendingReady){ensurePending().then(()=>openEditor(task,preset)).catch(report);return;}
    closePopup();dialogTask=task;
    const runLocally=task?.runLocally ?? catalog.defaults?.runLocally ?? true,defaultModel=models(runLocally)[0];
    const values={title:'',instruction:'',repeat:'daily',time:'09:00',timezone:'Asia/Shanghai',startDate:today(),endDate:null,enabled:true,runLocally,notificationMode:'important',newChatEachRun:false,model:defaultModel?.id || '',reasoning:defaultModel?.defaultReasoning || 'medium',...preset,...task};
    dialogPendingKey='save:'+(task?.id || 'new');const waiting=pending[dialogPendingKey];Object.assign(values,waiting || {});
    const dialog=$('scheduleEditor'),header=task?'编辑任务':'设置定时任务';
    dialog.innerHTML='<form id="scheduleEditorForm" class="schedule-editor-card" aria-labelledby="scheduleEditorTitle"><header><h2 id="scheduleEditorTitle">'+header+'</h2>'+button('close-editor','close','关闭')+'</header>'+
      (task?'<input id="scheduleTaskTitle" class="schedule-title-input" value="'+esc(values.title)+'" maxlength="120" aria-label="任务名称" placeholder="任务名称" required>':'')+
      '<textarea id="scheduleTaskInstruction" class="schedule-instruction" rows="5" placeholder="说明…" aria-label="任务说明" maxlength="16000" required>'+esc(values.instruction)+'</textarea>'+
      '<div class="schedule-setting-group">'+selectField('scheduleTaskRepeat','重复',[['once','不重复'],['daily','每天'],['weekdays','工作日'],['weekly','每周'],['monthly','每月'],['hourly','每小时']],values.repeat)+
      '<div class="schedule-setting-row"><span>时间</span><div class="schedule-time-field"><select id="scheduleTaskTimezone" aria-label="时区">'+Array.from(new Set(['Asia/Shanghai','Asia/Singapore','UTC',values.timezone])).map(tz=>option(tz,{'Asia/Shanghai':'中国时间','Asia/Singapore':'新加坡时间',UTC:'UTC'}[tz]||tz,values.timezone)).join('')+'</select><input id="scheduleTaskTime" type="time" aria-label="运行时间" value="'+esc(values.time)+'" required>'+icon('down')+'</div></div><label class="schedule-setting-row" id="scheduleOnceRow"'+(values.repeat!=='once'?' hidden':'')+'><span>日期</span><input id="scheduleStartDate" type="date" value="'+esc(values.startDate || today())+'" aria-label="执行日期" required></label></div>'+
      '<details class="schedule-advanced"><summary><span class="schedule-advanced-label">高级</span> '+icon('down')+'</summary><div class="schedule-advanced-options">'+(window.ShiYanAccount.user.serverAccess?toggleField('scheduleRunLocally','在此电脑上运行',values.runLocally):'<p>运行位置：独立工作区</p><input id="scheduleRunLocally" type="checkbox" hidden>')+selectField('scheduleNotification','通知',[['important','重要更新'],['all','每次更新'],['none','不通知']],values.notificationMode)+toggleField('scheduleNewChat','每次运行时都开启新聊天',values.newChatEachRun)+
      selectField('scheduleTaskModel','模型',(models(values.runLocally).length?models(values.runLocally).map((m,i,all)=>[m.id,modelLabel(m,all)]):[['','正在读取模型…']]),values.model)+selectField('scheduleTaskReasoning','强度',[],values.reasoning)+
      '<p class="schedule-advanced-note">定时任务需要拾燕保持运行；重新打开后补跑一次。</p></div></details><input id="scheduleEndDate" type="hidden" value="'+esc(values.endDate || '')+'">'+
      '<p id="scheduleEditorError" class="schedule-inline-error" role="alert" hidden></p><footer>'+(task?'<button type="button" class="schedule-secondary" data-schedule-action="editor-pause">'+(values.enabled?'暂停':'继续')+'</button>':'')+'<button type="button" class="schedule-secondary" data-schedule-action="close-editor">取消</button><button type="submit" id="scheduleSave" class="schedule-primary">'+(waiting?'重试保存':task?'保存':'创建')+'</button></footer></form>';
    dialog.dataset.title=values.title || '';dialog.hidden=false;
    updateReasoning(values.reasoning);$('scheduleTaskModel').onchange=()=>{updateReasoning();updateSaveState();};
    $('scheduleRunLocally').onchange=()=>updateModelOptions();
    $('scheduleTaskRepeat').onchange=e=>{$('scheduleOnceRow').hidden=(e as any).target.value!=='once';};
    const instruction=$('scheduleTaskInstruction');instruction.oninput=updateSaveState;
    $('scheduleEditorForm').onsubmit=saveTask;dialog.querySelector('.schedule-advanced').addEventListener('toggle',notifyNative);
    if(waiting)dialog.querySelectorAll('input,textarea,select').forEach(field=>field.disabled=true);
    updateSaveState();notifyNative();requestAnimationFrame(()=>instruction.focus({preventScroll:true}));
    if(!waiting)loadCatalog().then(()=>{if(!dialog.hidden && !saving)updateModelOptions(values.model,values.reasoning);});
  }
  function updateModelOptions(current?: any, reasoning?: any) {
    const select=$('scheduleTaskModel');if(!select)return;
    const choices=models(),wanted=current || select.value,selected=choices.find(m=>m.id===wanted) || choices[0];
    select.innerHTML=choices.length?choices.map(m=>option(m.id,modelLabel(m,choices),selected?.id)).join(''):option('','暂无可用模型','');
    const error=$('scheduleEditorError'),branch=catalog[$('scheduleRunLocally').checked?'local':'cloud'];
    if(!choices.length){error.textContent=branch?.error || '当前执行方式暂无可用模型';error.hidden=false;}
    else if(!pending[dialogPendingKey])error.hidden=true;
    updateReasoning(reasoning);updateSaveState();
  }
  function updateReasoning(current?: any) {
    const model=models().find(m=>m.id===$('scheduleTaskModel').value),efforts=model?.reasoningEfforts || [];
    const choices=efforts.length?efforts:['medium'];
    const selected=current && choices.includes(current)?current:model?.defaultReasoning || choices[0];
    $('scheduleTaskReasoning').innerHTML=choices.map(value=>option(value,effortLabel(value),selected)).join('');
    $('scheduleTaskReasoning').disabled=!efforts.length;
  }
  function updateSaveState() {
    const save=$('scheduleSave');if(!save)return;save.disabled=saving || !$('scheduleTaskInstruction').value.trim() || (!pending[dialogPendingKey] && !models().length);
  }
  function closeEditor() {if(saving)return;$('scheduleEditor').hidden=true;notifyNative();}
  async function saveTask(event) {
    event.preventDefault();if(saving)return;
    await ensurePending();if(saving)return;
    const instruction=$('scheduleTaskInstruction').value.trim();if(!instruction && !pending[dialogPendingKey])return;
    const values={title:$('scheduleTaskTitle')?.value.trim() || $('scheduleEditor').dataset.title || instruction.replace(/\s+/g,' ').slice(0,32),instruction,enabled:dialogTask?.enabled ?? true,repeat:$('scheduleTaskRepeat').value,time:$('scheduleTaskTime').value,timezone:$('scheduleTaskTimezone').value,startDate:$('scheduleStartDate').value,endDate:$('scheduleEndDate').value || null,runLocally:$('scheduleRunLocally').checked,notificationMode:$('scheduleNotification').value,newChatEachRun:$('scheduleNewChat').checked,model:$('scheduleTaskModel').value,reasoning:$('scheduleTaskReasoning').value};
    const slot=dialogPendingKey,payload=request(slot,values),id=dialogTask?.id;const error=$('scheduleEditorError');saving=true;updateSaveState();error.hidden=true;
    $('scheduleEditor').querySelectorAll('input,textarea,select').forEach(field=>field.disabled=true);
    try{await persistPending();const data=await api(id?'/'+encodeURIComponent(id):'',id?'PATCH':'POST',payload);await release(slot);saving=false;closeEditor();await refresh();const saved=data.task || data.schedule;if(saved?.id)openTask(saved.id);}
    catch(cause){if(rejected(cause)){await release(slot);$('scheduleEditor').querySelectorAll('input,textarea,select').forEach(field=>field.disabled=false);}error.textContent=(cause as any).message;error.hidden=false;}
    finally{saving=false;updateSaveState();if(!$('scheduleEditor').hidden)$('scheduleSave').textContent=pending[slot]?'重试保存':id?'保存':'创建';}
  }
  async function controlTask(id,action) {
    await ensurePending();
    const task=tasks.find(t=>String(t.id)===String(id));if(!task)return;
    closePopup();const slot='control:'+id,payload=request(slot,{action});
    try{await persistPending();await api('/'+encodeURIComponent(id)+'/control','POST',payload);await release(slot);await refresh();}
    catch(error){if(rejected(error))await release(slot);throw error;}
  }
  async function removeTask(id) {
    await ensurePending();
    closePopup();const task=tasks.find(t=>String(t.id)===String(id));if(!task)return;
    if(!await window.shiyan.confirmAction('删除定时任务？','删除后不再自动运行，已有对话和文件会保留。','删除'))return;
    const slot='delete:'+id,payload=request(slot,{});
    try{await persistPending();await api('/'+encodeURIComponent(id),'DELETE',payload);await release(slot);if(String(selected)===String(id)){selected=null;record=null;renderLanding();}await refresh();}
    catch(error){if(rejected(error))await release(slot);throw error;}
  }
  async function shareTask(id) {
    closePopup();const task=tasks.find(t=>String(t.id)===String(id));if(!task)return;
    const text=task.title+'\n'+task.instruction+'\n'+repeatText(task)+' · '+(task.timezone || 'Asia/Shanghai')+'\n'+JSON.stringify({runLocally:task.runLocally,notificationMode:task.notificationMode,newChatEachRun:task.newChatEachRun,model:task.model,reasoning:task.reasoning},null,2);
    if(navigator.share){try{await navigator.share({title:task.title,text});return;}catch(error){if((error as any).name==='AbortError')return;}}
    await window.shiyan.copyText(text);window.shiyan.toast('任务内容已复制');
  }
  async function sendMessage(event) {
    event.preventDefault();if(sending || !selected)return;
    await ensurePending();if(sending || !selected)return;
    const id=selected,input=$('scheduleReply'),text=input.value.trim(),slot='message:'+id;if(!text && !pending[slot])return;
    const payload=request(slot,{message:text,...replySettings(activeTask())}),error=$('scheduleReplyError');sending=true;error.hidden=true;renderConversation();
    try{await persistPending();await api('/'+encodeURIComponent(id)+'/messages','POST',payload);await release(slot);drafts[String(id)]='';await loadDetail(id);}
    catch(cause){if(rejected(cause))await release(slot);error.textContent=(cause as any).message;error.hidden=false;}
    finally{sending=false;if(String(selected)===String(id))renderConversation();}
  }
  function applyLayout() {
    if(!active || window.shiyan.getView()!=='schedules' || window.ShiYanKnowledge?.isOpen?.())return;
    const tools=document.body.classList.contains('schedules-tools-open');
    const showSidebar=!!C.prefs.leftOpen && !(innerWidth<=780 && tools);
    document.body.classList.toggle('schedules-sidebar-collapsed',!showSidebar);
    $('leftContainer').inert=!showSidebar;$('leftContainer').setAttribute('aria-hidden',String(!showSidebar));$('mainWorkspace').inert=false;
    $('railSchedules').classList.add('is-active');['railHome','railEnhance','railHistory'].forEach(id=>$(id)?.classList.remove('is-active'));
    const sidebar=showSidebar?(parseFloat(getComputedStyle($('desktopLayout')).getPropertyValue('--shiyan-sidebar-width'))||262):0;
    const toggle=$('toggleLeftSidebar');toggle.hidden=false;toggle.style.left=(showSidebar?50+sidebar-43:61)+'px';toggle.setAttribute('aria-expanded',String(showSidebar));
    const glyph=showSidebar?'left':'leftCollapsed';toggle.innerHTML=C.toolbarIcon(glyph);toggle.dataset.sidebarGlyph=glyph;toggle.title=toggle.ariaLabel=showSidebar?'隐藏左侧栏':'显示左侧栏';
    $('desktopLayout').style.setProperty('--schedule-tools-width',Math.max(220,Math.min(C.prefs.rightWidth || 460,innerWidth-50-sidebar-300))+'px');
    $('rightWorkspace').inert=!tools;$('rightWorkspace').setAttribute('aria-hidden',String(!tools));
    if(tools){$('toggleRightWorkspace').hidden=false;$('toggleRightWorkspace').setAttribute('aria-expanded','true');$('rightResizeHandle').style.left=(innerWidth-parseFloat($('desktopLayout').style.getPropertyValue('--schedule-tools-width'))-5)+'px';}
  }
  function showTools() {
    if(!active)return;
    document.body.classList.add('schedules-tools-open');C.prefs.rightOpen=true;
    window.dispatchEvent(new Event('resize'));applyLayout();notifyNative();
  }
  function activate() {
    active=window.shiyan.getView()==='schedules';document.body.classList.toggle('schedules-is-current-view',active);
    $('scheduleSidebar').hidden=!active;$('scheduleView').hidden=!active;$('railSchedules').classList.toggle('is-active',active);
    clearInterval(timer);closePopup();document.body.classList.remove('schedules-tools-open');
    if(active){applyLayout();if(selected)renderConversation();else renderLanding();renderSidebar();loadCatalog().then(()=>{if(active)renderConversation();});refresh();timer=setInterval(refresh,4000);requestAnimationFrame(applyLayout);}
    else{document.body.classList.remove('schedules-sidebar-collapsed');$('scheduleEditor').hidden=true;notifyNative();}
  }
  function build() {
    const rail=document.createElement('button');rail.id='railSchedules';rail.type='button';rail.className='wb-icon-button schedule-rail-button';rail.title=rail.ariaLabel='定时任务';rail.innerHTML='<svg class="wb-icon" viewBox="0 0 24 24" aria-hidden="true"><defs><mask id="scheduleRailFillMask"><rect width="24" height="24" fill="white"/><path d="M12 6v6l-3 2" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><path class="rail-glyph-outline" d="'+paths.clock+'"/><circle class="rail-glyph-filled" cx="12" cy="12" r="9" mask="url(#scheduleRailFillMask)"/></svg>';
    // 网页端不在左侧导航显示定时任务入口。
    if((window as any).__SHIYAN_PLATFORM__?.mode==='web'){rail.hidden=true;rail.style.display='none';}
    $('railEnhance').after(rail);rail.onclick=()=>window.shiyan.navigate('schedules');
    const sidebar=document.createElement('aside');sidebar.id='scheduleSidebar';sidebar.className='schedule-sidebar';sidebar.hidden=true;sidebar.setAttribute('aria-label','定时任务');
    sidebar.innerHTML='<header class="schedule-sidebar-header"><h2>定时任务</h2>'+button('search','search','搜索任务')+'</header><div id="scheduleSearch" class="schedule-search" hidden><input id="scheduleSearchInput" type="search" aria-label="搜索任务" placeholder="搜索定时任务"></div><button type="button" class="schedule-new" data-schedule-action="new">'+icon('plus')+'<span>新建任务</span></button><div class="schedule-section-heading"><h3>即将执行</h3>'+button('filter','filter','筛选任务')+'</div><p id="scheduleLoadError" class="schedule-inline-error" role="alert" hidden></p><div id="scheduledTaskList" class="schedule-task-list"></div>';
    $('leftContainer').appendChild(sidebar);
    sidebar.addEventListener('contextmenu',event=>{const row=(event.target as any)?.closest('[data-schedule-open]');if(row){event.preventDefault();taskMenu(row,row.dataset.scheduleOpen);}});
    const stage=document.createElement('section');stage.id='scheduleView';stage.className='schedule-view';stage.hidden=true;stage.setAttribute('aria-label','定时任务对话');stage.innerHTML='<div id="scheduleConversation" class="schedule-conversation"></div>';$('centerContent').appendChild(stage);
    const popup=document.createElement('div');popup.id='schedulePopup';popup.className='v2-popup schedule-popup';popup.hidden=true;popup.setAttribute('role','menu');$('app').appendChild(popup);
    const dialog=document.createElement('div');dialog.id='scheduleEditor';dialog.className='wb-modal schedule-editor-overlay';dialog.hidden=true;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');$('app').appendChild(dialog);
    $('scheduleSearchInput').oninput=e=>{query=(e as any).target.value;renderSidebar();};
    document.addEventListener('click',handleClick);
    document.addEventListener('click',e=>{
      if(!active)return;
      if((e as any).target.closest('[data-open-execution],[data-show-message-changes],[data-message-changes]'))showTools();
      if((e as any).target.closest('#toggleRightWorkspace'))queueMicrotask(()=>{if(active){document.body.classList.toggle('schedules-tools-open',!!C.prefs.rightOpen);applyLayout();}});
    },true);
    document.addEventListener('click',e=>{if(active && (e as any).target.closest('#toggleLeftSidebar')){if(C.prefs.leftOpen && innerWidth<=780){document.body.classList.remove('schedules-tools-open');C.prefs.rightOpen=false;}applyLayout();notifyNative();}});
    document.addEventListener('keydown',e=>{if(!active)return;if(e.key==='Escape'){if(!dialog.hidden){closeEditor();e.preventDefault();}else if(!popup.hidden){closePopup();e.preventDefault();}}});
    dialog.addEventListener('click',e=>{if((e as any).target===dialog)closeEditor();});
    window.addEventListener('shiyan-view',activate);
    window.addEventListener('shiyan-state',()=>{if(active){applyLayout();renderConversation();}});
    window.addEventListener('resize',()=>{if(active){closePopup();requestAnimationFrame(applyLayout);}});
    document.addEventListener('visibilitychange',()=>{if(active && !document.hidden)refresh();});
    window.addEventListener('pagehide',()=>clearInterval(timer));
  }
  async function handleClick(event) {
    if(!active)return;
    const target=(event.target as any)?.closest('[data-schedule-action],[data-schedule-open],[data-schedule-more],[data-schedule-filter],[data-schedule-preset],[data-schedule-copy-message],[data-schedule-reply-model],[data-schedule-reply-effort]');
    if(!(event.target as any)?.closest('#schedulePopup,[data-schedule-more],[data-schedule-action="filter"],[data-schedule-action="reply-model"]'))closePopup();
    if(!target)return;
    try{
      if(target.hasAttribute('data-schedule-open')){openTask(target.dataset.scheduleOpen);return;}
      if(target.hasAttribute('data-schedule-more')){taskMenu(target,target.dataset.scheduleMore);return;}
      if(target.hasAttribute('data-schedule-filter')){const f=target.dataset.scheduleFilter;filters.has(f)?filters.delete(f):filters.add(f);renderSidebar();const anchor=document.querySelector('[data-schedule-action="filter"]');popupAnchor='';filterMenu(anchor);return;}
      if(target.hasAttribute('data-schedule-preset')){openEditor(null,presets[Number(target.dataset.schedulePreset)]);return;}
      if(target.hasAttribute('data-schedule-reply-model')){const task=activeTask(),model=models(task.runLocally).find(m=>m.id===target.dataset.scheduleReplyModel);if(model){const previous=replySettings(task);replyOptions[String(task.id)]={model:model.id,reasoning:model.reasoningEfforts?.includes(previous.reasoning)?previous.reasoning:model.defaultReasoning || model.reasoningEfforts?.[0] || 'medium'};closePopup();renderConversation();}return;}
      if(target.hasAttribute('data-schedule-reply-effort')){const task=activeTask();replyOptions[String(task.id)]={...replySettings(task),reasoning:target.dataset.scheduleReplyEffort};closePopup();renderConversation();return;}
      if(target.hasAttribute('data-schedule-copy-message')){const m=record?.messages?.find(m=>String(m.id)===target.dataset.scheduleCopyMessage);await window.shiyan.copyText(m?.text || m?.content || '');return;}
      const action=target.dataset.scheduleAction,id=target.dataset.scheduleId || selected,task=tasks.find(t=>String(t.id)===String(id));
      if(action==='new')openEditor();
      else if(action==='search'){const box=$('scheduleSearch');box.hidden=!box.hidden;if(!box.hidden)$('scheduleSearchInput').focus();else{query='';$('scheduleSearchInput').value='';renderSidebar();}target.setAttribute('aria-expanded',String(!box.hidden));}
      else if(action==='filter')filterMenu(target);
      else if(action==='expand'){expanded=!expanded;renderSidebar();}
      else if(action==='edit' || action==='edit-task')openEditor(task);
      else if(action==='reply-model')replyModelMenu(target);
      else if(['pause','resume','run'].includes(action))await controlTask(id,action);
      else if(action==='retry-control')await controlTask(id,pending['control:'+id]?.action || 'run');
      else if(action==='delete')await removeTask(id);
      else if(action==='share' || action==='share-task')await shareTask(id);
      else if(action==='copy-task')await window.shiyan.copyText(task?.instruction || '');
      else if(action==='close-editor')closeEditor();
      else if(action==='editor-pause' && dialogTask){await controlTask(dialogTask.id,dialogTask.enabled?'pause':'resume');const next=tasks.find(t=>String(t.id)===String(dialogTask.id));openEditor(next);}
    }catch(error){report(error);}
  }
  function install(context) {if(installed||!window.ShiYanAccount.user)return;installed=true;C=context;ensurePending().catch(report);build();activate();}
  window.ShiYanSchedules={install,layout:applyLayout,open:()=>window.shiyan.navigate('schedules'),refresh,openEditor,
    message:id=>active?record?.messages?.find(message=>String(message.id)===String(id)):undefined,
    conversation:()=>active?record?.conversation:undefined,
    currentConversation:()=>active && selected?(record?.conversation || {id:activeTask()?.conversationId,messages:record?.messages || []}):undefined,
    inspect:()=>({active,selected,taskCount:tasks.length})};
   
  if(window.ShiYanV22?.install){const original=window.ShiYanV22.install;window.ShiYanV22.install=function(context){const result=original.call(this,context);install(context);return result;};}
})();
