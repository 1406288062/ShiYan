 
(() => {
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let C;
 const currentState=()=>window.shiyan?.getState();
 const totals=files=>files.reduce((a,f)=>({added:a.added+(f.added||0),removed:a.removed+(f.removed||0)}),{added:0,removed:0});
 const stats=(a,r)=>`<span class="v24-added">+${a}</span><span class="v24-removed">-${r}</span>`;
 const hasStats=f=>Number.isInteger(f.added)&&f.added>=0&&Number.isInteger(f.removed)&&f.removed>=0;
 function recordedCounts(files,missing='历史记录缺少 diff'){
  const recorded=files.filter(hasStats);if(!recorded.length)return `<span class="v24-muted">${missing}</span>`;
  const {added,removed}=totals(recorded);return stats(added,removed)+(recorded.length<files.length?'<span class="v24-muted">部分统计未记录</span>':'');
 }
 function normalize(f){
  if(!f||typeof f!=='object')return null;
  const path=typeof f.path==='string'?f.path:typeof f.name==='string'?f.name:'';if(!path)return null;
  const diff=typeof f.diff==='string'?f.diff:'',lines=diff?diff.split('\n'):[];
  const count=(value,sign)=>Number.isInteger(value)&&value>=0?value:diff&&f.diffTruncated!==true?lines.filter(l=>l.startsWith(sign)&&!l.startsWith(sign.repeat(3))).length:null;
  return {...f,path,available:f.available===true||f.available!==false&&!!diff,diff,added:count(f.added,'+'),removed:count(f.removed,'-')};
 }

 function isImageOutput(file,message){
  const kind=String(file.kind||'').toLowerCase();
  if(!['','add','create'].includes(kind)||file.beforeSha256||!kind&&file.diff)return false;
  const name=String(file.path||'').replace(/\\/g,'/').split('/').pop();
  if(!/\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif|svg)$/i.test(name))return false;
  return (Array.isArray(message?.assets)?message.assets:[]).some(asset=>{
   if(!String(asset?.mimeType||'').toLowerCase().startsWith('image/'))return false;
   const output=String(asset.filename||'').replace(/\\/g,'/').split('/').pop();
   if(output===name)return true;
   // The cloud may deliver a JPEG display copy of the generated original.
   return /\.(?:png|jpe?g|webp|bmp)$/i.test(name)&&/\.jpe?g$/i.test(output)&&
    name.replace(/\.[^.]+$/,'')===output.replace(/\.[^.]+$/,'');
  });
 }
 function filesFor(m){
  const files=new Map();
  function add(values){
   for(const f of Array.isArray(values)?values:[]){
    const normalized=normalize(f);if(!normalized)continue;
    const key=normalized.path.replace(/\\/g,'/'),existing=files.get(key);
    if(!existing){files.set(key,normalized);continue;}
     
    const merged={...normalized,...existing};
    if(!existing.diff&&normalized.diff){merged.diff=normalized.diff;merged.available=normalized.available;}
    if(existing.added===null&&normalized.added!==null)merged.added=normalized.added;
    if(existing.removed===null&&normalized.removed!==null)merged.removed=normalized.removed;
    if(!existing.kind&&normalized.kind)merged.kind=normalized.kind;
    files.set(key,merged);
   }
  }
  add(m?.fileChanges);
  const displayed=Array.isArray(m?.displayItems)?m.displayItems:[];
  for(const item of displayed)if(item?.type==='file_change'&&(!item.status||item.status==='completed'))add(item.changes);
  if(!files.size&&!displayed.length){
   let raw=[];try{
    const value=m?.rawResult;if(typeof value!=='string'||new TextEncoder().encode(value).length<=262144)raw=typeof value==='string'?JSON.parse(value):value||[];
   }catch{}
   const legacy=Array.isArray(raw)?raw:Array.isArray(raw?.items)?raw.items:[];
   for(const item of legacy)if(item?.type==='file_change'&&(!item.status||item.status==='completed'))add(item.changes);
  }
  return [...files.values()].filter(file=>!isImageOutput(file,m));
 }
 function relativePath(file,message){
  const raw=String(file.relativePath||file.path||file.name||'').replace(/\\/g,'/');
  if(file.relativePath||!/^\/|^[A-Za-z]:\//.test(raw))return raw.replace(/^\.\//,'');
  const conversation=currentState()?.conversations?.find(c=>(c.messages||[]).some(m=>m.id===message?.id));
  const project=C?.projects?.find(p=>p.id===conversation?.projectId);
  const roots=[message?.workingDirectory,message?.cwd,message?.workspace,conversation?.workingDirectory,conversation?.workspacePath,conversation?.workspace,project?.path,C?.defaultDirectory].filter(v=>typeof v==='string').map(v=>v.replace(/\\/g,'/').replace(/\/$/,''));
  roots.sort((a,b)=>b.length-a.length);
  for(const root of roots)if(raw.startsWith(root+'/'))return raw.slice(root.length+1);
  const workspace=raw.match(/\/workspaces\/[A-Za-z0-9_-]{16,}\/(.+)$/);if(workspace)return workspace[1];
  const home=raw.match(/^\/(?:Users|home)\/[^/]+\/(.+)$/);return home?'~/'+home[1]:raw.replace(/^\/+/,'');
 }
 function absolutePath(file,message){
  const raw=String(file.absolutePath||file.path||file.name||'').replace(/\\/g,'/');if(/^\/|^[A-Za-z]:\//.test(raw))return raw;
  const conversation=currentState()?.conversations?.find(c=>(c.messages||[]).some(m=>m.id===message?.id))||window.ShiYanSchedules?.currentConversation?.();
  const project=C?.projects?.find(p=>p.id===conversation?.projectId);
  const root=message?.workingDirectory||message?.cwd||conversation?.workspacePath||project?.path||C?.defaultDirectory;
  return typeof root==='string'?root.replace(/\/$/,'')+'/'+raw.replace(/^\.\//,''):raw;
 }
 function summary(m,providedFiles){
  const files=providedFiles||filesFor(m);if(!files.length)return '';
  const execution=window.ShiYanOutput?.executionStats(m)||{total:0,success:0,failed:0,pending:0};
  return `<section class="v24-change-summary" aria-label="代码修改摘要"><header><span class="v24-change-symbol" aria-hidden="true">${'<svg viewBox="0 0 24 24"><path d="M6 3h12v18H6zM12 7v6M9 10h6M9 17h6"/></svg>'}</span><div><strong>已编辑 ${files.length} 个文件</strong><div class="v24-change-count">${recordedCounts(files)}</div></div><button type="button" data-show-message-changes="${esc(m.id)}">查看变更</button></header><div class="v24-change-files">${files.map((f,i)=>`<button type="button" data-show-message-changes="${esc(m.id)}" data-change-index="${i}" title="${esc(absolutePath(f,m))}"><span>${esc(relativePath(f,m))}</span><span class="v24-change-count">${hasStats(f)?stats(f.added,f.removed):'—'}</span></button>`).join('')}</div><footer class="v24-execution-summary"><button type="button" data-open-execution="${esc(m.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h13M8 12h13M8 19h13M2 5l1.5 1.5L6 3M2 12l1.5 1.5L6 10M2 19l1.5 1.5L6 17"/></svg><span>执行过程</span><svg class="v24-execution-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button><span>工具 ${execution.total} · 成功 ${execution.success} · 失败 ${execution.failed}${execution.pending?' · 未记录结果 '+execution.pending:''}</span></footer></section>`;
 }
 function findMessage(tab){return currentState()?.conversations?.find(c=>c.id===tab.conversationId)?.messages?.find(m=>m.id===tab.messageId)||window.ShiYanSchedules?.message?.(tab.messageId);}
 function openFiles(files,options={}){
  if(!C)return;const existing=C.tabs.find(t=>t.type==='changes');
  if(existing){Object.assign(existing,{files:files.map(normalize).filter(Boolean),conversationId:undefined,messageId:undefined,...options});renderPane(existing,C.panes.get(existing.id));C.selectTab(existing.id);return existing;}
  return C.openTab({type:'changes',title:'变更',files:files.map(normalize).filter(Boolean),...options});
 }
 function openMessage(id,index){
  const conversation=currentState()?.conversations?.find(c=>(c.messages||[]).some(m=>m.id===id))||(window.ShiYanSchedules?.message?.(id)?window.ShiYanSchedules.currentConversation():null);const message=conversation?.messages.find(m=>m.id===id);if(!message)return;
  const tab=openFiles(filesFor(message),{conversationId:conversation.id,messageId:id,changeIndex:index});
 }
 function diffHTML(file){
  if(!file.diff)return `<p class="v24-diff-empty">${esc(file.available===false?(file.source||'这条历史记录没有保存修改前的内容，暂无 diff。'):'文件与基准一致，没有变更。')}</p>`;
  let old=0,next=0;
  return '<table class="v24-diff-code"><tbody>'+file.diff.split('\n').map(line=>{
   if(line.startsWith('--- ')||line.startsWith('+++ '))return '';
   const hunk=line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
   if(hunk){old=Number(hunk[1]);next=Number(hunk[2]);return `<tr class="v24-diff-hunk"><td colspan="4">${esc(line)}</td></tr>`;}
   if(!/^[ +\-]/.test(line))return line?`<tr class="v24-diff-meta"><td colspan="4">${esc(line)}</td></tr>`:'';
   const sign=line[0],cls=sign==='+'?'added':sign==='-'?'removed':'context',a=sign==='+'?'':old++,b=sign==='-'?'':next++;
   return `<tr class="v24-diff-${cls}"><td class="v24-line-number">${a}</td><td class="v24-line-number">${b}</td><td class="v24-diff-sign">${sign===' '?'':sign}</td><td class="v24-diff-text"><code>${esc(line.slice(1))||' '}</code></td></tr>`;
  }).join('')+'</tbody></table>';
 }
 function renderPane(tab,pane){
  if(!pane)return;pane.classList.add('v24-changes-pane');const compact=findMessage(tab),refresh=()=>renderPane(tab,pane);
  const message=window.ShiYanMessageDetails.resolve(compact,tab.conversationId,refresh,pane);
  if(message?.detailsDeferred){window.ShiYanMessageDetails.placeholder(message,pane,refresh);return;}
  const files=message?filesFor(message):(tab.files||[]);
  const rounds=currentState()?.conversations?.find(c=>c.id===tab.conversationId)?.messages.filter(m=>m.role==='assistant'&&filesFor(m).length)||[];
  const roundPicker=rounds.length?`<select data-change-round aria-label="选择修改轮次">${rounds.map((m,i)=>`<option value="${esc(m.id)}" ${m.id===tab.messageId?'selected':''}>${i===rounds.length-1?'上一轮':'第 '+(i+1)+' 轮'}</option>`).join('')}</select>`:'<strong>变更</strong>';
  pane.innerHTML=`<header class="v24-changes-toolbar"><div>${roundPicker}<span class="v24-change-count">${recordedCounts(files,'未记录统计')}</span></div><span>${files.length} 个文件</span></header><div class="v24-diff-scroll">${files.length?files.map((f,i)=>`<details class="v24-diff-file" data-diff-file="${i}" open><summary>${C.icon('file')}<span title="${esc(f.path)}">${esc(f.path)}</span><span class="v24-change-count">${hasStats(f)?stats(f.added,f.removed):'—'}</span>${C.icon('down')}</summary><div class="v24-diff-content">${diffHTML(f)}</div></details>`).join(''):'<p class="v24-diff-empty">请从消息中的“查看变更”打开修改记录。</p>'}</div>`;
  pane.querySelector('[data-change-round]')?.addEventListener('change',e=>openMessage(e.target.value));
  if(tab.changeIndex!==undefined){const index=tab.changeIndex;delete tab.changeIndex;requestAnimationFrame(()=>pane.querySelector('[data-diff-file="'+index+'"]')?.scrollIntoView({block:'start'}));}
 }
 function refreshVisibleCards(){
  const messages=new Map((currentState()?.conversations||[]).flatMap(c=>(c.messages||[]).map(m=>[m.id,m])));
  for(const article of document.querySelectorAll('#messages>article[data-message-id]')){
   const message=messages.get(article.dataset.messageId);if(!message||message.role!=='assistant'||['submitting','queued','running','reconnecting'].includes(message.state))continue;
   const signature=JSON.stringify([message.assets||[],message.fileChanges||null,message.rawResult||'',message.displayItems||[],message.executionStats||null]);
   if(article.__changeCardSignature===signature){
    const expected=filesFor(message).map(f=>relativePath(f,message));
    const visible=[...article.querySelectorAll('.v24-change-files>button>span:first-child')].map(e=>e.textContent);
    if(expected.length===visible.length&&expected.every((value,i)=>value===visible[i]))continue;
   }
   article.__changeCardSignature=signature;
   const html=summary(message),old=article.querySelector('.v24-change-summary');
   if(old&&old.outerHTML!==html){if(html)old.outerHTML=html;else old.remove();}
   else if(!old&&html){const template=document.createElement('template');template.innerHTML=html;article.insertBefore(template.content.firstElementChild,article.querySelector('.v22-message-tools'));}
   if(html){const names=new Set(filesFor(message).map(f=>f.path.replace(/\\/g,'/').split('/').pop()));
    for(const asset of article.querySelectorAll('.message-files>[data-asset-id]')){
     const record=message.assets?.find(a=>a.id===asset.dataset.assetId);
     if(record&&names.has(String(record.filename||'').replace(/\\/g,'/').split('/').pop()))asset.remove();
    }
    const container=article.querySelector('.message-files');if(container&&!container.children.length)container.remove();
   }
  }
 }
 function install(context){
  C=context;window.addEventListener('shiyan-state',refreshVisibleCards);refreshVisibleCards();document.addEventListener('click',e=>{const b=e.target.closest('[data-show-message-changes]');if(b)openMessage(b.dataset.showMessageChanges,b.dataset.changeIndex);});
  window.addEventListener('shiyan-state',()=>{for(const tab of C.tabs)if(tab.type==='changes'&&tab.conversationId){const m=findMessage(tab),signature=JSON.stringify([m?.detailsToken,m?.assets||[],m?.fileChanges||null,m?.displayItems||[],m?.rawResult||null]);if(tab.changeSignature!==signature){tab.changeSignature=signature;renderPane(tab,C.panes.get(tab.id));}}});
  const rail=document.getElementById('activityRail'),avatar=document.createElement('button');
  avatar.id='railAvatar';avatar.type='button';avatar.className='wb-icon-button';avatar.title='头像与额度';avatar.setAttribute('aria-label','头像与剩余额度');avatar.setAttribute('aria-haspopup','dialog');avatar.setAttribute('aria-expanded','false');avatar.innerHTML='<svg class="v24-avatar-placeholder" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="12" r="5"/><path d="M6 29v-4a10 10 0 0 1 20 0v4Z"/></svg><img alt="用户头像" hidden>';
  rail.append(avatar);
   const card=document.createElement('section');card.id='avatarQuotaCard';card.className='v26-avatar-card';card.hidden=true;card.tabIndex=-1;card.setAttribute('role','dialog');card.setAttribute('aria-label','头像与剩余额度');
   card.innerHTML='<header><strong>剩余额度</strong></header><div class="v26-quota-content" role="status">正在获取…</div><footer><button type="button" data-avatar-change><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 21v-1a8 8 0 0 1 16 0v1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span>更换头像</span></button></footer>';document.body.append(card);let quotaPending;
   function closeCard(){card.hidden=true;avatar.setAttribute('aria-expanded','false');}
   async function loadQuota(){
    if(quotaPending)return quotaPending;
    const content=card.querySelector('.v26-quota-content');content.textContent='正在获取…';
    quotaPending=(async()=>{try{
     const data=await window.shiyan.api('/api/account/quota'),quota=data.quota;
     const rows=[...(quota?.claude?.available?quota.claude.windows||[]:[]),...(quota?.available?quota.windows||[]:[])].filter(w=>typeof w.remainingPercent==='number'&&Number.isFinite(w.remainingPercent));
     if(!rows.length){content.textContent='暂时无法获取剩余额度';return;}
     content.innerHTML=rows.map(w=>{const percent=Math.max(0,Math.min(100,w.remainingPercent)),reset=typeof w.resetsAt==='number'?new Date(w.resetsAt*1000):null;return '<div class="v26-quota-row"><div><span>'+esc(w.bucket)+' · '+esc(w.period)+'</span><strong>'+esc(Math.round(percent))+'%</strong></div><progress max="100" value="'+percent+'" aria-label="'+esc(w.period)+'剩余额度"></progress>'+(reset&&!isNaN(reset)?'<small>'+esc(reset.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))+' 重置</small>':'')+'</div>';}).join('');
    }catch{content.textContent='暂时无法获取剩余额度';}finally{quotaPending=null;}})();return quotaPending;
   }
   function positionQuotaCard(){
    const rect=avatar.getBoundingClientRect();
    const width=Math.min(246,Math.max(0,innerWidth-16));card.style.width=width+'px';
    card.style.left=Math.max(8,Math.min(rect.right+10,innerWidth-width-8))+'px';card.style.bottom=Math.max(8,innerHeight-rect.bottom)+'px';
   }
   avatar.onclick=()=>{if(!card.hidden){closeCard();return;}positionQuotaCard();card.hidden=false;avatar.setAttribute('aria-expanded','true');card.focus();if(window.ShiYanAccount?.user?.serverAccess)loadQuota();};
   window.addEventListener('resize',()=>{if(!card.hidden)positionQuotaCard();});
   card.querySelector('[data-avatar-change]').onclick=()=>{closeCard();window.ShiYanAvatar.choose();};
   document.addEventListener('pointerdown',e=>{if(!card.hidden&&!card.contains(e.target)&&!avatar.contains(e.target))closeCard();});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!card.hidden){closeCard();avatar.focus();}});
  window.ShiYanAvatar.bind(avatar.querySelector('img'),avatar.querySelector('svg'));
 }
 window.ShiYanChanges={summary,filesFor,relativePath,openFiles,openMessage,renderPane,install,refreshVisibleCards};
})();
