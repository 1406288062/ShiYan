(() => {
 'use strict';
 const entries=new Map();
 const key=(m: any)=>m.id+':'+m.detailsToken;
 function resolve(message: any,conversationId: any,refresh: any,owner: any) {
  if(!message?.detailsDeferred)return message;
  const k=key(message);let entry=entries.get(k);
  if(!entry){
   entry={listeners:new Map()};entries.set(k,entry);
   while(entries.size>12){const first=entries.keys().next().value;if(first===k)break;entries.delete(first);}
   window.shiyan.api('/api/conversations/'+encodeURIComponent(conversationId)+'/messages/'+encodeURIComponent(message.id)+'/details').then((data: any)=>{
    if(!data.message)throw new Error('记录不存在');entry.message={...data.message,detailsDeferred:false};
   }).catch(()=>{entry.error=true;}).finally(()=>{for(const fn of entry.listeners.values())fn();entry.listeners.clear();});
  }
  if(entry.message)return {...message,...entry.message};
  if(!entry.error)entry.listeners.set(owner,refresh);
  return {...message,detailsError:!!entry.error};
 }
 function placeholder(message: any,pane: any,refresh: any) {
  pane.innerHTML='<p class="wb-empty">'+(message.detailsError?'记录加载失败。<button type="button" data-details-retry>重试</button>':'正在加载完整记录…')+'</p>';
  pane.querySelector('[data-details-retry]')?.addEventListener('click',()=>{entries.delete(key(message));refresh();});
 }
 window.ShiYanMessageDetails={resolve,placeholder};
})();
