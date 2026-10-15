 
(() => {
 'use strict';
 const dotsPersonalIcon="<svg class=\"wb-icon wb-dots-personal-icon\" aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13.6 4.1a8.5 8.5 0 1 0 5.4 6.1M13.1 9.8a2.6 2.6 0 1 1-5.2 0a2.6 2.6 0 1 1 5.2 0ZM5.3 19c.9-2.4 2.5-3.8 5.2-3.8s4.3 1.4 5.2 3.8M19 1.8l.85 2.35L22.2 5l-2.35.85L19 8.2l-.85-2.35L15.8 5l2.35-.85Z\"/></svg>";
 const identityIcon=()=>window.ShiYanDotsPanels?.avatar()||dotsPersonalIcon;
 const $=id=>document.getElementById(id);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const key='shiyan.dots.v1';let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}');}catch{}
 let C,view,active=false,monitorReady=false,hydration,saveChain=Promise.resolve(),refreshChain=Promise.resolve(),events=Promise.resolve();
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
 const rawOutputs=new Map();let uploading=false;
 const attachments=()=>drafts.managerAttachments||[];
 const fileChip=(a,removable=false)=>'<span class="dots-file-chip"><span aria-hidden="true">'+C.icon('file')+'</span>'+(!removable?'<a download href="/api/dots/attachments/'+encodeURIComponent(a.id)+'">'+esc(a.filename)+'</a>':'<span>'+esc(a.filename)+'</span><button type="button" data-dots-remove-file="'+esc(a.id)+'" aria-label="移除 '+esc(a.filename)+'"'+(busy||pending.managerMessage?' disabled':'')+'>×</button>')+'</span>';
 async function uploadFiles(files){if(uploading||busy||pending.managerMessage)return;uploading=true;refreshContent();try{for(const file of files){if(attachments().length>=8)throw Error('最多添加 8 个文件');if(!file.size||file.size>20*1024*1024)throw Error('文件不能为空，单个文件不能超过 20 MB');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('无法读取文件'));reader.readAsDataURL(file);});const result=await api('/attachments','POST',{id:crypto.randomUUID(),filename:file.name,mimeType:file.type||'application/octet-stream',data});drafts.managerAttachments=[...attachments(),result.attachment];await persist();refreshContent();}}finally{uploading=false;refreshContent();}}
 let managerIME=null;
 let busy=false,historyLoading=false,historyChecked=false,hasMoreMessages=true,error='',drawerOpen=false,selected=null,source,reconnectTimer,recoveryTimer,reconnectAttempt=0,streamEpoch=0;
  
  
 let voiceCard=null;
 const voice={active:false,phase:'idle',recognitionId:null,playbackId:null,text:'',acceptedId:0,epoch:0,waitTimer:0,pollTimer:0,clockTimer:0,playbackTimer:0,callId:null,startedAt:0,muted:false,paused:false,previousFocus:null,consumedRecognitionIds:new Set(),errors:new Map()};
 const voiceGlyph='<svg class="dots-voice-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4"/></svg>';
 function voiceNative(action,detail={}){const bridge=window.webkit?.messageHandlers?.native;if(!bridge)return false;bridge.postMessage({action,...detail});return true;}
 function traceVoice(stage,extra={}){
  voiceNative('dotsVoiceTrace',{stage,callId:voice.callId,phase:voice.phase,recognitionId:voice.recognitionId,playbackId:voice.playbackId,messageId:voice.acceptedId,...extra});
 }
 function callGlyph(kind){
  const paths={mic:'M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V4ZM5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8',muted:'M4 3l16 18M9 8v3a3 3 0 0 0 4.5 2.6M15 8V4a3 3 0 0 0-5.4-1.8M5 10v1a7 7 0 0 0 12.1 4.8M19 10v1a7 7 0 0 1-.4 2.2M12 18v4M8 22h8',end:'M4 15l2.6 2.5 3.1-2v-3a18 18 0 0 1 4.6 0v3l3.1 2L20 15c-4.4-4.7-11.6-4.7-16 0Z',pause:'M9 5v14M15 5v14',play:'M8 5l11 7-11 7V5Z',interrupt:'M5 12h14M12 5v14'};
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[kind]+'"/></svg>';
 }
 function ensureVoiceCard(){
  if(voiceCard)return voiceCard;if(!view)return null;
  const card=document.createElement('section');card.id='dotsVoiceCard';card.className='dots-voice-card';card.hidden=true;card.tabIndex=0;
  card.setAttribute('role','group');card.setAttribute('aria-keyshortcuts','Space');card.setAttribute('aria-describedby','dotsVoiceStatus dotsVoiceHelp');
  card.title='按空格打断播报，或暂停、继续聆听';
  card.innerHTML='<div class="dots-call-identity"><div id="dotsCallIdentity" class="dots-call-avatar" aria-hidden="true"></div><div class="dots-call-person"><h2 id="dotsCallName"></h2><time id="dotsCallTime" class="dots-call-time">00:00</time></div></div><p id="dotsVoiceStatus" class="dots-call-accessible" role="status"></p><p id="dotsVoiceHelp" class="dots-call-accessible">按空格打断播报，或暂停、继续聆听。静音与挂断按钮在下方。</p><div class="dots-call-controls"><button id="dotsVoiceMute" type="button" aria-label="静音麦克风" aria-pressed="false"></button><button id="dotsVoiceEnd" class="dots-call-end" type="button" aria-label="挂断语音通话">'+callGlyph('end')+'</button></div>';
  card.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target===card){e.preventDefault();interruptVoice();}});
  voiceCard=card;view.appendChild(card);$('dotsVoiceEnd').onclick=()=>stopVoice();$('dotsVoiceMute').onclick=toggleVoiceMute;
  return card;
 }
 function positionCompactVoiceCard(){
  if(!voiceCard||!voice.active||drawerOpen)return;
  const button=$('dotsTasksButton'),rect=button?.getBoundingClientRect(),bounds=$('mainWorkspace')?.getBoundingClientRect()||view.getBoundingClientRect();
  if(!rect)return;
  const leftLimit=Math.max(0,bounds.left)+10,rightLimit=Math.max(leftLimit,Math.min(innerWidth,bounds.right)-10);
  const width=Math.min(300,Math.max(0,rightLimit-leftLimit)),top=Math.max(10,Math.min(rect.bottom+10,Math.max(10,innerHeight-10)));
  voiceCard.style.width=width+'px';voiceCard.style.left=Math.max(leftLimit,rightLimit-width)+'px';voiceCard.style.top=top+'px';voiceCard.style.maxHeight=Math.max(0,innerHeight-top-10)+'px';voiceCard.style.overflowY='auto';
 }
 function mountVoiceCard(card){
  const previousFocus=card.contains(document.activeElement)?document.activeElement:null;
  const panel=$('dotsActivity'),expanded=voice.active&&drawerOpen&&!panel?.hidden;
  panel?.classList.toggle('has-voice-call',!!expanded);card.classList.toggle('is-compact',!expanded);
  if(expanded){
   if(card.parentElement!==panel||panel.firstElementChild!==card)panel.prepend(card);
   for(const property of ['left','top','width','max-height','overflow-y'])card.style.removeProperty(property);
  }else if(voice.active){if(card.parentElement!==view)view.appendChild(card);positionCompactVoiceCard();}
  if(previousFocus?.isConnected&&document.activeElement!==previousFocus)previousFocus.focus({preventScroll:true});
 }
 function updateVoiceClock(){
  const time=$('dotsCallTime');if(!voice.active||!time)return;
  const elapsed=Math.max(0,Math.floor((Date.now()-voice.startedAt)/1000));
  time.textContent=String(Math.floor(elapsed/60)).padStart(2,'0')+':'+String(elapsed%60).padStart(2,'0');
 }
 function setCallGlyph(button,kind){
  if(button.dataset.glyph===kind)return;button.dataset.glyph=kind;button.innerHTML=callGlyph(kind);
 }
 function renderVoice(){
  const card=voice.active?ensureVoiceCard():voiceCard;if(!card){resizeComposer();return;}
  card.hidden=!voice.active;mountVoiceCard(card);
  if(voice.active){
   const statuses={listening:'正在聆听',sending:'正在发送',waiting:'等待回复',starting:'准备播报',speaking:'正在播报',muted:'麦克风已静音',paused:'聆听已暂停'};
   $('dotsVoiceStatus').textContent=statuses[voice.phase]||'语音通话';card.dataset.phase=voice.phase;
   const name=window.ShiYanDotsPanels?.name()||'Dots';$('dotsCallName').textContent=name;card.setAttribute('aria-label','与 '+name+' 的语音通话');
   const icon=identityIcon();if($('dotsCallIdentity').__icon!==icon){$('dotsCallIdentity').innerHTML=icon;$('dotsCallIdentity').__icon=icon;}
   updateVoiceClock();
   const mute=$('dotsVoiceMute');mute.setAttribute('aria-pressed',String(voice.muted));mute.setAttribute('aria-label',voice.muted?'取消麦克风静音':'静音麦克风');mute.title=mute.getAttribute('aria-label');setCallGlyph(mute,'muted');
  }
  resizeComposer();
 }
 function toggleVoiceMute(){
  if(!voice.active)return;voice.muted=!voice.muted;
  if(voice.muted&&['listening','paused'].includes(voice.phase)){
   const id=voice.recognitionId;voice.recognitionId=null;voice.phase='muted';
   if(id)voiceNative('cancelSpeech',{sessionId:id});
  }else if(!voice.muted&&voice.phase==='muted')listenVoice();
  renderVoice();
 }
 function stopVoice(message=''){
  traceVoice('call_stopped',{hasError:!!message});
  const recognitionId=voice.recognitionId,playbackId=voice.playbackId;
  voice.active=false;voice.phase='idle';voice.recognitionId=null;voice.playbackId=null;voice.acceptedId=0;voice.text='';voice.errors.clear();voice.muted=false;voice.paused=false;voice.epoch++;
  clearTimeout(voice.waitTimer);clearInterval(voice.pollTimer);clearInterval(voice.clockTimer);clearTimeout(voice.playbackTimer);voice.playbackTimer=0;voice.waitTimer=0;voice.pollTimer=0;voice.clockTimer=0;
  if(recognitionId)voiceNative('cancelSpeech',{sessionId:recognitionId});
  if(playbackId)voiceNative('cancelVoicePlayback',{sessionId:playbackId});
  renderVoice();if(active&&!document.hidden&&voice.previousFocus?.isConnected)voice.previousFocus.focus({preventScroll:true});voice.previousFocus=null;if(message)showError(message);
 }
 function listenVoice(){
  if(!voice.active||!active||document.hidden)return;
  if(voice.muted||voice.paused){voice.phase=voice.muted?'muted':'paused';renderVoice();return;}
  voice.phase='listening';voice.text='';voice.acceptedId=0;voice.recognitionId=crypto.randomUUID();renderVoice();traceVoice('recognition_requested');
  if(!voiceNative('startSpeech',{sessionId:voice.recognitionId,autoStopAfterSilence:1.4}))stopVoice('请在拾燕桌面应用中开启语音聊天。');
 }
 function toggleVoice(){
  if(voice.active){stopVoice();return;}
  if(busy||uploading||pending.managerMessage||attachments().length||$('dotsManagerInput')?.value.trim())return;
  if(manager?.status==='paused'||manager?.status==='cancelled'){showError('请先在更多菜单中继续总管，再开启语音聊天。');return;}
  if(!window.webkit?.messageHandlers?.native){showError('请在拾燕桌面应用中开启语音聊天。');return;}
  showError('');voice.previousFocus=document.activeElement;voice.active=true;voice.consumedRecognitionIds.clear();voice.muted=false;voice.paused=false;voice.startedAt=Date.now();voice.callId=crypto.randomUUID();voice.epoch++;drawerOpen=true;renderDrawer();traceVoice('call_started');if(pending.voiceMessage)sendVoicePending().catch(e=>stopVoice(e?.message||'语音消息发送失败。'));else listenVoice();voiceCard?.focus({preventScroll:true});voice.clockTimer=setInterval(updateVoiceClock,1000);
  voice.pollTimer=setInterval(()=>{if(voice.active&&voice.phase==='waiting'&&active&&!document.hidden)refresh().catch(showError);},2000);
 }
 async function sendVoice(text){
  if(!voice.active||voice.phase!=='listening'||voice.muted||voice.paused)return;
  voice.recognitionId=null;
  if(!text.trim()){listenVoice();return;}
  request('voiceMessage',{message:text.trim(),host:'shiyan_desktop',attachments:[]});
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
   try{await persist();}catch(e){pending.voiceMessage=payload;throw e;}
   if(!voice.active||voice.epoch!==epoch)return;
   voice.acceptedId=acceptedId;voice.phase='waiting';renderVoice();traceVoice('voice_message_accepted',{requestId:payload.requestId,messageId:acceptedId});
   if(voice.errors.has(acceptedId)){stopVoice(voice.errors.get(acceptedId));return;}
   voice.waitTimer=setTimeout(()=>{if(voice.active&&voice.epoch===epoch&&voice.phase==='waiting')stopVoice('总管仍在处理，语音聊天已暂停；文字回复会继续同步。');},300000);
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
 function checkVoiceReply(){
  if(!voice.active||voice.phase!=='waiting'||!voice.acceptedId)return;
  const acceptedId=voice.acceptedId;
  const reply=messages.find(m=>m.role==='assistant'&&Number(m.id)>voice.acceptedId&&Array.isArray(m.respondsToMessageIds)&&m.respondsToMessageIds.includes(voice.acceptedId));
  if(!reply)return;
  clearTimeout(voice.waitTimer);voice.waitTimer=0;voice.acceptedId=0;
  const text=spokenText(reply.content||'');if(!text){listenVoice();return;}
  voice.phase='starting';voice.text='';voice.playbackId=crypto.randomUUID();renderVoice();traceVoice('voice_reply_matched',{messageId:acceptedId,replyId:Number(reply.id),characterCount:text.length});
  const playbackId=voice.playbackId;voice.playbackTimer=setTimeout(()=>{if(voice.active&&voice.playbackId===playbackId&&voice.phase==='starting')stopVoice('语音播放未启动，请重新开启语音通话。');},15000);
  if(!voiceNative('speakVoice',{sessionId:voice.playbackId,text}))stopVoice('语音播放不可用，请在拾燕桌面应用中重试。');
 }
 function interruptVoice(){
  if(!voice.active)return;
  if(['starting','speaking'].includes(voice.phase)){
   const id=voice.playbackId;voice.playbackId=null;voice.paused=false;clearTimeout(voice.playbackTimer);voice.playbackTimer=0;
   if(id)voiceNative('cancelVoicePlayback',{sessionId:id});listenVoice();
  }else if(voice.phase==='listening'){
   const id=voice.recognitionId;voice.recognitionId=null;voice.paused=true;voice.phase='paused';
   if(id)voiceNative('cancelSpeech',{sessionId:id});renderVoice();
  }else if(voice.phase==='paused'){voice.paused=false;listenVoice();}
 }
 function receiveVoiceEvent(d){
  if(d.type==='voiceSessionSuspended'){if(voice.active)stopVoice();return;}
  if(!voice.active)return;
  if(d.type==='voicePlaybackState'&&d.sessionId===voice.playbackId){
   traceVoice('playback_event',{state:d.state});
   if(d.state==='speaking'){clearTimeout(voice.playbackTimer);voice.playbackTimer=0;voice.phase='speaking';renderVoice();}
   else if(d.state==='finished'){clearTimeout(voice.playbackTimer);voice.playbackTimer=0;voice.playbackId=null;listenVoice();}
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
 const labels={active:'等待执行',running:'处理中',waiting:'等待中',scheduled:'已排队',pending:'已排队',queued:'已排队',paused:'已暂停',blocked:'需处理',completed:'已完成',done:'已完成',cancelled:'已取消',canceled:'已取消',failed:'失败',awaiting_approval:'待审批',waiting_approval:'待审批',sleeping:'等待唤醒'};
 const label=s=>labels[s]||s||'等待中';
 const date=n=>n?new Date(Number(n)*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
 const markdown=s=>window.ShiYanOutput?.markdown(s,C.icon('copy'))||'<p>'+esc(s).replace(/\n/g,'<br>')+'</p>';
 const api=(path,method='GET',data)=>window.shiyan.api('/api/dots'+path,method,data);
 function persist(){
  const snapshot=JSON.parse(JSON.stringify({manager,messages,tasks,goals,details,drafts,pending,cursor,readState}));
  try{localStorage.setItem(key,JSON.stringify(snapshot));}catch{throw Error('无法保存 Dots 状态，请释放本机存储后重试');}
  const task=saveChain.catch(()=>{}).then(()=>api('/local-state','PATCH',{state:snapshot}));saveChain=task;task.catch(showError);return task;
 }
 async function hydrate(){const {dotsState:s={}}=await api('/local-state');if(Object.keys(s).length){manager=s.manager||null;messages=s.messages||[];tasks=s.tasks||[];goals=s.goals||[];details=s.details||{};drafts=s.drafts||{};pending=s.pending||{};cursor=Number(s.cursor)||0;readState=normalizeReadState(s.readState,messages);}}
 function showError(e){error=e?.message||String(e);if(error==='连接中断，请检查网络后重试')error='';if($('dotsError')){$('dotsError').textContent=error;$('dotsError').hidden=!error;}if(error.includes('解锁')||error.includes('设备授权')){disconnect();setConnection('等待设备解锁或授权');}renderDrawer();}
 function setConnection(text){const notice=$('dotsConnection');if(notice){notice.textContent=text==='已连接'?'':text;notice.hidden=!notice.textContent;}renderDrawer();}
 function request(slot,payload){if(pending[slot])return pending[slot];pending[slot]={...payload,requestId:crypto.randomUUID()};return pending[slot];}
 function mergeMessages(incoming){messages=Array.from(new Map([...messages,...incoming].map(m=>[String(m.id),m])).values()).sort((a,b)=>Number(a.id)-Number(b.id));}
 function adopt(data){const version=Number(data.activityCursor??data.manager?.activityCursor)||0,current=Number(manager?.activityCursor)||0,fresh=version>=current;const incoming=data.messages||data.manager?.messages||[];const cachedOldest=messages.length?Number(messages[0].id):Infinity,remoteOldest=incoming.length?Math.min(...incoming.map(m=>Number(m.id))):Infinity;if(fresh){if(data.manager){const {messages:embeddedMessages,tasks:embeddedTasks,...metadata}=data.manager;manager=metadata;}if(!historyChecked||cachedOldest>=remoteOldest)hasMoreMessages=!!(data.hasMoreMessages??data.manager?.hasMoreMessages);tasks=data.tasks||data.manager?.tasks||tasks;}mergeMessages(incoming);observeReplies(incoming);if(voice.active&&['paused','cancelled'].includes(manager?.status))stopVoice('总管已暂停或停止，语音聊天已结束。');else checkVoiceReply();}
 async function earlier(){if(historyLoading||!messages.length)return;historyLoading=true;const records=$('dotsRecords'),height=records.scrollHeight,top=records.scrollTop;refreshContent();try{const batch=await api('/manager/messages?before='+messages[0].id+'&limit=100');mergeMessages(batch.messages||[]);hasMoreMessages=!!batch.hasMore;historyChecked=true;await persist();}finally{historyLoading=false;refreshContent();const updated=$('dotsRecords');if(updated)updated.scrollTop=top+updated.scrollHeight-height;}}
 function refresh(){const task=refreshChain.catch(()=>{}).then(async()=>{const observed=readState.observedThrough,data=await api('/manager');adopt(data);await reconcileUnreadGap(data,observed);if(active&&drawerOpen){const d=await api('/goals?limit=200');goals=d.goals||[];if(selected){const detail=await api('/goals/'+selected);details[String(selected)]=detail.goal;}}await persist();refreshContent();});refreshChain=task;return task;}
 function managerTime(message){
  if(message.role!=='user')return '';
  const value=Number(message.createdAt);if(!Number.isFinite(value)||value<=0)return '';
  const time=new Date(value>1e12?value:value*1000);if(!Number.isFinite(time.getTime()))return '';
  const now=new Date(),yesterday=new Date(now);yesterday.setDate(yesterday.getDate()-1);
  const sameDay=d=>time.getFullYear()===d.getFullYear()&&time.getMonth()===d.getMonth()&&time.getDate()===d.getDate();
  const prefix=sameDay(now)?'今天':sameDay(yesterday)?'昨天':(time.getFullYear()===now.getFullYear()?'':time.getFullYear()+'年')+(time.getMonth()+1)+'月'+time.getDate()+'日';
  const label=prefix+' '+time.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
  return '<div class="dots-message-time"><time datetime="'+esc(time.toISOString())+'">'+esc(label)+'</time></div>';
 }
 function renderMessages(){const records=$('dotsRecords');if(!records)return;records.innerHTML=(hasMoreMessages&&messages.length?'<button type="button" class="dots-history-more" data-dots-earlier'+(historyLoading?' disabled':'')+'>'+(historyLoading?'正在读取…':'查看更早消息')+'</button>':'')+(messages.length?messages.map(m=>managerTime(m)+'<article class="dots-manager-message '+(m.role==='user'?'is-user':'is-assistant')+'" data-dots-message="'+esc(m.id)+'">'+(m.role==='system'?'<header>状态</header>':'')+'<div class="message-body">'+markdown(m.content||'')+'</div>'+((m.attachments||[]).length?'<div class="dots-files">'+m.attachments.map(a=>fileChip(a)).join('')+'</div>':'')+'</article>').join(''):'');}
 function renderDrawer(){window.ShiYanDotsPanels?.render({manager,messages,tasks,goals,details,drawerOpen,selected,busy,uploading,loading:!monitorReady,notice:error,connection:$('dotsConnection')?.textContent||'',pendingMessage:!!pending.managerMessage});renderVoice();}
 function controlIcon(action){const path=action==='pause'?'M9 5v14M15 5v14':action==='resume'?'M7 4l13 8-13 8Z':'M6 6h12v12H6Z';return '<svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+path+'"/></svg>';}
 function renderToolbar(){
  const status=manager?.status==='paused'?'已暂停':manager?.status==='cancelled'?'已停止':Number(manager?.runningWorkers)>0?'正在处理 '+Number(manager.runningWorkers)+' 件事':'';
  $('dotsStatus').textContent=status;$('dotsStatus').hidden=!status;
  const menu=$('dotsMenuContent'),action=manager?.status==='active'?'pause':'resume',signature=action+':'+busy;
  if(menu.dataset.signature===signature)return;menu.dataset.signature=signature;
  menu.innerHTML='<button type="button" data-dots-rename>'+window.shiyan.sessionMenuIcon('rename')+'<span>重命名</span></button><button type="button" data-dots-manager-control="'+action+'"'+(busy?' disabled':'')+'>'+controlIcon(action)+'<span>'+(action==='pause'?'暂停':'继续')+'</span></button><button type="button" class="is-destructive" data-dots-manager-control="cancel"'+(busy?' disabled':'')+'>'+controlIcon('cancel')+'<span>停止全部任务</span></button><hr><button type="button" data-dots-refresh>'+C.icon('refresh')+'<span>刷新</span></button>';
 }
 function resizeComposer(){const input=$('dotsManagerInput'),button=$('dotsSendButton');if(!input||!button)return;input.style.height='auto';input.style.height=Math.min(160,Math.max(36,input.scrollHeight))+'px';const empty=!input.value.trim()&&!attachments().length&&!pending.managerMessage,isVoice=voice.active||(!busy&&empty);button.disabled=voice.active?false:busy||uploading;button.classList.toggle('is-empty',empty&&!isVoice);button.classList.toggle('is-voice',isVoice);button.classList.toggle('is-voice-active',voice.active);button.setAttribute('aria-label',voice.active?'结束语音聊天':isVoice?'语音实时聊天':busy?'发送中':pending.managerMessage?'重试发送':'发送');button.title=button.getAttribute('aria-label');button.innerHTML=isVoice?(voice.active?'<span class="dots-voice-stop" aria-hidden="true"></span>':voiceGlyph):pending.managerMessage&&!busy?C.icon('refresh'):'<span class="dots-send-icon" aria-hidden="true"></span>';}
   
   
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
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!e.repeat)submit().catch(showError);}
   };
   form.onsubmit=e=>{
    e.preventDefault();if(managerIMEBlocksSend())return;
    if(voice.active||(!input.value.trim()&&!attachments().length&&!pending.managerMessage))toggleVoice();
    else submit().catch(showError);
   };
  }
 function render(){if(!view)return;const frozen=!!pending.managerMessage;
  renderToolbar();
  $('dotsDetail').innerHTML='<div id="dotsRecords" class="dots-records"></div><form id="dotsManagerForm" class="dots-composer"><div class="dots-files">'+(frozen?pending.managerMessage.attachments||[]:attachments()).map(a=>fileChip(a,!frozen)).join('')+'</div><input id="dotsFileInput" type="file" multiple hidden><div class="dots-composer-surface"><button id="dotsAddFile" class="dots-add-file" type="button" aria-label="添加文件" title="添加文件"'+(frozen||busy||uploading?' disabled':'')+'><span aria-hidden="true">'+(uploading?'…':'+')+'</span></button><textarea id="dotsManagerInput" rows="1" maxlength="20000" aria-label="发送消息" placeholder="交给我…"'+(frozen?' readonly':'')+'>'+esc(frozen?pending.managerMessage.message:drafts.manager||'')+'</textarea><button id="dotsSendButton" class="send-button dots-send'+(busy?' is-busy':'')+'" type="submit"'+(busy?' disabled':'')+' aria-label="'+(frozen?'重试发送':'发送')+'"><span class="dots-send-icon" aria-hidden="true"></span></button></div>'+'</form>';
  renderMessages();renderDrawer();renderVoice();$('dotsAddFile').onclick=()=>$('dotsFileInput').click();$('dotsFileInput').onchange=e=>uploadFiles(Array.from(e.target.files||[])).catch(showError);view.querySelectorAll('[data-dots-remove-file]').forEach(button=>button.onclick=()=>{drafts.managerAttachments=attachments().filter(a=>a.id!==button.dataset.dotsRemoveFile);persist().catch(showError);view.__signature=null;refreshContent();});$('dotsManagerInput').oninput=e=>{if(voice.active)stopVoice();drafts.manager=e.target.value;resizeComposer();persist().catch(showError);};bindManagerComposer($('dotsManagerInput'),$('dotsManagerForm'));
 }
 function refreshContent(){renderUnread();if(!active)return;const records=$('dotsRecords'),scroll=records?.scrollTop||0,atBottom=!records||records.scrollHeight-scroll-records.clientHeight<60;const focused=document.activeElement?.id,start=document.activeElement?.selectionStart,end=document.activeElement?.selectionEnd;const sig=JSON.stringify([manager,messages,tasks,goals,details,drawerOpen,selected,busy,pending,hasMoreMessages,historyLoading,uploading,attachments()]);if(view.__signature===sig){markVisibleRepliesRead();return;}
    
    
   if(managerIME?.input===$('dotsManagerInput')&&(managerIME.composing||managerIME.ending||managerIME.confirmingEnter)){
    managerIME.deferred=true;renderToolbar();renderMessages();renderDrawer();
    const updated=$('dotsRecords');if(updated)updated.scrollTop=atBottom?updated.scrollHeight:scroll;markVisibleRepliesRead();return;
   }
   view.__signature=sig;render();const updated=$('dotsRecords');if(updated)updated.scrollTop=atBottom?updated.scrollHeight:scroll;if(focused&&$(focused)){$(focused).focus({preventScroll:true});if(typeof start==='number')$(focused).setSelectionRange(start,end);}markVisibleRepliesRead();}
 async function submit(){if(busy||uploading||managerIMEBlocksSend())return;const text=$('dotsManagerInput')?.value?.trim();if(!text&&!attachments().length&&!pending.managerMessage)return;const payload=request('managerMessage',{message:text||'请处理这些附件。',host:'shiyan_desktop',attachments:attachments().map(a=>({...a}))});let acceptedResponse=null;busy=true;showError('');refreshContent();try{await persist();const response=await api('/manager/messages','POST',{...payload,attachments:(payload.attachments||[]).map(a=>a.id)});if(response.accepted!==true)throw Error('总管未确认接收此消息');acceptedResponse=response;adopt(response);delete pending.managerMessage;if(drafts.manager?.trim()===payload.message||(!drafts.manager?.trim()&&payload.attachments?.length))delete drafts.manager;drafts.managerAttachments=attachments().filter(a=>!(payload.attachments||[]).some(sent=>sent.id===a.id));await persist();await refresh();return response;}catch(e){showError(e);return acceptedResponse;}finally{busy=false;refreshContent();}}
 async function managerControl(action){if(busy)return;if(voice.active)stopVoice();const slot='managerControl',payload=request(slot,{action});busy=true;try{await persist();adopt(await api('/manager/control','POST',payload));delete pending[slot];await persist();}finally{busy=false;refreshContent();}}
 async function taskControl(action){if(busy||!selected)return;const slot='taskControl:'+selected,payload=request(slot,{action});busy=true;try{await persist();await api('/goals/'+selected+'/control','POST',payload);delete pending[slot];await persist();await refresh();}finally{busy=false;refreshContent();}}
 async function decide(id,decision){if(busy||!selected)return;const a=details[String(selected)]?.approvals?.find(a=>String(a.id)===String(id));if(!a)return;const slot='approval:'+id,payload=request(slot,{decision,confirmedCommand:a.command});busy=true;try{await persist();await api('/goals/'+selected+'/approvals/'+id+'/decision','POST',payload);delete pending[slot];await persist();await refresh();}finally{busy=false;refreshContent();}}
 async function showOutput(id){const box=view.querySelector('[data-dots-output-body="'+CSS.escape(String(id))+'"]');if(!box)return;if(!box.hidden){box.hidden=true;return;}const data=await api('/outputs/'+id);let raw=data.output?.raw_result||data.output?.summary||'';if(typeof raw!=='string')raw=JSON.stringify(raw,null,2);let readable=raw;try{const parsed=JSON.parse(raw);readable=parsed.result||parsed.message||parsed.summary||JSON.stringify(parsed,null,2);}catch{}rawOutputs.set(String(id),raw);while(rawOutputs.size>20)rawOutputs.delete(rawOutputs.keys().next().value);const preview=raw.length>12000?raw.slice(0,8000)+'\n… 可复制完整结果 …\n'+raw.slice(-4000):raw;box.innerHTML='<div class="dots-result-readable">'+markdown(typeof readable==='string'?readable:JSON.stringify(readable,null,2))+'</div><details class="dots-raw-result"><summary>原始结果</summary><pre><code>'+esc(preview)+'</code></pre><button data-dots-copy-output="'+esc(id)+'">复制完整结果</button></details>';box.hidden=false;}
 function disconnect(){streamEpoch++;source?.close();source=null;clearTimeout(reconnectTimer);clearInterval(recoveryTimer);}
 function reconnect(){source?.close();source=null;setConnection('连接中断，正在重连');clearTimeout(reconnectTimer);const epoch=streamEpoch;reconnectTimer=setTimeout(()=>{if(monitorReady&&!document.hidden&&epoch===streamEpoch)connect();},Math.min(15000,1000*2**Math.min(4,reconnectAttempt++)));}
 function connect(){if(!monitorReady||document.hidden)return;const epoch=++streamEpoch;source?.close();source=new EventSource('/api/dots/events?after='+cursor);source.addEventListener('connected',()=>{if(epoch!==streamEpoch)return;reconnectAttempt=0;setConnection('已连接');});source.addEventListener('update',e=>{let event;try{event=JSON.parse(e.data);receiveVoiceActivity(event);}catch{reconnect();return;}const seq=Number(event.seq)||0;if(seq<=cursor)return;events=events.catch(()=>{}).then(async()=>{if(epoch!==streamEpoch||document.hidden||seq<=cursor)return;await refresh();if(epoch!==streamEpoch||document.hidden)return;const before=cursor;cursor=seq;try{await persist();}catch(e){cursor=before;throw e;}await api('/notifications/ack','POST',{cursor});}).catch(e=>{showError(e);if(epoch===streamEpoch)reconnect();});});source.addEventListener('connection-error',()=>{if(epoch===streamEpoch)reconnect();});source.onerror=()=>{if(epoch===streamEpoch)reconnect();};clearInterval(recoveryTimer);recoveryTimer=setInterval(()=>{if(monitorReady&&!document.hidden)refresh().catch(showError);},10000);}
 function activate(){active=window.shiyan.getView()==='dots';document.body.classList.toggle('dots-is-current-view',active);view.hidden=!active;$('dotsToolbar').hidden=!active;if(!active)$('dotsToolbar').querySelector('.dots-menu').open=false;$('openDotsButton').classList.toggle('is-selected',active);if(active){$('workspaceTitle').replaceChildren();$('railHome').classList.add('is-active');hydration.then(()=>{if(!active)return;refreshContent();if(!source)connect();refresh().catch(showError);}).catch(showError);}else {stopVoice();}renderUnread();C.scheduleNative();}
 function install(context){C=context;hydration=hydrate();hydration.catch(showError);const button=document.createElement('button');button.id='openDotsButton';button.type='button';button.className='sidebar-new-chat sidebar-dots';button.innerHTML=identityIcon()+'<span>'+esc(window.ShiYanDotsPanels?.name()||'Dots')+'</span>';button.title='Dots · 你的专属助手';button.setAttribute('aria-label','Dots 个人助手');button.onclick=()=>window.shiyan.navigate('dots');$('newConversationButton').after(button);$('agentSidebar')?.classList.add('has-dots-navigation');view=document.createElement('section');view.id='dotsView';view.className='dots-view dots-manager-view';view.hidden=true;view.setAttribute('aria-label','Dots 私人助手');view.innerHTML='<header id="dotsToolbar" class="dots-toolbar" hidden><span id="dotsStatus" class="dots-status" role="status" hidden></span><small id="dotsConnection" role="status" hidden></small><div class="dots-menu"><button type="button" data-dots-more class="wb-icon-button dots-icon-button" aria-label="更多" aria-expanded="false" title="更多">'+C.toolbarIcon('more')+'</button><div id="dotsMenuContent" class="dots-menu-content"></div></div><button id="dotsTasksButton" type="button" class="wb-icon-button dots-icon-button dots-tasks-button" data-dots-drawer aria-label="任务与活动" aria-expanded="false" title="任务与活动">'+C.toolbarIcon('tasks')+'</button><span class="dots-toolbar-divider" aria-hidden="true"></span></header><p id="dotsError" class="dots-error" role="alert" hidden></p><div class="dots-layout"><div id="dotsDetail" class="dots-detail"></div><aside id="dotsActivity" class="dots-activity" hidden></aside></div>';$('centerContent').appendChild(view);if($('toggleRightWorkspace'))$('toggleRightWorkspace').before($('dotsToolbar'));else if($('desktopToolbar'))$('desktopToolbar').appendChild($('dotsToolbar'));window.ShiYanDotsPanels.install({icon:C.icon,api,markdown,refresh,showError,snapshot:()=>({manager,messages,tasks,goals,details,drawerOpen,selected,busy}),request,persist,pending:()=>pending,releaseRequest:async slot=>{delete pending[slot];await persist();},closePanel:()=>{drawerOpen=false;renderDrawer();},nameChanged:()=>{const name=window.ShiYanDotsPanels.name();renderUnread();if(active)$('workspaceTitle').replaceChildren();},scheduleNative:C.scheduleNative,voiceUpdated:focus=>{renderVoice();if(focus?.isConnected)focus.focus({preventScroll:true});}});const dotsMenu=$('dotsToolbar').querySelector('.dots-menu');Object.defineProperty(dotsMenu,'open',{get(){return this.hasAttribute('open');},set(value){this.toggleAttribute('open',!!value);this.querySelector('[data-dots-more]').setAttribute('aria-expanded',String(!!value));}});const moreSummary=$('dotsToolbar').querySelector('[data-dots-more]');moreSummary.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const menu=moreSummary.parentElement;menu.open=!menu.open;moreSummary.setAttribute('aria-expanded',String(menu.open));C.scheduleNative?.();});const handleAction=async e=>{try{if(e.target.closest('.dots-menu-content button'))$('dotsToolbar').querySelector('.dots-menu').removeAttribute('open');const task=e.target.closest('[data-dots-task]'),mc=e.target.closest('[data-dots-manager-control]'),tc=e.target.closest('[data-dots-task-control]'),decision=e.target.closest('[data-dots-decision]');if(e.target.closest('[data-dots-earlier]'))await earlier();else if(e.target.closest('[data-dots-rename]')){window.ShiYanDotsPanels.openProfile();}else if(e.target.closest('[data-dots-drawer]')){drawerOpen=!drawerOpen;renderDrawer();C.scheduleNative?.();if(drawerOpen)refresh().catch(showError);}else if(e.target.closest('[data-dots-refresh]')){showError('');await refresh();if(!source)connect();}else if(task){selected=Number(task.dataset.dotsTask);const d=await api('/goals/'+selected);details[String(selected)]=d.goal;await persist();refreshContent();}else if(mc)await managerControl(mc.dataset.dotsManagerControl);else if(tc)await taskControl(tc.dataset.dotsTaskControl);else if(decision)await decide(decision.closest('[data-dots-approval]').dataset.dotsApproval,decision.dataset.dotsDecision);else if(e.target.closest('[data-dots-output]'))await showOutput(e.target.closest('[data-dots-output]').dataset.dotsOutput);else if(e.target.closest('[data-dots-copy-output]'))await window.shiyan.copyText(rawOutputs.get(e.target.closest('[data-dots-copy-output]').dataset.dotsCopyOutput)||'');}catch(e){showError(e);}};view.addEventListener('click',handleAction);$('dotsToolbar').addEventListener('click',handleAction);document.addEventListener('click',e=>{if(!e.target.closest('.dots-menu'))$('dotsToolbar').querySelector('.dots-menu')?.removeAttribute('open');});document.addEventListener('keydown',e=>{if(active&&e.key==='Escape'){const menu=$('dotsToolbar').querySelector('.dots-menu');if(menu?.open){menu.open=false;menu.querySelector('[data-dots-more]').focus();e.preventDefault();}}});window.addEventListener('shiyan-view',activate);window.addEventListener('shiyan-state',()=>{if(active)queueMicrotask(()=>{$('workspaceTitle').replaceChildren();$('railHome').classList.add('is-active');});});document.addEventListener('visibilitychange',()=>{if(document.hidden){stopVoice();disconnect();}else if(monitorReady){connect();refresh().catch(showError);}});window.addEventListener('pagehide',()=>{stopVoice();disconnect();persist().catch(()=>{});});window.addEventListener('online',()=>{if(monitorReady){connect();refresh().catch(showError);}});view.addEventListener('scroll',e=>{if(e.target.id==='dotsRecords')markVisibleRepliesRead();},true);hydration.then(()=>{monitorReady=true;renderUnread();connect();refresh().catch(showError);}).catch(showError);}
 window.addEventListener('focus',markVisibleRepliesRead);
 window.addEventListener('resize',positionCompactVoiceCard);
 window.addEventListener('shiyan-native',event=>receiveVoiceEvent(event.detail||{}));
 window.ShiYanDots={install};
})();
