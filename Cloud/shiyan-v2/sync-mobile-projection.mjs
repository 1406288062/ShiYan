// Preserve reply text and attachments; fetch full execution records on demand.
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const preview=(text,limit)=>{
  const data=Buffer.from(text);if(data.length<=limit)return text;
  return data.subarray(0,Math.max(0,limit-80)).toString('utf8').replace(/\uFFFD$/,'')+'\n…（完整内容按需加载）';
};
export function mobileSyncChange(change){
  if(change.kind!=='messages'||change.deleted)return change;
  const data={...change.data};let details=data.executionDetailsAvailable===true;
  if(typeof data.rawResult==='string'&&data.rawResult.trim()&&data.rawResult!=='[]')details=true;
  data.rawResult=null;
  if(Array.isArray(data.fileChanges)){
    let remaining=16*1024;
    data.fileChanges=data.fileChanges.map(file=>{
      if(!file||typeof file.diff!=='string')return file;
      const original=file.diff,limit=Math.min(4096,remaining);
      const diff=limit>=80?preview(original,limit):'';
      remaining=Math.max(0,remaining-Buffer.byteLength(diff));
      if(diff===original)return file;
      details=true;return {...file,diff,diffTruncated:true};
    });
  }
  if(Array.isArray(data.displayItems)){
    const items=data.displayItems.map(item=>({...item}));
    for(let i=0;i<items.length&&bytes(items)>24*1024;i++){
      for(const key of ['aggregated_output','result_text'])if(items[i][key]){items[i][key]='…（完整内容按需加载）';details=true;}
    }
    while(items.length&&bytes(items)>24*1024){items.shift();details=true;}
    data.displayItems=items;
  }
  data.executionDetailsAvailable=details;
  return {...change,data};
}
