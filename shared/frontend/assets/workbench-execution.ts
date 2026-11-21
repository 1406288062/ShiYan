 
(() => {
 'use strict';
 const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, (c: string): string => (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string,string>)[c]));
 const working=new Set(['submitting','queued','running','reconnecting']);
 let C,lastConversation='',previous=new Map();
 const state=()=>window.shiyan?.getState();
 const conversation=id=>state()?.conversations?.find(c=>c.id===id)||((window.ShiYanSchedules?.currentConversation?.()?.id===id)?window.ShiYanSchedules.currentConversation():null);
 const records=c=>(c?.messages||[]).filter(m=>m.role==='assistant'&&window.ShiYanOutput?.itemsFor(m).length);
 // 这一轮回复对应的用户消息（紧挨在它前面的那条）。
 const promptFor=(c,m)=>{const list=c?.messages||[],at=list.findIndex(x=>x.id===m?.id);for(let i=at-1;i>=0;i--)if(list[i].role==='user')return list[i];return null;};
 // 执行过程：第一层列出我发过的消息（太长只留开头）+ 这一轮在干嘛 + 时间；点一条进入步骤详情。
 const back='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>';
 const chevron='<svg class="xs-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
 const oneLine=text=>String(text||'').replace(/\s+/g,' ').trim();
 function renderPane(tab,pane) {
  if(C&&tab){const _id=tab.id;setTimeout(()=>{try{C.closeTab(_id);}catch(e){}},0);}
  return;
 }
 function _renderPane_disabled(tab,pane) {
  if(!pane)return;
  const c=conversation(tab.conversationId),rounds=records(c);
  pane.classList.add('execution-pane');
  if(tab.view==='detail'&&rounds.some(r=>r.id===tab.messageId))return renderDetail(tab,pane,c,rounds);
  const signature=JSON.stringify(['list',c?.id,rounds.map(m=>[m.id,m.state,m.completedAt])]);
  if(pane.__executionSignature===signature)return;pane.__executionSignature=signature;
  const items=rounds.slice().reverse().map(m=>({m,prompt:promptFor(c,m)}));
  pane.innerHTML='<header class="execution-toolbar"><strong>执行过程</strong></header><div class="execution-scroll">'+(items.length?'<ol class="xs-rounds">'+items.map(({m,prompt})=>{
    const text=oneLine(prompt?.text)||'（附件消息）',time=window.ShiYanSteps?.when?.(m.completedAt||m.createdAt)||'';
    return '<li><button type="button" data-round-id="'+esc(m.id)+'"><span class="xs-round-copy"><strong>'+esc(text.slice(0,400))+'</strong><small><span data-round-doing="'+esc(m.id)+'">'+(working.has(m.state)?'正在执行':'')+'</span>'+(time?'<span> · '+esc(time)+'</span>':'')+'</small></span>'+chevron+'</button></li>';
  }).join('')+'</ol>':'<p class="wb-empty">这条会话暂无执行记录。</p>')+'</div>';
  pane.querySelector('.xs-rounds')?.addEventListener('click',e=>{const b=(e as any).target.closest('[data-round-id]');if(!b)return;Object.assign(tab,{view:'detail',messageId:b.dataset.roundId});C.persist();pane.__executionSignature=null;renderPane(tab,pane);});
  window.ShiYanSteps?.summarizeRounds(items.slice(0,40).map(({m,prompt})=>({id:m.id,prompt:prompt?.text||'',reply:m.text||''}))).then(map=>{
    for(const node of pane.querySelectorAll('[data-round-doing]')){const doing=map['doing:'+node.dataset.roundDoing];if(doing&&!node.textContent)node.textContent=doing;}
  });
 }
 function renderDetail(tab,pane,c,rounds){
  const compact=rounds.find(m=>m.id===tab.messageId);
  const refresh=()=>{pane.__executionSignature=null;renderPane(tab,pane);};
  const live=working.has(compact?.state);
  const m=live?compact:window.ShiYanMessageDetails.resolve(compact,tab.conversationId,refresh,pane);
  if(m?.detailsDeferred){window.ShiYanMessageDetails.placeholder(m,pane,refresh);return;}
  const prompt=promptFor(c,m);
  const signature=JSON.stringify(['detail',m,prompt?.id]);
  if(pane.__executionSignature===signature)return;pane.__executionSignature=signature;
  pane.innerHTML='<header class="execution-toolbar"><strong>执行过程</strong></header><div class="execution-scroll"><button type="button" class="xs-detail-back" data-execution-back>'+back+'<span>全部消息</span></button><div class="execution-steps-host"></div></div>';
  pane.querySelector('[data-execution-back]').onclick=()=>{tab.view='list';C.persist();pane.__executionSignature=null;renderPane(tab,pane);};
  const host=pane.querySelector('.execution-steps-host'),title=oneLine(prompt?.text);
  window.ShiYanSteps.render(host,{status:live?'running':m.error?'failed':'done',title:title?title.slice(0,160)+(title.length>160?'…':''):(c?.title||'当前会话'),time:m.completedAt||m.createdAt,result:m.text||'',prompt:prompt?.text||'',steps:window.ShiYanSteps.fromItems(window.ShiYanOutput.itemsFor(m))});
 }
 function openMessage(id) { return; }
 function _openMessage_disabled(id) {
  if(!C)return;
  const c=state()?.conversations?.find(c=>(c.messages||[]).some(m=>m.id===id))||(window.ShiYanSchedules?.message?.(id)?window.ShiYanSchedules.currentConversation():null);
  if(!c)return;
  let tab=C.tabs.find(t=>t.type==='execution');
  if(tab){Object.assign(tab,{conversationId:c.id,messageId:id,view:'detail'});renderPane(tab,C.panes.get(tab.id));C.selectTab(tab.id);C.persist();}
  else tab=C.openTab({type:'execution',title:'执行过程',conversationId:c.id,messageId:id,view:'detail'});
  return tab;
 }
 function openLatest() { return; }
 function _openLatest_disabled() {
  const c=state()?.conversations?.find(c=>c.id===state()?.selectedConversationId);
  let tab=C?.tabs.find(t=>t.type==='execution');
  if(tab&&c){Object.assign(tab,{conversationId:c.id,view:'list'});tab.__sig=null;renderPane(tab,C.panes.get(tab.id));C.selectTab(tab.id);C.persist();return tab;}
  if(C&&c)return C.openTab({type:'execution',title:'执行过程',conversationId:c.id,view:'list'});
  if(C)C.openTab({type:'execution',title:'执行过程',conversationId:c?.id},true);
 }
 function update() {
  if(!C)return;
  const c=state()?.conversations?.find(c=>c.id===state()?.selectedConversationId);
  for(const tab of C.tabs)if(tab.type==='execution')renderPane(tab,C.panes.get(tab.id));
  lastConversation=c?.id||'';previous=new Map((c?.messages||[]).map(m=>[m.id,m.state]));
 }
 function install(context) {
  C=context;setTimeout(()=>{try{for(const t of [...(C.tabs||[])])if(t.type==='execution')C.closeTab(t.id);}catch(e){}},0);document.addEventListener('pointerdown',e=>{for(const menu of [...document.querySelectorAll('.execution-round-menu:not([hidden])')] as any[])if(!menu.parentElement.contains(e.target)){menu.hidden=true;menu.parentElement.querySelector('[data-execution-round]').setAttribute('aria-expanded','false');}},true);document.addEventListener('click',e=>{const b=(e as any).target.closest('[data-open-execution]');if(b)openMessage(b.dataset.openExecution);});
  window.addEventListener('shiyan-state',update);update();
 }
 window.ShiYanExecution={install,renderPane,openMessage,openLatest};
})();
