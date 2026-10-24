 
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = query => [...document.querySelectorAll(query)];
  const busyStates = new Set(['submitting', 'queued', 'running', 'reconnecting', 'cancelling']);
  const reasoningNames = {minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高',ultra:'极致',none:'关闭'};
  let state = null, eventSource = null, initialized = false, toastTimer = 0, draftTimer = 0;
  const drafts = new Map(), assets = new Map(), stoppingConversations = new Set();
  const ui = {
    view:'agent', feature:'enhance', model:'general', input:null, result:null, showOriginal:false,
    photoJobId:null, photoUploading:false, photoUploadFile:null, photoLocalURL:null, photoSubmitting:false, photoError:'', strokes:[], currentStroke:null, brush:.055, drawer:false, reasoning:false, reasoningDragging:false, reasoningPosition:0,
    editing:null, submitting:false, speech:false, speechFinishing:false, speechSessionId:null, speechPrefix:'', recordingConversation:null,
    selection:new Set(), selecting:false, sessionMenuId:null, deletingSessionId:null,
    preview:null, zoom:1, panX:0, panY:0, previewPointer:null, searchTerm:'', restoring:false, historyReturnView:'agent'
  };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => '<span class="symbol" data-symbol="' + esc(name) + '" style="--symbol:url(\'/assets/symbols/' + esc(name) + '.png\')" aria-hidden="true"></span>';
  const sessionMenuPaths = {
    rename:'M4.5 19.5l1-4L16.8 4.2a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5L8.5 18.5l-4 1zM14.8 6.2l3 3',
    pin:'M8 3h8v6.8l2 2.2 1 4.5H5L6 12l2-2.2V3ZM12 16.5V22',
    project:'M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3M3 8h18M3 8v10a2 2 0 0 0 2 2h7M14 17h7M18 14l3 3-3 3',
    folder:'M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2M3 8h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8',
    folderRemove:'M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v5M3 8h18M3 8v10a2 2 0 0 0 2 2h7M16 16l5 5M21 16l-5 5',
    check:'m5 12 4 4L19 6',chevron:'m9 5 7 7-7 7'
  };
  const sessionMenuIcon = name => '<svg class="session-menu-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="'+sessionMenuPaths[name==='unpin'?'pin':name]+'"'+(name==='pin'||name==='unpin'?' transform="rotate(45 12 12)"':'')+'></path>'+(name==='unpin'?'<path d="M3 3l18 18"></path>':'')+'</svg>';
   
  const messageEditIcon = () => sessionMenuIcon('rename').replace('viewBox="0 0 24 24"', 'viewBox="3.7 2.895 17.405 17.405"');
  let sessionProjectCloseTimer=0;
  const show = (id, visible = true) => {
    const el=$(id);
    if (!el) return;
    if (id==='latestButton') {
      const value=String(visible);
      if (el.dataset.visible!==value) {
        el.dataset.visible=value;
        el.inert=!visible;
        el.setAttribute('aria-hidden',String(!visible));
      }
      return;
    }
    if (el.hidden!==!visible) el.hidden=!visible;
  };
  const setText = (id, value) => { const el=$(id); if(el){const text=value == null ? '' : String(value);if(el.textContent!==text)el.textContent=text;} };
  const current = () => state && state.conversations.find(c => c.id === state.selectedConversationId);
  const visibleConversation = () => ui.view==='schedules'?(window.ShiYanSchedules?.currentConversation?.()||current()):current();
  const visibleMessage = id => (ui.view==='schedules'?window.ShiYanSchedules?.message?.(id):null)||visibleConversation()?.messages?.find(m=>m.id===id);
  const isBusy = c => !!(c && (c.pendingMessageId || (c.messages || []).some(m => busyStates.has(m.state))));
  const assetUrl = (a, download=false) => a && ((download ? a.downloadUrl : a.url) || '/api/assets/' + encodeURIComponent(a.id) + '/file' + (download ? '?download=1' : ''));
  function remember(a) { if(a && a.id) assets.set(a.id,a); return a; }
  function toast(message) {
    setText('toastText', message); show('toast'); clearTimeout(toastTimer);
    toastTimer=setTimeout(() => show('toast',false),4000);
  }
  function humanError(error) {
    if (!error) return '操作失败，请重试';
    if(typeof error === 'object') return error.message || error.error || JSON.stringify(error);
    return String(error);
  }
  async function api(path, method='GET', body) {
    const options={method,credentials:'same-origin',headers:{}};
    if(method !== 'GET') options.headers['X-Shiyan-Local']='1';
    if(body instanceof FormData) options.body=body;
    else if(body !== undefined) {options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
    let response;
    try { response=await fetch(path,options); } catch (_) { throw new Error('本地服务连接已断开，正在等待恢复'); }
    let data;
    try {data=await response.json();} catch (_) {throw new Error('服务返回了无法读取的响应（' + response.status + '）');}
    if(!response.ok || data.ok === false) {
      const error = new Error(humanError(data.error || data.detail || response.statusText));
      error.status = response.status; error.code = data.code;
      throw error;
    }
    if(data.state) applyState(data.state);
    return data;
  }
  async function upload(files,kind='input') {
    const form=new FormData();
    for(const file of files) form.append('files',file,file.name || 'image.png');
    form.append('kind',kind);
    const data=await api('/api/assets','POST',form);
    return (data.assets || []).map(remember);
  }
  async function resolveAsset(id) {
    if(!id) return null;
    if(assets.has(id)) return assets.get(id);
    try { const data=await api('/api/assets/'+encodeURIComponent(id));return remember(data.asset); }
    catch (_) {return null;}
  }
  function draftFor(c=current()) {
    if(!c) return {text:'',assets:[],reasoning:'low',dirty:false,revision:0};
    if(!drafts.has(c.id)) drafts.set(c.id,{text:c.draft || '',assets:(c.draftAssets || []).map(a=>typeof a==='string' ? assets.get(a) : remember(a)).filter(Boolean),reasoning:c.reasoning || 'low',model:c.model || state?.capabilities?.model,dirty:false,revision:0});
    return drafts.get(c.id);
  }
  function changeDraft(fn, textOnly=false) {
    const c=current();if(!c)return;
    const d=draftFor(c);fn(d);d.dirty=true;d.revision++;
    clearTimeout(draftTimer);draftTimer=setTimeout(()=>flushDraft(c.id).catch(e=>notice(e.message)),350);
    renderComposer(false,textOnly);
  }
  async function flushDraft(id) {
    clearTimeout(draftTimer);
    const d=drafts.get(id);if(!d || !d.dirty)return;
    const revision=d.revision;
    await api('/api/conversations/'+encodeURIComponent(id),'PATCH',{draft:d.text,draftAssets:d.assets.map(a=>a.id),reasoning:d.reasoning,...(d.model?{model:d.model}:{})});
    if(d.revision===revision)d.dirty=false;
  }
  function notice(message) {setText('agentNotice',message || '');show('agentNotice',!!message);}
  function safeLink(value) {
    try { const u=new URL(value,location.href);return ['http:','https:','mailto:'].includes(u.protocol) ? u.href : '#';}
    catch (_) {return '#';}
  }
  function markdown(raw) {
    return window.ShiYanOutput?window.ShiYanOutput.markdown(raw,icon('reply-copy')):'<p>'+esc(raw).replace(/\n/g,'<br>')+'</p>';
  }
  function dateText(value,full=false) {
    const d=new Date(value);if(Number.isNaN(d.getTime()))return '';
    if(full)return new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
    const today=new Date();const yesterday=new Date();yesterday.setDate(today.getDate()-1);
    const hm=d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
    if(d.toDateString()===today.toDateString())return '今天 '+hm;
    if(d.toDateString()===yesterday.toDateString())return '昨天 '+hm;
    return (d.getFullYear()!==today.getFullYear()?d.getFullYear()+'年':'')+(d.getMonth()+1)+'月'+d.getDate()+'日 '+hm;
  }
  function closePopovers(){closeSessionProjectMenu();['sessionMenu','sessionDeletePopover','historyMenu','messageMenu','assetMenu'].forEach(id=>show(id,false));window.workbench?.refreshOverlays?.();}
  function openHistory() {
    ui.historyReturnView=ui.view==='home'?'home':'agent';
    setView('history');
  }
  function setView(view) {
    if(ui.view==='agent' && view!=='agent'){saveReadingPosition();cancelSpeech();const c=current();if(c)flushDraft(c.id).catch(()=>{});}
    closePopovers();ui.view=view;
    for(const v of ['home','agent','history','search'])show(v+'View',v===view);
    document.body.dataset.view=view;
    window.dispatchEvent(new CustomEvent("shiyan-view",{detail:{view}}));
    if(state)renderConnection();
    if(view==='agent'){renderMessages(true);renderComposer(true);restoreReadingPosition(current()?.id);}
    if(view==='history'){renderHistory();}
    if(view==='search'){renderSearch();setTimeout(()=>$('searchInput').focus(),60);}
    if(view==='home'){renderPhoto();requestAnimationFrame(resizeMask);}
  }
  function applyState(next) {
    if(!next)return;
    if(state && Number(next.version)<Number(state.version))return;
    const previousId=state && state.selectedConversationId;
    state=next;state.conversations=state.conversations || [];state.history=state.history || [];state.settings=state.settings || {};state.photoJobs=state.photoJobs || [];
    (state.assets || []).forEach(remember);
    state.history.forEach(h=>remember(h.asset));
    state.conversations.forEach(c=>{
      (c.messages || []).forEach(m=>(m.assets || []).forEach(remember));
      (c.draftAssets || []).forEach(a=>typeof a==='object' && remember(a));
      const d=drafts.get(c.id);
      if(d && !d.dirty && !(ui.editing && ui.editing.conversationId===c.id)){d.text=c.draft || '';d.assets=(c.draftAssets || []).map(a=>typeof a==='string'?assets.get(a):a).filter(Boolean);d.reasoning=c.reasoning || 'low';d.model=c.model || state.capabilities?.model;}
    });
    if(previousId && previousId!==state.selectedConversationId){cancelSpeech();ui.editing=null;notice('');}
    renderConnection();renderSessions();renderMessages(previousId!==state.selectedConversationId);renderComposer(previousId!==state.selectedConversationId);renderPhoto();renderHistory();
    if(ui.view==='search')renderSearch();
    if(!initialized){initialized=true;restoreWorkspace().catch(()=>{});}
    window.dispatchEvent(new CustomEvent("shiyan-state",{detail:state}));
  }
  function renderConnection() {
    const c=state.connection || {};
    const message=c.status==='unauthorized'?'此 Mac 等待设备授权':c.status==='unavailable'?(c.error || 'Agent 服务暂时无法连接'):c.status==='connecting'?'正在连接 Agent':'';
    const relevant=ui.view==='agent';
    show('connectionBanner',!!message && relevant);setText('connectionText',message);
    const banner=$('connectionBanner');if(banner)banner.dataset.status=c.status || '';
    let retry=$('reconnectServiceButton');
    if(banner && !retry){retry=document.createElement('button');retry.id='reconnectServiceButton';retry.type='button';retry.textContent='重新连接';retry.addEventListener('click',connectAgent);banner.appendChild(retry);}
    if(retry)retry.hidden=c.status==='connecting';
    if(banner)banner.title=c.error || '';
  }
  async function connectAgent() {
    const button=$('reconnectServiceButton');if(button)button.disabled=true;
    try {await api('/api/agent/connect','POST',{});}
    catch(e){toast(e.message);}
    finally {if(button)button.disabled=false;}
  }
  function sortedConversations() {
    return [...(state ? state.conversations : [])].filter(c=>(c.messages || []).some(m=>m.role==='user')).sort((a,b)=>Number(b.isPinned)-Number(a.isPinned)||new Date(b.updatedAt)-new Date(a.updatedAt));
  }
  function conversationIcon() {const t=$('sessionRowTemplate');const svg=t && t.content.querySelector('svg');return svg?svg.outerHTML:icon('bubble.left.and.bubble.right');}
  function sessionHTML(c) {
    const selected=c.id===state.selectedConversationId;
    return '<button type="button" class="session-row'+(selected?' is-selected':'')+(c.isPinned?' is-pinned':'')+'" data-session-id="'+esc(c.id)+'" aria-label="'+esc(c.title || '新对话')+'" aria-current="'+(selected?'true':'false')+'">'+
      (c.isPinned?conversationIcon():'')+'<span class="session-title">'+esc(c.title || '新对话')+'</span>'+
      (isBusy(c)?'<span class="session-badge is-busy" aria-label="处理中"></span>':c.hasUnread?'<span class="session-badge is-unread" aria-label="未读"></span>':'')+
      '<span class="session-more" data-session-more="'+esc(c.id)+'" role="button" aria-label="会话选项" tabindex="0">'+icon('ellipsis')+'</span></button>';
  }
  function renderSessions() {
    if(!state)return;
    const all=sortedConversations(),pins=all.filter(c=>c.isPinned),recent=all.filter(c=>!c.isPinned && !c.projectId);
    show('pinnedSection',pins.length>0);
    {const list=$('pinnedSessions'),html=pins.map(sessionHTML).join('');if(list.__sessionHTML!==html){list.innerHTML=html;list.__sessionHTML=html;}}
    {const list=$('recentSessions'),html=recent.map(sessionHTML).join('');if(list.__sessionHTML!==html){list.innerHTML=html;list.__sessionHTML=html;}}
  }
  function fileDescription(a) {
    const ext=(a.filename||'').split('.').pop().toLowerCase();
    const kind=({md:'Markdown',docx:'Word',doc:'Word',pdf:'PDF',xlsx:'Excel',xls:'Excel',pptx:'PowerPoint',ppt:'PowerPoint',json:'JSON',txt:'文本',pdf:'PDF',csv:'CSV',html:'HTML',zip:'ZIP'})[ext]||ext.toUpperCase()||'文件';
    const bytes=Number(a.bytes),size=bytes>0?(bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB'):'';
    return kind+(size?' · '+size:'');
  }
  function assetTypeIcon(a) {
    const ext=(a.filename||'').split('.').pop().toLowerCase();
    const types={docx:['word','W'],doc:['word','W'],pdf:['pdf','PDF'],xlsx:['excel','X'],xls:['excel','X'],csv:['excel','CSV'],pptx:['slides','P'],ppt:['slides','P'],md:['markdown','M↓'],json:['json','{}'],jsonl:['json','{}'],zip:['archive','ZIP'],'7z':['archive','7Z'],svg:['vector','SVG'],txt:['text','TXT'],html:['code','<>'],js:['code','JS'],py:['code','Py']};
    const [kind,label]=types[ext]||['text',(ext||'FILE').toUpperCase().slice(0,4)];
    return '<span class="asset-type-icon type-'+kind+'" aria-hidden="true">'+icon('doc')+'<span>'+esc(label)+'</span></span>';
  }
  function assetHTML(a) {
    const isImage=(a.mimeType || '').startsWith('image/');
    return '<button type="button" class="asset-card '+(isImage?'is-image':'is-file')+'" data-asset-id="'+esc(a.id)+'" aria-label="'+esc(isImage?'预览图片 '+(a.filename || ''):a.filename || '打开文件')+'">'+
      (isImage?'<img class="asset-image" src="'+esc(assetUrl(a))+'" alt="'+esc(a.filename || '图片')+'" '+(a.width&&a.height?'width="'+Number(a.width)+'" height="'+Number(a.height)+'" style="aspect-ratio:'+Number(a.width)+' / '+Number(a.height)+';height:auto" ':'')+'loading="lazy">':assetTypeIcon(a)+'<span class="asset-file-info"><span class="asset-name" title="'+esc(a.filename || '文件')+'">'+esc(a.filename || '文件')+'</span><span class="file-kind">'+esc(fileDescription(a))+'</span></span>')+'</button>';
  }
  function canRetryConnection(m) {
    if(m.role!=='assistant' || !m.error)return false;
    if(current()?.messages?.at(-1)?.id!==m.id)return false;
    if(m.state==='reconnecting')return true;
    return m.state==='failed' && /连接中断|检查网络|网络连接|无法连接|接收中断|connection|network|timed out/i.test(m.error);
  }
  function messageHTML(m) {
    const user=m.role==='user',busy=busyStates.has(m.state),retry=canRetryConnection(m);
    const at=user?m.createdAt:m.completedAt;
    const time=at?'<time datetime="'+esc(at)+'" title="'+esc(dateText(at,true))+'">'+esc(dateText(at))+'</time>':'';
    const tools='<div class="v22-message-tools">'+(user?time:'')+'<button type="button" data-copy-message="'+esc(m.id)+'" aria-label="复制消息">'+icon('reply-copy')+'</button>'+(retry?'<button type="button" data-retry-message="'+esc(m.id)+'" aria-label="重试" title="重试">'+icon('arrow.clockwise')+'</button>':'')+(user?'<button type="button" data-edit-message="'+esc(m.id)+'" aria-label="编辑消息">'+messageEditIcon()+'</button>':time)+'</div>';
    const changeFiles=!user&&!busy?(window.ShiYanChanges?.filesFor(m)||[]):[];
    const changeSummary=!user&&!busy?(window.ShiYanChanges?.summary(m,changeFiles)||''):'';
    const changedNames=new Set(changeSummary?changeFiles.map(f=>String(f.path).replace(/\\/g,'/').split('/').pop()):[]);
    const attachments=(m.assets||[]).filter(a=>user||window.ShiYanOutput.generatedAssetVisible(a)),images=attachments.filter(a=>(a.mimeType||'').startsWith('image/')),files=attachments.filter(a=>!(a.mimeType||'').startsWith('image/')&&!changedNames.has(String(a.filename||'').replace(/\\/g,'/').split('/').pop()));
    let inner=(user?attachments:images).length?'<div class="message-assets">'+(user?attachments:images).map(assetHTML).join('')+'</div>':'';
    if(m.text)inner+='<div class="message-body">'+(user?esc(m.text).replace(/\n/g,'<br>'):markdown(m.text))+'</div>';
    if(!user&&files.length)inner+='<div class="message-files" aria-label="生成的文件">'+files.map(assetHTML).join('')+'</div>';
    if(!user && busy)inner+='<div class="thinking" aria-live="polite">'+esc(m.phase || '正在回复…')+'</div>';
    if(m.error)inner+='<div class="message-error">'+esc(m.error)+'</div>';
    if(!user && !busy && !m.text && !attachments.length && !m.error)inner+='<div class="message-empty">'+(m.state==='cancelled'?'已停止':'本次没有可展示的内容')+'</div>';
    const elapsed=!user&&m.requestStartedAt?'<div class="v22-elapsed" data-start="'+esc(m.requestStartedAt)+'" '+(m.completedAt?'data-end="'+esc(m.completedAt)+'"':'')+'><span></span></div>':'';
    return (user&&at?'<div class="v23-message-time"><time datetime="'+esc(at)+'">'+esc(dateText(at))+'</time></div>':'')+'<article class="message '+(user?'is-user':'is-assistant')+'" data-message-id="'+esc(m.id)+'">'+elapsed+'<div class="message-content">'+inner+'</div>'+changeSummary+(user||!busy||retry?tools:'')+'</article>';
  }
  let lastMessagesSignature='',lastRenderedConversation='',messageFollowFrame=0,messageAutoFollow=true,messageLastScrollTop=0;
  const readingPositions=new Map(),pendingReadingPositions=new Map();let readingSaveTimer=0,restoringReadingPosition=false,readingRestoreGeneration=0,messageUserScrollUntil=0;
  function saveReadingPosition(id=lastRenderedConversation){
    const scroller=$('messagesScroller');if(!id || ui.view!=='agent' || !scroller.clientHeight || restoringReadingPosition)return;
    const bounds=scroller.getBoundingClientRect(),anchor=[...$('messages').querySelectorAll(':scope>article')].find(e=>e.getBoundingClientRect().bottom>bounds.top+1);
    const position={scrollTop:scroller.scrollTop,anchorMessageId:anchor?.dataset.messageId||'',offset:anchor?anchor.getBoundingClientRect().top-bounds.top:0,followLatest:messageAutoFollow};
    readingPositions.set(id,position);pendingReadingPositions.set(id,position);clearTimeout(readingSaveTimer);readingSaveTimer=setTimeout(flushReadingPositions,500);
  }
  async function flushReadingPositions(){
    clearTimeout(readingSaveTimer);const pending=[...pendingReadingPositions];pendingReadingPositions.clear();
    for(const [id,readingPosition] of pending){try{await api('/api/conversations/'+encodeURIComponent(id),'PATCH',{readingPosition});}catch(_){if(!pendingReadingPositions.has(id))pendingReadingPositions.set(id,readingPosition);}}
  }
  function restoreReadingPosition(id){
    if(!id)return;const generation=++readingRestoreGeneration;const saved=readingPositions.get(id)||state?.conversations.find(c=>c.id===id)?.readingPosition;
    if(!saved){messageAutoFollow=true;scrollToLatest();return;}
    messageAutoFollow=!saved.anchorMessageId && saved.followLatest===true;restoringReadingPosition=true;
    const restore=()=>{if(generation!==readingRestoreGeneration || lastRenderedConversation!==id)return;const scroller=$('messagesScroller'),bounds=scroller.getBoundingClientRect(),anchor=saved.anchorMessageId&&$('messages').querySelector('[data-message-id="'+CSS.escape(saved.anchorMessageId)+'"]');
      scroller.scrollTop=messageAutoFollow?scroller.scrollHeight:anchor?scroller.scrollTop+anchor.getBoundingClientRect().top-bounds.top-saved.offset:saved.scrollTop;messageLastScrollTop=scroller.scrollTop;show('latestButton',!messageAutoFollow&&!!current()?.messages?.length);};
    restore();requestAnimationFrame(()=>{restore();requestAnimationFrame(()=>{if(generation===readingRestoreGeneration)restoringReadingPosition=false;});});
  }

  function renderMessages(force=false) {
    const c=current(),messages=c && c.messages || [],conversationId=c?.id||'';
    const signature=conversationId+':'+JSON.stringify(messages);
    if(!force && signature===lastMessagesSignature)return;
    const scroller=$('messagesScroller'),list=$('messages'),oldTop=scroller.scrollTop;
    const changedConversation=conversationId!==lastRenderedConversation;
    if(changedConversation){saveReadingPosition(lastRenderedConversation);const saved=readingPositions.get(conversationId)||c?.readingPosition;messageAutoFollow=saved?(!saved.anchorMessageId && saved.followLatest===true):true;}
    const follow=messageAutoFollow;
    const bounds=scroller.getBoundingClientRect();
    const anchor=changedConversation?null:[...list.querySelectorAll(':scope>article')].find(e=>e.getBoundingClientRect().bottom>bounds.top+1);
    const anchorOffset=anchor?.getBoundingClientRect().top-bounds.top;
    const existing=new Map([...list.querySelectorAll(':scope>article')].map(e=>[e.dataset.messageId,e]));
    const desired=[];
    for(const message of messages){
      const fingerprint=JSON.stringify(message);let article=existing.get(message.id);
      if(!changedConversation && article?.__messageFingerprint===fingerprint){
        if(article.__messageTime)desired.push(article.__messageTime);
        desired.push(article);continue;
      }
      const template=document.createElement('template');template.innerHTML=messageHTML(message);
      const nodes=[...template.content.children],fresh=nodes.find(e=>e.matches('article'));
       
       
      if(!changedConversation && article){
        const oldAssets=article.querySelector(".message-content>.message-assets"),newAssets=fresh.querySelector(".message-content>.message-assets");
        if(oldAssets && newAssets && oldAssets.outerHTML===newAssets.outerHTML)newAssets.replaceWith(oldAssets);
        const oldBody=article.querySelector('.message-body'),newBody=fresh.querySelector('.message-body');
        if(oldBody&&newBody&&article.__bodyText===(message.text||'')&&article.__bodyRole===message.role)newBody.replaceWith(oldBody);
        else if(oldBody&&newBody){
          const images=[...oldBody.querySelectorAll('img')];
          for(const image of newBody.querySelectorAll('img')){const old=images.find(i=>i.outerHTML===image.outerHTML);if(old){image.replaceWith(old);images.splice(images.indexOf(old),1);}}
        }
        const oldDetails=article.querySelector('.output-details'),newDetails=fresh.querySelector('.output-details');
        if(oldDetails&&newDetails){
          if(oldDetails.dataset.userToggled){newDetails.open=oldDetails.open;newDetails.dataset.userToggled='1';}
          if(oldDetails.innerHTML===newDetails.innerHTML){if(!oldDetails.dataset.userToggled)oldDetails.open=newDetails.open;newDetails.replaceWith(oldDetails);}
        }
        article.className=fresh.className;
        article.replaceChildren(...fresh.childNodes);
      }else article=fresh;
      const freshTime=nodes.find(e=>e.classList.contains('v23-message-time'))||null;
      const time=article.__messageTime&&freshTime&&article.__messageTime.outerHTML===freshTime.outerHTML?article.__messageTime:freshTime;
      article.__messageFingerprint=fingerprint;article.__messageTime=time;article.__bodyText=message.text||'';article.__bodyRole=message.role;
      if(time)desired.push(time);
      desired.push(article);
    }
     
    let cursor=list.firstElementChild;
    for(const node of desired){if(node===cursor)cursor=cursor.nextElementSibling;else list.insertBefore(node,cursor);}
    const keep=new Set(desired);for(const node of [...list.children])if(!keep.has(node))node.remove();
    lastMessagesSignature=signature;lastRenderedConversation=conversationId;
    show('emptyConversation',!messages.length);
    cancelAnimationFrame(messageFollowFrame);
    if(changedConversation){restoreReadingPosition(conversationId);}
    else if(follow){
       
       
      scrollToLatest();
      messageFollowFrame=requestAnimationFrame(()=>{if(conversationId===lastRenderedConversation&&messageAutoFollow)scrollToLatest();});
    }else{
      const restored=anchor&&list.querySelector('[data-message-id="'+CSS.escape(anchor.dataset.messageId)+'"]');
      scroller.scrollTop=restored?scroller.scrollTop+restored.getBoundingClientRect().top-bounds.top-anchorOffset:oldTop;
      messageLastScrollTop=scroller.scrollTop;
    }
    show('latestButton',!messageAutoFollow && messages.length>0);
  }
  function scrollToLatest(){++readingRestoreGeneration;restoringReadingPosition=false;const el=$('messagesScroller');messageAutoFollow=true;el.scrollTop=el.scrollHeight;messageLastScrollTop=el.scrollTop;show('latestButton',false);}
  function pauseMessageFollow(){++readingRestoreGeneration;restoringReadingPosition=false;messageAutoFollow=false;cancelAnimationFrame(messageFollowFrame);show('latestButton',!!current()?.messages?.length);}
  let composerSizeFrame=0,composerMeasureInput=null;
  let composerTypingConversation='',composerTypingEmpty=null;
  let composerComposing=false,composerCompositionEnding=false,composerRefreshDeferred=false,composerCompositionFrame=0;
  function bindComposerComposition(input) {
    input.addEventListener('compositionstart',()=>{
      cancelAnimationFrame(composerCompositionFrame);
      composerComposing=true;composerCompositionEnding=false;
    });
    input.addEventListener('compositionend',()=>{
      composerComposing=false;composerCompositionEnding=true;
      cancelAnimationFrame(composerCompositionFrame);
      composerCompositionFrame=requestAnimationFrame(()=>{
        composerCompositionEnding=false;
        if(composerRefreshDeferred){composerRefreshDeferred=false;renderComposer();}
        else scheduleComposerSize();
      });
    });
  }

  function scheduleComposerSize() {
    if(composerSizeFrame)return;
    composerSizeFrame=requestAnimationFrame(()=>{
      composerSizeFrame=0;
      const input=$('messageInput');if(!input || !input.getClientRects().length)return;
      const style=getComputedStyle(input);if(parseFloat(style.width)<=0)return;
      if(!composerMeasureInput){
        composerMeasureInput=document.createElement('textarea');
        composerMeasureInput.tabIndex=-1;composerMeasureInput.setAttribute('aria-hidden','true');
        composerMeasureInput.inert=true;
        composerMeasureInput.style.cssText='position:fixed;left:-10000px;top:0;height:0;min-height:0;max-height:none;visibility:hidden;pointer-events:none;contain:layout style paint;overflow:hidden;resize:none;';
        document.body.append(composerMeasureInput);
      }
      const mirror=composerMeasureInput;
      for(const property of ['width','minHeight','boxSizing','font','lineHeight','letterSpacing','padding','border','whiteSpace','wordBreak','overflowWrap','textIndent','tabSize','direction']){
        if(mirror.style[property]!==style[property])mirror.style[property]=style[property];
      }
      mirror.wrap=input.wrap;mirror.placeholder=input.placeholder;mirror.value=input.value;
      const height=Math.min(156,Math.max(32,mirror.scrollHeight))+'px';
      if(input.style.height!==height)input.style.height=height;
    });
  }
  function attachmentItemHTML(a) {const image=(a.mimeType||'').startsWith('image/');return '<div class="attachment-item'+(image?'':' attachment-document')+'"><button type="button" data-asset-id="'+esc(a.id)+'" aria-label="'+esc('预览 '+(a.filename||'附件'))+'" title="'+esc(a.filename||'附件')+'">'+(image?'<img class="attachment-image" src="'+esc(assetUrl(a))+'" alt="'+esc(a.filename || '附件')+'">':assetTypeIcon(a)+'<span class="attachment-filename">'+esc(a.filename||'文件')+'</span>')+'</button><button type="button" class="attachment-remove" data-remove-attachment="'+esc(a.id)+'" aria-label="移除附件">'+icon('xmark')+'</button></div>';}
  function renderComposer(force=false, textOnly=false) {
    if(force){composerComposing=false;composerCompositionEnding=false;composerRefreshDeferred=false;cancelAnimationFrame(composerCompositionFrame);}
    if(composerComposing || composerCompositionEnding){composerRefreshDeferred=true;return;}
    const c=current(),d=draftFor(c),empty=!d.text.trim() && !d.assets.length;
    // As with Dots, continuous typing must not rewrite the live editor or toolbar.
    if(textOnly && !empty && composerTypingConversation===(c?.id||'') && composerTypingEmpty===empty){scheduleComposerSize();return;}
    const busy=isBusy(c)||ui.submitting||stoppingConversations.has(c?.id);
    const input=$('messageInput');
    if(force || (document.activeElement!==input && input.value!==d.text))input.value=d.text;
    const inputDisabled=!c || ui.submitting;if(input.disabled!==inputDisabled)input.disabled=inputDisabled;
    const attachmentHTML=d.assets.map(attachmentItemHTML).join('');
    const attachmentList=$('attachmentList');if(attachmentList.__attachmentHTML!==attachmentHTML){attachmentList.innerHTML=attachmentHTML;attachmentList.__attachmentHTML=attachmentHTML;}
    show('attachmentList',!!d.assets.length);
    show('editBanner',!!ui.editing);setText('editBannerText','编辑后重新发送');

    const stopping=stoppingConversations.has(c?.id),stopMode=empty && (isBusy(c) || stopping);
    const send=$('sendButton');send.classList.toggle('is-empty',empty && !stopMode);send.classList.toggle('is-busy',stopMode);
    send.dataset.action=stopMode?'stop':'send';send.type=stopMode?'button':'submit';
    send.disabled=!c || ui.submitting || (stopMode?stopping:empty);
    const actionLabel=stopMode?(stopping?'正在中断…':'中断回复'):(busy?'排队等待':'发送消息');
    send.setAttribute('aria-label',actionLabel);send.title=actionLabel;send.setAttribute('aria-busy',String(stopping));
    $('sendIcon').dataset.symbol=stopMode?'stop.fill':'arrow.up';
    $('addImageButton').disabled=ui.submitting || d.assets.length>=maxImages();
    const queued=c?.messageQueue || [],queueElement=$('messageQueue');const queueHTML=queued.map((m,i)=>'<div class="message-queue-row"><span class="message-queue-label">'+(m.urgent?'优先等待':('等待 '+(i+1)))+'</span><span class="message-queue-text">'+esc(m.text || '附件消息')+'</span><button type="button" class="queue-return-button" data-priority-queued="'+esc(m.id)+'" aria-label="优先处理这条等待消息" title="优先处理"'+(m.urgent?' disabled':'')+'><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v8a3 3 0 0 1-3 3H5m5-5-5 5 5 5"/></svg></button><button type="button" data-remove-queued="'+esc(m.id)+'" aria-label="移除等待消息">×</button></div>').join('')+(c?.queueError?'<div class="message-queue-error">'+esc(c.queueError)+'</div>':'');if(queueElement.__queueHTML!==queueHTML){queueElement.innerHTML=queueHTML;queueElement.__queueHTML=queueHTML;}show('messageQueue',!!queued.length);
    $('speechButton').classList.toggle('is-recording',ui.speech);
    $('speechButton').querySelector('.symbol').dataset.symbol=ui.speech?'stop.fill':'mic';
    $('composerForm').classList.toggle('is-recording',ui.speech);$('composerForm').classList.toggle('is-reasoning-open',ui.reasoning);
    $('speechButton').setAttribute('aria-label',ui.speech?'停止语音输入':'语音输入');
    $('speechButton').disabled=busy || ui.speechFinishing;
    $('composerForm').classList.toggle('is-expanded',false);
    $('composerForm').classList.toggle('has-attachments',!!d.assets.length);
    if(!textOnly)renderReasoning();
    composerTypingConversation=c?.id||'';composerTypingEmpty=empty;
    scheduleComposerSize();
  }
  function maxImages(){return Number(state && state.capabilities && state.capabilities.maxUploadImages)||8;}
  function modelChoices(){
    if(state?.connection?.status!=='ready')return [];
    const caps=state.capabilities || {};
    return caps.models?.length?caps.models:[{id:caps.model,displayName:caps.model,reasoningEfforts:caps.reasoningEfforts || [],defaultReasoning:caps.defaultReasoning}];
  }
  function modelCapability(){const choices=modelChoices(),d=draftFor();return choices.find(m=>m.id===d.model)||choices.find(m=>m.id===state?.capabilities?.model)||choices[0];}
  function efforts(){return modelCapability()?.reasoningEfforts || [];}
  function slideReasoningText(node,text,index) {
    if(!node)return;
    const previous=node.dataset.reasoningText,previousIndex=Number(node.dataset.reasoningIndex);
    if(previous===text){node.dataset.reasoningIndex=index;return;}
    node.querySelectorAll('span').forEach(span=>span.getAnimations().forEach(a=>a.cancel()));
    node.dataset.reasoningText=text;node.dataset.reasoningIndex=index;
    node.classList.add('reasoning-text-slot');node.setAttribute('aria-label',text);
    const current=document.createElement('span');current.className='reasoning-text-current';node.replaceChildren(current);
    const previousChars=Array.from(previous||''),nextChars=Array.from(text);
    const columns=Math.max(previousChars.length,nextChars.length);
    const animate=previous!==undefined&&previousIndex!==index&&node.getClientRects().length&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
    const direction=index>previousIndex?1:-1,options={duration:180,easing:'cubic-bezier(.22,.8,.3,1)',fill:'none'};
    const createCharacter=(value,parent,position,count)=>{
      const span=document.createElement('span');span.className='reasoning-character';
      span.style.left='calc(50% + '+(position-count/2)+'em)';
      span.textContent=value;parent.append(span);return span;
    };
    for(let column=0;column<columns;column++){
      const sourcePosition=column-columns+previousChars.length,targetPosition=column-columns+nextChars.length;
      const sourceText=previousChars[sourcePosition]||'',targetText=nextChars[targetPosition]||'';
      const next=targetText?createCharacter(targetText,current,targetPosition,nextChars.length):null;
      if(!animate||sourceText===targetText)continue;
      const old=sourceText?createCharacter(sourceText,node,sourcePosition,previousChars.length):null;
      if(old)old.setAttribute('aria-hidden','true');
      const outgoing=old?.animate([{transform:'translateY(0)',opacity:1},{transform:'translateY('+(-direction*100)+'%)',opacity:0}],options);
      const incoming=next?.animate([{transform:'translateY('+(direction*100)+'%)',opacity:0},{transform:'translateY(0)',opacity:1}],options);
      const cleanup=()=>{old?.remove();incoming?.cancel();};const timer=setTimeout(cleanup,220);
      outgoing?.finished.then(()=>{clearTimeout(timer);cleanup();}).catch(()=>{clearTimeout(timer);old?.remove();});
    }
  }

  function renderReasoning() {
    const values=efforts(),d=draftFor(),index=Math.max(0,values.indexOf(d.reasoning));
    const range=$('reasoningRange'),available=values.length>0;
    range.min=0;range.max=Math.max(0,values.length-1);range.step='0.001';range.disabled=!available;
    range.value=ui.reasoningDragging?ui.reasoningPosition:index;
    range.setAttribute('aria-valuetext',reasoningNames[values[index]] || values[index] || '能力暂不可用');
    slideReasoningText($('reasoningTitle'),available?(reasoningNames[values[index]] || values[index]):'暂不可用',index);
    $('reasoningDots').innerHTML=values.map((value,i)=>'<span class="reasoning-dot'+(i<=Number(range.value)?' is-passed':'')+'" title="'+esc(reasoningNames[value] || value)+'"></span>').join('');
    const composerModel=modelCapability();$('reasoningButton').querySelector('.v23-composer-model').textContent=composerModel?.displayName||composerModel?.id||'';
    slideReasoningText($('reasoningButton').querySelector('.v22-strength-label'),available?(reasoningNames[values[index]]||values[index]):'暂不可用',index);
    $('reasoningButton').setAttribute('aria-label','选择推理强度：'+(reasoningNames[values[index]] || '暂不可用'));
    $('reasoningButton').setAttribute('aria-expanded',String(ui.reasoning));show('reasoningPanel',ui.reasoning);show('reasoningBackdrop',ui.reasoning);
    const selected=modelCapability(),choices=modelChoices(),modelSelect=$('reasoningModel');
    if(modelSelect){
      const html=choices.map(m=>'<option value="'+esc(m.id)+'">'+esc(m.displayName || m.id)+'</option>').join('') || '<option value="">云端能力暂不可用</option>';
      if(modelSelect.innerHTML!==html)modelSelect.innerHTML=html;
      modelSelect.value=selected?.id || '';modelSelect.disabled=!choices.length;const measure=document.createElement('canvas').getContext('2d');if(measure){measure.font=getComputedStyle(modelSelect).font;modelSelect.style.width=Math.ceil(measure.measureText(modelSelect.selectedOptions[0]?.textContent||'').width+24)+'px';}
      $('reasoningReset').disabled=!available;
    }
    const ratio=values.length>1?Number(range.value)/(values.length-1):0;
    $('reasoningTrack').style.setProperty('--reasoning-progress',String(ratio));$('reasoningTrack').classList.toggle('is-minimum',ratio===0);
    window.dispatchEvent(new CustomEvent('shiyan-reasoning'));
    const radians=degrees=>degrees*Math.PI/180,angle=135+270*(.30+.67*ratio);
    const sx=14+12*Math.cos(radians(135)),sy=14+12*Math.sin(radians(135));
    const ex=14+12*Math.cos(radians(angle)),ey=14+12*Math.sin(radians(angle));
    $('gaugeActive').setAttribute('d','M'+sx+' '+sy+' A12 12 0 '+(angle-135>180?1:0)+' 1 '+ex+' '+ey);
    $('gaugeActive').style.strokeDasharray='none';
    $('gaugePointer').style.transform='none';
    $('gaugePointer').setAttribute('d','M'+(14+3.3*Math.cos(radians(angle)))+' '+(14+3.3*Math.sin(radians(angle)))+' L'+(14+8.5*Math.cos(radians(angle)))+' '+(14+8.5*Math.sin(radians(angle))));
  }

  async function selectConversation(id) {
    cancelSpeech();const c=current();if(c && c.id!==id)await flushDraft(c.id);
    ui.editing=null;notice('');
    await api('/api/conversations/'+encodeURIComponent(id)+'/select','POST',{});
    setDrawer(false);setView('agent');
  }
  async function newConversation(projectId) {
    cancelSpeech();const c=current();if(c)await flushDraft(c.id);
    ui.editing=null;notice('');
    await api('/api/conversations','POST',{projectId:typeof projectId==='string'?projectId:null});
    setDrawer(false);setView('agent');$('messageInput').focus();
  }
  function setDrawer(open) {
    if(window.workbench){closePopovers();return;}
    ui.drawer=open;
    $('agentStage').classList.toggle('is-drawer-open',open);
    $('agentStage').style.setProperty('--drawer-progress',open?'1':'0');
    $('openSidebarButton').setAttribute('aria-expanded',String(open));
    const compact=window.innerWidth<760;
    $('agentSidebar').setAttribute('aria-hidden',String(compact && !open));show('closeSidebarButton',compact && open);$('closeSidebarButton').tabIndex=compact && open?0:-1;
    closePopovers();ui.reasoning=false;renderComposer();
  }
  function validateAttachmentFiles(files, existing=[]) {
    if(files.length>maxImages()-existing.length)throw new Error('每次最多添加 '+maxImages()+' 个附件');
    const image=f=>(f.type||'').startsWith('image/') || /\.(heic|heif)$/i.test(f.name||'');
    if(files.some(f=>!image(f) && f.size>10*1024*1024))throw new Error('单个文档不能超过 10 MB');
    if((files.some(f=>!image(f)) || existing.some(a=>!(a.mimeType||'').startsWith('image/'))) && files.reduce((n,f)=>n+f.size,existing.reduce((n,a)=>n+(a.bytes||0),0))>24*1024*1024)throw new Error('图片与文档合计不能超过 24 MB');
  }
  async function addAttachments(files) {
    const c=current();if(!c)await newConversation();
    if(!files.length)return;
    try {validateAttachmentFiles(files,draftFor().assets);} catch(error){notice(error.message);return;}
    $('addImageButton').disabled=true;
    try {
      const result=await upload(files,'attachment');
      changeDraft(d=>{d.assets.push(...result);});
      await flushDraft(current().id);
    } catch(e){notice(e.message);}
    finally {$('attachmentInput').value='';renderComposer();}
  }
  async function submitMessage(event) {
    if(event)event.preventDefault();
    const c=current();if(!c || ui.submitting)return;
    const d=draftFor(c);if(!d.text.trim() && !d.assets.length)return;
    ui.reasoning=false;ui.submitting=true;notice('');renderComposer();
    try {
      await stopSpeech();
      if(!current() || current().id!==c.id)return;
      await flushDraft(c.id);
      const payload={text:d.text,assetIds:d.assets.map(a=>a.id),priority:"normal"};
      if(ui.editing && ui.editing.conversationId===c.id)payload.editingMessageId=ui.editing.messageId;
      await api('/api/conversations/'+encodeURIComponent(c.id)+'/send','POST',payload);
      const updated=draftFor(c);updated.text='';updated.assets=[];updated.dirty=false;updated.revision++;
      ui.editing=null;$('messageInput').value='';if(!isBusy(c))scrollToLatest();
    } catch(e){notice(e.message);}
    finally {ui.submitting=false;renderComposer(true);}
  }
  async function stopGeneration() {
    const c=current();if(!isBusy(c) || stoppingConversations.has(c.id))return;
    stoppingConversations.add(c.id);renderComposer();
    try {await api('/api/conversations/'+encodeURIComponent(c.id)+'/stop','POST',{});}
    catch(e){if(current()?.id===c.id)notice('停止尚未确认：'+e.message);}
    finally {stoppingConversations.delete(c.id);renderComposer();}
  }
  async function retryReceive() {
    const c=current();if(!c)return;
    try {await api('/api/conversations/'+encodeURIComponent(c.id)+'/retry','POST',{});notice('');}
    catch(e){notice(e.message);}
  }
  function editMessage(id) {
    const c=current();if(!c || isBusy(c)){toast('请先等待当前回复完成');return;}
    const m=(c.messages || []).find(m=>m.id===id && m.role==='user');if(!m)return;
    const d=draftFor(c);
    ui.editing={conversationId:c.id,messageId:m.id,original:{text:d.text,assets:[...d.assets],reasoning:d.reasoning}};
    d.text=m.text || '';d.assets=[...(m.assets || [])];if(m.reasoning)d.reasoning=m.reasoning;d.dirty=true;d.revision++;
    closePopovers();renderComposer(true);$('messageInput').focus();
  }
  function cancelEdit() {
    if(!ui.editing)return;
    const d=draftFor();Object.assign(d,ui.editing.original);d.dirty=true;d.revision++;
    ui.editing=null;renderComposer(true);
    const c=current();if(c)flushDraft(c.id).catch(e=>notice(e.message));
  }
  function renderSearch() {
    if(!state)return;
    const term=ui.searchTerm.trim().toLocaleLowerCase();
    let results=sortedConversations().filter(c=>!term || (c.title || '').toLocaleLowerCase().includes(term) || (c.messages || []).some(m=>(m.text || '').toLocaleLowerCase().includes(term)));
    if(!term)results=results.sort((a,b)=>new Date(b.lastOpenedAt || b.updatedAt)-new Date(a.lastOpenedAt || a.updatedAt));
    setText('searchHeading',term?'搜索结果':'最近打开');
    $('searchResults').innerHTML=results.length?results.map(c=>{const message=[...(c.messages || [])].reverse().find(m=>m.text && m.text.trim());const excerpt=message?message.text.replace(/\s+/g,' ').slice(0,100):'新对话';return '<button type="button" class="search-result" data-search-session="'+esc(c.id)+'"><span class="search-result-icon">'+conversationIcon()+'</span><span class="search-result-copy"><strong class="search-result-title">'+esc(c.title || '新对话')+'</strong><span class="search-result-excerpt">'+esc(excerpt)+'</span></span></button>';}).join(''):'<div class="empty-state">没有找到对话</div>';
    show('clearSearchButton',!!ui.searchTerm);
  }
  async function restoreWorkspace() {
    ui.restoring=true;
    ui.feature='enhance';  
    ui.model=state.settings.homeModel==='anime'?'anime':'general';
    ui.input=await resolveAsset(state.settings.homeInputAssetId);
    if(ui.input){
      const jobs=state.photoJobs.filter(j=>j.inputAssetId===ui.input.id && j.feature===ui.feature).sort((a,b)=>new Date(b.createdAt || 0)-new Date(a.createdAt || 0));
      if(jobs[0]){ui.photoJobId=jobs[0].id;ui.result=await resolveAsset(jobs[0].outputAssetId);}
    }
    ui.restoring=false;renderPhoto();
    if(!state.conversations.length)await api('/api/conversations','POST',{});
  }
  async function saveWorkspace() {
    if(ui.photoUploadFile)return;
    await api('/api/settings','PATCH',{homeInputAssetId:ui.input && ui.input.id,homeFeature:ui.feature,homeModel:ui.model});
  }
  async function chooseWebHomeImage(file) {
    const keys=['input','result','showOriginal','photoJobId','strokes','photoError','photoUploadFile','photoLocalURL'];
    const previous=Object.fromEntries(keys.map(key=>[key,ui[key]]));
    const url=URL.createObjectURL(file);
    const local={id:'local:'+url,url,filename:file.name,mimeType:file.type};
    ui.input=local;ui.result=null;ui.showOriginal=false;ui.photoJobId=null;ui.strokes=[];
    ui.photoError='';ui.photoUploadFile=file;ui.photoLocalURL=url;ui.photoUploading=true;
    $('homeFileInput').disabled=true;
    renderPhoto(); // Preview the selected file before waiting for the network.
    const image=new Image();
    image.onload=()=>{if(ui.input===local){local.width=image.naturalWidth;local.height=image.naturalHeight;renderPhoto();}};
    image.src=url;
    let restored=false;
    try {
      const result=await upload([file]);if(!result[0])throw new Error('没有读取到图片');
      const asset=result[0];
      if(Math.max(asset.width || 0,asset.height || 0)>2000 && !await confirmAction('图片较大','图片分辨率超过 2000px，处理时间可能较长且占用更多内存，是否继续？','继续')){
        Object.assign(ui,previous);restored=true;return;
      }
      // Keep the decoded local original visible while using the server asset ID
      // for processing and persistence. Blob URLs are never saved to settings.
      ui.input=image.naturalWidth?{...asset,url}:asset;ui.photoUploadFile=null;
      if(!image.naturalWidth){URL.revokeObjectURL(url);ui.photoLocalURL=null;}
      try {await saveWorkspace();}catch(error){toast('图片已上传，但保存图片选择失败：'+error.message);}
    } catch(error) {
      const timeout=error.status===408 || /\b408\b/.test(error.message || '');
      ui.photoError=timeout?'图片上传超时，原图已保留，请点击“重试上传”。'
        :'图片上传失败：'+(error.message || '连接中断')+'。原图已保留，请点击“重试上传”。';
    } finally {
      ui.photoUploading=false;
      if(restored)URL.revokeObjectURL(url);
      else if(previous.photoLocalURL && previous.photoLocalURL!==ui.photoLocalURL)URL.revokeObjectURL(previous.photoLocalURL);
      $('homeFileInput').disabled=false;$('homeFileInput').value='';renderPhoto();
    }
  }
  async function chooseHomeImage(file) {
    if(!file)return;
    if(photoBusy()){toast('请先停止当前处理');return;}
    if(window.ShiYanPlatform?.mode==='web')return chooseWebHomeImage(file);
    $('homeFileInput').disabled=true;
    try {
      const result=await upload([file]);if(!result[0])throw new Error('没有读取到图片');
      if(Math.max(result[0].width || 0,result[0].height || 0)>2000 && !await confirmAction('图片较大','图片分辨率超过 2000px，处理时间可能较长且占用更多内存，是否继续？','继续'))return;
      ui.input=result[0];ui.result=null;ui.showOriginal=false;ui.photoJobId=null;ui.strokes=[];ui.photoError='';
      setText('photoError','');show('photoError',false);renderPhoto();await saveWorkspace();
    }catch(e){ui.photoError=e.message;setText('photoError',e.message);show('photoError');}
    finally {$('homeFileInput').disabled=false;$('homeFileInput').value='';}
  }
  function photoJob(){return state && (state.photoJobs || []).find(j=>j.id===ui.photoJobId);}
  function photoBusy(){const j=photoJob();return ui.photoUploading || ui.photoSubmitting || !!(j && busyStates.has(j.state));}
  function setFeature(feature) {
    if(feature==='agent'){setView('agent');return;}
    if(feature!=='enhance'){toast('此图片工具已下线');return;}
    if(photoBusy()){toast('请先停止当前处理');return;}
    if(ui.feature!==feature){ui.feature=feature;ui.result=null;ui.showOriginal=false;ui.strokes=[];ui.photoJobId=null;ui.photoError='';}
    renderPhoto();renderConnection();saveWorkspace().catch(e=>toast(e.message));
  }
  function renderPhoto() {
    if(!state)return;
    const job=photoJob(),busy=photoBusy();
    if(job && job.outputAssetId && assets.has(job.outputAssetId))ui.result=assets.get(job.outputAssetId);
    const image=ui.showOriginal || !ui.result?ui.input:ui.result;
    $('homeWorkspace').style.setProperty('--photo-aspect',String(image && image.width && image.height?image.width/image.height:1));
    $$('[data-feature]').forEach(el=>{const active=el.dataset.feature===ui.feature;el.classList.toggle('is-selected',active);el.setAttribute('aria-selected',String(active));});
    $$('[data-model]').forEach(el=>{const active=el.dataset.model===(ui.model==='anime'?'x4anime':'x4');el.classList.toggle('is-selected',active);el.setAttribute('aria-pressed',String(active));el.disabled=busy;});
    show('enhanceControls',ui.feature==='enhance');show('removeControls',ui.feature==='remove' && !!ui.input);show('colorizeControls',ui.feature==='colorize');
    show('imageEmptyState',!ui.input);show('homeImage',!!ui.input);show('imageMeta',!!image);
    show('changeImageButton',!!ui.input);show('previewHomeButton',!!image && !busy);
    show('showResultButton',!!ui.result);show('showOriginalButton',!!ui.result);
    $('showResultButton').classList.toggle('is-selected',!ui.showOriginal);
    $('showOriginalButton').classList.toggle('is-selected',ui.showOriginal);
    setText('showResultButton',ui.feature==='remove'?'消除':ui.feature==='colorize'?'上色':'增强');
    setText('imageDimensions',image && image.width && image.height ? image.width+' × '+image.height:'');
    if(image && $('homeImage').getAttribute('src')!==assetUrl(image))$('homeImage').src=assetUrl(image);
    if(!image)$('homeImage').removeAttribute('src');
    $('imageDropZone').classList.toggle('has-image',!!image);
    $('imageDropZone').classList.toggle('is-processing',busy);
    $('imageDropZone').classList.toggle('is-editing',ui.feature==='remove' && !!ui.input && !busy && (!ui.result || ui.showOriginal));
    const canDraw=ui.feature==='remove' && !!ui.input && !busy && (!ui.result || ui.showOriginal);
    show('maskCanvas',canDraw);$('maskCanvas').style.pointerEvents=canDraw?'auto':'none';
    const redo=ui.feature==='remove' && !!ui.result;
    const processLabel=ui.photoUploadFile?'重试上传':redo?'重新涂抹':ui.feature==='enhance'?'开始增强':ui.feature==='remove'?'开始消除':'开始上色';
    $('processIcon').dataset.symbol=redo?'pencil.tip':ui.feature==='remove'?'eraser':ui.feature==='colorize'?'paintpalette':'wand.and.stars';
    $('homeView').style.setProperty('--image-accent',ui.feature==='enhance' && ui.model==='anime'?'var(--pink)':'var(--accent)');
    setText('processLabel',busy?(ui.photoUploading?'正在上传图片':ui.photoSubmitting?'正在准备':job && job.label || '处理中'):processLabel);
    $('processButton').disabled=!ui.input || busy || (ui.feature==='remove' && !ui.strokes.length && !redo);
    $('saveResultButton').disabled=!ui.result || busy;
    show('saveResultButton',!!ui.result);show('cancelProcessButton',busy && !ui.photoSubmitting && !!job);
    $('changeImageButton').disabled=busy;
    $('brushWidth').value=ui.brush;$('brushWidth').disabled=busy;
    $('undoStrokeButton').disabled=busy || !ui.strokes.length;$('clearStrokesButton').disabled=busy || !ui.strokes.length;
    show('processingOverlay',busy && !ui.photoUploading);$('processingOverlay').classList.toggle('is-indeterminate',busy && ui.feature!=='enhance');
    const raw=job && !ui.photoSubmitting?Number(job.progress)||0:0,progress=raw>1?Math.min(1,raw/100):Math.min(1,Math.max(0,raw));
    if($('progressRing'))$('progressRing').style.strokeDashoffset=String(175.929*(1-progress));
    setText('progressValue',Math.round(progress*100)+'%');setText('processingStatus',ui.photoSubmitting?'正在准备':job && job.label || '处理中');
    const error=!ui.photoSubmitting && ((job && job.error) || ui.photoError);
    if(error){setText('photoError',error);show('photoError');}else{show('photoError',false);}
    requestAnimationFrame(resizeMask);
    window.dispatchEvent(new CustomEvent("shiyan-photo"));
  }
  function imageDisplayRect() {
    const img=$('homeImage'),outer=$('imageDropZone').getBoundingClientRect(),r=img.getBoundingClientRect();
    const aspect=img.naturalWidth/(img.naturalHeight || 1),boxAspect=r.width/(r.height || 1);
    let w=r.width,h=r.height,x=r.left,y=r.top;
    if(boxAspect>aspect){w=h*aspect;x+=(r.width-w)/2;}else{h=w/aspect;y+=(r.height-h)/2;}
    return {left:x-outer.left,top:y-outer.top,width:w,height:h,clientLeft:x,clientTop:y};
  }
  function resizeMask() {
    if(!ui.input || !$('homeImage').naturalWidth)return;
    const canvas=$('maskCanvas'),r=imageDisplayRect(),ratio=Math.min(2,window.devicePixelRatio || 1);
    if(r.width<1 || r.height<1)return;
    canvas.style.left=r.left+'px';canvas.style.top=r.top+'px';canvas.style.width=r.width+'px';canvas.style.height=r.height+'px';
    const w=Math.round(r.width*ratio),h=Math.round(r.height*ratio);
    if(canvas.width!==w || canvas.height!==h){canvas.width=w;canvas.height=h;}
    drawMask();
  }
  function paintStrokes(ctx,w,h,mask=false) {
    for(const stroke of ui.strokes){
      const points=stroke.points;if(!points.length)continue;
      ctx.strokeStyle=mask?'#fff':'rgba(255,107,138,.62)';ctx.fillStyle=ctx.strokeStyle;
      ctx.lineWidth=Math.max(mask?8:1,stroke.width*Math.min(w,h));ctx.lineCap='round';ctx.lineJoin='round';
      if(points.length===1){ctx.beginPath();ctx.arc(points[0].x*w,points[0].y*h,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();continue;}
      ctx.beginPath();ctx.moveTo(points[0].x*w,points[0].y*h);
      for(const p of points.slice(1))ctx.lineTo(p.x*w,p.y*h);
      ctx.stroke();
    }
  }
  function drawMask() {const canvas=$('maskCanvas'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);paintStrokes(ctx,canvas.width,canvas.height);}
  function brushPoint(event) {
    const rect=$('maskCanvas').getBoundingClientRect();
    return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};
  }
  async function makeMask() {
    const canvas=document.createElement('canvas');canvas.width=ui.input.width;canvas.height=ui.input.height;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);paintStrokes(ctx,canvas.width,canvas.height,true);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('无法生成消除蒙版');
    return new File([blob],'mask.png',{type:'image/png'});
  }
  async function processPhoto() {
    if(!ui.input || photoBusy())return;
    if(ui.photoUploadFile){await chooseHomeImage(ui.photoUploadFile);return;}
    if(ui.feature==='remove' && ui.result){ui.result=null;ui.photoJobId=null;ui.strokes=[];ui.showOriginal=false;ui.photoError='';renderPhoto();return;}
    ui.photoError='';ui.photoSubmitting=true;renderPhoto();show('photoError',false);
    try {
      const body={feature:ui.feature,assetId:ui.input.id,model:ui.model};
      if(ui.feature==='remove'){
        if(!ui.strokes.length)throw new Error('请先涂抹需要消除的区域');
        const [mask]=await upload([await makeMask()],'mask');body.maskAssetId=mask.id;
      }
      const data=await api('/api/photo/jobs','POST',body);
      ui.photoJobId=data.jobId;ui.result=null;ui.showOriginal=false;renderPhoto();
    }catch(e){ui.photoError=e.message;setText('photoError',e.message);show('photoError');}
    finally {ui.photoSubmitting=false;renderPhoto();}
  }
  async function cancelPhoto() {
    if(!ui.photoJobId)return;
    try{await api('/api/photo/jobs/'+encodeURIComponent(ui.photoJobId)+'/cancel','POST',{});}
    catch(e){ui.photoError='停止尚未确认：'+e.message;setText('photoError',ui.photoError);show('photoError');}
  }
  function historyHTML(item) {
    const a=item.asset,selected=ui.selection.has(item.id);
    if(!a)return '';
    const model=item.modelName || (item.feature==='remove'?'AI 消除':item.feature==='colorize'?'老照片上色':'增强图片');
    const created=new Date(item.createdAt),date=Number.isNaN(created.getTime())?'':new Intl.DateTimeFormat(undefined,{dateStyle:'long'}).format(created);
    return '<button type="button" class="history-item'+(selected?' is-selected':'')+'" data-history-id="'+esc(item.id)+'" aria-label="'+esc((ui.selecting?(selected?'取消选择 ':'选择 '):'预览 ')+(item.filename || a.filename || '图片'))+'" aria-pressed="'+String(selected)+'"><div class="history-thumb"><img src="'+esc('/api/assets/'+encodeURIComponent(a.id)+'/thumbnail')+'" alt="'+esc(item.filename || a.filename || '图片')+'" loading="lazy" decoding="async"><span class="selection-indicator">'+(selected?icon('checkmark'):'')+'</span></div><div class="history-info"><div class="history-name">'+esc(item.filename || a.filename || '图片')+'</div><div class="history-meta">'+esc(model+' · '+(item.imageWidth || a.width || '')+'×'+(item.imageHeight || a.height || ''))+'</div><div class="history-date">'+esc(date)+'</div></div></button>';
  }
  function renderHistory() {
    if(!state)return;
    const all=[...state.history].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),valid=new Set(all.map(h=>h.id));
    ui.selection=new Set([...ui.selection].filter(id=>valid.has(id)));
    const items=$('historyItems');items.dataset.mode=state.settings.historyViewMode==='grid'?'grid':'list';
    items.classList.toggle('is-selecting',ui.selecting);const html=all.map(historyHTML).join('');if(items._historyHTML!==html){items._historyHTML=html;items.innerHTML=html;}
    show('historyEmpty',!all.length);show('historySelectionBar',ui.selecting);show('historyCloseSelectionButton',ui.selecting);
    show('historyMenuButton',!ui.selecting);setText('historyTitle',ui.selecting?'已选择 '+ui.selection.size+' 项':'历史记录');
    $('historyShareButton').disabled=!ui.selection.size;$('historyDeleteButton').disabled=!ui.selection.size;
    $('historySelectButton').disabled=!all.length;
    $('historyGridButton').classList.toggle('is-selected',items.dataset.mode==='grid');$('historyListButton').classList.toggle('is-selected',items.dataset.mode==='list');
    $('historyGridButton').setAttribute('aria-checked',String(items.dataset.mode==='grid'));$('historyListButton').setAttribute('aria-checked',String(items.dataset.mode==='list'));
  }
  async function setHistoryMode(mode) {await api('/api/settings','PATCH',{historyViewMode:mode});show('historyMenu',false);}
  async function deleteHistory() {
    if(!ui.selection.size)return;
    if(!await confirmAction('删除所选图片？','将从历史记录中删除 '+ui.selection.size+' 张图片。','删除'))return;
    try {await api('/api/history/delete','POST',{ids:[...ui.selection]});ui.selection.clear();renderHistory();toast('已删除');}
    catch(e){toast(e.message);}
  }
  function native(action,extra={}) {
    if(window.ShiYanPlatform)return window.ShiYanPlatform.postNative(action,extra);
    const bridge=window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;
    if(!bridge)return false;bridge.postMessage(Object.assign({action},extra));return true;
  }
  function exportFilename(a) {
    const filename=a.filename || '拾燕作品';
    const anime=(state?.history || []).some(h=>h.assetId===a.id && h.modelName==='动漫增强') ||
      (state?.photoJobs || []).some(j=>j.feature==='enhance' && j.model==='anime' &&
        (j.outputAssetId===a.id || (j.outputAssets || []).some(output=>output.id===a.id)));
    if(!anime)return filename;
    const dot=filename.lastIndexOf('.'),stem=dot>0?filename.slice(0,dot):filename,suffix=dot>0?filename.slice(dot):'';
    return /_anime(?:_4x)?$/i.test(stem)?filename:stem+'_anime'+suffix;
  }
  async function saveAsset(a) {
    if(!a)return;
    const filename=exportFilename(a);
    if(native('save',{url:new URL(assetUrl(a,true),location.href).href,filename}))return;
    const anchor=document.createElement('a');anchor.href=assetUrl(a,true);anchor.download=filename;document.body.appendChild(anchor);anchor.click();anchor.remove();
  }
  async function shareAssets(items) {
    if(!items.length)return;
    if(native('share',{assets:items.map(a=>({url:new URL(assetUrl(a,true),location.href).href,filename:exportFilename(a)}))}))return;
    if(items.length===1){await saveAsset(items[0]);return;}
    try {
      const ids=state.history.filter(h=>items.some(a=>h.asset && h.asset.id===a.id)).map(h=>h.id);
      const data=await api('/api/history/export','POST',{ids});remember(data.asset);await saveAsset(data.asset);
    }catch(e){toast(e.message);}
  }
  async function openGeneratedDocument(a) {
    if(window.workbench?.openAsset)return window.workbench.openAsset(a);
    toast('文件工具正在加载，请稍后重试');
  }
  function generatedLinkAsset(link) {
    const raw=link.dataset.generatedFile||link.getAttribute('href')||'';
    const id=raw.match(/\/(?:api\/assets|v1\/artifacts)\/([\w-]+)/)?.[1];
    const message=visibleMessage(link.closest('[data-message-id]')?.dataset.messageId);
    const candidates=message?.assets||[];
    if(id){const matches=candidates.filter(a=>a.id===id||a.remoteId===id);return matches.length===1?matches[0]:null;}
    let filename;
    try {filename=decodeURIComponent(raw.replace(/^sandbox:/,'').split(/[?#]/)[0]).replace(/:\d+(?::\d+)?$/,'').split('/').pop();}catch{return null;}
    const matches=candidates.filter(a=>a.filename===filename);
    return matches.length===1?matches[0]:null;
  }
  async function openPreview(a) {
    if(!a)return;ui.preview=a;ui.zoom=1;ui.panX=ui.panY=0;ui.previewPointer=null;
    const image=(a.mimeType || '').startsWith('image/');
    if(!image && native('preview',{url:new URL(assetUrl(a,true),location.href).href,filename:a.filename || '文件'}))return;
    show('imagePreview');show('previewImage',image);show('filePreview',!image);show('previewControls');setText('previewCaption',a.filename || '');
    if(image){$('previewImage').src=assetUrl(a);$('previewImage').alt=a.filename || '图片';}
    else{
      const iframe=$('filePreview');iframe.setAttribute('sandbox','');iframe.src=assetUrl(a);
    }
    updateZoom();$('closePreviewButton').focus();
  }
  function closePreview() {show('imagePreview',false);$('filePreview').src='about:blank';ui.preview=null;ui.zoom=1;ui.panX=ui.panY=0;}
  function previewGallery() {
    const image=a=>a&&(a.mimeType||'').startsWith('image/');
    const conversation=state?.conversations?.find(c=>(c.messages||[]).some(m=>(m.assets||[]).some(a=>a.id===ui.preview?.id)));
    const source=conversation?(conversation.messages||[]).flatMap(m=>m.assets||[]):(state?.history||[]).map(h=>h.asset);
    return [...new Map([...(source.filter(image)),ui.preview].filter(image).map(a=>[a.id,a])).values()];
  }
  function stepPreview(direction) {const gallery=previewGallery(),i=gallery.findIndex(a=>a.id===ui.preview?.id),next=gallery[i+direction];if(next)openPreview(next);}
  function previewFit() {const image=$('previewImage'),box=$('previewViewport').getBoundingClientRect();return image.naturalWidth?Math.min(1,(box.width-120)/image.naturalWidth,(box.height-12)/image.naturalHeight):1;}
  function updateZoom() {
    const image=$('previewImage');image.style.transform='translate('+ui.panX+'px,'+ui.panY+'px) scale('+ui.zoom+')';
    const fit=previewFit(),percent=Math.round(fit*ui.zoom*100),select=$('previewZoom');
    select.querySelector('[data-current-zoom]')?.remove();const option=new Option(percent+'%','current');option.dataset.currentZoom='1';select.add(option,0);select.value='current';
    const gallery=previewGallery(),index=gallery.findIndex(a=>a.id===ui.preview?.id);show('previousPreviewButton',gallery.length>1);show('nextPreviewButton',gallery.length>1);$('previousPreviewButton').disabled=index<=0;$('nextPreviewButton').disabled=index>=gallery.length-1;
    show('previewZoom',(ui.preview?.mimeType||'').startsWith('image/'));
  }

  function openDialog(id) {const el=$(id);show(id);if(typeof el.showModal==='function' && !el.open)el.showModal();}
  function closeDialog(id) {const el=$(id);if(typeof el.close==='function' && el.open)el.close();show(id,false);}
  function confirmAction(title,message,accept='确认') {
    return new Promise(resolve=>{
      setText('confirmTitle',title);setText('confirmMessage',message);setText('confirmAcceptButton',accept);$('confirmAcceptButton').classList.toggle('danger-action',accept==='删除');openDialog('confirmDialog');
      const finish=value=>{closeDialog('confirmDialog');resolve(value);};
      $('confirmCancelButton').onclick=()=>finish(false);$('confirmAcceptButton').onclick=()=>finish(true);
      $('confirmDialog').oncancel=e=>{e.preventDefault();finish(false);};
    });
  }
  function positionMenu(menu,x,y,within=null) {
    menu.hidden=false;menu.style.position='fixed';menu.style.left='0px';menu.style.top='0px';
    const rect=menu.getBoundingClientRect(),bounds=within || {left:8,top:8,right:innerWidth-8,bottom:innerHeight-8};
    menu.style.left=Math.max(bounds.left+8,Math.min(x,bounds.right-rect.width-8))+'px';
    menu.style.top=Math.max(bounds.top+8,Math.min(y,bounds.bottom-rect.height-8))+'px';
  }
  function showSessionMenu(id,event) {
    if(!ui.drawer)setDrawer(true);closePopovers();ui.sessionMenuId=id;
    const c=state.conversations.find(c=>c.id===id);if(!c)return;
    const menu=$('sessionMenu');
    menu.innerHTML='<button type="button" data-session-action="rename" role="menuitem">'+sessionMenuIcon('rename')+'<span>重命名</span></button>'+
      '<button type="button" data-session-action="pin" role="menuitem">'+sessionMenuIcon(c.isPinned?'unpin':'pin')+'<span>'+(c.isPinned?'取消置顶':'置顶')+'</span></button>'+
      '<button type="button" data-session-action="project" role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="sessionProjectMenu">'+sessionMenuIcon('project')+'<span>项目</span>'+sessionMenuIcon('chevron')+'</button>'+
      '<div class="menu-separator"></div><button class="danger" type="button" data-session-action="delete" role="menuitem">'+icon('trash')+'<span>删除</span></button>';
    const projectButton=menu.querySelector('[data-session-action="project"]');
    projectButton.onpointerenter=()=>showSessionProjectMenu();
    projectButton.onpointerleave=scheduleSessionProjectClose;
    projectButton.onkeydown=e=>{if(e.key==='ArrowRight'){e.preventDefault();showSessionProjectMenu(true);}};
    menu.onpointerover=e=>{const button=e.target.closest('[data-session-action]');if(button&&button!==projectButton)closeSessionProjectMenu();};
    const row=$$('.session-row').find(el=>el.dataset.sessionId===id),r=row?row.getBoundingClientRect():{left:20,bottom:120};
    positionMenu(menu,event && event.clientX || r.left+12,event && event.clientY || r.bottom+5,$('agentSidebar').getBoundingClientRect());
    window.workbench?.refreshOverlays?.();
  }
  function closeSessionProjectMenu(){
    clearTimeout(sessionProjectCloseTimer);show('sessionProjectMenu',false);
    $('sessionMenu')?.querySelector('[data-session-action="project"]')?.setAttribute('aria-expanded','false');
  }
  function scheduleSessionProjectClose(){clearTimeout(sessionProjectCloseTimer);sessionProjectCloseTimer=setTimeout(closeSessionProjectMenu,180);}
  function showSessionProjectMenu(focus=false){
    clearTimeout(sessionProjectCloseTimer);
    const c=state?.conversations.find(c=>c.id===ui.sessionMenuId),anchor=$('sessionMenu')?.querySelector('[data-session-action="project"]');
    if(!c||!anchor||$('sessionMenu').hidden)return;
    const menu=ensureMenu('sessionProjectMenu'),projects=window.workbench?.getLayout?.().projects||state?.projects||[];
    const rows=projects.filter(p=>p.id!==c.projectId),currentProject=projects.find(p=>p.id===c.projectId);
    menu.setAttribute('role','menu');menu.setAttribute('tabindex','-1');menu.setAttribute('aria-label','移动会话到项目');
    menu.innerHTML=rows.map(p=>'<button type="button" data-session-project="'+esc(p.id)+'" role="menuitem" title="'+esc(p.name)+'">'+
      sessionMenuIcon('folder')+'<span class="session-project-name">'+esc(p.name)+'</span></button>').join('');
    if(c.projectId){
      const label=currentProject?'从“'+currentProject.name+'”中移除':'从原项目中移除';
      menu.innerHTML+='<button type="button" data-session-project="" class="session-project-remove" role="menuitem" title="'+esc(label)+'">'+sessionMenuIcon('folderRemove')+'<span class="session-project-name">'+esc(label)+'</span></button>';
    }else if(!rows.length)menu.innerHTML='<p class="session-project-empty" role="status">暂无可选项目</p>';
    menu.onpointerenter=()=>clearTimeout(sessionProjectCloseTimer);menu.onpointerleave=scheduleSessionProjectClose;
    menu.onkeydown=e=>{
      const buttons=[...menu.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);
      if(e.key==='ArrowLeft'){e.preventDefault();e.stopPropagation();closeSessionProjectMenu();anchor.focus({preventScroll:true});}
      else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!buttons.length)return;buttons[(index+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus({preventScroll:true});}
    };
    menu.hidden=false;const r=anchor.getBoundingClientRect(),parent=$('sessionMenu').getBoundingClientRect(),size=menu.getBoundingClientRect();
    const x=parent.right+size.width<=innerWidth-8?parent.right-2:parent.left-size.width+2;
    menu.style.left=Math.max(8,Math.min(x,innerWidth-size.width-8))+'px';
    menu.style.top=Math.max(8,Math.min(r.top-6,innerHeight-size.height-8))+'px';
    anchor.setAttribute('aria-expanded','true');if(focus)(menu.querySelector('button:not(:disabled)')||menu).focus({preventScroll:true});
    window.workbench?.refreshOverlays?.();
  }
  async function moveSessionProject(projectId){
    const id=ui.sessionMenuId,c=state?.conversations.find(c=>c.id===id);if(!c)return;
    closePopovers();if((c.projectId||null)===projectId)return;
    try{await api('/api/conversations/'+encodeURIComponent(id),'PATCH',{projectId});window.workbench?.revealConversationProject?.(id,projectId);}
    catch(e){toast(e.message);}
  }
  async function handleSessionAction(action) {
    const id=ui.sessionMenuId,c=state.conversations.find(c=>c.id===id);if(!c)return;
    if(action==='project'){showSessionProjectMenu();return;}
    const menuRect=$('sessionMenu').getBoundingClientRect();closePopovers();
    if(action==='pin'){try{await api('/api/conversations/'+encodeURIComponent(id),'PATCH',{isPinned:!c.isPinned});}catch(e){toast(e.message);}}
    if(action==='rename'){ui.renamingSessionId=id;$('renameInput').value=c.title || '';openDialog('renameDialog');setTimeout(()=>{$('renameInput').focus();$('renameInput').select();},30);}
    if(action==='delete'){ui.deletingSessionId=id;positionMenu($('sessionDeletePopover'),menuRect.left,menuRect.top,$('agentSidebar').getBoundingClientRect());}
  }
  async function deleteConversation() {
    const id=ui.deletingSessionId;if(!id)return;
    $('confirmSessionDeleteButton').disabled=true;
    try {await api('/api/conversations/'+encodeURIComponent(id),'DELETE');drafts.delete(id);show('sessionDeletePopover',false);if(!state.conversations.length)await newConversation();}
    catch(e){toast(e.message);}
    finally {$('confirmSessionDeleteButton').disabled=false;ui.deletingSessionId=null;}
  }
  async function renameConversation(event) {
    event.preventDefault();const title=$('renameInput').value.trim();if(!title || !ui.renamingSessionId)return;
    $('saveRenameButton').disabled=true;
    try {await api('/api/conversations/'+encodeURIComponent(ui.renamingSessionId),'PATCH',{title});closeDialog('renameDialog');}
    catch(e){toast(e.message);}
    finally {$('saveRenameButton').disabled=false;}
  }
  async function copyText(text) {
    try {await navigator.clipboard.writeText(text);toast('已复制');}
    catch (_) {const el=document.createElement('textarea');el.value=text;el.style.cssText='position:fixed;left:-10000px';document.body.appendChild(el);el.select();const ok=document.execCommand('copy');el.remove();toast(ok?'已复制':'无法访问剪贴板');}
  }
  function ensureMenu(id) {let el=$(id);if(!el){el=document.createElement('div');el.id=id;el.className='context-menu glass-popover';el.hidden=true;document.body.appendChild(el);}return el;}
  function showMessageMenu(id,event) {
    closePopovers();const c=visibleConversation(),m=visibleMessage(id);if(!m)return;
    const menu=ensureMenu('messageMenu');
    menu.innerHTML='<div class="menu-caption">'+esc(dateText(m.createdAt,true))+'</div><button type="button" data-copy-message="'+esc(id)+'">'+icon('reply-copy')+'<span>复制</span></button>'+
      (m.role==='user'&&ui.view!=='schedules'?'<button type="button" data-edit-message="'+esc(id)+'" '+(isBusy(c)?'disabled':'')+'>'+sessionMenuIcon('rename')+'<span>编辑</span></button>':'');
    const target=$$('[data-message-id]').find(el=>el.dataset.messageId===id),r=target?target.getBoundingClientRect():{left:innerWidth/2,bottom:100};
    positionMenu(menu,event && event.clientX || r.left,event && event.clientY || r.bottom);
  }
  function showAssetMenu(id,event) {
    closePopovers();const a=assets.get(id);if(!a)return;
    const menu=ensureMenu('assetMenu'),image=(a.mimeType || '').startsWith('image/');
    menu.innerHTML=(image?'<button type="button" data-use-asset="'+esc(id)+'">'+icon('photo')+'<span>使用这张图片</span></button>':'')+
      '<button type="button" data-save-asset="'+esc(id)+'">'+icon('square.and.arrow.down')+'<span>'+(image?'保存图片':'保存文件')+'</span></button>'+
      '<button type="button" data-share-asset="'+esc(id)+'">'+icon('square.and.arrow.up')+'<span>分享</span></button>';
    positionMenu(menu,event.clientX,event.clientY);
  }
  async function useAsset(id) {
    const a=assets.get(id);if(!a)return;
    if(ui.view!=='agent')setView('agent');if(!current())await newConversation();
    if(isBusy(current())){toast('请等待当前回复完成');return;}
    const d=draftFor();if(d.assets.some(item=>item.id===id)){toast('图片已在输入栏中');return;}
    if(d.assets.length>=maxImages()){toast('每次最多添加 '+maxImages()+' 个附件');return;}
    changeDraft(d=>d.assets.push(a));closePopovers();closePreview();$('messageInput').focus();
  }
  let webSpeech=null, speechStopPromise=null, speechStopResolve=null, speechStopTimer=0, webSpeechToken=0;
  function finishSpeech() {
    ui.speech=false;ui.speechFinishing=false;ui.recordingConversation=null;ui.speechSessionId=null;
    clearTimeout(speechStopTimer);speechStopTimer=0;
    const resolve=speechStopResolve;speechStopResolve=null;speechStopPromise=null;
    $('composerForm').classList.remove('is-recording');if(state)renderComposer();
    if(resolve)resolve();
  }
  function startSpeech() {
    if(ui.speechFinishing)return;
    if(ui.speech){stopSpeech();return;}
    const c=current();if(!c || isBusy(c))return;
    ui.recordingConversation=c.id;ui.speechSessionId=crypto.randomUUID();ui.speechPrefix=draftFor(c).text;ui.speech=true;
    $('composerForm').classList.add('is-recording');renderComposer();
    if(native('startSpeech',{sessionId:ui.speechSessionId}))return;
    const Recognition=window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!Recognition){finishSpeech();notice('此浏览器不支持语音输入，请在拾燕桌面应用中使用');return;}
    const token=++webSpeechToken;
    webSpeech=new Recognition();webSpeech.lang='zh-CN';webSpeech.continuous=true;webSpeech.interimResults=true;
    webSpeech.onresult=event=>{
      if(token!==webSpeechToken)return;
      const text=Array.from(event.results).map(r=>r[0].transcript).join('');
      receiveSpeech(text,false);
    };
    webSpeech.onerror=event=>{if(token!==webSpeechToken)return;notice(event.error==='not-allowed'?'请允许麦克风和语音识别权限':'语音输入失败：'+event.error);cancelSpeech();};
    webSpeech.onend=()=>{if(token===webSpeechToken){webSpeech=null;finishSpeech();}};
    try{webSpeech.start();}catch(e){notice(e.message);cancelSpeech();}
  }
  function receiveSpeech(text,isFinal) {
    if(!ui.speech || !current() || ui.recordingConversation!==current().id)return;
    changeDraft(d=>{d.text=ui.speechPrefix+(ui.speechPrefix && text?'\n':'')+text;});$('messageInput').value=draftFor().text;
    if(isFinal)finishSpeech();
  }
  function stopSpeech() {
    if(speechStopPromise)return speechStopPromise;
    if(!ui.speech)return Promise.resolve();
    ui.speechFinishing=true;renderComposer();
    speechStopPromise=new Promise(resolve=>{speechStopResolve=resolve;});
    const pending=speechStopPromise;
    speechStopTimer=setTimeout(()=>cancelSpeech(),2000);
    if(native('stopSpeech',{sessionId:ui.speechSessionId}))return pending;
    if(webSpeech){try{webSpeech.stop();}catch(_){finishSpeech();}}
    else finishSpeech();
    return pending;
  }
  function cancelSpeech() {
    const was=ui.speech || ui.speechFinishing;
    ++webSpeechToken;
    if(was)native('cancelSpeech',{sessionId:ui.speechSessionId});
    if(webSpeech){try{webSpeech.abort();}catch(_){}webSpeech=null;}
    finishSpeech();
  }
  window.addEventListener('shiyan-native',event=>{
    const d=event.detail || {};
    if(['speech','speechState','speechError'].includes(d.type) && d.sessionId && d.sessionId!==ui.speechSessionId)return;
    if(d.type==='speech')receiveSpeech(d.text || '',!!d.isFinal);
    else if(d.type==='speechError'){notice(d.message || '语音识别不可用');cancelSpeech();}
    else if(d.type==='speechState' && !d.active)finishSpeech();
    else if(d.type==='error')toast(d.message || '操作失败');
    else if(d.type==='saved')toast('已保存');
    else if(d.type==='openFiles' && Array.isArray(d.files))toast('请通过选择图片导入文件');
  });
  function bindClick(id,fn) {const el=$(id);if(el)el.addEventListener('click',event=>{const result=fn(event);if(result && result.catch)result.catch(e=>toast(e.message));});}
  function initEvents() {
    $('reasoningDots').setAttribute('aria-hidden','true');
    if(window.ResizeObserver)new ResizeObserver(()=>{$('chatPanel').style.setProperty('--composer-height',Math.ceil($('composerForm').getBoundingClientRect().height+24)+'px');}).observe($('composerForm'));
    bindClick('historyButton',openHistory);
    bindClick('openHistoryToolButton',openHistory);
    bindClick('agentNavButton',()=>{setDrawer(false);setView('agent');});
    bindClick('openEnhancerButton',()=>{setDrawer(false);setView('home');});
    bindClick('backToAgentButton',()=>{setDrawer(false);setView('agent');});
    bindClick('historyBackButton',()=>{ui.selecting=false;ui.selection.clear();setView(ui.historyReturnView || 'agent');});
    bindClick('openSidebarButton',()=>setDrawer(!ui.drawer));
    bindClick('closeSidebarButton',()=>setDrawer(false));
    bindClick('newConversationButton',newConversation);
    bindClick('closeAgentButton',()=>{setDrawer(false);setView('home');});
    bindClick('openSearchButton',()=>setView('search'));
    bindClick('closeSearchButton',()=>{setView('agent');setDrawer(window.innerWidth<760);});
    bindClick('clearSearchButton',()=>{ui.searchTerm='';$('searchInput').value='';renderSearch();$('searchInput').focus();});
    $('searchInput').addEventListener('input',event=>{ui.searchTerm=event.target.value;renderSearch();});
    $('messageQueue').addEventListener('click',async event=>{
      const remove=event.target.closest('[data-remove-queued]'),priority=event.target.closest('[data-priority-queued]'),c=current();
      if(!c)return;
      try{
        if(remove){await api('/api/conversations/'+encodeURIComponent(c.id)+'/queue/'+encodeURIComponent(remove.dataset.removeQueued),'DELETE');return;}
        if(!priority || priority.disabled)return;
        const id=priority.dataset.priorityQueued;
        await api('/api/conversations/'+encodeURIComponent(c.id)+'/queue/'+encodeURIComponent(id)+'/priority','POST',{confirmed:true});
      }catch(error){notice(error.message);}
    });
    $('composerForm').addEventListener('submit',event=>submitMessage(event).catch(e=>notice(e.message)));
    $('sendButton').addEventListener('click',event=>{
      if($('sendButton').dataset.action!=='stop')return;
      event.preventDefault();stopGeneration().catch(e=>notice(e.message));
    });
    $('messageInput').addEventListener('input',event=>changeDraft(d=>{d.text=event.target.value;},true));
    bindComposerComposition($('messageInput'));
    $('messageInput').addEventListener('focus',()=>renderComposer());
    $('messageInput').addEventListener('blur',()=>setTimeout(()=>renderComposer(),100));
    $('messageInput').addEventListener('keydown',event=>{if(!event.isComposing && event.keyCode!==229 && !composerComposing && !composerCompositionEnding)window.ShiYanComposerKeys.handleEnter(event,()=>submitMessage().catch(e=>notice(e.message)));});
    bindClick('cancelEditButton',cancelEdit);
    bindClick('addImageButton',()=>$('attachmentInput').click());
    $('attachmentInput').addEventListener('change',event=>addAttachments([...event.target.files]));
    bindClick('reasoningButton',()=>{ui.reasoning=!ui.reasoning;renderComposer();});
    bindClick('reasoningBackdrop',()=>{ui.reasoning=false;renderComposer();});
    const reasoningRange=$('reasoningRange');
    reasoningRange.addEventListener('pointerdown',()=>{ui.reasoningDragging=true;ui.reasoningPosition=Number(reasoningRange.value);});
    reasoningRange.addEventListener('input',event=>{ui.reasoningPosition=Number(event.target.value);const value=efforts()[Math.round(ui.reasoningPosition)];if(value)changeDraft(d=>{d.reasoning=value;});});
    const finishReasoning=()=>{if(!ui.reasoningDragging)return;ui.reasoningDragging=false;renderReasoning();if(current())flushDraft(current().id).catch(e=>notice(e.message));};
    window.addEventListener('pointerup',finishReasoning);window.addEventListener('pointercancel',finishReasoning);window.addEventListener('blur',finishReasoning);
    reasoningRange.addEventListener('keydown',event=>{const keys=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];if(!keys.includes(event.key))return;event.preventDefault();const values=efforts(),index=Math.max(0,values.indexOf(draftFor().reasoning));const target=event.key==='Home'?0:event.key==='End'?values.length-1:Math.max(0,Math.min(values.length-1,index+(['ArrowLeft','ArrowDown'].includes(event.key)?-1:1)));if(values[target])changeDraft(d=>{d.reasoning=values[target];});});
    $('reasoningModel')?.addEventListener('change',event=>{const model=modelChoices().find(m=>m.id===event.target.value);if(model)changeDraft(d=>{d.model=model.id;if(!model.reasoningEfforts.includes(d.reasoning))d.reasoning=model.defaultReasoning;});});
    bindClick('reasoningReset',()=>{const model=modelCapability();if(model)changeDraft(d=>{d.reasoning=model.defaultReasoning;});});
    bindClick('speechButton',startSpeech);
    bindClick('latestButton',scrollToLatest);
    const messagesScroller=$('messagesScroller');
     
     
    $('messages').addEventListener('load',event=>{if(event.target.tagName==='IMG' && messageAutoFollow && ui.view==='agent')scrollToLatest();},true);
    const noteUserScroll=()=>{messageUserScrollUntil=performance.now()+1000;};
    messagesScroller.addEventListener('wheel',event=>{noteUserScroll();if(event.deltaY<0)pauseMessageFollow();},{passive:true});
    messagesScroller.addEventListener('pointerdown',noteUserScroll,{passive:true});
    messagesScroller.addEventListener('pointermove',event=>{if(event.buttons)noteUserScroll();},{passive:true});
    messagesScroller.addEventListener('keydown',event=>{if(['ArrowUp','PageUp','Home','ArrowDown','PageDown','End'].includes(event.key))noteUserScroll();if(['ArrowUp','PageUp','Home'].includes(event.key))pauseMessageFollow();});
    messagesScroller.addEventListener('scroll',()=>{
      const top=messagesScroller.scrollTop,gap=messagesScroller.scrollHeight-top-messagesScroller.clientHeight;
      if(restoringReadingPosition){messageLastScrollTop=top;return;}
      if(gap<4)messageAutoFollow=true;
      else if(performance.now()<messageUserScrollUntil && top<messageLastScrollTop-1)pauseMessageFollow();
      messageLastScrollTop=top;
      show('latestButton',!messageAutoFollow && !!current()?.messages?.length);saveReadingPosition();
    },{passive:true});
    $('homeFileInput').addEventListener('change',event=>chooseHomeImage(event.target.files[0]));
    bindClick('imageEmptyState',()=>$('homeFileInput').click());
    bindClick('changeImageButton',()=>$('homeFileInput').click());
    bindClick('previewHomeButton',()=>openPreview(ui.showOriginal || !ui.result?ui.input:ui.result));
    bindClick('showOriginalButton',()=>{ui.showOriginal=true;renderPhoto();});
    bindClick('showResultButton',()=>{ui.showOriginal=false;renderPhoto();});
    $('homeImage').addEventListener('load',resizeMask);
    $('homeImage').addEventListener('click',()=>{if(ui.feature!=='remove' && !photoBusy())openPreview(ui.showOriginal || !ui.result?ui.input:ui.result);});
    $('brushWidth').addEventListener('input',event=>{ui.brush=Number(event.target.value);});
    bindClick('undoStrokeButton',()=>{ui.strokes.pop();renderPhoto();});
    bindClick('clearStrokesButton',()=>{ui.strokes=[];renderPhoto();});
    bindClick('processButton',processPhoto);
    bindClick('saveResultButton',()=>saveAsset(ui.result));
    bindClick('cancelProcessButton',cancelPhoto);
    const canvas=$('maskCanvas');
    canvas.addEventListener('pointerdown',event=>{
      if(photoBusy() || !ui.input || ui.feature!=='remove')return;
      event.preventDefault();event.stopPropagation();canvas.setPointerCapture(event.pointerId);
      ui.currentStroke={width:ui.brush,points:[brushPoint(event)]};ui.strokes.push(ui.currentStroke);drawMask();
    });
    canvas.addEventListener('pointermove',event=>{if(!ui.currentStroke)return;event.preventDefault();ui.currentStroke.points.push(brushPoint(event));drawMask();});
    const finishStroke=()=>{if(ui.currentStroke){ui.currentStroke=null;renderPhoto();}};
    canvas.addEventListener('pointerup',finishStroke);canvas.addEventListener('pointercancel',finishStroke);
    bindClick('historyMenuButton',event=>{event.stopPropagation();const menu=$('historyMenu'),open=menu.hidden;closePopovers();if(open){const r=event.currentTarget.getBoundingClientRect();positionMenu(menu,r.right-230,r.bottom+8);}});
    bindClick('historySelectButton',()=>{ui.selecting=true;ui.selection.clear();show('historyMenu',false);renderHistory();});
    bindClick('historyCloseSelectionButton',()=>{ui.selecting=false;ui.selection.clear();renderHistory();});
    bindClick('historyGridButton',()=>setHistoryMode('grid'));bindClick('historyListButton',()=>setHistoryMode('list'));
    bindClick('historyDeleteButton',deleteHistory);
    bindClick('historyShareButton',()=>shareAssets(state.history.filter(h=>ui.selection.has(h.id)).map(h=>h.asset)));
    bindClick('previousPreviewButton',()=>stepPreview(-1));bindClick('nextPreviewButton',()=>stepPreview(1));
    $('previewZoom').addEventListener('change',event=>{ui.zoom=event.target.value==='fit'?1:Number(event.target.value)/previewFit();ui.panX=ui.panY=0;updateZoom();});
    $('previewImage').addEventListener('load',updateZoom);window.addEventListener('resize',()=>{if(ui.preview)updateZoom();});
    bindClick('closePreviewButton',closePreview);bindClick('savePreviewButton',()=>saveAsset(ui.preview));
    bindClick('cancelSessionDeleteButton',()=>show('sessionDeletePopover',false));bindClick('confirmSessionDeleteButton',deleteConversation);
    $('renameForm').addEventListener('submit',renameConversation);bindClick('cancelRenameButton',()=>closeDialog('renameDialog'));
    $('renameInput').addEventListener('input',()=>$('saveRenameButton').disabled=!$('renameInput').value.trim());
    document.addEventListener('click',event=>{
      const target=event.target instanceof Element?event.target:null;if(!target)return;
      const outputSummary=target.closest('.output-details>summary');if(outputSummary)outputSummary.parentElement.dataset.userToggled='1';
      const feature=target.closest('[data-feature]');if(feature){setFeature(feature.dataset.feature);return;}
      const model=target.closest('[data-model]');if(model){ui.model=model.dataset.model==='x4anime'?'anime':'general';renderPhoto();saveWorkspace().catch(e=>toast(e.message));return;}
      const more=target.closest('[data-session-more]');if(more){event.stopPropagation();showSessionMenu(more.dataset.sessionMore,event);return;}
      const session=target.closest('[data-session-id]');if(session){selectConversation(session.dataset.sessionId).catch(e=>toast(e.message));return;}
      const search=target.closest('[data-search-session]');if(search){selectConversation(search.dataset.searchSession).catch(e=>toast(e.message));return;}
      const projectTarget=target.closest('[data-session-project]');if(projectTarget){moveSessionProject(projectTarget.dataset.sessionProject||null);return;}
      const sessionAction=target.closest('[data-session-action]');if(sessionAction){handleSessionAction(sessionAction.dataset.sessionAction);return;}
      const remove=target.closest('[data-remove-attachment]');if(remove){changeDraft(d=>d.assets=d.assets.filter(a=>a.id!==remove.dataset.removeAttachment));return;}
      const messageMenu=target.closest('[data-message-menu]');if(messageMenu){showMessageMenu(messageMenu.dataset.messageMenu,event);return;}
      const retry=target.closest('[data-retry-message]');if(retry){const m=current()?.messages?.find(m=>m.id===retry.dataset.retryMessage);if(m&&canRetryConnection(m)&&!retry.disabled){retry.disabled=true;retryReceive().finally(()=>{retry.disabled=false;});}return;}
      const copy=target.closest('[data-copy-message]');if(copy){const m=visibleMessage(copy.dataset.copyMessage);if(m)copyText(m.text || '');closePopovers();return;}
      const edit=target.closest('[data-edit-message]');if(edit){editMessage(edit.dataset.editMessage);return;}
      const copyCode=target.closest('[data-copy-code]');if(copyCode){copyText(copyCode.dataset.copyCode);return;}
      const use=target.closest('[data-use-asset]');if(use){useAsset(use.dataset.useAsset);return;}
      const save=target.closest('[data-save-asset]');if(save){saveAsset(assets.get(save.dataset.saveAsset));closePopovers();return;}
      const share=target.closest('[data-share-asset]');if(share){shareAssets([assets.get(share.dataset.shareAsset)]);closePopovers();return;}
      const history=target.closest('[data-history-id]');if(history){
        const id=history.dataset.historyId;if(ui.selecting){ui.selection.has(id)?ui.selection.delete(id):ui.selection.add(id);renderHistory();}
        else {const h=state.history.find(h=>h.id===id);if(h)openPreview(h.asset);}return;
      }
      const documentLink=target.closest('a[data-generated-file],a[href*="/api/assets/"],a[href*="/v1/artifacts/"]');
      if(documentLink&&documentLink.closest('[data-message-id]')){
        event.preventDefault();const file=generatedLinkAsset(documentLink);
        if(file){if((file.mimeType||'').startsWith('image/'))openPreview(file);else openGeneratedDocument(file).catch(error=>toast(error.message));}
        else toast('该文件尚未加入当前消息，请让助手重新提供文件附件');
        return;
      }
      const asset=target.closest('[data-asset-id]');if(asset){const file=assets.get(asset.dataset.assetId);if(file&&(file.mimeType||'').startsWith('image/'))openPreview(file);else if(file)openGeneratedDocument(file).catch(error=>toast(error.message));return;}
      const reasoning=target.closest('[data-reasoning]');if(reasoning){changeDraft(d=>d.reasoning=reasoning.dataset.reasoning);return;}
      if(target.closest('[data-action="retry-receive"]')){retryReceive();return;}
      if(!target.closest('.context-menu,.glass-popover,#sessionMenu,#sessionDeletePopover,#historyMenu'))closePopovers();
    });
    document.addEventListener('contextmenu',event=>{
      const target=event.target instanceof Element?event.target:null;if(!target)return;
      const session=target.closest('[data-session-id]'),asset=target.closest('[data-asset-id]'),message=target.closest('[data-message-id]');
      if(session){event.preventDefault();showSessionMenu(session.dataset.sessionId,event);}
      else if(asset){event.preventDefault();showAssetMenu(asset.dataset.assetId,event);}
      else if(message){event.preventDefault();showMessageMenu(message.dataset.messageId,event);}
      else if(target.closest('#previewImage') && ui.preview){event.preventDefault();showAssetMenu(ui.preview.id,event);}
    });
    let hold=null,holdOrigin=null;
    document.addEventListener('pointerdown',event=>{
      if(event.pointerType!=='touch')return;const el=event.target.closest('[data-session-id],[data-asset-id],[data-message-id]');if(!el)return;
      holdOrigin={x:event.clientX,y:event.clientY};hold=setTimeout(()=>{hold=null;if(el.dataset.sessionId)showSessionMenu(el.dataset.sessionId,event);else if(el.dataset.assetId)showAssetMenu(el.dataset.assetId,event);else showMessageMenu(el.dataset.messageId,event);},480);
    });
    document.addEventListener('pointerup',()=>{clearTimeout(hold);hold=null;});document.addEventListener('pointercancel',()=>{clearTimeout(hold);hold=null;});
    document.addEventListener('pointermove',event=>{if(hold && holdOrigin && Math.hypot(event.clientX-holdOrigin.x,event.clientY-holdOrigin.y)>8){clearTimeout(hold);hold=null;}},{passive:true});
    const viewport=$('previewViewport');
    viewport.addEventListener('wheel',event=>{if(!ui.preview || !(ui.preview.mimeType || '').startsWith('image/'))return;event.preventDefault();ui.zoom=Math.max(.1/previewFit(),Math.min(8/previewFit(),ui.zoom*Math.exp(-event.deltaY*.002)));if(ui.zoom===1)ui.panX=ui.panY=0;updateZoom();},{passive:false});
    viewport.addEventListener('dblclick',event=>{event.preventDefault();ui.zoom=ui.zoom===1?2.5:1;ui.panX=ui.panY=0;updateZoom();});
    viewport.addEventListener('pointerdown',event=>{if(event.target.closest('button') || ui.zoom===1)return;ui.previewPointer={x:event.clientX,y:event.clientY,panX:ui.panX,panY:ui.panY};viewport.setPointerCapture(event.pointerId);});
    viewport.addEventListener('pointermove',event=>{if(!ui.previewPointer)return;ui.panX=ui.previewPointer.panX+event.clientX-ui.previewPointer.x;ui.panY=ui.previewPointer.panY+event.clientY-ui.previewPointer.y;updateZoom();});
    viewport.addEventListener('pointerup',()=>ui.previewPointer=null);viewport.addEventListener('pointercancel',()=>ui.previewPointer=null);

    document.addEventListener('keydown',event=>{
      if(!$('imagePreview').hidden && ['ArrowLeft','ArrowRight'].includes(event.key) && event.target.tagName!=='SELECT'){event.preventDefault();stepPreview(event.key==='ArrowLeft'?-1:1);return;}
      if(event.key==='Escape'){
        if(!$('confirmDialog').hidden){event.preventDefault();$('confirmCancelButton').click();return;}
        if(!$('renameDialog').hidden){event.preventDefault();closeDialog('renameDialog');return;}
        closePopovers();
        if(!$('imagePreview').hidden)closePreview();else if(ui.editing)cancelEdit();else if(ui.reasoning){ui.reasoning=false;renderComposer();}else if(ui.drawer)setDrawer(false);else if(ui.view==='search')setView('agent');else if(ui.view==='history')setView(ui.historyReturnView || 'agent');else if(ui.view==='home')setView('agent');
      }
      if((event.metaKey || event.ctrlKey) && !event.altKey){
        if(event.key.toLowerCase()==='n'){event.preventDefault();newConversation().catch(e=>toast(e.message));}
        if(event.key.toLowerCase()==='o'){event.preventDefault();(ui.view==='agent'?$('attachmentInput'):$('homeFileInput')).click();}
      }
    });
    let drag=null;
    $('chatPanel').addEventListener('pointerdown',event=>{if(window.workbench)return;if(window.innerWidth>=760 || event.button!==0 || event.target.closest('button,input,textarea,a,canvas'))return;drag={x:event.clientX,y:event.clientY,start:performance.now(),progress:ui.drawer?1:0,moved:false};});
    window.addEventListener('pointermove',event=>{
      if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      if(!drag.moved && Math.abs(dy)>Math.abs(dx)+6){drag=null;return;}
      if(Math.abs(dx)<8 && !drag.moved)return;
      drag.moved=true;const width=$('agentSidebar').getBoundingClientRect().width;
      drag.current=Math.max(0,Math.min(1,drag.progress+dx/width));$('agentStage').classList.add('is-dragging');$('agentStage').style.setProperty('--drawer-progress',String(drag.current));
    },{passive:true});
    window.addEventListener('pointerup',event=>{if(!drag)return;const d=drag;drag=null;$('agentStage').classList.remove('is-dragging');if(d.moved){const velocity=(event.clientX-d.x)/Math.max(1,performance.now()-d.start)*1000;setDrawer(Math.abs(velocity)>350?velocity>0:d.current>.5);}});
    window.addEventListener('pointercancel',()=>{if(drag){drag=null;setDrawer(ui.drawer);}$('agentStage').classList.remove('is-dragging');});
    document.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();$(ui.view==='agent'?'composerForm':'imageDropZone').classList.add('is-drop-target');}});
    document.addEventListener('dragleave',event=>{if(!event.relatedTarget){$('composerForm').classList.remove('is-drop-target');$('imageDropZone').classList.remove('is-drop-target');}});
    document.addEventListener('drop',event=>{
      if(!event.dataTransfer.files.length)return;event.preventDefault();$('composerForm').classList.remove('is-drop-target');$('imageDropZone').classList.remove('is-drop-target');
      const files=Array.from(event.dataTransfer.files);if(ui.view==='agent')addAttachments(files);else {if(ui.view!=='home')setView('home');chooseHomeImage(files[0]);}
    });
    window.addEventListener('resize',resizeMask);
    window.addEventListener('online',()=>{if(state && state.connection.status!=='ready')connectAgent();});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelSpeech();});
    window.addEventListener('pagehide',()=>{saveReadingPosition();flushReadingPositions();cancelSpeech();if(eventSource)eventSource.close();});
  }
  function connectStateEvents() {
    if(window.ShiYanPlatform?.deferUntilLoaded?.(connectStateEvents))return;
    if(eventSource)eventSource.close();
    eventSource=new EventSource('/api/events');
    eventSource.addEventListener('state',event=>{try {applyState(JSON.parse(event.data));}catch(e){console.error('Invalid state event',e);}});
    eventSource.onopen=()=>{if(state)renderConnection();};
    eventSource.onerror=()=>{setText('connectionText','本地连接已断开，正在重新连接');show('connectionBanner');};
  }
  async function start() {
    if(new URLSearchParams(location.search).has('native') || (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native)){document.body.classList.add('is-native');document.documentElement.classList.add('is-native');}
    initEvents();
    try {
      const data=await api('/api/state');if(!state)applyState(data.state);
      connectStateEvents();
      setView('agent');
      if(state.connection && !['ready','connecting','unauthorized'].includes(state.connection.status))connectAgent();
    }catch(e){show('connectionBanner');setText('connectionText',e.message);toast(e.message);}
  }
  window.shiyan={
    newConversation,selectConversation,openImagePicker:()=>(ui.view==='agent'?$('attachmentInput'):$('homeFileInput')).click(),
    showHistory:openHistory,stopSpeech,
    getState:()=>state,editMessage,flushDraft,getDraft:()=>draftFor(),
    getView:()=>ui.view,renderMessage:messageHTML,renderAttachment:attachmentItemHTML,
    uploadAttachments:(files,existing=[])=>{validateAttachmentFiles(files,existing);return upload(files,'attachment');},
    navigate:setView,toast,copyText,confirmAction,api,sessionHTML,sessionMenuIcon,openPreview,openGeneratedDocument,saveAsset,shareAssets,
    getPhotoState:()=>({input:ui.input,result:ui.result,model:ui.model,busy:photoBusy(),uploading:ui.photoUploading,
      progress:photoJob()?.progress || 0,label:ui.photoUploading?'正在上传图片':photoJob()?.label || (ui.photoSubmitting?'正在准备':''),error:photoJob()?.error || ui.photoError}),
    addContext:async text=>{
      if(!current())await newConversation();
      setView('agent');
      changeDraft(d=>{d.text+=(d.text?'\n\n':'')+String(text);});
      renderComposer(true);$('messageInput').focus();
    }
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
