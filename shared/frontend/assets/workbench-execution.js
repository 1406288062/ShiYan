 
(() => {
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const working=new Set(['submitting','queued','running','reconnecting']);
 let C,lastConversation='',previous=new Map();
 const state=()=>window.shiyan?.getState();
 const conversation=id=>state()?.conversations?.find(c=>c.id===id)||((window.ShiYanSchedules?.currentConversation?.()?.id===id)?window.ShiYanSchedules.currentConversation():null);
 const records=c=>(c?.messages||[]).filter(m=>m.role==='assistant'&&window.ShiYanOutput?.itemsFor(m).length);
 // 这一轮回复对应的用户消息（紧挨在它前面的那条）。
 const promptFor=(c,m)=>{const list=c?.messages||[],at=list.findIndex(x=>x.id===m?.id);for(let i=at-1;i>=0;i--)if(list[i].role==='user')return list[i];return null;};
 function renderPane(tab,pane) {
  if(!pane)return;
  const c=conversation(tab.conversationId),rounds=records(c);
  const compact=rounds.find(m=>m.id===tab.messageId)||rounds.at(-1);
  const refresh=()=>{pane.__executionSignature=null;renderPane(tab,pane);};
  const live=working.has(compact?.state);
  const m=live?compact:window.ShiYanMessageDetails.resolve(compact,tab.conversationId,refresh,pane);
  if(m?.detailsDeferred){window.ShiYanMessageDetails.placeholder(m,pane,refresh);return;}
  if(m)tab.messageId=m.id;
  const prompt=promptFor(c,m);
  const signature=JSON.stringify([c?.title,rounds.map(m=>[m.id,m.completedAt]),m,prompt?.id]);
  if(pane.__executionSignature===signature)return;pane.__executionSignature=signature;
  pane.classList.add('execution-pane');
  const index=rounds.findIndex(r=>r.id===m?.id);
  pane.innerHTML='<header class="execution-toolbar"><strong>执行过程</strong><div class="execution-round-picker"><button type="button" data-execution-round aria-label="选择执行轮次" aria-haspopup="listbox" aria-expanded="false"'+(rounds.length?'':' disabled')+'>'+(rounds.length?'第 '+(index+1)+' 轮'+(live?' · 进行中':''):'暂无轮次')+'<span aria-hidden="true">⌄</span></button><div class="execution-round-menu" role="listbox" aria-label="执行轮次" hidden>'+rounds.map((r,i)=>'<button type="button" role="option" aria-selected="'+(r.id===m?.id)+'" data-round-id="'+esc(r.id)+'"><span class="execution-round-check" aria-hidden="true">'+(r.id===m?.id?'✓':'')+'</span>第 '+(i+1)+' 轮</button>').join('')+'</div></div></header><div class="execution-scroll"><p class="execution-conversation">'+esc(c?.title||'当前会话')+'</p>'+(prompt&&(prompt.text||'').trim()?'<blockquote class="execution-prompt">'+esc(String(prompt.text).slice(0,2000))+'</blockquote>':'')+(m?window.ShiYanOutput.details(m,true):'<p class="wb-empty">这条会话暂无已完成的执行记录。</p>')+'</div>';
  const trigger=pane.querySelector('[data-execution-round]'),menu=pane.querySelector('.execution-round-menu');
  const close=focus=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus();};
  const open=()=>{menu.hidden=false;trigger.setAttribute('aria-expanded','true');menu.style.maxHeight=Math.max(60,Math.min(310,innerHeight-trigger.getBoundingClientRect().bottom-14))+'px';const chosen=menu.querySelector('[aria-selected="true"]')||menu.firstElementChild;chosen?.focus({preventScroll:true});chosen?.scrollIntoView({block:'nearest'});};
  trigger.onclick=()=>menu.hidden?open():close(false);
  trigger.onkeydown=e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();open();}};
  menu.onclick=e=>{const option=e.target.closest('[data-round-id]');if(!option)return;tab.messageId=option.dataset.roundId;C.persist();renderPane(tab,pane);pane.querySelector('[data-execution-round]')?.focus();};
  menu.onkeydown=e=>{const options=[...menu.children],at=options.indexOf(document.activeElement);let next;if(e.key==='Escape'){e.preventDefault();close(true);return;}if(e.key==='Tab'){close(false);return;}if(e.key==='ArrowDown')next=Math.min(options.length-1,at+1);if(e.key==='ArrowUp')next=Math.max(0,at-1);if(e.key==='Home')next=0;if(e.key==='End')next=options.length-1;if(e.key==='PageDown')next=Math.min(options.length-1,at+10);if(e.key==='PageUp')next=Math.max(0,at-10);if(next!==undefined){e.preventDefault();options[next]?.focus();}};

 }
 function openMessage(id) {
  if(!C)return;
  const c=state()?.conversations?.find(c=>(c.messages||[]).some(m=>m.id===id))||(window.ShiYanSchedules?.message?.(id)?window.ShiYanSchedules.currentConversation():null);
  if(!c)return;
  let tab=C.tabs.find(t=>t.type==='execution');
  if(tab){Object.assign(tab,{conversationId:c.id,messageId:id});renderPane(tab,C.panes.get(tab.id));C.selectTab(tab.id);C.persist();}
  else tab=C.openTab({type:'execution',title:'执行过程',conversationId:c.id,messageId:id});
  return tab;
 }
 function openLatest() {
  const c=state()?.conversations?.find(c=>c.id===state()?.selectedConversationId),m=records(c).at(-1);
  if(m)return openMessage(m.id);
  if(C)C.openTab({type:'execution',title:'执行过程',conversationId:c?.id},true);
 }
 function update() {
  if(!C)return;
  const c=state()?.conversations?.find(c=>c.id===state()?.selectedConversationId);
  for(const tab of C.tabs)if(tab.type==='execution')renderPane(tab,C.panes.get(tab.id));
  lastConversation=c?.id||'';previous=new Map((c?.messages||[]).map(m=>[m.id,m.state]));
 }
 function install(context) {
  C=context;document.addEventListener('pointerdown',e=>{for(const menu of document.querySelectorAll('.execution-round-menu:not([hidden])'))if(!menu.parentElement.contains(e.target)){menu.hidden=true;menu.parentElement.querySelector('[data-execution-round]').setAttribute('aria-expanded','false');}},true);document.addEventListener('click',e=>{const b=e.target.closest('[data-open-execution]');if(b)openMessage(b.dataset.openExecution);});
  window.addEventListener('shiyan-state',update);update();
 }
 window.ShiYanExecution={install,renderPane,openMessage,openLatest};
})();
