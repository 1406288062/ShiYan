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
    let active=null,generation=0,timer=null,flight=null;
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
  window.ShiYanPhotoStatus={newer,mergeSnapshot,create};
})();
