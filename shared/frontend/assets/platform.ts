/* Shared platform context. Profiles select explicit configuration and adapters;
   they do not assign features or change the shared interface by themselves. */
(() => {
  'use strict';
  const metadata = (window as any).__SHIYAN_PLATFORM__ || {};
  const mode=metadata.mode==='web'?'web':'desktop';
  if(typeof document!=='undefined')document.documentElement.dataset.shiyanPlatform=mode;
  // Web streams start after the initial document load, not ahead of its assets.
  const pendingLoadCallbacks = new Set<any>();
  let loadListenerInstalled=false;
  function deferUntilLoaded(callback: any) {
    if(mode!=='web'||typeof document==='undefined'||document.readyState==='complete')return false;
    pendingLoadCallbacks.add(callback);
    if(!loadListenerInstalled){
      loadListenerInstalled=true;
      window.addEventListener('load',()=>{
        const callbacks=[...pendingLoadCallbacks];pendingLoadCallbacks.clear();
        setTimeout(()=>callbacks.forEach(run=>run()),0);
      },{once:true});
    }
    return true;
  }
  const config=metadata.config && typeof metadata.config==='object' && !Array.isArray(metadata.config)?metadata.config:{};
  const adapters=new Map(['shared','desktop','web'].map(profile=>[profile,new Map()]));
  function get(path: any,fallback: any) {
    if(path===undefined || path===null || path==='')return config;
    const parts=Array.isArray(path)?path:String(path).split('.');
    let value=config;
    for(const part of parts){
      if(value===null || typeof value!=='object' || !Object.prototype.hasOwnProperty.call(value,part))return fallback;
      value=value[part];
    }
    return value;
  }
  function registerAdapter(name: any,implementation: any,profile='shared') {
    if(typeof name!=='string' || !name.trim())throw new TypeError('Adapter name must be a non-empty string');
    if(!adapters.has(profile))throw new TypeError('Adapter profile must be shared, desktop or web');
    adapters.get(profile)?.set(name,implementation);
    return implementation;
  }
  function adapter(name: any) {
    const selected: any =adapters.get(mode);
    return selected.has(name)?selected.get(name):adapters.get('shared')?.get(name);
  }
  const bridge=()=>window.webkit?.messageHandlers?.native;
  registerAdapter('native',{
    available:()=>!!bridge(),
    post(action: any,detail={}) {
      const handler=bridge();
      if(!handler)return false;
      handler.postMessage(Object.assign({action},detail));
      return true;
    }
  });
  function postNative(action: any,detail={}) {
    const native=adapter('native');
    return typeof native?.post==='function'?native.post(action,detail):false;
  }
  window.ShiYanPlatform=Object.freeze({mode,config,get,registerAdapter,adapter,postNative,deferUntilLoaded});
})();
