import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
process.env.SHIYAN_GATEWAY_NO_LISTEN='1';
const {createMemberGateway}=await import('./member-gateway.ts');
const listen=server=>new Promise<number>(resolve=>server.listen(0,'127.0.0.1',()=>resolve((server.address() as any).port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
test('gateway routes authenticated members to isolated execution and preserves streamed responses',async()=>{
  const destination=label=>http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({label,url:req.url,spoof:req.headers['x-shiyan-owner']||null})+'\n\n');setImmediate(()=>res.end('data: done\n\n'));});
  const admin=destination('admin'),member=destination('member');let calls=0;
  const gateway=createMemberGateway({adminPort:await listen(admin),memberPort:await listen(member),authenticate:req=>{calls++;return req.headers.authorization==='Bearer ordinary'?{role:'user',serverAccess:false}:{role:'admin',serverAccess:true};}});
  try{
    const base='http://127.0.0.1:'+await listen(gateway);
    const a=await(await fetch(base+'/shiyan/v1/jobs/test/events?after=1',{headers:{authorization:'Bearer ordinary','x-shiyan-owner':'admin'}})).text();assert.match(a,/"label":"member"/);assert.match(a,/"spoof":null/);assert.match(a,/data: done/);
    const b=await(await fetch(base+'/shiyan/v1/capabilities',{headers:{authorization:'Bearer admin'}})).text();assert.match(b,/"label":"admin"/);
    const c=await(await fetch(base+'/shiyan/v1/workspace/bootstrap',{headers:{authorization:'Bearer admin'}})).text();assert.match(c,/"label":"member"/);
    const previous=calls;await fetch(base+'/shiyan/v1/health');assert.equal(calls,previous,'legacy nonce is not consumed by router');
  }finally{await Promise.all([close(gateway),close(admin),close(member)]);}
});

test('Sponge connection routes use the isolated destination for every account without matching adjacent names',async()=>{
  const destination=label=>http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({label,url:req.url,owner:req.headers['x-shiyan-owner']||null,dotsOwner:req.headers['x-dots-owner']||null}));});
  const admin=destination('admin'),member=destination('member');let authCalls=0;
  const gateway=createMemberGateway({adminPort:await listen(admin),memberPort:await listen(member),authenticate:req=>{authCalls++;return req.headers.authorization==='Bearer ordinary'?{role:'user',serverAccess:false}:{role:'admin',serverAccess:true};}});
  try{
    const base='http://127.0.0.1:'+await listen(gateway);
    for(const prefix of ['/v1','/shiyan/v1']){
      for(const suffix of ['/integrations/sponge','/integrations/sponge/status?after=1','/integrations/sponge/start','/integrations/sponge/disconnect','/integrations/sponge/unknown']){
        for(const authorization of ['Bearer admin','Bearer ordinary',undefined]){
          const headers={'x-shiyan-owner':'spoofed-owner','x-dots-owner':'spoofed-owner',...(authorization?{authorization}:{})};
          const value=(await(await fetch(base+prefix+suffix,{headers})).json()) as any;
          assert.equal(value.label,'member',authorization+' '+prefix+suffix);assert.equal(value.url,prefix+suffix);
          assert.equal(value.owner,null);assert.equal(value.dotsOwner,null);
        }
      }
      for(const suffix of ['/integrations/spongex/status','/integrations/sponge-other','/integrations/spongebob','/capabilities']){
        const value=(await(await fetch(base+prefix+suffix,{headers:{authorization:'Bearer admin'}})).json()) as any;assert.equal(value.label,'admin',prefix+suffix);
      }
    }
    const previous=authCalls;await fetch(base+'/shiyan/v1/integrations/sponge/status');assert.equal(authCalls,previous,'legacy proof is verified only at the destination');
  }finally{await Promise.all([close(gateway),close(admin),close(member)]);}
});
