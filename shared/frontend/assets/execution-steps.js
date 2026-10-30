// 执行过程页（桌面端 / 网页端共用）：状态、标题、结果，下面逐步列出工具调用；点一步进入详情。
// 步骤标题和说明由服务端按内容生成并缓存，拿到之前先显示原始标题。
(() => {
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const limit=(v,n=4000)=>{const s=String(v??'');return s.length>n?s.slice(0,n)+'…':s;};
 const STATUS={done:['已完成','is-done'],running:['进行中','is-running'],failed:['未完成','is-failed'],waiting:['等待确认','is-waiting']};
 const cache=new Map();
 const toolText=item=>typeof item.result_text==='string'?item.result_text:Array.isArray(item.result?.content)?item.result.content.filter(c=>c?.type==='text').map(c=>c.text).join('\n'):'';
 const failedItem=item=>item.type==='error'||item.status==='failed'||!!item.error||item.result?.isError===true||(item.type==='command_execution'&&Number.isFinite(item.exit_code)&&item.exit_code!==0);
 // 原始执行记录 → 统一的步骤 {id,type,title,input,output,status}
 function fromItem(item,i){
  if(!item||typeof item!=='object')return null;
  const id=String(item.id||'s'+i),status=failedItem(item)?'failed':['in_progress','running','started'].includes(item.status)?'running':'completed';
  switch(item.type){
   case 'command_execution':return {id,type:item.type,title:'运行命令',input:limit(item.command,1500),output:limit(String(item.aggregated_output||'')+(Number.isFinite(item.exit_code)&&item.exit_code!==0?'\n退出码 '+item.exit_code:''),4000),status};
   case 'mcp_tool_call':{const err=item.error?(typeof item.error==='string'?item.error:item.error.message||'工具调用失败'):'';
    return {id,type:item.type,title:'使用工具 · '+[item.server,item.tool].filter(Boolean).join(' / '),input:limit([item.server,item.tool].filter(Boolean).join('.')+(item.arguments?' '+JSON.stringify(item.arguments):''),1500),output:limit(err||toolText(item),4000),status};}
   case 'web_search':return {id,type:item.type,title:'搜索网页',input:limit(item.query,1000),output:'',status};
   case 'file_change':{const files=Array.isArray(item.changes)?item.changes:[];return {id,type:item.type,title:'修改 '+files.length+' 个文件',input:files.slice(0,40).map(f=>(({add:'新增',delete:'删除',update:'修改'})[f.kind]||'修改')+' '+f.path).join('\n'),output:'',status};}
   case 'collab_tool_call':return {id,type:item.type,title:'分派协作任务',input:limit(item.tool,200),output:'',status};
   case 'image_generation':return {id,type:item.type,title:'生成图片',input:'',output:'',status};
   case 'error':return {id,type:item.type,title:'遇到问题',input:'',output:limit(item.message,2000),status:'failed'};
  }
  return null;
 }
 const fromItems=items=>(items||[]).map(fromItem).filter(Boolean).slice(-60);
 const ACTIONS={mac_codex:'在 Mac 上执行',host_command:'执行命令',write_file:'写入文件',append_file:'追加文件',mkdir:'创建目录',delete_file:'删除文件',run_command:'执行命令',inspect_host:'检查运行环境'};
 // Dots 任务时间线 → 步骤
 function fromTimeline(timeline){
  const out=[];
  for(const entry of timeline||[]){
   const kind=entry.kind||'';if(!['tool_action','tool_error','approval_executed','approval_failed','approval_unknown'].includes(kind))continue;
   let data=entry.data;if(typeof data==='string'){try{data=JSON.parse(data);}catch{data={};}}data=data&&typeof data==='object'?data:{};
   const id='t'+entry.id;
   if(kind.startsWith('approval_')){out.push({id,type:'approval',title:'执行已批准的操作',input:limit(entry.message,600),output:limit(data.output,4000),status:kind==='approval_executed'?'completed':'failed'});continue;}
   const step=fromItem({...data,id},out.length);
   if(step){out.push(step);continue;}
   if(data.type==='reasoning'||data.type==='todo_list')continue;
   const ok=data.ok??kind!=='tool_error';
   out.push({id,type:data.type||'action',title:ACTIONS[data.type]||entry.message||'执行操作',input:limit(data.reason||data.command||'',1500),output:limit(data.detail||data.output||'',4000),status:ok?'completed':'failed'});
  }
  return out.slice(-60);
 }
 const check='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="m8 12.3 2.7 2.7L16.2 9.5"/></svg>';
 const bang='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="M12 7.5v5.5M12 16.4h.01"/></svg>';
 const dotted='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25" stroke-dasharray="2.5 3"/></svg>';
 const chevron='<svg class="xs-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
 const node=s=>s==='failed'?bang:s==='running'?dotted:check;
 const plain=text=>String(text||'').replace(/\*\*|`/g,'').replace(/^#{1,6}\s*/gm,'').trim();
 const when=t=>{if(!t)return '';const d=typeof t==='number'?new Date(t>1e12?t:t*1000):new Date(t);if(Number.isNaN(d.getTime()))return '';const today=new Date().toDateString()===d.toDateString();return today?d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):d.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});};
 const md=text=>window.ShiYanOutput?.markdown?window.ShiYanOutput.markdown(text):'<p>'+esc(text).replace(/\n/g,'<br>')+'</p>';
 const block=(label,text)=>text?'<section class="xs-block"><h4>'+esc(label)+'</h4><pre>'+esc(text)+'</pre></section>':'';
 function stepRow(step,info,last){
  const sub=info?.summary||step.input;
  return '<li class="xs-step'+(last?' is-last':'')+'" data-state="'+esc(step.status)+'"><button type="button" data-xs-step="'+esc(step.id)+'"><span class="xs-node">'+node(step.status)+'</span><span class="xs-text"><strong data-xs-title>'+esc(info?.title||step.title)+'</strong>'+(sub?'<small data-xs-sub class="'+(info?'':'is-raw')+'">'+esc(limit(sub,240))+'</small>':'<small data-xs-sub hidden></small>')+'</span>'+chevron+'</button></li>';
 }
 function detailHTML(step,info){
  return '<button type="button" class="xs-back" data-xs-back aria-label="返回执行步骤"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg></button>'+
   '<h2>'+esc(info?.title||step.title)+'</h2>'+(info?.detail?'<div class="xs-detail-md message-body">'+md(info.detail)+'</div>':info?.summary?'<p class="xs-detail-text">'+esc(info.summary)+'</p>':'')+
   block(step.type==='command_execution'?'命令':'输入',step.input)+block(step.status==='failed'?'错误':'输出',step.output);
 }
 function render(container,options){
  if(!container)return;
  const o={status:'done',title:'',summary:'',time:null,result:'',steps:[],...options},steps=o.steps||[];
  const key=steps.map(s=>s.id+':'+s.input.length+':'+s.output.length+':'+s.status).join('|');
  const info=cache.get(key)||{};const [label,cls]=STATUS[o.status]||STATUS.done;const result=plain(o.result);const resultKey='page:'+String(o.title||'').slice(0,60)+':'+result.length;
  container.classList.add('xs-host');container.dataset.xsKey=key;
  container.innerHTML='<div class="xs-page"><div class="xs-list"><header class="xs-head"><span class="xs-badge '+cls+'">'+label+'</span><h2>'+esc(o.title||'执行过程')+'</h2>'+(o.summary?'<p class="xs-summary">'+esc(o.summary)+'</p>':'')+(when(o.time)?'<time>'+esc(when(o.time))+'</time>':'')+'</header>'+
   (result?'<p class="xs-result" data-xs-result>'+(roundCache.get(resultKey)?esc(roundCache.get(resultKey)):'<span class="xs-loading">正在整理结果…</span>')+'</p>':'')+
   '<h3 class="xs-section">执行步骤</h3>'+(steps.length?'<ol class="xs-steps">'+steps.map((s,i)=>stepRow(s,info[s.id],i===steps.length-1)).join('')+'</ol>':'<p class="xs-empty">'+(o.status==='running'?'正在执行…':'这次没有调用工具')+'</p>')+
   '</div><div class="xs-detail" hidden></div></div>';
  const list=container.querySelector('.xs-list'),detail=container.querySelector('.xs-detail');
  container.onclick=e=>{
   const row=e.target.closest('[data-xs-step]');
   if(row){const step=steps.find(s=>s.id===row.dataset.xsStep);if(!step)return;detail.innerHTML=detailHTML(step,(cache.get(key)||{})[step.id]);list.hidden=true;detail.hidden=false;detail.scrollIntoView?.({block:'start'});detail.querySelector('[data-xs-back]')?.focus({preventScroll:true});return;}
   if(e.target.closest('[data-xs-back]')){detail.hidden=true;list.hidden=false;return;}
  };
  // 中间的结果只显示简短总结，不照搬模型原文。
  if(result&&!roundCache.has(resultKey))summarizeRounds([{id:resultKey,prompt:o.prompt||o.title||'',reply:result}]).then(map=>{const box=container.querySelector('[data-xs-result]');if(!box||container.dataset.xsKey!==key)return;const text=map[resultKey];box.textContent=text||limit(result,100);});
  if(!steps.length||cache.has(key))return;
  window.shiyan?.api?.('/api/dots/steps/summary','POST',{steps}).then(res=>{
   const map={};for(const s of res?.steps||[])map[s.id]=s;cache.set(key,map);
   if(container.dataset.xsKey!==key)return;
   for(const button of container.querySelectorAll('[data-xs-step]')){const value=map[button.dataset.xsStep];if(!value)continue;
    button.querySelector('[data-xs-title]').textContent=value.title;const sub=button.querySelector('[data-xs-sub]');sub.textContent=value.summary;sub.hidden=!value.summary;sub.classList.remove('is-raw');}
  }).catch(()=>{});
 }
 // 每轮“在干嘛 / 结果总结”，按 id 缓存。
 const roundCache=new Map();
 async function summarizeRounds(items){
  const missing=items.filter(i=>!roundCache.has(i.id)&&(i.prompt||i.reply));
  if(missing.length){try{const res=await window.shiyan.api('/api/dots/rounds/summary','POST',{rounds:missing.slice(0,40).map(i=>({id:i.id,prompt:limit(i.prompt,1200),reply:limit(i.reply,2500)}))});for(const r of res?.rounds||[]){roundCache.set(r.id,r.result);roundCache.set('doing:'+r.id,r.doing);}}catch{}
   for(const i of missing)if(!roundCache.has(i.id))roundCache.set(i.id,'');}
  return Object.fromEntries(items.map(i=>[i.id,roundCache.get(i.id)||'']).concat(items.map(i=>['doing:'+i.id,roundCache.get('doing:'+i.id)||''])));
 }
 window.ShiYanSteps={render,fromItems,fromTimeline,summarizeRounds,when};
})();
