/* Diagnostics only: opaque IDs and timings; never file names, URLs or pixels. */
(() => {
  'use strict';
  const send = (record: any) => {
    try {
      console.info('[ShiYan enhancement timing]',JSON.stringify({event:'enhancement_timing',source:'browser',...record}));
      if(record.status==='started')return;
      fetch('/api/photo/timings',{method:'POST',credentials:'same-origin',keepalive:true,
        headers:{'Content-Type':'application/json','X-Shiyan-Local':'1'},body:JSON.stringify(record)}).catch(()=>{});
    }catch(_){}
  };
  const beginUpload = () => {
    const start=performance.now(),startedAtMs=performance.timeOrigin+start;
    const attemptId=crypto.randomUUID(),base={stage:'upload',attemptId,startedAtMs};
    send({...base,status:'started'});let done=false;
    return (status: any,assetId: any,bytes: any)=>{if(done)return;done=true;send({...base,status,...(assetId?{assetId}:{}),bytes,
      durationMs:performance.now()-start,endedAtMs:performance.timeOrigin+performance.now()});};
  };
  const observeResource = (entry: any) => {
    try {
      const url=new URL(entry.name,location.href);
      if(url.origin!==location.origin||entry.initiatorType!=='img'||entry.responseEnd<=0)return;
      const match=url.pathname.match(/^\/api\/assets\/([A-Za-z0-9_-]+)\/file$/);
      if(!match)return;
      const job=window.shiyan?.getState()?.photoJobs?.find((j: any)=>j.feature==='enhance'&&j.outputAssetId===match[1]);
      if(!job)return;
      send({stage:'web_download',status:'completed',photoJobId:job.id,assetId:match[1],
        startedAtMs:performance.timeOrigin+entry.startTime,endedAtMs:performance.timeOrigin+entry.responseEnd,
        durationMs:entry.responseEnd-entry.startTime,transferBytes:entry.transferSize,
        cacheStatus:entry.deliveryType==='cache'?'cache':entry.transferSize>0?'network':'cache_or_unreported'});
    }catch(_){}
  };
  window.ShiYanEnhancementTiming={beginUpload};
  if(typeof PerformanceObserver!=='undefined')try{
    new PerformanceObserver(list=>list.getEntries().forEach(observeResource)).observe({type:'resource',buffered:true});
  }catch(_){}
})();
