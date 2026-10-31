import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { handleAccountRequest } from './account-http.mjs';

export function createAccountSidecar(){
  return http.createServer(async(req,res)=>{
    if(await handleAccountRequest(req,res))return;
    res.writeHead(404,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({ok:false,error:'接口不存在'}));
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  createAccountSidecar().listen(Number(process.env.SHIYAN_ACCOUNTS_PORT||4331),'127.0.0.1',()=>console.log('Shiyan accounts ready'));
}
