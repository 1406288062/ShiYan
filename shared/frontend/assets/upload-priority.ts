/* Let image uploads use the connection before background state synchronization. */
(() => {
  'use strict';
  let count=0;
  const waiting = new Set<any>();
  const changed=()=>window.dispatchEvent(new CustomEvent('shiyan-upload-priority-change',{detail:{active:count>0}}));
  function begin(){
    if(count++===0)changed();
    let released=false;
    return ()=>{if(released)return;released=true;if(--count===0){changed();for(const resolve of waiting)resolve();waiting.clear();}};
  }
  const wait=()=>count?new Promise(resolve=>waiting.add(resolve)):Promise.resolve();
  function upload(path: any,body: any,onProgress: any){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();let settled=false,timer: any;
      const finish=(error: any, data?: any)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(data);};
      const fail=(message: any, status?: any)=>Object.assign(new Error(message),status?{status}:{});
      const alive=()=>{clearTimeout(timer);timer=setTimeout(()=>{finish(fail('图片上传长时间没有进展，请检查网络后重试',408));xhr.abort();},120000);};
      const progress=(value: any)=>{try{onProgress?.(value);}catch(_){}};
      xhr.open('POST',path);xhr.withCredentials=true;xhr.setRequestHeader('X-Shiyan-Local','1');
      xhr.upload.onprogress=e=>{alive();progress({loaded:e.loaded,total:e.total,percent:e.lengthComputable&&e.total?Math.min(100,Math.floor(e.loaded/e.total*100)):null,sent:false});};
      xhr.upload.onload=e=>{alive();progress({loaded:e.loaded,total:e.total,percent:100,sent:true});};
      xhr.onprogress=alive;
      xhr.onload=()=>{
        let data;try{data=JSON.parse(xhr.responseText);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid response');}catch(_){finish(fail('服务返回了无法读取的响应（'+xhr.status+'）',xhr.status));return;}
        if(xhr.status<200||xhr.status>=300||data.ok===false){const message=data.error||data.detail||xhr.statusText;finish(Object.assign(fail(typeof message==='string'?message:JSON.stringify(message),xhr.status),{code:data.code}));return;}
        finish(null,data);
      };
      xhr.onerror=()=>finish(fail('图片上传连接中断，请检查网络后重试'));
      xhr.onabort=()=>finish(fail('图片上传已中断'));
      alive();try{xhr.send(body);}catch(error){finish(error);}
    });
  }
  window.ShiYanUploadPriority={get active(){return count>0;},begin,wait,upload};
})();
