(() => {
 'use strict';
 const entries=new Map();let timer,requesting=false,lastContext='';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function context(){
  const s=window.shiyan?.getState(),c=s?.conversations?.find(c=>c.id===s.selectedConversationId);
  const m=c?.messages?.slice().reverse().find(m=>m.role==='assistant'&&m.remoteJobId);
  return c&&m?{conversationId:c.id,messageId:m.id,jobId:m.remoteJobId,key:c.id+':'+m.remoteJobId}:null;
 }
 function valid(questions,form){
  const answers={};
  for(const q of questions){
   const group=form.querySelector('[data-question-id="'+CSS.escape(q.id)+'"]');
   const selected=group.querySelector('input[type=radio]:checked');
   const text=group.querySelector('textarea')?.value.trim()||'';
   const value=q.options?.length?(selected?.dataset.custom?text:selected?.value):text;
   if(!value)return null;
   answers[q.id]={answers:[value]};
  }
  return answers;
 }
 function refresh(entry){
  const {node,request:r}=entry;
  if(r.status==='cancelled'||r.status==='expired'){node.innerHTML='<div class="user-input-heading">'+(r.status==='cancelled'?'问题已取消':'问题已过期')+'</div>';return;}
  if(r.status==='answered'){node.remove();return;}
  const form=node.querySelector('form');
  if(!form)return;
  const button=form.querySelector('button[type=submit]');button.disabled=entry.submitting||!valid(r.questions,form);button.textContent=entry.submitting?'提交中…':'确认';
  const status=node.querySelector('[data-answer-status]');status.textContent=entry.error||'';
 }
 function create(r,ctx){
  const node=document.createElement('section');node.className='user-input-card';node.setAttribute('aria-label','回答问题');
  const entry={node,request:r,context:ctx,submitting:false,error:''};
  node.innerHTML='<div class="user-input-heading">请选择</div><form>'+r.questions.map((q,i)=>'<fieldset data-question-id="'+esc(q.id)+'"><legend>'+esc(q.question)+'</legend>'+(q.options?.length?q.options.map((o,j)=>'<label class="user-input-option"><input type="radio" name="question-'+i+'" value="'+esc(o.label)+'"><span><strong>'+esc(o.label)+'</strong>'+(o.description?'<small>'+esc(o.description)+'</small>':'')+'</span></label>').join('')+'<label class="user-input-option"><input type="radio" name="question-'+i+'" data-custom="true"><span><strong>其他</strong></span></label>':'')+'<textarea aria-label="'+esc(q.options?.length?'填写自己的回答':q.question)+'" placeholder="'+(q.options?.length?'填写其他回答':'填写回答')+'" rows="2" maxlength="10000"></textarea></fieldset>').join('')+'<footer><span data-answer-status role="status" aria-live="polite"></span><button type="submit" disabled>确认</button></footer></form>';
  node.addEventListener('input',e=>{const group=e.target.closest('fieldset');if(e.target.matches('textarea')&&group){const custom=group.querySelector('[data-custom]');if(custom)custom.checked=true;}entry.error='';refresh(entry);});
  node.addEventListener('change',()=>{entry.error='';refresh(entry);});
  node.querySelector('form').addEventListener('submit',async e=>{
   e.preventDefault();if(entry.submitting||entry.request.status!=='pending')return;
   const answers=valid(entry.request.questions,e.target);if(!answers)return;
   entry.submitting=true;entry.error='';refresh(entry);
   try{
    const data=await window.shiyan.api('/api/conversations/'+encodeURIComponent(ctx.conversationId)+'/questions/'+encodeURIComponent(r.id)+'/answer','POST',{jobId:ctx.jobId,answers});
    entry.request={...r,...data.request,status:'answered',answers:data.request?.answers||answers};
   }catch(error){entry.error=error.message||'提交失败，请重试';}
   finally{entry.submitting=false;refresh(entry);}
  });
  refresh(entry);return entry;
 }
 function mount(ctx){
  for(const entry of entries.values()){
   if(entry.request.status==='answered'||!ctx||entry.context.key!==ctx.key||window.shiyan?.getView?.()!=='agent'){entry.node.remove();continue;}
   const article=document.querySelector('#messages>article[data-message-id="'+CSS.escape(ctx.messageId)+'"]');
   const target=article?.querySelector('.message-content');
   if(target&&entry.node.parentNode!==target){
    const scroller=document.getElementById('messagesScroller'),top=scroller?.scrollTop;
    const follow=scroller&&scroller.scrollHeight-scroller.clientHeight-top<64;
    target.append(entry.node);
    if(follow)requestAnimationFrame(()=>{if(context()?.key===ctx.key&&scroller.scrollTop===top)scroller.scrollTop=scroller.scrollHeight;});
   }
  }
 }
 async function poll(){
  const ctx=context();mount(ctx);
  if(!ctx||requesting||document.hidden)return;
  requesting=true;
  try{
   const data=await window.shiyan.api('/api/conversations/'+encodeURIComponent(ctx.conversationId)+'/questions');
   if(context()?.key!==ctx.key)return;
   for(const r of data.pendingQuestions||[]){
    if(r.jobId!==ctx.jobId||!['pending','answered','cancelled','expired'].includes(r.status)||!r.questions?.length)continue;
    const key=ctx.key+':'+r.id;let entry=entries.get(key);
    if(r.status==='answered'){if(entry){entry.node.remove();entries.delete(key);}continue;}
    if(!entry){entry=create(r,ctx);entries.set(key,entry);}
    else if(r.status!=='pending'&&entry.request.status!==r.status){entry.request=r;refresh(entry);}
   }
   while(entries.size>40){const key=entries.keys().next().value;entries.get(key).node.remove();entries.delete(key);}
   mount(ctx);
  }catch(_){}
  finally{requesting=false;}
 }
 function update(){const ctx=context();mount(ctx);if(ctx?.key!==lastContext){lastContext=ctx?.key||'';clearTimeout(timer);timer=setTimeout(poll,0);}}
 window.addEventListener('shiyan-state',update);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
 setInterval(poll,1500);update();
})();
