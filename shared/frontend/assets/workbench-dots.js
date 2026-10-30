 
(() => {
 'use strict';
 const dotsPersonalIcon="<svg class=\"wb-icon wb-dots-personal-icon\" aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13.6 4.1a8.5 8.5 0 1 0 5.4 6.1M13.1 9.8a2.6 2.6 0 1 1-5.2 0a2.6 2.6 0 1 1 5.2 0ZM5.3 19c.9-2.4 2.5-3.8 5.2-3.8s4.3 1.4 5.2 3.8M19 1.8l.85 2.35L22.2 5l-2.35.85L19 8.2l-.85-2.35L15.8 5l2.35-.85Z\"/></svg>";
 const identityIcon=()=>window.ShiYanDotsPanels?.avatar()||dotsPersonalIcon;
 const $=id=>document.getElementById(id);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const key=window.ShiYanAccount.storageKey('shiyan.dots.v1');let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}');}catch{}
 let C,view,active=false,monitorReady=false,hydration,saveChain=Promise.resolve(),refreshFlight=null,refreshQueuedForce=false,events=Promise.resolve();
 let persistedSnapshot=null,savingSnapshot=null,savingTask=null;
 let manager=saved.manager||null,messages=saved.messages||[],tasks=saved.tasks||[],goals=saved.goals||[],details=saved.details||{},drafts=saved.drafts||{},pending=saved.pending||{},cursor=Number(saved.cursor)||0;
  
 let readState=normalizeReadState(saved.readState,messages);
 const messageId=m=>Number.isSafeInteger(Number(m?.id))&&Number(m.id)>0?Number(m.id):0;
 function normalizeReadState(value,cached){
  const latest=Math.max(0,...cached.map(m=>Number(m.id)||0));
  if(!value?.initialized)return {initialized:cached.length>0,readThrough:latest,observedThrough:latest,unreadIds:[]};
  const readThrough=Math.max(0,Number(value.readThrough)||0);
  return {initialized:true,readThrough,observedThrough:Math.max(readThrough,Number(value.observedThrough)||0),unreadIds:[...new Set((Array.isArray(value.unreadIds)?value.unreadIds:[]).map(Number).filter(id=>Number.isSafeInteger(id)&&id>readThrough))]};
 }
 function observeReplies(incoming){
  const latest=Math.max(0,...incoming.map(messageId));
  if(!readState.initialized){readState={initialized:true,readThrough:latest,observedThrough:latest,unreadIds:[]};return;}
  const unread=new Set(readState.unreadIds);
  incoming.forEach(m=>{const id=messageId(m);if(m.role==='assistant'&&id>readState.readThrough)unread.add(id);});
  readState.unreadIds=[...unread].sort((a,b)=>a-b);renderUnread();
 }
 function renderUnread(){
  const button=$('openDotsButton');if(!button)return;
  const name=window.ShiYanDotsPanels?.name()||'Dots',count=readState.unreadIds.length,icon=identityIcon(),signature=JSON.stringify([name,count,icon]);
  if(button.dataset.replySignature!==signature){button.dataset.replySignature=signature;button.innerHTML=icon+'<span class="dots-navigation-name">'+esc(name)+'</span><span class="dots-unread-count"'+(count?'':' hidden')+' aria-hidden="true">'+count+'</span>';}
  button.title=name+' · 你的专属助手'+(count?' · '+count+' 条未读回复':'');button.setAttribute('aria-label',name+(count?'，'+count+' 条未读回复':' 个人助手'));
 }
 function markVisibleRepliesRead(){
  const records=$('dotsRecords');if(!active||document.hidden||!document.hasFocus()||historyLoading||!records||records.scrollHeight-records.scrollTop-records.clientHeight>=60)return;
  const latest=Math.max(0,...messages.map(messageId));if(latest<=readState.readThrough&&!readState.unreadIds.length)return;
  readState.readThrough=Math.max(readState.readThrough,latest);readState.unreadIds=readState.unreadIds.filter(id=>id>readState.readThrough);renderUnread();persist().catch(showError);
 }
 async function reconcileUnreadGap(data,observed){
  const incoming=data.messages||data.manager?.messages||[],ids=incoming.map(messageId).filter(Boolean);
  let before=ids.length?Math.min(...ids):0,more=!!(data.hasMoreMessages??data.manager?.hasMoreMessages);
   
   
  const floor=Math.max(observed,readState.readThrough);
  while(before>floor&&more){
   const batch=await api('/manager/messages?before='+before+'&limit=200'),rows=batch.messages||[];
   if(!rows.length)throw Error('Dots 消息分页为空，稍后重试');
   const next=Math.min(...rows.map(messageId).filter(Boolean));if(!next||next>=before)throw Error('Dots 消息分页顺序无效');
   observeReplies(rows.filter(m=>messageId(m)>floor));before=next;more=!!batch.hasMore;
  }
  readState.observedThrough=Math.max(readState.observedThrough,0,...ids);renderUnread();
 }
 const rawOutputs=new Map(),approvalVersions=new Map(),approvalErrors=new Map(),approvalBusy=new Set();let uploading=false;
 const attachments=()=>drafts.managerAttachments||[];
 const fileChip=(a,removable=false)=>'<span class="dots-file-chip"><span aria-hidden="true">'+C.icon('file')+'</span>'+(!removable?'<a download href="/api/dots/attachments/'+encodeURIComponent(a.id)+'">'+esc(a.filename)+'</a>':'<span>'+esc(a.filename)+'</span><button type="button" data-dots-remove-file="'+esc(a.id)+'" aria-label="移除 '+esc(a.filename)+'"'+(busy||pending.managerMessage?' disabled':'')+'>×</button>')+'</span>';
 async function uploadFiles(files){if(uploading||busy||pending.managerMessage)return;uploading=true;refreshContent();try{for(const file of files){if(attachments().length>=8)throw Error('最多添加 8 个文件');if(!file.size||file.size>20*1024*1024)throw Error('文件不能为空，单个文件不能超过 20 MB');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('无法读取文件'));reader.readAsDataURL(file);});const result=await api('/attachments','POST',{id:crypto.randomUUID(),filename:file.name,mimeType:file.type||'application/octet-stream',data});drafts.managerAttachments=[...attachments(),result.attachment];await persist();refreshContent();}}finally{uploading=false;refreshContent();}}
 let managerIME=null;
 let busy=false,historyLoading=false,historyChecked=false,hasMoreMessages=true,error='',drawerOpen=false,selected=null,source,reconnectTimer,recoveryTimer,reconnectAttempt=0,streamEpoch=0;
  
  
 let voiceCard=null,voiceOrb=null,voiceComposerDeferred=false;
 let voiceCardPosition=null,voiceCardDrag=null,voiceCardSuppressClickUntil=0,nativeVoiceCallSignature='';
 const voice={active:false,phase:'idle',recognitionId:null,playbackId:null,text:'',acceptedId:0,epoch:0,waitTimer:0,pollTimer:0,clockTimer:0,playbackTimer:0,callId:null,startedAt:0,muted:false,paused:false,previousFocus:null,level:0,levelAt:0,consumedRecognitionIds:new Set(),errors:new Map(),replyQueue:[],replySeen:new Set(),replyProgress:new Map(),replySuppressed:new Set(),replyFloor:0,playbackMessageId:0,lastSpeechEnergyAt:0};
 // A native voice call outlives window visibility. Hidden windows keep only
 // the call's data/audio path alive; rendering and read receipts stay visual.
 function monitorAllowed(){return monitorReady&&!window.ShiYanUploadPriority?.active&&(!document.hidden||voice.active);}
 const voiceGlyph='<svg class="dots-voice-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4"/></svg>';
 function voiceNative(action,detail={}){if(window.ShiYanPlatform?.mode==='web')return window.ShiYanPlatform.adapter('voice')?.post(action,detail)??false;const bridge=window.webkit?.messageHandlers?.native;if(!bridge)return false;bridge.postMessage({action,...detail});return true;}
 function syncNativeVoiceCall(force=false){
  if(!voice.active||!voice.callId)return;
  const identity=window.ShiYanDotsPanels?.voiceCallIdentity?.()||{name:window.ShiYanDotsPanels?.name()||'Dots',pet:null};
  const detail={callId:voice.callId,startedAt:voice.startedAt,muted:voice.muted,name:identity.name,phase:voice.phase,pet:identity.pet};
  const signature=JSON.stringify(detail);if(!force&&signature===nativeVoiceCallSignature)return;
  if(voiceNative('updateDotsVoiceCall',detail))nativeVoiceCallSignature=signature;
 }
 function traceVoice(stage,extra={}){
  voiceNative('dotsVoiceTrace',{stage,callId:voice.callId,phase:voice.phase,recognitionId:voice.recognitionId,playbackId:voice.playbackId,messageId:voice.acceptedId,...extra});
 }
 function callGlyph(kind){
  const paths={mic:'M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V4ZM5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8',muted:'M4 3l16 18M9 8v3a3 3 0 0 0 4.5 2.6M15 8V4a3 3 0 0 0-5.4-1.8M5 10v1a7 7 0 0 0 12.1 4.8M19 10v1a7 7 0 0 1-.4 2.2M12 18v4M8 22h8',end:'M4 15l2.6 2.5 3.1-2v-3a18 18 0 0 1 4.6 0v3l3.1 2L20 15c-4.4-4.7-11.6-4.7-16 0Z',pause:'M9 5v14M15 5v14',play:'M8 5l11 7-11 7V5Z',interrupt:'M5 12h14M12 5v14'};
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[kind]+'"/></svg>';
 }
 function ensureVoiceCard(){
  if(!view)return null;
  if(!voiceOrb&&window.ShiYanDotsVoiceOrb)voiceOrb=new window.ShiYanDotsVoiceOrb({onFormChange:()=>{
   if(voiceComposerDeferred&&!voiceOrb?.drag)queueMicrotask(()=>{if(voiceComposerDeferred&&!voiceOrb?.drag)refreshContent();});
  }});
  voiceOrb?.attach(view,$('dotsManagerForm')?.querySelector('.dots-composer-surface'));
  if(voiceCard)return voiceCard;
  const card=document.createElement('section');card.id='dotsVoiceCard';card.className='dots-voice-card';card.hidden=true;card.tabIndex=0;
  card.setAttribute('role','group');card.setAttribute('aria-keyshortcuts','Space');card.setAttribute('aria-describedby','dotsVoiceStatus dotsVoiceHelp');
  card.title='按空格打断播报，或暂停、继续聆听';
  card.innerHTML='<div class="dots-call-identity"><div id="dotsCallIdentity" class="dots-call-avatar" aria-hidden="true"><span class="dots-call-fallback">'+dotsPersonalIcon+'</span></div><div class="dots-call-person"><h2 id="dotsCallName"></h2><time id="dotsCallTime" class="dots-call-time">00:00</time></div></div><p id="dotsVoiceStatus" class="dots-call-accessible" role="status"></p><p id="dotsVoiceHelp" class="dots-call-accessible">按空格打断播报，或暂停、继续聆听。静音与挂断按钮在下方。</p><div class="dots-call-controls"><button id="dotsVoiceMute" type="button" aria-label="静音麦克风" aria-pressed="false"></button><button id="dotsVoiceEnd" class="dots-call-end" type="button" aria-label="挂断语音通话">'+callGlyph('end')+'</button></div>';
  card.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target===card){e.preventDefault();interruptVoice();}});
  voiceCard=card;document.body.appendChild(card);bindVoiceCardDrag(card);$('dotsVoiceEnd').onclick=()=>stopVoice();$('dotsVoiceMute').onclick=toggleVoiceMute;
  return card;
 }
 function finishVoiceCardDrag(){
  const drag=voiceCardDrag;if(!drag)return;voiceCardDrag=null;voiceCard?.classList.remove('is-dragging');
  if(drag.moved)voiceCardSuppressClickUntil=Date.now()+300;
  if(voiceCard?.hasPointerCapture(drag.id))voiceCard.releasePointerCapture(drag.id);
 }
 function bindVoiceCardDrag(card){
  card.addEventListener('pointerdown',e=>{
   if(!card.classList.contains('is-compact')||e.button!==0||e.target.closest('button,input,textarea,a'))return;
   const rect=card.getBoundingClientRect();voiceCardDrag={id:e.pointerId,x:e.clientX,y:e.clientY,left:rect.left,top:rect.top,moved:false};
   card.setPointerCapture(e.pointerId);e.preventDefault();
  });
  card.addEventListener('pointermove',e=>{
   const drag=voiceCardDrag;if(!drag||drag.id!==e.pointerId)return;
   const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<4)return;
   drag.moved=true;card.classList.add('is-dragging');voiceCardPosition={left:drag.left+dx,top:drag.top+dy};positionCompactVoiceCard();
  });
  for(const event of ['pointerup','pointercancel','lostpointercapture'])card.addEventListener(event,e=>{if(voiceCardDrag?.id===e.pointerId)finishVoiceCardDrag();});
  card.addEventListener('click',e=>{if(e.detail&&Date.now()<voiceCardSuppressClickUntil){e.preventDefault();e.stopImmediatePropagation();voiceCardSuppressClickUntil=0;}},true);
  window.addEventListener('blur',finishVoiceCardDrag);
 }
 function positionCompactVoiceCard(){
  if(!voiceCard||!voice.active||!voiceCard.classList.contains('is-compact'))return;
  const bounds=$('mainWorkspace')?.getBoundingClientRect(),button=$('dotsTasksButton'),rect=active&&button?.getClientRects().length?button.getBoundingClientRect():$('desktopToolbar')?.getBoundingClientRect();
  const width=Math.min(300,Math.max(0,innerWidth-20));
  voiceCard.style.width=width+'px';voiceCard.style.maxHeight=Math.max(0,innerHeight-20)+'px';voiceCard.style.overflowY='auto';
  const height=voiceCard.getBoundingClientRect().height;
  const desired=voiceCardPosition||{left:(bounds?.right||innerWidth)-width-10,top:(rect?.bottom||60)+10};
  const left=Math.max(10,Math.min(desired.left,innerWidth-width-10)),top=Math.max(10,Math.min(desired.top,innerHeight-height-10));
  voiceCard.style.left=left+'px';voiceCard.style.top=top+'px';if(voiceCardPosition)voiceCardPosition={left,top};
 }
 function mountVoiceCard(card){
  const previousFocus=card.contains(document.activeElement)?document.activeElement:null;
  const panel=$('dotsActivity'),expanded=voice.active&&active&&drawerOpen&&!panel?.hidden;
  panel?.classList.toggle('has-voice-call',!!expanded);card.classList.toggle('is-compact',!expanded);
  if(expanded){
   finishVoiceCardDrag();if(card.parentElement!==panel||panel.firstElementChild!==card)panel.prepend(card);
   for(const property of ['left','top','width','max-height','overflow-y'])card.style.removeProperty(property);
  }else if(voice.active){if(card.parentElement!==document.body)document.body.appendChild(card);positionCompactVoiceCard();}
  else{finishVoiceCardDrag();if(card.parentElement!==document.body)document.body.appendChild(card);}
  if(previousFocus?.isConnected&&document.activeElement!==previousFocus)previousFocus.focus({preventScroll:true});
 }
 function updateVoiceClock(){
  syncNativeVoiceCall();
  const time=$('dotsCallTime');if(!voice.active||!time)return;
  const elapsed=Math.max(0,Math.floor((Date.now()-voice.startedAt)/1000));
  time.textContent=String(Math.floor(elapsed/60)).padStart(2,'0')+':'+String(elapsed%60).padStart(2,'0');
 }
 function setCallGlyph(button,kind){
  if(button.dataset.glyph===kind)return;button.dataset.glyph=kind;button.innerHTML=callGlyph(kind);
 }
 function renderVoice(){
  syncNativeVoiceCall();
  const card=voice.active?ensureVoiceCard():voiceCard;voiceOrb?.setState({active:voice.active,phase:voice.phase,level:voice.level,visible:active&&!document.hidden});if(!card){resizeComposer();return;}
  card.hidden=!voice.active;mountVoiceCard(card);
  if(voice.active){
   const statuses={listening:'正在聆听',sending:'正在发送',waiting:'等待回复',starting:'准备播报',speaking:'正在播报',muted:'麦克风已静音',paused:'聆听已暂停'};
   $('dotsVoiceStatus').textContent=statuses[voice.phase]||'语音通话';card.dataset.phase=voice.phase;
   const name=window.ShiYanDotsPanels?.name()||'Dots';$('dotsCallName').textContent=name;card.setAttribute('aria-label','与 '+name+' 的语音通话');
   updateVoiceClock();
   const mute=$('dotsVoiceMute');mute.setAttribute('aria-pressed',String(voice.muted));mute.setAttribute('aria-label',voice.muted?'取消麦克风静音':'静音麦克风');mute.title=mute.getAttribute('aria-label');setCallGlyph(mute,voice.muted?'muted':'mic');
  }
  window.ShiYanDotsPanels?.syncVoiceLayout?.();
  resizeComposer();
 }
 function toggleVoiceMute(){
  if(!voice.active)return;voice.muted=!voice.muted;
  if(voice.muted&&['listening','paused'].includes(voice.phase)){
   const id=voice.recognitionId;voice.recognitionId=null;voice.phase='muted';
   if(id)voiceNative('cancelSpeech',{callId:voice.callId,sessionId:id});
  }else if(!voice.muted&&voice.phase==='muted')listenVoice();
  renderVoice();
 }
 function stopVoice(message=''){
  traceVoice('call_stopped',{hasError:!!message});
  const wasActive=voice.active,callId=voice.callId;
  voice.active=false;voice.phase='idle';voice.recognitionId=null;voice.playbackId=null;voice.acceptedId=0;voice.text='';voice.errors.clear();voice.replyQueue=[];voice.replySeen.clear();voice.replyProgress.clear();voice.replySuppressed.clear();voice.playbackMessageId=0;voice.level=0;voice.muted=false;voice.paused=false;voice.epoch++;
  clearTimeout(voice.waitTimer);clearInterval(voice.pollTimer);clearInterval(voice.clockTimer);clearTimeout(voice.playbackTimer);voice.playbackTimer=0;voice.waitTimer=0;voice.pollTimer=0;voice.clockTimer=0;
  if(wasActive)voiceNative('endVoiceCall',{callId});
  voice.callId=null;nativeVoiceCallSignature='';
  renderVoice();voiceOrb?.destroy();voiceOrb=null;if(document.hidden)disconnect();if(active&&!document.hidden&&voice.previousFocus?.isConnected)voice.previousFocus.focus({preventScroll:true});voice.previousFocus=null;if(message)showError(message);
 }
 function listenVoice(){
  if(!voice.active)return;
  if(voice.muted||voice.paused){voice.phase=voice.muted?'muted':'paused';renderVoice();return;}
  voice.phase='listening';voice.level=0;voice.lastSpeechEnergyAt=0;voice.text='';voice.acceptedId=0;voice.recognitionId=crypto.randomUUID();renderVoice();traceVoice('recognition_requested');
  if(!voiceNative('startSpeech',{callId:voice.callId,sessionId:voice.recognitionId,autoStopAfterSilence:1.4}))stopVoice(window.ShiYanPlatform?.mode==='web'?'当前浏览器语音输入暂时不可用，请检查麦克风权限。':'请在拾燕桌面应用中开启语音聊天。');
 }
 function toggleVoice(){
  if(voice.active){stopVoice();return;}
  if(busy||uploading||pending.managerMessage||attachments().length||$('dotsManagerInput')?.value.trim())return;
  if(manager?.status==='paused'||manager?.status==='cancelled'){showError('请先在更多菜单中继续总管，再开启语音聊天。');return;}
   if(window.ShiYanPlatform?.mode==='web'){
    const browserVoice=window.ShiYanPlatform.adapter('voice');
    if(!browserVoice?.available()){showError(browserVoice?.unavailableReason()||'网页语音尚未就绪，请刷新后重试。');return;}
   }else if(!window.webkit?.messageHandlers?.native){showError('请在拾燕桌面应用中开启语音聊天。');return;}
  showError('');voice.previousFocus=document.activeElement;voice.active=true;voice.replyQueue=[];voice.replySeen.clear();voice.replyProgress.clear();voice.replySuppressed.clear();voice.replyFloor=Math.max(0,...messages.map(m=>Number(m.id)||0));voice.playbackMessageId=0;voice.consumedRecognitionIds.clear();voice.muted=false;voice.paused=false;voice.startedAt=Date.now();voice.callId=crypto.randomUUID();voice.epoch++;voice.level=0;drawerOpen=true;renderDrawer();voiceNative('prepareVoicePlayback',{callId:voice.callId});syncNativeVoiceCall(true);traceVoice('call_started');if(pending.voiceMessage)sendVoicePending().catch(e=>stopVoice(e?.message||'语音消息发送失败。'));else listenVoice();voiceCard?.focus({preventScroll:true});voice.clockTimer=setInterval(updateVoiceClock,1000);
  voice.pollTimer=setInterval(()=>{if(!voice.active)return;if(pending.voiceMessage&&!busy&&!uploading)sendVoicePending().catch(showError);else {checkVoiceReply();refresh().catch(showError);}},2000);
 }
 async function sendVoice(text){
  if(!voice.active||voice.phase!=='listening'||voice.muted||voice.paused)return;
  voice.recognitionId=null;
  if(!text.trim()){resumeVoice();return;}
  request('voiceMessage',{message:text.trim(),host:'shiyan_desktop',attachments:[]});
  voice.phase='sending';voice.level=0;renderVoice();
  await sendVoicePending();
 }
 async function sendVoicePending(){
  if(!voice.active||busy||uploading||!pending.voiceMessage)return;
  const epoch=voice.epoch,payload=pending.voiceMessage;voice.phase='sending';voice.text='';busy=true;renderVoice();
  traceVoice('voice_submit_requested',{requestId:payload.requestId,characterCount:payload.message.length});
  let response=null;
  try{
   await persist();
   response=await api('/manager/messages','POST',{...payload,attachments:[]});
   const acceptedId=Number(response.message?.id);
   if(response.accepted!==true||!Number.isSafeInteger(acceptedId)||acceptedId<1)throw Error('语音消息接收尚未确认，点击语音按钮重试。');
   adopt(response);delete pending.voiceMessage;
   // Acceptance already carries the real user message. Show it before local
   // persistence; an assistant delta can arrive while that write is pending.
   renderStreamMessages();
   try{await persist();}catch(e){pending.voiceMessage=payload;throw e;}
   if(!voice.active||voice.epoch!==epoch)return;
   voice.acceptedId=acceptedId;voice.phase='waiting';renderVoice();traceVoice('voice_message_accepted',{requestId:payload.requestId,messageId:acceptedId});
   if(voice.errors.has(acceptedId)){stopVoice(voice.errors.get(acceptedId));return;}
   voice.waitTimer=setTimeout(()=>{if(voice.active&&voice.epoch===epoch&&voice.acceptedId===acceptedId)stopVoice('总管仍在处理，语音聊天已暂停；文字回复会继续同步。');},300000);
   checkVoiceReply();refresh().catch(showError);
  }catch(e){
   traceVoice('voice_submit_failed',{requestId:payload.requestId,accepted:response?.accepted===true});
   if(voice.active&&voice.epoch===epoch)stopVoice('语音消息发送未确认，点击语音按钮重试。');
   showError(e?.message||'语音消息发送失败。');
  }finally{busy=false;refreshContent();}
 }
 function spokenText(content){
  const box=document.createElement('div');box.innerHTML=markdown(content);box.querySelectorAll('button,script,style').forEach(node=>node.remove());
  return box.textContent.trim().slice(0,20000);
 }
 // Keep a raw-text cursor per reply: rendered Markdown can change while a
 // delimiter is still arriving. Only stable sentences enter the audio queue.
 function deliveryState(message){return message.deliveryState||'completed';}
 function voiceSentences(raw,offset,complete){
  const chunks=[];let start=offset,i=offset,inline=false;
  while(i<raw.length){
   const fence=raw.slice(i).match(/^(\`{3,}|~{3,})/);
   if(fence&&(i===0||raw[i-1]==='\n')){
    const marker=fence[1][0],size=fence[1].length;
    let close=i+size;
    for(;close<raw.length;close++)if(raw[close]===marker&&(close===0||raw[close-1]==='\n')){
     let end=close;while(raw[end]===marker)end++;
     if(end-close>=size){i=end;break;}
    }
    if(close>=raw.length)break;
    continue;
   }
   if(raw[i]==='\`'){inline=!inline;i++;continue;}
   const char=raw[i],boundary=!inline&&(/[。！？!?；;\n]/.test(char)||(char==='.'&&/\s/.test(raw[i+1]||'')&&!/\d/.test(raw[i-1]||''))||((i-start)>=100&&/[，,：:]/.test(char)));
   if(boundary){
    let end=i+1;while(end<raw.length&&/[”’」』）)\]。！？!?；;]/.test(raw[end]))end++;
    chunks.push({offset:end,raw:raw.slice(start,end)});start=end;i=end;
   }else i++;
  }
  if(complete&&start<raw.length){chunks.push({offset:raw.length,raw:raw.slice(start)});start=raw.length;}
  return {offset:start,chunks};
 }
 function hasVoiceReplyStream(){return [...voice.replyProgress].some(([id,progress])=>progress.streaming&&!voice.replySuppressed.has(id));}
 function checkVoiceReply(){
  if(!voice.active)return;
  for(const reply of messages){
   if(reply.role!=='assistant')continue;
   const id=Number(reply.id);if(!Number.isSafeInteger(id)||id<=voice.replyFloor)continue;
   const state=deliveryState(reply),streaming=state==='streaming';
   const related=Array.isArray(reply.respondsToMessageIds)&&reply.respondsToMessageIds.some(value=>Number(value)===voice.acceptedId&&voice.acceptedId>0);
   if(related&&!streaming){clearTimeout(voice.waitTimer);voice.waitTimer=0;voice.acceptedId=0;}
   if(voice.replySeen.has(id)||voice.replySuppressed.has(id))continue;
   const stamp=Number(reply.createdAt),created=stamp>1e12?stamp:stamp*1000;
   if(!related&&Number.isFinite(created)&&created>0&&created<voice.startedAt-1000)continue;
   const raw=String(reply.content||''),progress=voice.replyProgress.get(id)||{offset:0,content:'',streaming:false,respondsTo:[]};
   // A revised already-spoken prefix cannot be taken back. Keep the screen's
   // correction, but never restart this reply and repeat its old sentences.
   if(raw.slice(0,progress.offset)!==progress.content.slice(0,progress.offset)){
    voice.replySuppressed.add(id);progress.streaming=false;continue;
   }
   progress.streaming=streaming;progress.respondsTo=reply.respondsToMessageIds||[];
   const ready=voiceSentences(raw,progress.offset,state==='completed');
   for(const part of ready.chunks){
    const clean=part.raw.replace(/(\`{3,}|~{3,})[\s\S]*?\1/g,'（代码内容请查看屏幕。）').replace(/(\`{3,}|~{3,})[\s\S]*$/g,'');
    const text=spokenText(clean);if(text)voice.replyQueue.push({id,text,offset:part.offset});
   }
   progress.offset=ready.offset;progress.content=raw;voice.replyProgress.set(id,progress);
   if(!streaming)voice.replySeen.add(id);
  }
  voice.replyQueue.sort((a,b)=>a.id-b.id||a.offset-b.offset);
  if(!flushVoiceReply()&&voice.phase==='waiting'&&!voice.acceptedId&&!hasVoiceReplyStream())resumeVoice();
 }
 function flushVoiceReply(){
  if(!voice.active||voice.paused||!voice.replyQueue.length||['sending','starting','speaking'].includes(voice.phase))return false;
  // Let a live utterance finish before reporting a worker's result.
  if(voice.phase==='listening'&&(voice.text.trim()||(voice.lastSpeechEnergyAt>0&&performance.now()-voice.lastSpeechEnergyAt<700)))return false;
  const reply=voice.replyQueue.shift(),progress=voice.replyProgress.get(reply.id);
  // Start the first sentence at once. Once it is playing, combine the same
  // reply's ready backlog so Qwen does not restart synthesis for every clause.
  if(progress?.playbackStarted){
   while(voice.replyQueue[0]?.id===reply.id&&reply.text.length+voice.replyQueue[0].text.length+1<=240){
    const next=voice.replyQueue.shift();reply.text+='\n'+next.text;reply.offset=next.offset;
   }
  }
  if(progress)progress.playbackStarted=true;
  const recognitionId=voice.recognitionId;
  voice.recognitionId=null;voice.phase='starting';voice.text='';voice.level=0;
  voice.playbackId=crypto.randomUUID();voice.playbackMessageId=reply.id;
  if(recognitionId)voiceNative('cancelSpeech',{callId:voice.callId,sessionId:recognitionId});
  renderVoice();traceVoice('voice_reply_queued',{replyId:reply.id,characterCount:reply.text.length});
  const playbackId=voice.playbackId;clearTimeout(voice.playbackTimer);
  voice.playbackTimer=setTimeout(()=>{if(voice.active&&voice.playbackId===playbackId&&voice.phase==='starting')stopVoice('语音播放未启动，请重新开启语音通话。');},120000);
  if(!voiceNative('speakVoice',{callId:voice.callId,sessionId:playbackId,text:reply.text}))stopVoice(window.ShiYanPlatform?.mode==='web'?'当前浏览器语音朗读暂时不可用，请重试。':'语音播放不可用，请在拾燕桌面应用中重试。');
  return true;
 }
 function resumeVoice(){
  if(!voice.active)return;
  voice.phase=(voice.acceptedId||hasVoiceReplyStream())?'waiting':voice.muted?'muted':voice.paused?'paused':'listening';voice.text='';
  if(flushVoiceReply())return;
  if(voice.acceptedId||hasVoiceReplyStream()){renderVoice();return;}
  listenVoice();
 }
 function interruptVoice(){
  if(!voice.active)return;
  if(['starting','speaking'].includes(voice.phase)||(voice.phase==='waiting'&&hasVoiceReplyStream())){
   const ids=new Set([voice.playbackMessageId,...voice.replyQueue.map(reply=>reply.id)]);
   for(const [id,progress] of voice.replyProgress)if(progress.streaming)ids.add(id);
   for(const id of ids){
    if(!id)continue;voice.replySuppressed.add(id);
    const progress=voice.replyProgress.get(id);if(progress){progress.streaming=false;if(progress.respondsTo.some(value=>Number(value)===voice.acceptedId)){clearTimeout(voice.waitTimer);voice.waitTimer=0;voice.acceptedId=0;}}
   }
   const id=voice.playbackId;voice.playbackId=null;voice.playbackMessageId=0;voice.replyQueue=[];voice.paused=false;clearTimeout(voice.playbackTimer);voice.playbackTimer=0;
   if(id)voiceNative('cancelVoicePlayback',{callId:voice.callId,sessionId:id});resumeVoice();
  }else if(voice.phase==='listening'){
   const id=voice.recognitionId;voice.recognitionId=null;voice.paused=true;voice.phase='paused';
   if(id)voiceNative('cancelSpeech',{callId:voice.callId,sessionId:id});renderVoice();
  }else if(voice.phase==='paused'){voice.paused=false;resumeVoice();}
 }
 function receiveVoiceEvent(d){
  if(d.type==='voiceSessionSuspended'){if(d.callId&&d.callId!==voice.callId)return;if(voice.active)stopVoice();return;}
  if(d.type==='dotsCallPanelAction'){
   if(!voice.active||d.callId!==voice.callId)return;
   if(d.action==='mute')toggleVoiceMute();else if(d.action==='end')stopVoice();
   return;
  }
  if(!voice.active)return;
  if((d.type==='speechLevel'&&d.sessionId===voice.recognitionId)||(d.type==='voicePlaybackLevel'&&d.sessionId===voice.playbackId)){
   voice.level=Math.max(0,Math.min(1,Number(d.level)||0));voice.levelAt=performance.now();
   if(d.type==='speechLevel'&&voice.level>.06)voice.lastSpeechEnergyAt=voice.levelAt;
   voiceOrb?.setState({level:voice.level});return;
  }
  if(d.type==='voicePlaybackState'&&d.sessionId===voice.playbackId){
   traceVoice('playback_event',{state:d.state});
   if(d.state==='speaking'){clearTimeout(voice.playbackTimer);voice.playbackTimer=0;voice.phase='speaking';voice.level=0;renderVoice();}
   else if(d.state==='finished'){clearTimeout(voice.playbackTimer);voice.playbackTimer=0;voice.playbackId=null;voice.playbackMessageId=0;resumeVoice();}
   else if(d.state==='failed')stopVoice(d.message||'语音播放失败，请重新开启语音通话。');
   else if(d.state==='cancelled')stopVoice('语音聊天已暂停。');
   return;
  }
  if(d.sessionId!==voice.recognitionId)return;
  if(d.type==='speech'){
   voice.text=String(d.text||'');
   if(d.isFinal){
    if(voice.consumedRecognitionIds.has(d.sessionId))return;
    voice.consumedRecognitionIds.add(d.sessionId);
    while(voice.consumedRecognitionIds.size>128)voice.consumedRecognitionIds.delete(voice.consumedRecognitionIds.values().next().value);
    sendVoice(voice.text).catch(e=>stopVoice(e?.message||'语音消息发送失败。'));
   }
  }else if(d.type==='speechError')stopVoice(d.message||'语音识别暂时不可用。');
  else if(d.type==='speechState'&&!d.active)stopVoice('语音聊天已暂停，请点按语音按钮重新开始。');
 }
 function receiveVoiceActivity(event){
  const item=event?.payload?.activity;
  if(!voice.active||item?.kind!=='manager_error'||!Array.isArray(item.data?.respondsToMessageIds))return;
  const message=item.data?.error||item.message||'总管处理失败，语音聊天已暂停。';
  for(const id of item.data.respondsToMessageIds)voice.errors.set(id,message);
  while(voice.errors.size>100)voice.errors.delete(voice.errors.keys().next().value);
  if(voice.phase==='waiting'&&voice.errors.has(voice.acceptedId))stopVoice(message);
 }
 const labels={active:'等待执行',running:'处理中',waiting:'等待中',scheduled:'已排队',pending:'已排队',queued:'已排队',paused:'已暂停',blocked:'需处理',completed:'已完成',done:'已完成',cancelled:'已取消',canceled:'已取消',failed:'失败',awaiting_approval:'需要你批准操作',waiting_approval:'需要你批准操作',sleeping:'等待唤醒'};
 const label=s=>labels[s]||s||'等待中';
 const date=n=>n?new Date(Number(n)*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
 const markdown=s=>window.ShiYanOutput?.markdown(s,C.icon('copy'),{prose:true})||'<p>'+esc(s).replace(/\n/g,'<br>')+'</p>';
 const api=(path,method='GET',data)=>window.shiyan.api('/api/dots'+path,method,data);
 // 对话订阅卡片：Dots 在对话里请用户补充凭据或确认取消。凭据直接提交到订阅接口，不进模型、不进聊天记录。
 const SUB_LABEL={github:'GitHub',email:'QQ 邮箱','google-calendar':'Google 日历'};
 function subscriptionCard(m){
  const c=m.card;if(!c||c.type!=='subscription')return '';
  const name=SUB_LABEL[c.provider]||c.provider;
  if(c.state!=='open')return '<div class="dots-sub-card is-'+esc(c.state)+'">'+(c.state==='done'?(c.action==='unsubscribe'?'已取消订阅 '+esc(name):'已订阅 '+esc(name)):'已关闭')+'</div>';
  if(c.action==='unsubscribe')return '<form class="dots-sub-card" data-dots-sub-card="'+esc(m.id)+'"><div><button type="submit" class="dots-white-button">确认取消订阅</button></div><small role="alert" data-sub-error hidden></small></form>';
  return '<form class="dots-sub-card" data-dots-sub-card="'+esc(m.id)+'" autocomplete="off">'+(c.fields||[]).map(f=>'<label><span>'+esc(f.label)+(f.optional?'（可选）':'')+'</span><input name="'+esc(f.key)+'" type="'+(f.secret?'password':'text')+'" value="'+(f.secret?'':esc(f.value||''))+'"'+(f.optional?'':' required')+' autocomplete="off" spellcheck="false"></label>').join('')+'<div><button type="submit" class="dots-white-button">订阅 '+esc(name)+'</button></div><small>只保存在服务器上，不会发给模型，也不会留在聊天记录里。</small><small role="alert" data-sub-error hidden></small></form>';
 }
 document.addEventListener('submit',async event=>{
  const form=event.target?.closest?.('[data-dots-sub-card]');if(!form)return;event.preventDefault();
  const m=messages.find(x=>String(x.id)===form.dataset.dotsSubCard),c=m?.card;if(!c||c.state!=='open')return;
  const error=form.querySelector('[data-sub-error]');error.hidden=true;form.querySelectorAll('button,input').forEach(n=>n.disabled=true);
  try{
   if(c.action==='unsubscribe')await api('/subscriptions/'+c.provider,'DELETE');
   else{const value={enabled:true};for(const f of c.fields||[]){const v=(form.elements[f.key]?.value||'').trim();if(v||!f.secret)value[f.key]=v;}await api('/subscriptions/'+c.provider,'PATCH',value);}
   m.card={...c,state:'done',fields:(c.fields||[]).map(f=>f.secret?{...f,value:''}:f)};renderMessages();
  }catch(cause){error.textContent=cause?.message||'订阅没有成功';error.hidden=false;form.querySelectorAll('button,input').forEach(n=>n.disabled=false);}
 });
 function persist(){
  const snapshot=JSON.stringify({manager,messages,tasks,goals,details,drafts,pending,cursor,readState});
  try{localStorage.setItem(key,snapshot);}catch{throw Error('无法保存 Dots 状态，请释放本机存储后重试');}
  if(savingTask&&savingSnapshot===snapshot)return savingTask;
  // Preserve write order and durability barriers, but do not resend unchanged history.
  const task=saveChain.catch(()=>{}).then(async()=>{
   if(snapshot===persistedSnapshot)return;
   await api('/local-state','PATCH',{state:JSON.parse(snapshot)});persistedSnapshot=snapshot;
  });
  saveChain=task;savingTask=task;savingSnapshot=snapshot;
  const clear=()=>{if(savingTask===task){savingTask=null;savingSnapshot=null;}};
  task.then(clear,clear);task.catch(showError);return task;
 }
 async function hydrate(){const {dotsState:s={}}=await api('/local-state');if(Object.keys(s).length){manager=s.manager||null;messages=s.messages||[];tasks=s.tasks||[];goals=s.goals||[];details=s.details||{};drafts=s.drafts||{};pending=s.pending||{};cursor=Number(s.cursor)||0;readState=normalizeReadState(s.readState,messages);}}
 function showError(e){error=e?.message||String(e);if(error==='连接中断，请检查网络后重试')error='';if($('dotsError')){$('dotsError').textContent=error;$('dotsError').hidden=!error;}if(error.includes('解锁')||error.includes('设备授权')){disconnect();setConnection('等待设备解锁或授权');}renderDrawer();}
 function setConnection(text){const notice=$('dotsConnection');if(notice){notice.textContent=text==='已连接'?'':text;notice.hidden=!notice.textContent;}renderDrawer();}
 function request(slot,payload){if(pending[slot])return pending[slot];pending[slot]={...payload,requestId:crypto.randomUUID()};return pending[slot];}
 function messageRevision(message){const value=Number(message?.revision);return Number.isSafeInteger(value)&&value>=0?value:0;}
 function mergeMessages(incoming){
  const merged=new Map(messages.map(message=>[String(message.id),message]));
  for(const message of incoming){
   const key=String(message.id),old=merged.get(key);
   if(old&&message.role==='assistant'){
    if(deliveryState(old)!=='streaming'&&deliveryState(message)==='streaming')continue;
    const previous=messageRevision(old),revision=messageRevision(message);
    if(revision<previous)continue;
    if(revision===previous&&(revision>0||old.deliveryState||message.deliveryState)){
     if(deliveryState(old)!=='streaming'&&deliveryState(message)==='streaming')continue;
     if(!String(message.content||'').startsWith(String(old.content||'')))continue;
    }
   }
   merged.set(key,message);
  }
  messages=[...merged.values()].sort((a,b)=>Number(a.id)-Number(b.id));
 }
 function adopt(data){const version=Number(data.activityCursor??data.manager?.activityCursor)||0,current=Number(manager?.activityCursor)||0,fresh=version>=current;const incoming=[...(data.messages||data.manager?.messages||[])];if(messageId(data.message)&&typeof data.message.content==='string')incoming.push(data.message);const cachedOldest=messages.length?Number(messages[0].id):Infinity,remoteOldest=incoming.length?Math.min(...incoming.map(m=>Number(m.id))):Infinity;if(fresh){if(data.manager){const {messages:embeddedMessages,tasks:embeddedTasks,...metadata}=data.manager;manager=metadata;}if(!historyChecked||cachedOldest>=remoteOldest)hasMoreMessages=!!(data.hasMoreMessages??data.manager?.hasMoreMessages);tasks=data.tasks||data.manager?.tasks||tasks;}mergeMessages(incoming);observeReplies(incoming);if(voice.active&&['paused','cancelled'].includes(manager?.status))stopVoice('总管已暂停或停止，语音聊天已结束。');else checkVoiceReply();}
 async function earlier(){if(historyLoading||!messages.length)return;historyLoading=true;const records=$('dotsRecords'),height=records.scrollHeight,top=records.scrollTop;refreshContent();try{const batch=await api('/manager/messages?before='+messages[0].id+'&limit=100');mergeMessages(batch.messages||[]);hasMoreMessages=!!batch.hasMore;historyChecked=true;await persist();}finally{historyLoading=false;refreshContent();const updated=$('dotsRecords');if(updated)updated.scrollTop=top+updated.scrollHeight-height;}}
 const needsApproval=task=>task.legacyImported!==true&&['waiting_approval','awaiting_approval'].includes(task.status);
 const approvalSlot=(goalId,id)=>'approval:'+goalId+':'+id;
 const approvalState=(goalId,id)=>({busy:approvalBusy.has(approvalSlot(goalId,id)),pending:pending[approvalSlot(goalId,id)]});
 async function refreshApprovals(force=false){
  const waiting=tasks.filter(needsApproval);renderApprovals();
  await Promise.all(waiting.map(async task=>{
   const id=String(task.id),version=JSON.stringify([task.status,task.updatedAt,task.controlRevision,manager?.activityCursor]),cached=approvalVersions.get(id);
   if(!force&&cached?.version===version&&Date.now()-cached.at<10000)return;
   try{const data=await api('/goals/'+encodeURIComponent(id));details[id]=data.goal;approvalVersions.set(id,{version,at:Date.now()});approvalErrors.delete(id);}
   catch(cause){approvalErrors.set(id,cause.message||'暂时无法读取审批详情');}
  }));
  renderApprovals();
 }
 function refresh(forceApprovals=false){
  if(refreshFlight){refreshQueuedForce=refreshQueuedForce||forceApprovals;return refreshFlight;}
  const run=async()=>{
   let force=forceApprovals;
   do{
    refreshQueuedForce=false;
    const observed=readState.observedThrough,data=await api('/manager');adopt(data);
    await reconcileUnreadGap(data,observed);await refreshApprovals(force);
    if(active&&drawerOpen){const d=await api('/goals?limit=200');goals=d.goals||[];if(selected){const detail=await api('/goals/'+selected);details[String(selected)]=detail.goal;}}
    await persist();refreshContent();force=refreshQueuedForce;
   }while(force);
  };
  refreshFlight=run().finally(()=>{refreshFlight=null;});return refreshFlight;
 }
 function managerTime(message){
  if(message.role!=='user'&&message.origin!=='proactive')return '';
  const value=Number(message.createdAt);if(!Number.isFinite(value)||value<=0)return '';
  const time=new Date(value>1e12?value:value*1000);if(!Number.isFinite(time.getTime()))return '';
  const now=new Date(),yesterday=new Date(now);yesterday.setDate(yesterday.getDate()-1);
  const sameDay=d=>time.getFullYear()===d.getFullYear()&&time.getMonth()===d.getMonth()&&time.getDate()===d.getDate();
  const prefix=sameDay(now)?'今天':sameDay(yesterday)?'昨天':(time.getFullYear()===now.getFullYear()?'':time.getFullYear()+'年')+(time.getMonth()+1)+'月'+time.getDate()+'日';
  const label=prefix+' '+time.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
  return '<div class="dots-message-time"><time datetime="'+esc(time.toISOString())+'">'+esc(label)+'</time></div>';
 }
 // 回复：以 Markdown 引用的形式放进消息正文，三端与模型看到的一致。
 let replyTo=null,sentAfterId=null;
 function quoteExcerpt(text){const plain=String(text||'').split('\n').map(l=>l.replace(/^(\s*>)+/,'').replace(/^[#*\-`\s]+/,'').trim()).filter(Boolean).join(' ');return plain.length>160?plain.slice(0,160)+'…':plain;}
 function composeQuote(quote,body){return quote.split('\n').filter(Boolean).slice(0,4).map(l=>'> '+l.trim()).join('\n')+'\n\n'+body;}
 function blankReply(m){return m.role==='assistant'&&!String(m.content||'').trim()&&!(m.attachments||[]).length&&!m.card;}
 function awaitingReply(){
  if(voice.active)return false;if(pending.managerMessage&&!busy)return false;
  if(sentAfterId!==null){if(!messages.some(m=>Number(m.id)>sentAfterId&&m.role==='assistant'&&!blankReply(m)))return true;sentAfterId=null;}
  if(busy)return false;const last=messages[messages.length-1];if(!last)return false;
  if(last.role==='assistant')return last.deliveryState==='streaming'&&blankReply(last);
  if(last.role!=='user'||['paused','cancelled'].includes(manager?.status))return false;
  const t=Number(last.createdAt)||0,ms=t>1e12?t:t*1000;return Date.now()-ms<300000;
 }
 let thinkingSince=0;
 // 重新渲染时延续同一相位，动画不会从头再播。
 function thinkingHTML(){const now=Date.now();const fresh=!thinkingSince||now-thinkingSince>400;if(!thinkingSince)thinkingSince=now;const t=now-thinkingSince,wave=i=>' style="animation-delay:-'+((t+1150-i*150)%1150)+'ms"';return '<div class="dots-thinking'+(fresh&&t<50?'':' is-steady')+'" role="status" aria-label="Dots 正在思考"><span class="dots-thinking-dots" aria-hidden="true"><i'+wave(0)+'></i><i'+wave(1)+'></i><i'+wave(2)+'></i></span></div>';}
 const msgActionIcon={reply:'<span class="symbol" data-symbol="arrowshape.turn.up.left" style="--symbol:url(\'/assets/symbols/arrowshape.turn.up.left.png\')" aria-hidden="true"></span>',copy:'<span class="symbol" data-symbol="dots-copy" style="--symbol:url(\'/assets/symbols/dots-copy.png\')" aria-hidden="true"></span>',up:'<span class="symbol" data-symbol="hand.thumbsup" style="--symbol:url(\'/assets/symbols/hand.thumbsup.png\')" aria-hidden="true"></span>',down:'<span class="symbol" data-symbol="hand.thumbsdown" style="--symbol:url(\'/assets/symbols/hand.thumbsdown.png\')" aria-hidden="true"></span>'};
 function messageActions(m){if(m.role==='system'||m.deliveryState==='streaming')return '';return '<div class="dots-msg-actions"><button type="button" data-dots-reply="'+esc(m.id)+'" title="回复" aria-label="回复">'+msgActionIcon.reply+'</button><button type="button" data-dots-copy="'+esc(m.id)+'" title="复制" aria-label="复制">'+msgActionIcon.copy+'</button>'+(m.origin==='proactive'?'<span class="dots-msg-sep"></span><button type="button" class="'+(m.feedback==='useful'?'is-on':'')+'" data-dots-feedback="useful" data-dots-feedback-id="'+esc(m.id)+'" title="有用" aria-label="有用" aria-pressed="'+(m.feedback==='useful')+'">'+msgActionIcon.up+'</button><button type="button" class="'+(m.feedback==='not_useful'?'is-on':'')+'" data-dots-feedback="not_useful" data-dots-feedback-id="'+esc(m.id)+'" title="没用，以后少推这类" aria-label="没用" aria-pressed="'+(m.feedback==='not_useful')+'">'+msgActionIcon.down+'</button>':'')+'</div>';}
 function replyPreviewHTML(){if(!replyTo)return '';return '<div class="dots-reply-preview"><div><strong>'+(replyTo.role==='user'?'回复自己':'回复 Dots')+'</strong><span>'+esc(quoteExcerpt(replyTo.content))+'</span></div><button type="button" data-dots-cancel-reply aria-label="取消回复" title="取消回复">×</button></div>';}
 document.addEventListener('click',async event=>{
  const fb=event.target.closest?.('[data-dots-feedback]');if(!fb)return;
  const m=messages.find(x=>String(x.id)===fb.dataset.dotsFeedbackId);if(!m)return;
  const value=m.feedback===fb.dataset.dotsFeedback?'clear':fb.dataset.dotsFeedback,before=m.feedback;
  m.feedback=value==='clear'?undefined:value;view.__signature=null;refreshContent();
  try{await api('/manager/messages/'+m.id+'/feedback','POST',{value});}catch(e){m.feedback=before;view.__signature=null;refreshContent();showError(e);}
 });
 document.addEventListener('click',event=>{
  const reply=event.target.closest?.('[data-dots-reply]'),copy=event.target.closest?.('[data-dots-copy]'),cancel=event.target.closest?.('[data-dots-cancel-reply]');
  if(!reply&&!copy&&!cancel)return;
  if(cancel){replyTo=null;view.__signature=null;refreshContent();$('dotsManagerInput')?.focus();return;}
  const id=(reply||copy).dataset.dotsReply||(reply||copy).dataset.dotsCopy,m=messages.find(x=>String(x.id)===String(id));if(!m)return;
  if(copy){navigator.clipboard?.writeText(m.content||'').then(()=>{copy.classList.add('is-done');setTimeout(()=>copy.classList.remove('is-done'),1200);}).catch(()=>{});return;}
  replyTo={id:m.id,role:m.role,content:m.content||''};view.__signature=null;refreshContent();$('dotsManagerInput')?.focus();
 });
 function renderMessagesRaw(records){records.innerHTML=(hasMoreMessages&&messages.length?'<button type="button" class="dots-history-more" data-dots-earlier'+(historyLoading?' disabled':'')+'>'+(historyLoading?'正在读取…':'查看更早消息')+'</button>':'')+(messages.length?messages.filter(m=>!blankReply(m)||m.card).map(m=>managerTime(m)+'<article class="dots-manager-message '+(m.role==='user'?'is-user':m.role==='system'?'is-system':'is-assistant')+'" data-dots-message="'+esc(m.id)+'">'+(m.role==='system'?'<header>状态</header>':'')+'<div class="message-body">'+markdown(m.content||'')+'</div>'+subscriptionCard(m)+((m.attachments||[]).length?'<div class="dots-files">'+m.attachments.map(a=>fileChip(a)).join('')+'</div>':'')+messageActions(m)+'</article>').join(''):'')+optimisticHTML()+(awaitingReply()?thinkingHTML():(thinkingSince=0,''));}
 function optimisticHTML(){const p=pending.managerMessage;if(!busy||!p||messages.some(m=>m.requestId===p.requestId))return '';return '<article class="dots-manager-message is-user is-optimistic"><div class="message-body">'+markdown(p.message||'')+'</div></article>';}
 // 重新渲染时保留卡片里已经输入的内容和焦点（轮询刷新不会清空用户正在填写的值）。
 function renderMessages(){const records=$('dotsRecords');if(!records)return;
  const kept={},active=document.activeElement,focusKey=active?.closest?.('[data-dots-sub-card]')&&active.name?active.closest('[data-dots-sub-card]').dataset.dotsSubCard+':'+active.name:'';
  records.querySelectorAll('[data-dots-sub-card] input').forEach(i=>{kept[i.closest('[data-dots-sub-card]').dataset.dotsSubCard+':'+i.name]=i.value;});
  renderMessagesRaw(records);
  records.querySelectorAll('[data-dots-sub-card] input').forEach(i=>{const k=i.closest('[data-dots-sub-card]').dataset.dotsSubCard+':'+i.name;if(k in kept)i.value=kept[k];if(k===focusKey)i.focus({preventScroll:true});});
 }
 function renderApprovals(){
  const box=$('dotsApprovals');if(!box)return;
  const waiting=tasks.filter(needsApproval),cards=waiting.map(task=>{
   const id=String(task.id),goal=details[id],checked=approvalVersions.has(id),notice=approvalErrors.get(id);
   if(!checked||notice)return '<section class="dots-child-approval dots-approval-unavailable"><h3>'+esc(task.title||'待批准操作')+'</h3><p role="status">'+esc(notice||'正在读取需要你批准的操作…')+'</p>'+(notice?'<button type="button" data-dots-refresh-approvals>重新读取</button>':'')+'</section>';
   return window.ShiYanDotsPanels?.approvalCards({...goal,title:task.title||goal?.title})||'';
  }).join('');
  const html=cards?'<header class="dots-approvals-heading">需要你批准的操作</header><small>请查看下方命令，并选择批准或拒绝。</small>'+cards:'';
  box.hidden=!html;if(box.__html!==html){box.__html=html;box.innerHTML=html;}
 }
 function syncApprovalState(){renderApprovals();window.ShiYanDotsPanels?.syncApprovalState();}
 function renderDrawer(){renderApprovals();window.ShiYanDotsPanels?.render({manager,messages,tasks,goals,details,drawerOpen,selected,busy,uploading,loading:!monitorReady,notice:error,connection:$('dotsConnection')?.textContent||'',pendingMessage:!!pending.managerMessage});renderVoice();}
 function controlIcon(action){const path=action==='pause'?'M9 5v14M15 5v14':action==='resume'?'M7 4l13 8-13 8Z':'M6 6h12v12H6Z';return '<svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+path+'"/></svg>';}
 function renderToolbar(){
  const status=manager?.status==='paused'?'已暂停':manager?.status==='cancelled'?'已停止':Number(manager?.runningWorkers)>0?'正在处理 '+Number(manager.runningWorkers)+' 件事':'';
  $('dotsStatus').textContent=status;$('dotsStatus').hidden=!status;
  const menu=$('dotsMenuContent'),action=manager?.status==='active'?'pause':'resume',signature=action+':'+busy;
  if(menu.dataset.signature===signature)return;menu.dataset.signature=signature;
  menu.innerHTML='<button type="button" data-dots-rename>'+window.shiyan.sessionMenuIcon('rename')+'<span>重命名</span></button><button type="button" data-dots-manager-control="'+action+'"'+(busy?' disabled':'')+'>'+controlIcon(action)+'<span>'+(action==='pause'?'暂停':'继续')+'</span></button><button type="button" class="is-destructive" data-dots-manager-control="cancel"'+(busy?' disabled':'')+'>'+controlIcon('cancel')+'<span>停止全部任务</span></button><hr><button type="button" data-dots-subscriptions>'+'<span class="wb-icon wb-ios-icon" style="--ios-symbol:url(\'/assets/symbols/bell.badge.png\')" aria-hidden="true"></span>'+'<span>事件订阅</span></button><button type="button" data-dots-refresh>'+'<span class="wb-icon wb-ios-icon" style="--ios-symbol:url(\'/assets/symbols/arrow.clockwise.png\')" aria-hidden="true"></span>'+'<span>刷新</span></button>';
 }
 // 输入变成多行时：文字在上占满整行，加号和发送按钮放到底部一行。离开多行要明显变短才切回，避免来回跳。
 function layoutComposer(input){const surface=input.closest('.dots-composer-surface');if(!surface)return;const tall=surface.classList.contains('is-tall'),length=input.value.length;let next=tall;
  if(!tall&&(input.scrollHeight>46||input.value.includes('\n'))){next=true;surface.dataset.tallAt=String(length);}
  else if(tall&&(!input.value.trim()||(!input.value.includes('\n')&&length<Number(surface.dataset.tallAt||0)*0.6)))next=false;
  if(next!==tall){surface.classList.toggle('is-tall',next);input.style.height='auto';input.style.height=Math.min(160,Math.max(36,input.scrollHeight))+'px';}}
 function resizeComposer(){const input=$('dotsManagerInput'),button=$('dotsSendButton');if(!input||!button)return;input.style.height='auto';input.style.height=Math.min(160,Math.max(36,input.scrollHeight))+'px';layoutComposer(input);const empty=!input.value.trim()&&!attachments().length&&!pending.managerMessage,isVoice=empty&&(voice.active||!busy);button.disabled=isVoice&&voice.active?false:busy||uploading;button.classList.toggle('is-empty',empty&&!isVoice);button.classList.toggle('is-voice',isVoice);button.classList.toggle('is-voice-active',isVoice&&voice.active);button.setAttribute('aria-label',isVoice&&voice.active?'结束语音聊天':isVoice?'语音实时聊天':busy?'发送中':pending.managerMessage?'重试发送':'发送');button.title=button.getAttribute('aria-label');button.innerHTML=isVoice?(voice.active?'<span class="dots-voice-stop" aria-hidden="true"></span>':voiceGlyph):pending.managerMessage&&!busy?C.icon('refresh'):'<span class="dots-send-icon" aria-hidden="true"></span>';positionCompactVoiceCard();}
   
   
  function managerIMEBlocksSend(){
   return managerIME?.input===$('dotsManagerInput')&&
    (managerIME.composing||managerIME.confirmingEnter);
  }
  function finishManagerIME(ime){
   if(managerIME!==ime||ime.composing)return;
   ime.epoch++;ime.ending=false;ime.confirmingEnter=false;
   if(!ime.deferred)return;
   ime.deferred=false;
   queueMicrotask(()=>{if(managerIME===ime&&!ime.composing&&!ime.ending&&!ime.confirmingEnter)refreshContent();});
  }
  function bindManagerComposer(input,form){
   const ime=managerIME={input,composing:false,ending:false,confirmingEnter:false,deferred:false,epoch:0};
   input.addEventListener('compositionstart',()=>{ime.epoch++;ime.composing=true;ime.ending=false;ime.confirmingEnter=false;});
   input.addEventListener('compositionend',()=>{
    ime.composing=false;ime.ending=true;const epoch=++ime.epoch;
     
     
     
    setTimeout(()=>{if(managerIME===ime&&ime.epoch===epoch)finishManagerIME(ime);},50);
   });
   input.addEventListener('keyup',e=>{
    if(!ime.composing&&(e.key==='Enter'||e.code==='Enter'||e.code==='NumpadEnter'||!ime.confirmingEnter))finishManagerIME(ime);
   });
   input.addEventListener('blur',()=>{ime.composing=false;finishManagerIME(ime);});
   input.onkeydown=e=>{
    const enter=e.key==='Enter'||e.code==='Enter'||e.code==='NumpadEnter';
    if(ime.composing||e.isComposing||e.keyCode===229||ime.confirmingEnter||(enter&&ime.ending)){
     if(enter)ime.confirmingEnter=true;
      
     return;
    }
    window.ShiYanComposerKeys.handleEnter(e,()=>submit().catch(showError));
   };
   form.onsubmit=e=>{
    e.preventDefault();if(managerIMEBlocksSend())return;
    if(!input.value.trim()&&!attachments().length&&!pending.managerMessage)toggleVoice();
    else submit().catch(showError);
   };
  }
 function render(){if(!view)return;const frozen=!!pending.managerMessage;
  renderToolbar();
  $('dotsDetail').innerHTML='<div id="dotsRecords" class="dots-records"></div><section id="dotsApprovals" class="dots-manager-approvals" aria-label="需要你批准的操作" hidden></section><form id="dotsManagerForm" class="dots-composer">'+replyPreviewHTML()+'<div class="dots-files">'+(frozen?pending.managerMessage.attachments||[]:attachments()).map(a=>fileChip(a,!frozen)).join('')+'</div><input id="dotsFileInput" type="file" multiple hidden><div class="dots-composer-surface"><button id="dotsAddFile" class="dots-add-file" type="button" aria-label="添加文件" title="添加文件"'+(frozen||busy||uploading?' disabled':'')+'>'+(uploading?'<span aria-hidden="true">…</span>':'<svg width="20" height="20" viewBox="0 0 24 24" style="display:block" aria-hidden="true" focusable="false"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>')+'</button><textarea id="dotsManagerInput" rows="1" maxlength="20000" aria-label="发送消息" placeholder="交给我…"'+(frozen?' readonly':'')+'>'+esc(frozen?pending.managerMessage.message:drafts.manager||'')+'</textarea><button id="dotsSendButton" class="send-button dots-send'+(busy?' is-busy':'')+'" type="submit"'+(busy?' disabled':'')+' aria-label="'+(frozen?'重试发送':'发送')+'"><span class="dots-send-icon" aria-hidden="true"></span></button></div>'+'</form>';
  renderMessages();renderDrawer();renderVoice();$('dotsAddFile').onclick=()=>$('dotsFileInput').click();$('dotsFileInput').onchange=e=>uploadFiles(Array.from(e.target.files||[])).catch(showError);view.querySelectorAll('[data-dots-remove-file]').forEach(button=>button.onclick=()=>{drafts.managerAttachments=attachments().filter(a=>a.id!==button.dataset.dotsRemoveFile);persist().catch(showError);view.__signature=null;refreshContent();});$('dotsManagerInput').oninput=e=>{drafts.manager=e.target.value;resizeComposer();persist().catch(showError);};bindManagerComposer($('dotsManagerInput'),$('dotsManagerForm'));
 }
 function refreshContent(){renderUnread();if(!active||document.hidden)return;const records=$('dotsRecords'),scroll=records?.scrollTop||0,atBottom=!records||records.scrollHeight-scroll-records.clientHeight<60;const focused=document.activeElement?.id,start=document.activeElement?.selectionStart,end=document.activeElement?.selectionEnd;const sig=JSON.stringify([manager,messages,tasks,goals,details,drawerOpen,selected,busy,pending,hasMoreMessages,historyLoading,uploading,attachments(),replyTo&&replyTo.id,sentAfterId]);if(view.__signature===sig){if(!voiceOrb?.drag)voiceComposerDeferred=false;markVisibleRepliesRead();return;}
    
    
   // Keep the captured input lip mounted for the entire pointer gesture. A
   // task update may repaint messages/panels, but must not cancel an upward drag
   // by replacing its composer; finish/release flushes the deferred full render.
   if(voiceOrb?.drag){
    voiceComposerDeferred=true;renderToolbar();renderMessages();renderDrawer();
    const updated=$('dotsRecords');if(updated)updated.scrollTop=atBottom?updated.scrollHeight:scroll;markVisibleRepliesRead();return;
   }
   if(managerIME?.input===$('dotsManagerInput')&&(managerIME.composing||managerIME.ending||managerIME.confirmingEnter)){
    managerIME.deferred=true;renderToolbar();renderMessages();renderDrawer();
    const updated=$('dotsRecords');if(updated)updated.scrollTop=atBottom?updated.scrollHeight:scroll;markVisibleRepliesRead();return;
   }
   voiceComposerDeferred=false;view.__signature=sig;render();const updated=$('dotsRecords');if(updated)updated.scrollTop=atBottom?updated.scrollHeight:scroll;if(focused&&$(focused)){$(focused).focus({preventScroll:true});if(typeof start==='number')$(focused).setSelectionRange(start,end);}markVisibleRepliesRead();}
 async function submit(){if(busy||uploading||managerIMEBlocksSend())return;const text=$('dotsManagerInput')?.value?.trim();if(!text&&!attachments().length&&!pending.managerMessage)return;const body=text||'请处理这些附件。',quoted=replyTo&&!pending.managerMessage?composeQuote(quoteExcerpt(replyTo.content),body):body;sentAfterId=messages.reduce((a,m)=>Math.max(a,Number(m.id)||0),0);replyTo=null;const payload=request('managerMessage',{message:quoted,host:'shiyan_desktop',attachments:attachments().map(a=>({...a}))});let acceptedResponse=null;busy=true;showError('');refreshContent();try{await persist();const response=await api('/manager/messages','POST',{...payload,attachments:(payload.attachments||[]).map(a=>a.id)});if(response.accepted!==true)throw Error('总管未确认接收此消息');acceptedResponse=response;adopt(response);delete pending.managerMessage;if(drafts.manager?.trim()===body||(!drafts.manager?.trim()&&payload.attachments?.length))delete drafts.manager;drafts.managerAttachments=attachments().filter(a=>!(payload.attachments||[]).some(sent=>sent.id===a.id));await persist();await refresh();return response;}catch(e){showError(e);return acceptedResponse;}finally{busy=false;refreshContent();if(voice.active&&pending.voiceMessage)sendVoicePending().catch(showError);}}
 async function managerControl(action){if(busy)return;if(voice.active)stopVoice();const slot='managerControl',payload=request(slot,{action});busy=true;try{await persist();adopt(await api('/manager/control','POST',payload));delete pending[slot];await persist();}finally{busy=false;refreshContent();}}
 async function taskControl(action){if(busy||!selected)return;const slot='taskControl:'+selected,payload=request(slot,{action});busy=true;try{await persist();await api('/goals/'+selected+'/control','POST',payload);delete pending[slot];await persist();await refresh();}finally{busy=false;refreshContent();}}
 async function decide(goalId,id,decision,shownCommand,scope='once'){
  goalId=Number(goalId);id=Number(id);
  if(!Number.isSafeInteger(goalId)||goalId<1||!Number.isSafeInteger(id)||id<1||!['approve','reject'].includes(decision))throw Error('审批标识无效，请重新读取事项');
  const slot=approvalSlot(goalId,id);if(approvalBusy.has(slot))return;
  const prior=pending[slot];
  if(prior&&(prior.decision!==decision||prior.confirmedCommand!==shownCommand))throw Error('上次决定的结果尚待确认，请重试原决定');
  if(decision==='approve'&&!window.ShiYanDotsPanels.canApprove(shownCommand))throw Error('命令尚未完整，无法批准；请让 Dots 补全具体命令');
  approvalBusy.add(slot);syncApprovalState();
  try{
   if(!prior){
    const data=await api('/goals/'+goalId);details[String(goalId)]=data.goal;
    const current=data.goal?.approvals?.find(a=>Number(a.id)===id);
    if(!current||!window.ShiYanDotsPanels.isPendingApproval(current)||String(current.command??'')!==shownCommand){
     approvalErrors.delete(String(goalId));renderApprovals();throw Error('该审批的状态或命令已更新，请查看最新内容后再决定');
    }
   }
   const payload=request(slot,{decision,confirmedCommand:shownCommand,...(decision==='approve'&&scope&&scope!=='once'?{scope}:{})});await persist();
   const result=await api('/goals/'+goalId+'/approvals/'+id+'/decision','POST',payload);
   if(result.goal)details[String(goalId)]=result.goal;
   delete pending[slot];await persist();await refresh(true);
  }catch(cause){
   if([400,403,404,422].includes(cause.status)||(cause.status===409&&cause.code==='approval_changed')){delete pending[slot];await persist();approvalVersions.delete(String(goalId));refresh(true).catch(showError);}
   throw cause;
  }finally{approvalBusy.delete(slot);syncApprovalState();}
 }
 async function showOutput(id){const box=view.querySelector('[data-dots-output-body="'+CSS.escape(String(id))+'"]');if(!box)return;if(!box.hidden){box.hidden=true;return;}const data=await api('/outputs/'+id);let raw=data.output?.raw_result||data.output?.summary||'';if(typeof raw!=='string')raw=JSON.stringify(raw,null,2);let readable=raw;try{const parsed=JSON.parse(raw);readable=parsed.result||parsed.message||parsed.summary||JSON.stringify(parsed,null,2);}catch{}rawOutputs.set(String(id),raw);while(rawOutputs.size>20)rawOutputs.delete(rawOutputs.keys().next().value);const preview=raw.length>12000?raw.slice(0,8000)+'\n… 可复制完整结果 …\n'+raw.slice(-4000):raw;box.innerHTML='<div class="dots-result-readable">'+markdown(typeof readable==='string'?readable:JSON.stringify(readable,null,2))+'</div><details class="dots-raw-result"><summary>原始结果</summary><pre><code>'+esc(preview)+'</code></pre><button data-dots-copy-output="'+esc(id)+'">复制完整结果</button></details>';box.hidden=false;}
 let eventFlushTimer=0,eventPendingCursor=0,eventRefreshNeeded=false,messageRenderTimer=0;
 function renderStreamMessages(){
  clearTimeout(messageRenderTimer);messageRenderTimer=0;if(!active||document.hidden)return;
  const records=$('dotsRecords');if(!records)return;
  const scroll=records.scrollTop,atBottom=records.scrollHeight-scroll-records.clientHeight<60;
  // Updating only the transcript keeps input, selection, IME and orb pointer
  // capture mounted while the very same assistant message grows.
  renderMessages();renderUnread();records.scrollTop=atBottom?records.scrollHeight:scroll;
 }
 function adoptMessageEvent(event){
  const activity=event?.payload?.activity,snapshot=event?.type==='manager_snapshot',message=snapshot?event?.payload?.message:activity?.data?.message;
  const user=snapshot||activity?.kind==='user_message';
  if((user?message?.role!=='user':!['assistant_delta','assistant_message','proactive_message'].includes(activity?.kind)||message?.role!=='assistant')||!messageId(message)||typeof message.content!=='string')return false;
  mergeMessages([message]);
  if(user){
   // User activities precede their assistant deltas, so commit their visible
   // transcript synchronously rather than waiting behind GET/save/ack work.
   renderStreamMessages();
   return !snapshot;
  }
  observeReplies([message]);checkVoiceReply();
  if(!messageRenderTimer)messageRenderTimer=setTimeout(renderStreamMessages,60);
  return true;
 }
 function scheduleEventFlush(epoch){
  if(eventFlushTimer)return;
  eventFlushTimer=setTimeout(()=>{
   eventFlushTimer=0;
   events=events.catch(()=>{}).then(async()=>{
    if(epoch!==streamEpoch||!monitorAllowed())return;
    const target=eventPendingCursor,needsRefresh=eventRefreshNeeded;eventRefreshNeeded=false;
    if(target<=cursor)return;
    if(needsRefresh)await refresh();
    if(epoch!==streamEpoch||!monitorAllowed())return;
    const before=cursor;cursor=target;
    try{await persist();}catch(error){cursor=before;throw error;}
    if(epoch!==streamEpoch||!monitorAllowed())return;
    await api('/notifications/ack','POST',{cursor:target});markVisibleRepliesRead();
   }).catch(error=>{
    showError(error);if(epoch===streamEpoch){eventPendingCursor=cursor;eventRefreshNeeded=false;reconnect();}
   }).finally(()=>{if(epoch===streamEpoch&&monitorAllowed()&&eventPendingCursor>cursor)scheduleEventFlush(epoch);});
  },120);
 }
 function disconnect(){streamEpoch++;source?.close();source=null;clearTimeout(reconnectTimer);clearInterval(recoveryTimer);clearTimeout(eventFlushTimer);clearTimeout(messageRenderTimer);eventFlushTimer=0;messageRenderTimer=0;eventPendingCursor=cursor;eventRefreshNeeded=false;}
 function reconnect(){source?.close();source=null;setConnection('连接中断，正在重连');clearTimeout(reconnectTimer);const epoch=streamEpoch;reconnectTimer=setTimeout(()=>{if(monitorAllowed()&&epoch===streamEpoch)connect();},Math.min(15000,1000*2**Math.min(4,reconnectAttempt++)));}
 function connect(){
  if(!monitorAllowed())return;
  if(window.ShiYanPlatform?.deferUntilLoaded?.(connect))return;
  const epoch=++streamEpoch;source?.close();clearTimeout(eventFlushTimer);eventFlushTimer=0;eventPendingCursor=cursor;eventRefreshNeeded=false;
  source=new EventSource('/api/dots/events?after='+cursor);
  source.addEventListener('connected',()=>{if(epoch!==streamEpoch)return;reconnectAttempt=0;setConnection('已连接');});
  source.addEventListener('update',e=>{
   if(epoch!==streamEpoch||!monitorAllowed())return;
   let event;try{event=JSON.parse(e.data);}catch{reconnect();return;}
   const seq=Number(event.seq);if(!Number.isSafeInteger(seq)||seq<=cursor)return;
   receiveVoiceActivity(event);
   const incremental=adoptMessageEvent(event);
   eventPendingCursor=Math.max(eventPendingCursor,seq);eventRefreshNeeded=eventRefreshNeeded||!incremental;
   scheduleEventFlush(epoch);
  });
  source.addEventListener('connection-error',()=>{if(epoch===streamEpoch)reconnect();});source.onerror=()=>{if(epoch===streamEpoch)reconnect();};
  clearInterval(recoveryTimer);recoveryTimer=setInterval(()=>{if(monitorAllowed())refresh().catch(showError);},10000);
 }
 function handleUploadPriorityChange(){
  if(window.ShiYanUploadPriority?.active){disconnect();return;}
  if(monitorAllowed()){connect();refresh().catch(showError);}
 }
 window.addEventListener('shiyan-upload-priority-change',handleUploadPriorityChange);
 function handleVisibilityChange(){
  // Visibility can toggle briefly during fullscreen transitions as well as
  // minimization. Neither is a hangup or a request to restart recognition.
  renderVoice();
  if(!monitorAllowed()){disconnect();return;}
  if(!source)connect();
  if(!document.hidden){refreshContent();refresh().catch(showError);}
 }
 function activate(){active=window.shiyan.getView()==='dots';document.body.classList.toggle('dots-is-current-view',active);view.hidden=!active;$('dotsToolbar').hidden=!active;if(!active)$('dotsToolbar').querySelector('.dots-menu').open=false;$('openDotsButton').classList.toggle('is-selected',active);if(active){$('workspaceTitle').replaceChildren();$('railHome').classList.add('is-active');hydration.then(()=>{if(!active)return;refreshContent();if(!source)connect();refresh().catch(showError);}).catch(showError);}renderVoice();renderUnread();C.scheduleNative();}
 function install(context){if(!window.ShiYanAccount.user)return;C=context;hydration=hydrate();hydration.catch(showError);const button=document.createElement('button');button.id='openDotsButton';button.type='button';button.className='sidebar-new-chat sidebar-dots';button.innerHTML=identityIcon()+'<span>'+esc(window.ShiYanDotsPanels?.name()||'Dots')+'</span>';button.title='Dots · 你的专属助手';button.setAttribute('aria-label','Dots 个人助手');button.onclick=()=>window.shiyan.navigate('dots');$('newConversationButton').after(button);$('agentSidebar')?.classList.add('has-dots-navigation');view=document.createElement('section');view.id='dotsView';view.className='dots-view dots-manager-view';view.hidden=true;view.setAttribute('aria-label','Dots 私人助手');view.innerHTML='<header id="dotsToolbar" class="dots-toolbar" hidden><span id="dotsStatus" class="dots-status" role="status" hidden></span><small id="dotsConnection" role="status" hidden></small><div class="dots-menu"><button type="button" data-dots-more class="wb-icon-button dots-icon-button" aria-label="更多" aria-expanded="false" title="更多">'+C.toolbarIcon('more')+'</button><div id="dotsMenuContent" class="dots-menu-content"></div></div><button id="dotsTasksButton" type="button" class="wb-icon-button dots-icon-button dots-tasks-button" data-dots-drawer aria-label="任务与活动" aria-expanded="false" title="任务与活动">'+C.toolbarIcon('tasks')+'</button><span class="dots-toolbar-divider" aria-hidden="true"></span></header><p id="dotsError" class="dots-error" role="alert" hidden></p><div class="dots-layout"><div id="dotsDetail" class="dots-detail"></div><aside id="dotsActivity" class="dots-activity" hidden></aside></div>';$('centerContent').appendChild(view);if($('toggleRightWorkspace'))$('toggleRightWorkspace').before($('dotsToolbar'));else if($('desktopToolbar'))$('desktopToolbar').appendChild($('dotsToolbar'));window.ShiYanDotsPanels.install({icon:C.icon,api,markdown,refresh,showError,sendText:async text=>{const input=$('dotsManagerInput');if(!input||busy||pending.managerMessage)return;input.value=text;drafts.manager=text;resizeComposer();await submit();},snapshot:()=>({manager,messages,tasks,goals,details,drawerOpen,selected,busy}),decideApproval:decide,approvalState,request,persist,pending:()=>pending,releaseRequest:async slot=>{delete pending[slot];await persist();},closePanel:()=>{drawerOpen=false;renderDrawer();},nameChanged:()=>{const name=window.ShiYanDotsPanels.name();renderUnread();if(active)$('workspaceTitle').replaceChildren();},scheduleNative:C.scheduleNative,voiceUpdated:focus=>{renderVoice();if(focus?.isConnected)focus.focus({preventScroll:true});}});const dotsMenu=$('dotsToolbar').querySelector('.dots-menu');Object.defineProperty(dotsMenu,'open',{get(){return this.hasAttribute('open');},set(value){this.toggleAttribute('open',!!value);this.querySelector('[data-dots-more]').setAttribute('aria-expanded',String(!!value));}});const moreSummary=$('dotsToolbar').querySelector('[data-dots-more]');moreSummary.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const menu=moreSummary.parentElement;menu.open=!menu.open;moreSummary.setAttribute('aria-expanded',String(menu.open));C.scheduleNative?.();});const handleAction=async e=>{try{if(e.target.closest('.dots-menu-content button'))$('dotsToolbar').querySelector('.dots-menu').removeAttribute('open');const task=e.target.closest('[data-dots-task]'),mc=e.target.closest('[data-dots-manager-control]'),tc=e.target.closest('[data-dots-task-control]'),decision=e.target.closest('[data-dots-decision]');if(e.target.closest('[data-dots-earlier]'))await earlier();else if(e.target.closest('[data-dots-subscriptions]')){await window.ShiYanDotsPanels.openSubscriptions();}else if(e.target.closest('[data-dots-connectors]')){await window.ShiYanDotsPanels.openConnectors();}else if(e.target.closest('[data-dots-settings]')){await window.ShiYanDotsPanels.openDotsSettings();}else if(e.target.closest('[data-dots-audit]')){await window.ShiYanDotsPanels.openAudit();}else if(e.target.closest('[data-dots-rename]')){window.ShiYanDotsPanels.openProfile();}else if(e.target.closest('[data-dots-drawer]')){drawerOpen=!drawerOpen;renderDrawer();C.scheduleNative?.();if(drawerOpen)refresh().catch(showError);}else if(e.target.closest('[data-dots-refresh]')){showError('');await refresh();if(!source)connect();}else if(task){selected=Number(task.dataset.dotsTask);const d=await api('/goals/'+selected);details[String(selected)]=d.goal;await persist();refreshContent();}else if(mc)await managerControl(mc.dataset.dotsManagerControl);else if(tc)await taskControl(tc.dataset.dotsTaskControl);else if(e.target.closest('[data-dots-refresh-approvals]'))await refresh(true);else if(decision){const card=decision.closest('[data-dots-approval]');await decide(card.dataset.dotsApprovalGoal,card.dataset.dotsApproval,decision.dataset.dotsDecision,decodeURIComponent(card.dataset.dotsApprovalCommand),window.ShiYanDotsPanels.approvalScope(Number(card.dataset.dotsApprovalGoal),Number(card.dataset.dotsApproval)));}else if(e.target.closest('[data-dots-output]'))await showOutput(e.target.closest('[data-dots-output]').dataset.dotsOutput);else if(e.target.closest('[data-dots-copy-output]'))await window.shiyan.copyText(rawOutputs.get(e.target.closest('[data-dots-copy-output]').dataset.dotsCopyOutput)||'');}catch(e){showError(e);}};view.addEventListener('click',handleAction);view.addEventListener('change',e=>{const select=e.target.closest('[data-dots-approval-scope]');if(!select)return;const card=select.closest('[data-dots-approval]');window.ShiYanDotsPanels.setApprovalScope(Number(card.dataset.dotsApprovalGoal),Number(card.dataset.dotsApproval),select.value);const hint=select.closest('.dots-approval-scope')?.querySelector('small');if(hint)hint.textContent=select.value==='once'?'只执行上面这条命令。':'同类操作之后自动执行，可在 Dots 设置里随时撤销。';});$('dotsToolbar').addEventListener('click',handleAction);document.addEventListener('click',e=>{if(!e.target.closest('.dots-menu'))$('dotsToolbar').querySelector('.dots-menu')?.removeAttribute('open');});document.addEventListener('keydown',e=>{if(active&&e.key==='Escape'){const menu=$('dotsToolbar').querySelector('.dots-menu');if(menu?.open){menu.open=false;menu.querySelector('[data-dots-more]').focus();e.preventDefault();}}});window.addEventListener('shiyan-view',activate);window.addEventListener('shiyan-state',()=>{if(active)queueMicrotask(()=>{$('workspaceTitle').replaceChildren();$('railHome').classList.add('is-active');});});document.addEventListener('visibilitychange',handleVisibilityChange);window.addEventListener('pagehide',()=>{stopVoice();disconnect();persist().catch(()=>{});});window.addEventListener('online',()=>{if(monitorAllowed()){connect();refresh().catch(showError);}});view.addEventListener('scroll',e=>{if(e.target.id==='dotsRecords')markVisibleRepliesRead();},true);hydration.then(()=>{monitorReady=true;renderUnread();connect();refresh().catch(showError);}).catch(showError);}
 window.addEventListener('focus',markVisibleRepliesRead);
 window.addEventListener('resize',positionCompactVoiceCard);
 window.addEventListener('shiyan-native',event=>receiveVoiceEvent(event.detail||{}));
 window.ShiYanDots={install};
})();
