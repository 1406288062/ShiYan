import { createHash } from 'node:crypto';
export function sendSyncAsset(res: any,url: any,asset: any,bytes: any){
 const headers={'Content-Type':asset.metadata.mimeType,'X-Content-SHA256':createHash('sha256').update(bytes).digest('hex'),'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(asset.metadata.filename)};
 if(url.searchParams.has('offset')){
  const start=Number(url.searchParams.get('offset')),length=Number(url.searchParams.get('length')||65536);
  if(!Number.isSafeInteger(start)||start<0||start>=bytes.length||!Number.isSafeInteger(length)||length<1||length>1048576){res.writeHead(416,{'Content-Range':`bytes */${bytes.length}`});return res.end();}
  const end=Math.min(bytes.length,start+length),chunk=bytes.subarray(start,end);
  res.writeHead(206,{...headers,'Content-Length':chunk.length,'Content-Range':`bytes ${start}-${end-1}/${bytes.length}`});return res.end(chunk);
 }
 res.writeHead(200,{...headers,'Content-Length':bytes.length});return res.end(bytes);
}
