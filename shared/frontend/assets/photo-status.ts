/* Enhancement updates must not wait behind the full conversation snapshot. */
(() => {
  'use strict';
  const working=new Set(['submitting','queued','running','reconnecting','cancelling']);
  function newer(left,right){
    if(!right)return true;
    const a=Number(left.photoRevision)||0,b=Number(right.photoRevision)||0;
    return a!==b?a>b:Date.parse(left.updatedAt||0)>=Date.parse(right.updatedAt||0);
  }
  function mergeSnapshot(next,previous){
    if(!previous)return next;
    const jobs=new Map((next.photoJobs||[]).map(j=>[j.id,j])),retained=new Set();
    for(const j of previous.photoJobs||[]){const incoming=jobs.get(j.id);if((!incoming&&Number(j.photoRevision)>0)||(incoming&&!newer(incoming,j))){jobs.set(j.id,j);retained.add(j.id);}}
    const history=new Map((next.history||[]).map(h=>[h.id,h]));
    for(const h of previous.history||[])if(retained.has(h.jobId))history.set(h.id,h);
    return {...next,photoJobs:[...jobs.values()],history:[...history.values()]};
  }
  function create({request,apply,isVisible=()=>true,interval=1000,timeout=8000}){
    let active: any = null,generation=0,timer: any = null,flight: any = null;
    const later=(token,delay)=>{if(token===generation&&active)timer=setTimeout(()=>{timer=null;tick(token)},delay);};
    async function tick(token){
      if(token!==generation||!active||flight)return;
      if(!isVisible()){later(token,3000);return;}
      const id=active,controller=new AbortController();flight=controller;
      const deadline=setTimeout(()=>controller.abort(),timeout);let delay=interval;
      try{
        const data=await request(id,controller.signal);
        if(token!==generation||id!==active)return;
        if(data?.job?.id!==id)throw Error('Unexpected enhancement task');
        apply(data);
        if(!working.has(data.job.state)){watch(null);return;}
      }catch(error){if(token===generation)delay=3000;}
      finally{
        clearTimeout(deadline);if(flight===controller)flight=null;
        later(token,delay);
      }
    }
    function watch(id){
      id=id||null;if(active===id)return;
      generation++;if(timer!==null)clearTimeout(timer);timer=null;
      flight?.abort();flight=null;active=id;
      if(active)tick(generation);
    }
    function refresh(){if(active&&!flight){if(timer!==null)clearTimeout(timer);timer=null;tick(generation);}}
    return {watch,refresh,stop:()=>watch(null)};
  }
  function label(job){
    const state=job?.state;
    const fixed={submitting:'正在准备',queued:'等待增强',reconnecting:'正在重新连接',cancelling:'正在停止',cancelled:'已停止',completed:'增强完成',failed:'增强失败'};
    if(fixed[state])return fixed[state];
    const raw=String(job?.label||'');
    if(/加载|模型/.test(raw))return '加载增强模型';
    if(/保存|回传|编码|上传.*结果/.test(raw))return '正在保存图片';
    if(/接收|下载|准备/.test(raw))return '正在准备图片';
    if(/等待|排队/.test(raw))return '等待增强';
    if(/连接|离线/.test(raw))return '正在重新连接';
    return state==='running'?'正在增强':'处理中';
  }
  function error(value){
    const text=String(value||'');
    return /\b(?:mac|cos|gpu|mps)\b|回传/i.test(text)?'图片增强暂时未完成，请重试':text;
  }
  window.ShiYanPhotoStatus={newer,mergeSnapshot,create,label,error};
})();
