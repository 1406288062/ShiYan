 
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
   
  const area=$('compareWorkbench'),status=$('compareStatus'),zoom=area.querySelector('.v2-compare-zoom');
  const line=document.createElement('div');line.className='v22-compare-info';line.append(status,zoom);area.querySelector('.v2-enhance-toolbar').append(line);
  const overlay=$('comparePreview'),oldZoom=overlay.querySelector('.v2-compare-zoom'),upperZoom=document.createElement('div');upperZoom.className='v2-compare-zoom';while(oldZoom.firstChild)upperZoom.appendChild(oldZoom.firstChild);overlay.querySelector('header').appendChild(upperZoom);oldZoom.remove();
   
  const noticePosition=()=>{const r=$('mainWorkspace').getBoundingClientRect();document.body.style.setProperty('--v23-notice-center',(r.width?r.x+r.width/2:innerWidth/2)+'px');};new ResizeObserver(noticePosition).observe($('mainWorkspace'));window.addEventListener('resize',noticePosition);window.addEventListener('shiyan-state',noticePosition);noticePosition();
   
  const updateTimes=()=>{for(const el of document.querySelectorAll('.v22-elapsed')){const start=Date.parse(el.dataset.start),end=el.dataset.end?Date.parse(el.dataset.end):Date.now();if(!Number.isFinite(start)||!Number.isFinite(end))continue;const seconds=Math.max(0,(end-start)/1000);el.querySelector('span').textContent=(el.dataset.end?'已处理 ':'已等待 ')+(seconds<60?seconds.toFixed(1)+' 秒':Math.floor(seconds/60)+' 分 '+Math.floor(seconds%60)+' 秒');}};
  setInterval(updateTimes,250);window.addEventListener('shiyan-state',updateTimes);
  function updateTheme(){document.body.dataset.theme=dark.matches?'dark':'light';for(const session of C.sessions.values())session.term.options.theme=terminalTheme();}
  dark.addEventListener('change',updateTheme);window.addEventListener('shiyan-terminal',updateTheme);updateTheme();
  window.addEventListener('resize',()=>adaptTabs(C,C.prefs.bottomTerminalIds));
   
  let temporaryId=null,temporaryDrafts=new Map();
  const temp=document.createElement('section');temp.id='v22TemporaryPane';temp.className='v22-temporary-pane';temp.hidden=true;
  temp.innerHTML='<header><strong>临时聊天</strong><span>最后发送后 1 小时过期</span><button type="button" data-hide-temporary aria-label="收起临时聊天">'+C.icon('down')+'</button></header><div class="v22-temporary-list"></div><div class="v22-temporary-messages"></div><form><textarea aria-label="临时聊天消息" placeholder="发送临时消息…" rows="2"></textarea><p role="status" hidden></p><button type="submit">发送</button></form>';
  $('rightWorkspace').appendChild(temp);
  const temporaryChats=()=>window.shiyan.getState()?.temporaryConversations||[];
  const renderTemporary=()=>{
   const chats=temporaryChats();if(temporaryId&&!chats.some(c=>c.id===temporaryId)){temporaryId=null;temp.hidden=true;C.scheduleNative();}
   const c=chats.find(c=>c.id===temporaryId);if(!c)return;
   temp.querySelector('.v22-temporary-list').innerHTML=chats.map(t=>'<button type="button" data-temporary-id="'+esc(t.id)+'" class="'+(t.id===c.id?'selected':'')+'">'+esc(t.title==='临时聊天'?t.messages.find(m=>m.role==='user')?.text?.slice(0,12)||'新临时聊天':t.title)+'</button>').join('')+'<button type="button" data-new-temporary aria-label="新建临时聊天">＋</button>';
   const messages=temp.querySelector('.v22-temporary-messages'),html=c.messages.map(m=>'<article class="'+(m.role==='user'?'is-user':'is-assistant')+'">'+esc(m.text||m.error||m.phase||'').replace(/\n/g,'<br>')+'</article>').join('');
   if(messages.innerHTML!==html){const atBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;messages.innerHTML=html;if(atBottom)messages.scrollTop=messages.scrollHeight;}
   const input=temp.querySelector('textarea');if(document.activeElement!==input)input.value=temporaryDrafts.get(c.id)||'';
   temp.querySelector('[type=submit]').textContent=c.isBusy?'停止':'发送';input.disabled=false;
  };
  async function openTemporary(forceNew=false){
   let c=!forceNew&&temporaryChats().find(c=>c.id===temporaryId);if(!c&&!forceNew)c=temporaryChats()[0];
   if(!c){const data=await C.api('/temporary-chats','POST',{});c=data.conversation;window.dispatchEvent(new CustomEvent('shiyan-temporary',{detail:data.state}));await window.shiyan.api('/api/state');}
   temporaryId=c.id;temp.hidden=false;C.prefs.rightOpen=true;C.scheduleNative();$('toggleRightWorkspace').getAttribute('aria-expanded')==='false'&&$('toggleRightWorkspace').click();renderTemporary();temp.querySelector('textarea').focus();
  }
  window.ShiYanV22.openTemporary=()=>openTemporary().catch(toast);
  for(const grid of document.querySelectorAll('.browser-tool-grid:not(:has([data-workspace-temporary]))')){const add=document.createElement('button');add.type='button';add.setAttribute('data-workspace-temporary','');add.innerHTML=C.icon('newChat')+'<span>临时聊天</span>';grid.appendChild(add);}
  $('rightContent').addEventListener('click',e=>{if(e.target.closest('[data-workspace-temporary]'))openTemporary().catch(toast);});
  temp.querySelector('[data-hide-temporary]').onclick=()=>{temp.hidden=true;C.scheduleNative();};
  temp.querySelector('textarea').oninput=e=>{if(temporaryId)temporaryDrafts.set(temporaryId,e.target.value);};
  temp.onclick=e=>{const tab=e.target.closest('[data-temporary-id]');if(tab){temporaryId=tab.dataset.temporaryId;renderTemporary();}else if(e.target.closest('[data-new-temporary]'))openTemporary(true).catch(toast);};
  temp.querySelector('form').onsubmit=async e=>{e.preventDefault();const c=temporaryChats().find(c=>c.id===temporaryId);if(!c)return;const input=temp.querySelector('textarea'),button=temp.querySelector('[type=submit]'),error=temp.querySelector('form p');button.disabled=true;error.hidden=true;try{if(c.isBusy)await window.shiyan.api('/api/conversations/'+encodeURIComponent(c.id)+'/stop','POST',{});else{const text=input.value;if(!text.trim())return;await C.api('/temporary-chats/'+c.id+'/send','POST',{text});temporaryDrafts.set(c.id,'');input.value='';await window.shiyan.api('/api/state');}renderTemporary();}catch(err){error.textContent=err.message;error.hidden=false;}finally{button.disabled=false;}};
  window.addEventListener('shiyan-state',renderTemporary);setInterval(renderTemporary,15000);
  window.ShiYanChanges.install(C);
  window.ShiYanExecution.install(C);
  window.ShiYanDots.install(C);
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
