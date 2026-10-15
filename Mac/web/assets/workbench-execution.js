 
(() => {
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const working=new Set(['submitting','queued','running','reconnecting']);
 let C,lastConversation='',previous=new Map();
 const state=()=>window.shiyan?.getState();
 const conversation=id=>state()?.conversations?.find(c=>c.id===id)||((window.ShiYanSchedules?.currentConversation?.()?.id===id)?window.ShiYanSchedules.currentConversation():null);
 const records=c=>(c?.messages||[]).filter(m=>m.role==='assistant'&&!working.has(m.state)&&window.ShiYanOutput?.itemsFor(m).length);
 function renderPane(tab,pane) {
  if(!pane)return;
  const c=conversation(tab.conversationId),rounds=records(c);
  const compact=rounds.find(m=>m.id===tab.messageId)||rounds.at(-1);
  const refresh=()=>{pane.__executionSignature=null;renderPane(tab,pane);};
  const m=window.ShiYanMessageDetails.resolve(compact,tab.conversationId,refresh,pane);
  if(m?.detailsDeferred){window.ShiYanMessageDetails.placeholder(m,pane,refresh);return;}
  if(m)tab.messageId=m.id;
  const signature=JSON.stringify([c?.title,rounds.map(m=>[m.id,m.completedAt]),m]);
  if(pane.__executionSignature===signature)return;pane.__executionSignature=signature;
  pane.classList.add('execution-pane');
  const selected=rounds.map((r,i)=>'<option value="'+esc(r.id)+'"'+(r.id===m?.id?' selected':'')+'>第 '+(i+1)+' 轮</option>').join('');
  pane.innerHTML='<header class="execution-toolbar"><strong>执行过程</strong><select data-execution-round aria-label="选择执行轮次">'+selected+'</select></header><div class="execution-scroll"><p class="execution-conversation">'+esc(c?.title||'当前会话')+'</p>'+(m?window.ShiYanOutput.details(m,true):'<p class="wb-empty">这条会话暂无已完成的执行记录。</p>')+'</div>';
  pane.querySelector('[data-execution-round]')?.addEventListener('change',e=>{tab.messageId=e.target.value;C.persist();renderPane(tab,pane);});
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
  C=context;document.addEventListener('click',e=>{const b=e.target.closest('[data-open-execution]');if(b)openMessage(b.dataset.openExecution);});
  window.addEventListener('shiyan-state',update);update();
 }
 window.ShiYanExecution={install,renderPane,openMessage,openLatest};
})();
