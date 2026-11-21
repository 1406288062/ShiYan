// Account-aware transport routing. The administrative runtime stays independent
// of the isolated runtime, including during upgrades and long-running jobs.
import http from 'node:http';
import {authenticateDevice} from './device-auth.ts';

export function createMemberGateway({authenticate=authenticateDevice,adminPort=4323,memberPort=4350}={}){
  return http.createServer((req,res)=>{
    // Legacy device proofs are single-use; leave their verification to the
    // administrative destination instead of consuming the nonce twice.
    let auth;if(req.headers.authorization!==undefined)try{auth=authenticate(req);}catch{}
    const pathname=(req.url||'').split('?')[0].replace(/^\/shiyan/,'');
    const sponge=pathname==='/v1/integrations/sponge'||pathname.startsWith('/v1/integrations/sponge/');
    const member=sponge||pathname.startsWith('/v1/workspace/')||Boolean(auth&&(auth.role!=='admin'||auth.serverAccess!==true));
    const headers={...req.headers};delete headers['x-dots-owner'];delete headers['x-shiyan-owner'];
    // Authentication is repeated by the destination; no client-supplied owner
    // or upstream selection is trusted.
    const upstream=http.request({hostname:'127.0.0.1',port:member?memberPort:adminPort,path:req.url,method:req.method,headers},response=>{
      res.writeHead(response.statusCode!,response.headers);response.pipe(res);
      response.on('error',()=>res.destroy());
    });
    upstream.on('error',()=>{if(res.headersSent){res.destroy();return;}res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:false,error:'服务暂不可用，请稍后重试'}));});
    req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
  });
}
if(process.env.SHIYAN_GATEWAY_NO_LISTEN!=='1')createMemberGateway().listen(Number(process.env.SHIYAN_GATEWAY_PORT||4349),'127.0.0.1',()=>console.log('Shiyan account gateway ready'));
