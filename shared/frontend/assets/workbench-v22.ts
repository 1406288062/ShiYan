 
(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const dark=matchMedia('(prefers-color-scheme: dark)');
 const terminalTheme=()=>dark.matches?{background:'#202124',foreground:'#e4e5e9',cursor:'#e4e5e9',selectionBackground:'#3e536e'}:{background:'#ffffff',foreground:'#242426',cursor:'#333333',selectionBackground:'#dce9fa'};
 let installed=false;
 function adaptTabs(C,bottomIds=[]){
  const strip=$('workspaceTabs');if(!strip)return;
  let pinned=$('v22FirstTab');if(!pinned){pinned=document.createElement('div');pinned.id='v22FirstTab';strip.before(pinned);pinned.onclick=e=>{const close=e.target.closest('[data-close-tab]'),tab=e.target.closest('[data-tab]');if(close)C.closeTab(close.dataset.closeTab);else if(tab)C.selectTab(tab.dataset.tab);};pinned.onkeydown=e=>{if(['Enter',' '].includes(e.key)){const tab=e.target.closest('[data-tab]');if(tab){e.preventDefault();C.selectTab(tab.dataset.tab);}}};}
  const firstId=C.tabs.find(t=>!bottomIds.includes(t.id))?.id;const first=firstId&&(strip.querySelector('[data-tab="'+firstId+'"]')||pinned.querySelector('[data-tab="'+firstId+'"]'));if(first)pinned.replaceChildren(first);else pinned.replaceChildren();
  const visible=C.tabs.filter(t=>!bottomIds.includes(t.id)),available=$('rightWorkspace').clientWidth-150;
  const width=Math.max(78,Math.min(178,available/Math.max(1,visible.length)));
  for(const el of [...pinned.children,...strip.children])if(!el.hidden)el.style.setProperty('--v22-tab-width',width+'px');
  pinned.hidden=!visible.length;strip.style.flexBasis=Math.max(0,width*(visible.length-1))+'px';
 }
 function install(C){
  if(installed)return;installed=true;document.body.classList.add('workbench-v22');
  const toast=e=>window.shiyan.toast(e?.message||String(e));
   
  for(const summary of document.querySelectorAll('.sidebar-group>summary')){const disclosure=summary.querySelector(':scope>.wb-icon');if(disclosure)summary.querySelector(':scope>span')?.after(disclosure);}
  const groups=$('projectsGroup').querySelector('summary>span');groups.textContent='项目';
   
  const overlay=$('comparePreview'),oldZoom=overlay.querySelector('.v2-compare-zoom'),upperZoom=document.createElement('div');upperZoom.className='v2-compare-zoom';while(oldZoom.firstChild)upperZoom.appendChild(oldZoom.firstChild);overlay.querySelector('header').appendChild(upperZoom);oldZoom.remove();
   
  const noticePosition=()=>{const r=$('mainWorkspace').getBoundingClientRect();document.body.style.setProperty('--v23-notice-center',(r.width?r.x+r.width/2:innerWidth/2)+'px');};new ResizeObserver(noticePosition).observe($('mainWorkspace'));window.addEventListener('resize',noticePosition);window.addEventListener('shiyan-state',noticePosition);noticePosition();
   
  const elapsedClocks=new Map();
  const updateTimes=()=>{for(const el of document.querySelectorAll('.v22-elapsed')){const start=Date.parse(el.dataset.start),id=el.dataset.messageId||el.dataset.start,end=el.dataset.end?Date.parse(el.dataset.end):NaN;if(!Number.isFinite(start))continue;let clock=elapsedClocks.get(id);if(!clock){const initial=Number.isFinite(end)?Math.max(0,(end-start)/1000):Math.max(0,(Date.now()-start)/1000);clock={origin:performance.now()-initial*1000,max:initial,frozen:Number.isFinite(end)};elapsedClocks.set(id,clock);}if(!clock.frozen){const measured=Math.max(0,(performance.now()-clock.origin)/1000);clock.max=Math.max(clock.max,measured);if(Number.isFinite(end)){clock.max=Math.max(clock.max,Math.max(0,(end-start)/1000));clock.frozen=true;}}const seconds=clock.max;const number=(value,kind)=>'<span class="v22-elapsed-number v22-elapsed-'+kind+'">'+value+'</span>',unit=value=>'<span class="v22-elapsed-unit">'+value+'</span>';const label=(Number.isFinite(end)?'已处理 ':'已等待 ')+(seconds<60?number(seconds.toFixed(1),'decimal')+' '+unit('秒'):number(Math.floor(seconds/60),'minutes')+' '+unit('分')+' '+number(Math.floor(seconds%60),'seconds')+' '+unit('秒')),span=el.querySelector('span');if(span.innerHTML!==label)span.innerHTML=label;}};
  setInterval(updateTimes,250);window.addEventListener('shiyan-state',updateTimes);
  function updateTheme(){document.body.dataset.theme=dark.matches?'dark':'light';for(const session of C.sessions.values())session.term.options.theme=terminalTheme();}
  dark.addEventListener('change',updateTheme);window.addEventListener('shiyan-terminal',updateTheme);updateTheme();
  window.addEventListener('resize',()=>adaptTabs(C,C.prefs.bottomTerminalIds));
   
  let temporaryId=null,temporaryDrafts=new Map(),temporaryAssets=new Map(),temporaryUploading=new Set(),temporarySubmitting=new Set();
  const temp=document.createElement('section');temp.id='v22TemporaryPane';temp.className='v22-temporary-pane';temp.hidden=true;
  temp.innerHTML='<div class="v22-temporary-scroller"><div class="v22-temporary-empty"><div aria-hidden="true">'+C.icon('sideChat')+'</div><h2>侧边聊天</h2><p>侧边聊天是临时聊天，关闭应用后会消失。</p></div><div class="v22-temporary-messages messages" role="log" aria-label="侧边聊天消息"></div></div><form class="composer-form" autocomplete="off"><div class="v22-temporary-composer composer-surface glass-surface"><div class="attachment-list" aria-label="待发送附件" hidden></div><textarea class="message-input" aria-label="侧边聊天消息" placeholder="发送消息" rows="2"></textarea><div class="composer-actions"><input type="file" data-temporary-file-input multiple hidden><button type="button" class="icon-button add-image-button" data-temporary-add aria-label="添加文件"><span class="symbol" data-symbol="plus" aria-hidden="true"></span></button><span class="composer-spacer"></span><button type="submit" class="send-button" aria-label="发送"></button></div></div><p role="status" hidden></p></form>';
  temp.querySelector('[data-temporary-add]').innerHTML=$('addImageButton').innerHTML;
  window.ShiYanV22.renderTemporaryPane=(tab,pane)=>{const changed=temporaryId!==tab.conversationId;temporaryId=tab.conversationId;if(changed){temp.querySelector('textarea').value=temporaryDrafts.get(temporaryId)||'';temp.querySelector('form p').hidden=true;}pane.classList.add('v22-temporary-host');pane.appendChild(temp);temp.hidden=false;renderTemporary();};
  const sendMarkup=(()=>{const element=$('sendButton').cloneNode(true);element.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'));return element.innerHTML;})();
  const stopMarkup=sendMarkup;
  const messageCache=new Map();
  function temporaryMessageHTML(m){
   const signature=JSON.stringify(m),cached=messageCache.get(m.id);if(cached?.signature===signature)return cached.html;
   const template=document.createElement('template');template.innerHTML=window.shiyan.renderMessage(m);
   template.content.querySelectorAll('[data-edit-message],[data-retry-message]').forEach(b=>b.remove());
   const html=template.innerHTML;messageCache.set(m.id,{signature,html});return html;
  }
  const temporaryChats=()=>window.shiyan.getState()?.temporaryConversations||[];
  function renderTemporaryComposer(c){
   if(!c)return;
   const input=temp.querySelector('textarea');if(document.activeElement!==input)input.value=temporaryDrafts.get(c.id)||'';
   const selected=temporaryAssets.get(c.id)||[],uploading=temporaryUploading.has(c.id)||temporarySubmitting.has(c.id),empty=!input.value.trim()&&!selected.length;
   const attachmentList=temp.querySelector('.attachment-list'),attachmentHTML=selected.map(window.shiyan.renderAttachment).join('');
   if(attachmentList.innerHTML!==attachmentHTML)attachmentList.innerHTML=attachmentHTML;attachmentList.hidden=!selected.length;
   temp.querySelector('[data-temporary-add]').disabled=uploading;
   temp.querySelector('[data-temporary-add]').setAttribute('aria-label',uploading?'正在上传附件':'添加文件');
   const send=temp.querySelector('[type=submit]');const markup=c.isBusy?stopMarkup:sendMarkup;if(send.__markup!==markup){send.innerHTML=markup;send.__markup=markup;}send.setAttribute('aria-label',c.isBusy?'停止':'发送');send.classList.toggle('is-busy',!!c.isBusy);send.classList.toggle('is-empty',!c.isBusy&&(empty||uploading));send.disabled=!c.isBusy&&(empty||uploading);input.disabled=temporarySubmitting.has(c.id);
  }
  const renderTemporary=()=>{
   const chats=temporaryChats();if(temporaryId&&!chats.some(c=>c.id===temporaryId)){temporaryId=null;temp.hidden=true;C.scheduleNative();}
   const c=chats.find(c=>c.id===temporaryId);if(!c)return;
   temp.querySelector('.v22-temporary-empty').hidden=c.messages.length>0;
   temp.querySelector('.v22-temporary-scroller').classList.toggle('is-empty',!c.messages.length);
   const messages=temp.querySelector('.v22-temporary-messages'),html=c.messages.map(temporaryMessageHTML).join('');
   const retained=new Set(chats.flatMap(chat=>chat.messages.map(m=>m.id)));for(const id of messageCache.keys())if(!retained.has(id))messageCache.delete(id);
   if(messages.innerHTML!==html){const scroller=temp.querySelector('.v22-temporary-scroller'),atBottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80;messages.innerHTML=html;if(atBottom)scroller.scrollTop=scroller.scrollHeight;}
   renderTemporaryComposer(c);

  };
  async function openTemporary(forceNew=false){
   let c=!forceNew&&temporaryChats().find(c=>c.id===temporaryId);if(!c&&!forceNew)c=temporaryChats()[0];
   if(!c){const data=await C.api('/temporary-chats','POST',{});c=data.conversation;window.dispatchEvent(new CustomEvent('shiyan-temporary',{detail:data.state}));await window.shiyan.api('/api/state');}
   temporaryId=c.id;let tab=C.tabs.find(t=>t.type==='temporary'&&t.conversationId===c.id);if(tab)C.selectTab(tab.id);else tab=C.openTab({type:'temporary',title:'侧边聊天',conversationId:c.id});if(!tab)return;renderTemporary();temp.querySelector('textarea').focus();
  }
  window.ShiYanV22.openTemporary=()=>openTemporary().catch(toast);
  for(const grid of document.querySelectorAll('.browser-tool-grid:not(:has([data-workspace-temporary]))')){const add=document.createElement('button');add.type='button';add.setAttribute('data-workspace-temporary','');add.innerHTML=C.icon('sideChat')+'<span>临时聊天</span>';grid.appendChild(add);}
  $('rightContent').addEventListener('click',e=>{if(e.target.closest('[data-workspace-temporary]'))openTemporary().catch(toast);});
  temp.querySelector('[data-temporary-add]').onclick=()=>temp.querySelector('[data-temporary-file-input]').click();
  temp.querySelector('[data-temporary-file-input]').onchange=async event=>{
   const id=temporaryId,files=[...event.target.files];event.target.value='';if(!id||!files.length||temporaryUploading.has(id))return;
   const error=temp.querySelector('form p');error.hidden=true;temporaryUploading.add(id);renderTemporary();
   try{const selected=temporaryAssets.get(id)||[],uploaded=await window.shiyan.uploadAttachments(files,selected);if(temporaryChats().some(c=>c.id===id))temporaryAssets.set(id,[...(temporaryAssets.get(id)||[]),...uploaded]);}
   catch(err){if(temporaryId===id){error.textContent=err.message;error.hidden=false;}else toast(err);}
   finally{temporaryUploading.delete(id);renderTemporary();}
  };
  temp.querySelector('textarea').oninput=e=>{if(temporaryId)temporaryDrafts.set(temporaryId,e.target.value);temp.querySelector('form').classList.toggle('is-expanded',!!e.target.value);renderTemporaryComposer(temporaryChats().find(c=>c.id===temporaryId));};
  temp.querySelector('textarea').onkeydown=e=>{if(e.key!=='Enter'||e.isComposing)return;if(e.ctrlKey){e.preventDefault();const input=e.currentTarget,start=input.selectionStart,end=input.selectionEnd;input.setRangeText('\n',start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));return;}e.preventDefault();temp.querySelector('form').requestSubmit();};
  temp.onclick=e=>{const remove=e.target.closest('[data-remove-attachment]');if(remove){e.stopPropagation();temporaryAssets.set(temporaryId,(temporaryAssets.get(temporaryId)||[]).filter(a=>a.id!==remove.dataset.removeAttachment));renderTemporary();return;}const copy=e.target.closest('[data-copy-message]');if(copy){const m=temporaryChats().find(c=>c.id===temporaryId)?.messages.find(m=>m.id===copy.dataset.copyMessage);if(m)window.shiyan.copyText(m.text||'');return;}};
  temp.querySelector('form').onsubmit=async e=>{e.preventDefault();const c=temporaryChats().find(c=>c.id===temporaryId);if(!c||temporarySubmitting.has(c.id))return;const input=temp.querySelector('textarea'),button=temp.querySelector('[type=submit]'),error=temp.querySelector('form p');button.disabled=true;error.hidden=true;try{if(c.isBusy)await window.shiyan.api('/api/conversations/'+encodeURIComponent(c.id)+'/stop','POST',{});else{const text=input.value,selected=temporaryAssets.get(c.id)||[];if(temporaryUploading.has(c.id)||(!text.trim()&&!selected.length))return;temporarySubmitting.add(c.id);renderTemporary();await C.api('/temporary-chats/'+c.id+'/send','POST',{text,assetIds:selected.map(a=>a.id)});temporaryDrafts.set(c.id,'');temporaryAssets.delete(c.id);if(temporaryId===c.id)input.value='';await window.shiyan.api('/api/state');}renderTemporary();}catch(err){error.textContent=err.message;error.hidden=false;}finally{temporarySubmitting.delete(c.id);renderTemporary();}};
  window.addEventListener('shiyan-state',renderTemporary);setInterval(renderTemporary,15000);
  window.ShiYanChanges.install(C);
  window.ShiYanExecution.install(C);
  window.ShiYanDots.install(C);
  window.__SHIYAN_DOTS_INSTALLED__=true;
  window.dispatchEvent(new Event('shiyan-dots-installed'));
  window.ShiYanV22.showChanges=async reference=>{try{const data=(await C.api('/files/changes','POST',reference)).changes;window.ShiYanChanges.openFiles([{...data,path:reference.path||data.name}]);}catch(e){toast(e);}};
   
  const bar=document.createElement('div');bar.id='v22SelectionBar';bar.className='v22-selection-bar';bar.hidden=true;bar.innerHTML='<button type="button" data-selection-add>添加到对话</button><button type="button" data-selection-edit>编辑</button>';$('app').appendChild(bar);
  let selected=null;
  function updateSelection(){
   if(!$('v22TextEditor').hidden)return;
   const selection=getSelection();if(!selection?.rangeCount||selection.isCollapsed){bar.hidden=true;return;}
   const range=selection.getRangeAt(0),node=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
   const message=node.closest('#messages .message-body'),preview=node.closest('.v2-file-preview');
   if(!message&&!preview?.__shiyanFile){bar.hidden=true;return;}
   const text=selection.toString();if(!text.trim()){bar.hidden=true;return;}
   bar.querySelector('[data-selection-add]').disabled=!!preview?.__shiyanFile?.file.sensitive;
   selected={text,messageId:message?.closest('[data-message-id]').dataset.messageId,file:preview?.__shiyanFile};
   const rect=range.getBoundingClientRect();bar.hidden=false;bar.style.left=Math.max(8,Math.min(innerWidth-bar.offsetWidth-8,rect.x+rect.width/2-bar.offsetWidth/2))+'px';bar.style.top=Math.max(8,rect.top-bar.offsetHeight-8)+'px';
  }
  const editor=document.createElement('div');editor.id='v22TextEditor';editor.className='v22-text-editor';editor.hidden=true;
  editor.innerHTML='<form><header><h2></h2><button type="button" data-editor-cancel aria-label="取消编辑">'+C.icon('close')+'</button></header><p class="v22-edit-description"></p><textarea aria-label="编辑文本" spellcheck="false"></textarea><p class="v22-edit-error" role="status" hidden></p><footer><button type="button" data-editor-cancel>取消</button><button type="submit"></button></footer></form>';$('app').appendChild(editor);
  let editTarget=null;
  const closeEditor=()=>{editor.hidden=true;editTarget=null;C.scheduleNative();};for(const b of editor.querySelectorAll('[data-editor-cancel]'))b.onclick=closeEditor;
  document.addEventListener('selectionchange',()=>setTimeout(updateSelection,0));document.addEventListener('pointerup',()=>setTimeout(updateSelection,0));bar.onpointerdown=e=>e.preventDefault();
  bar.querySelector('[data-selection-add]').onclick=async()=>{const text=selected?.text;if(!text)return;bar.hidden=true;getSelection().removeAllRanges();await window.shiyan.addContext(text);};
  bar.querySelector('[data-selection-edit]').onclick=()=>{
   const target=selected;if(!target)return;bar.hidden=true;getSelection().removeAllRanges();
   const message=window.shiyan.getState().conversations.find(c=>c.id===window.shiyan.getState().selectedConversationId)?.messages.find(m=>m.id===target.messageId);
   if(message?.role==='user'){window.shiyan.editMessage(message.id);return;}
   editTarget=target;editor.hidden=false;editor.querySelector('h2').textContent=target.file?'编辑 '+target.file.file.name:'编辑为新草稿';
   editor.querySelector('.v22-edit-description').textContent=target.file?'保存将写入原文件，并保留修改前的备份。':'编辑后的文字加入输入框，由你发送。原回复保留。';
   const input=editor.querySelector('textarea');input.value=target.file?target.file.file.text:target.text;editor.querySelector('[type=submit]').textContent=target.file?'保存到原文件':'添加到对话';editor.querySelector('.v22-edit-error').hidden=true;input.focus();if(target.file){const at=input.value.indexOf(target.text);if(at>=0)input.setSelectionRange(at,at+target.text.length);}C.scheduleNative();
  };
  editor.querySelector('form').onsubmit=async e=>{e.preventDefault();const target=editTarget;if(!target)return;const button=editor.querySelector('[type=submit]'),text=editor.querySelector('textarea').value;button.disabled=true;try{if(target.file){await C.api('/files/save-text','POST',{...target.file.reference,contentHash:target.file.file.contentHash,text,confirmed:true});await target.file.reload();window.shiyan.toast('已保存，原文件备份已保留');}else await window.shiyan.addContext(text);closeEditor();}catch(err){const error=editor.querySelector('.v22-edit-error');error.textContent=err.message;error.hidden=false;}finally{button.disabled=false;}};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){bar.hidden=true;if(!editor.hidden){e.preventDefault();closeEditor();}}},true);
  document.querySelector('#rightContent').addEventListener('scroll',()=>{bar.hidden=true;},true);$('messagesScroller').addEventListener('scroll',()=>{bar.hidden=true;});
 }
 window.ShiYanV22={install,adaptTabs,terminalTheme};
})();
