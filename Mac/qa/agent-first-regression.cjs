
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('/Users/yu/codex/boss-job-copilot/node_modules/playwright-core');
const root='/Users/yu/claude code/image_enhancer';
const qa=path.join(root,'qa');
const ready=JSON.parse(fs.readFileSync('/tmp/shiyan-agent-first-ready.json','utf8'));
const tests=[],errors=[];
let browser,ctx,page;
async function test(name,fn){
  const start=Date.now();
  try{await fn();tests.push({name,ok:true,ms:Date.now()-start});console.log('PASS',name);}
  catch(e){tests.push({name,ok:false,ms:Date.now()-start,error:String(e)});console.log('FAIL',name,String(e));await page.screenshot({path:path.join(qa,'agent-first-fail-'+tests.length+'.png')}).catch(()=>{});}
}
async function view(){return page.evaluate(()=>window.shiyan.getView());}
async function shot(label){await page.screenshot({path:path.join(qa,'agent-first-'+label+'.png'),animations:'disabled'});}
async function backToAgent(){await page.locator('#backToAgentButton').click();await page.waitForFunction(()=>window.shiyan.getView()==='agent');}
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 ctx=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,acceptDownloads:true});
 page=await ctx.newPage();page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(ready.url,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.shiyan?.getState()?.conversations?.length>0,null,{timeout:45000});
 await test('Agent is the launch/home screen',async()=>{
   assert.equal(await view(),'agent');
   assert(await page.locator('#agentView').isVisible());
   assert(await page.locator('#homeView').isHidden());
   assert(await page.locator('#messageInput').isVisible());
   assert(await page.locator('#agentNavButton').isVisible());
   assert(!await page.locator('#openSidebarButton').isVisible());
   await shot('agent-wide');
 });
 await test('Desktop permanent left sidebar and chat have separate areas',async()=>{
   const layout=await page.evaluate(()=>{
     const s=document.querySelector('#agentSidebar').getBoundingClientRect(),c=document.querySelector('#chatPanel').getBoundingClientRect();
     return {side:[s.left,s.right,s.width],chat:[c.left,c.right,c.width],overflow:document.documentElement.scrollWidth>innerWidth};
   });
   assert(layout.side[2]>=240&&layout.side[2]<=340,JSON.stringify(layout));
   assert(layout.chat[0]>=layout.side[1]-2,JSON.stringify(layout));
   assert(layout.chat[2]>750&&!layout.overflow,JSON.stringify(layout));
 });
 await test('Enhancer is secondary, not a parallel home entry',async()=>{
   await page.locator('#openEnhancerButton').click();
   assert.equal(await view(),'home');
   assert(await page.locator('#homeView').isVisible());
   assert.equal(await page.locator('nav#featureStrip button').count(),0);
   assert(await page.locator('#modelSelector').isVisible());
   assert(await page.getByRole('heading',{name:'增强设置'}).isVisible());
   assert(!await page.getByText('AI 消除',{exact:true}).count());
   assert(!await page.getByText('老照片上色',{exact:true}).count());
   const dims=await page.evaluate(()=>({w:document.querySelector('.home-workspace').getBoundingClientRect(),p:document.querySelector('#toolPanel').getBoundingClientRect()}));
   assert(dims.w.right<=dims.p.left+1,JSON.stringify(dims));
   await shot('enhancer-wide');
 });
 await test('Enhancer returns to Agent without losing conversation',async()=>{
   const previous=await page.evaluate(()=>window.shiyan.getState().selectedConversationId);
   await backToAgent();
   assert.equal(await page.evaluate(()=>window.shiyan.getState().selectedConversationId),previous);
   assert(await page.locator('#messageInput').isVisible());
 });
 await test('Agent toolbar also opens enhancement',async()=>{
   await page.locator('#closeAgentButton').click();
   assert.equal(await view(),'home');
   await backToAgent();
 });
 await test('History is accessible and back returns to original view',async()=>{
   await page.locator('#openHistoryToolButton').click();
   assert.equal(await view(),'history');
   await page.locator('#historyBackButton').click();
   assert.equal(await view(),'agent');
   await page.locator('#openEnhancerButton').click();
   await page.locator('#historyButton').click();
   assert.equal(await view(),'history');
   await page.locator('#historyBackButton').click();
   assert.equal(await view(),'home');
 });
 await test('Discontinued remote photo features reject new API jobs',async()=>{
   const result=await page.evaluate(async()=>{
     const responses=[];
     for(const feature of ['remove','colorize']){
       const r=await fetch('/api/photo/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Shiyan-Local':'1'},body:JSON.stringify({feature,assetId:'none'})});
       responses.push({status:r.status,data:await r.json()});
     }
     return responses;
   });
   assert(result.every(x=>x.status>=400 && JSON.stringify(x.data).includes('已下线')),JSON.stringify(result));
 });
 await test('Real 4x enhancement works from secondary tool',async()=>{
   const fixture=path.join(qa,'fixtures/enhance-input.png');
   assert(fs.existsSync(fixture));
   await page.locator('#homeFileInput').setInputFiles(fixture);
   await page.waitForFunction(()=>!document.querySelector('#homeImage').hidden&&document.querySelector('#homeImage').naturalWidth>0);
   const before=await page.evaluate(()=>window.shiyan.getState().history.length);
   await page.locator('#processButton').click();
   await page.waitForFunction(n=>window.shiyan.getState().history.length>n,before,{timeout:130000});
   await page.waitForFunction(()=>!document.querySelector('#saveResultButton').hidden,null,{timeout:10000});
   assert((await page.locator('#imageDimensions').innerText()).includes('256'));
   await shot('enhancer-processed');
   await backToAgent();
 });
 await test('Compact native window keeps horizontal Agent layout',async()=>{
   await page.setViewportSize({width:780,height:660});
   assert.equal(await view(),'agent');
   const layout=await page.evaluate(()=>{
     const s=document.querySelector('#agentSidebar').getBoundingClientRect(),c=document.querySelector('#chatPanel').getBoundingClientRect();
     return {sidebar:s.width,chat:c.width,x:c.left,overflow:document.documentElement.scrollWidth>innerWidth};
   });
   assert(layout.sidebar>=240&&layout.chat>=480&&!layout.overflow,JSON.stringify(layout));
   assert(await page.locator('#openEnhancerButton').isVisible());
   await shot('agent-compact');
 });
 await test('Narrow viewport retains drawer navigation',async()=>{
   await page.setViewportSize({width:690,height:790});
   assert(await page.locator('#openSidebarButton').isVisible());
   await page.locator('#openSidebarButton').click();
   assert(await page.locator('#openEnhancerButton').isVisible());
   await page.locator('#openEnhancerButton').click();
   assert.equal(await view(),'home');
   await backToAgent();
 });
 await test('Dark mode remains readable',async()=>{
   await page.setViewportSize({width:1440,height:900});
   await page.emulateMedia({colorScheme:'dark'});
   const background=await page.locator('#chatPanel').evaluate(el=>getComputedStyle(el).backgroundColor);
   assert.notEqual(background,'rgb(255, 255, 255)');
   await shot('agent-dark');
 });
 fs.writeFileSync(path.join(qa,'agent-first-regression.json'),JSON.stringify({url:ready.url,tests,errors,passed:tests.filter(x=>x.ok).length,failed:tests.filter(x=>!x.ok).length},null,2)+'\n');
 await browser.close();
 console.log(JSON.stringify({passed:tests.filter(x=>x.ok).length,failed:tests.filter(x=>!x.ok).length,errors},null,2));
 process.exit(tests.some(x=>!x.ok)||errors.length?1:0);
})().catch(async error=>{console.error(error);await browser?.close().catch(()=>{});process.exit(2)});
