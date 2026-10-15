const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('/Users/yu/codex/boss-job-copilot/node_modules/playwright-core');
const root='/Users/yu/claude code/image_enhancer';
const qa=path.join(root,'qa/ui-polish-run');
const config=JSON.parse(fs.readFileSync(process.env.SHIYAN_QA_RUN_CONFIG||path.join(qa,'run.json'),'utf8'));
const tests=[],errors=[];let browser,page,ctx,token,projectId;
async function test(name,fn){let started=Date.now();try{await fn();tests.push({name,ok:true,ms:Date.now()-started});console.log('PASS',name);}catch(e){tests.push({name,ok:false,error:String(e),ms:Date.now()-started});console.log('FAIL',name,String(e));await page.screenshot({path:path.join(qa,'failure-'+tests.length+'.png')}).catch(()=>{});}}
const layout=()=>page.evaluate(()=>window.workbench.getLayout());
async function request(endpoint,method='GET',body,headers={}){const r=await ctx.request.fetch(config.url.replace(/\/$/,'')+endpoint,{method,headers:{'X-Shiyan-Local':'1','X-Shiyan-Workspace':token||'',...headers},data:body});return {status:r.status(),body:await r.json()};}
async function shot(name){await page.screenshot({path:path.join(qa,name+'.png'),animations:'disabled'});}
async function rect(selector){return page.locator(selector).boundingBox();}
async function waitFor(predicate,arg){await page.waitForFunction(predicate,arg,{timeout:15000});}
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 ctx=await browser.newContext({viewport:{width:1536,height:986},deviceScaleFactor:1,acceptDownloads:true});
 page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(config.url,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.workbench?.ready&&window.shiyan?.getState()?.conversations?.length>0,null,{timeout:45000});
 const boot=await request('/api/workspace/bootstrap','POST',{});assert.equal(boot.status,200);token=boot.body.token;
 await test('Default AI Coding, true three-region layout and far-left sibling tools',async()=>{
   assert.equal(await page.evaluate(()=>window.shiyan.getView()),'agent');
   assert.equal(await page.locator('#activityRail button').count(),3);
   assert(await page.locator('#railEnhance').isVisible());assert(await page.locator('#railHistory').isVisible());
   assert.equal(await page.locator('.workspace-navigation').count(),0);
   const l=await layout(),r=l.rects;assert(r.activityRail.width>=45&&r.activityRail.width<=56);assert(r.leftContainer.width>220);
   assert(r.mainWorkspace.x>=r.leftContainer.x+r.leftContainer.width-1);assert(r.rightWorkspace.x>=r.mainWorkspace.x+r.mainWorkspace.width-1);
   assert.equal(await page.locator('#chatPanel').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
   assert(await page.locator('#browserAddress').isVisible());await shot('home-1536');
 });
 await test('Logo / fixed New Chat / pinned / projects / recents in required order',async()=>{
   const selectors=['.sidebar-header','#newConversationButton','#pinnedGroup','#projectsGroup','#recentGroup'];const positions=[];
   for(const s of selectors){const r=await rect(s);assert(r,s);positions.push(r.y);}assert(positions.every((n,i)=>i===0||n>=positions[i-1]));
   const before=await page.evaluate(()=>window.shiyan.getState().conversations.length);
   await page.locator('#newConversationButton').click();await waitFor(n=>window.shiyan.getState().conversations.length===n+1,before);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'messageInput');
 });
 await test('All three sidebar groups fold independently',async()=>{
   for(const id of ['pinnedGroup','projectsGroup','recentGroup']){await page.locator('#'+id+' > summary').click();assert.equal(await page.locator('#'+id).evaluate(e=>e.open),false);await page.locator('#'+id+' > summary').click();assert.equal(await page.locator('#'+id).evaluate(e=>e.open),true);}
 });
 await test('Left and right independently fold and center expands',async()=>{
   const first=(await layout()).rects.mainWorkspace.width;
   await page.locator('#toggleLeftSidebar').click();assert.equal((await layout()).leftOpen,false);assert((await layout()).rects.mainWorkspace.width>first);
   await page.locator('#toggleRightWorkspace').click();assert.equal((await layout()).rightOpen,false);assert((await layout()).rects.mainWorkspace.width>1400);
   assert(await page.locator('#activityRail').isVisible());await page.locator('#toggleLeftSidebar').click();await page.locator('#toggleRightWorkspace').click();
 });
 await test('Composer focus has no width, height or panel scaling changes',async()=>{
   await page.locator('#workspaceTitle').click();const before=await rect('#composerSurface'),main=await rect('#mainWorkspace');
   await page.locator('#messageInput').focus();await page.waitForTimeout(350);const after=await rect('#composerSurface');
   for(const k of ['x','y','width','height'])assert(Math.abs(before[k]-after[k])<2,JSON.stringify({before,after}));assert.deepEqual(await rect('#mainWorkspace'),main);
 });
 await test('Enhancement and unified history are separate rail destinations',async()=>{
   await page.locator('#railEnhance').click();assert.equal(await page.evaluate(()=>window.shiyan.getView()),'home');
   assert.equal(await page.locator('#historyButton').count(),0);assert(await page.locator('#modelSelector').isVisible());
   assert.equal(await page.locator('[data-feature="remove"],[data-feature="colorize"]').count(),0);await shot('enhance');
   await page.locator('#railHistory').click();assert.equal(await page.evaluate(()=>window.shiyan.getView()),'history');
   await page.locator('#railHome').click();
 });
 await test('Existing project import, project chat association and directory tree',async()=>{
   await page.locator('#addProjectButton').click();await page.locator('#projectName').fill('工作台回归项目');await page.locator('#projectPath').fill(config.fixtureProject);await page.locator('#submitProject').click();
   await waitFor(()=>window.workbench.getLayout().projects.some(p=>p.name==='工作台回归项目'));
   projectId=(await layout()).projects.find(p=>p.name==='工作台回归项目').id;
   await waitFor(id=>window.shiyan.getState().conversations.find(c=>c.id===window.shiyan.getState().selectedConversationId)?.projectId===id,projectId);
   await page.getByRole('button',{name:'hello.py',exact:true}).waitFor({state:'visible'});
   const before=await page.evaluate(()=>window.shiyan.getState().conversations.length);await page.locator('#newConversationButton').click();
   await waitFor(n=>window.shiyan.getState().conversations.length===n+1,before);
   assert.equal(await page.evaluate(()=>window.shiyan.getState().conversations.find(c=>c.id===window.shiyan.getState().selectedConversationId).projectId),projectId);
 });
 await test('Read code, syntax highlighting and explicitly add bounded context to draft',async()=>{
   await page.getByRole('button',{name:'hello.py',exact:true}).click();await page.locator('.workspace-pane:not([hidden]) .source-code').waitFor();
   assert((await page.locator('.workspace-pane:not([hidden]) .source-code').innerText()).includes('你好，拾燕'));
   assert(await page.locator('.workspace-pane:not([hidden]) .syntax-string').count()>0);
   await page.locator('.workspace-pane:not([hidden]) [data-context-file]').click();assert((await page.locator('#messageInput').inputValue()).includes('你好，拾燕'));
   assert.equal(await page.evaluate(()=>window.shiyan.getState().conversations.find(c=>c.id===window.shiyan.getState().selectedConversationId).messages.length),0);
   await shot('code-file');
 });
 await test('Unsafe local HTML is displayed as inert code, not executed',async()=>{
   await page.evaluate(()=>window.workbench.openTool('files'));await page.getByRole('button',{name:'unsafe.html',exact:true}).click();await page.locator('.workspace-pane:not([hidden]) .source-code').waitFor();
   assert.equal(await page.evaluate(()=>window.badMarkupExecuted),undefined);assert((await page.locator('.workspace-pane:not([hidden]) .source-code').innerText()).includes('<script>'));
 });
 await test('Project traversal and outside symlink rejected; binary/large files bounded',async()=>{
   for(const p of ['../../../../../../etc/hosts','outside-link']){const r=await request('/api/workspace/files/read','POST',{projectId,path:p});assert.equal(r.status,403,JSON.stringify(r));}
   assert.equal((await request('/api/workspace/files/read','POST',{projectId,path:'large.txt'})).body.file.kind,'large');
   assert.equal((await request('/api/workspace/files/read','POST',{projectId,path:'binary.bin'})).body.file.kind,'binary');
   assert.equal((await request('/api/workspace/files/read','POST',{projectId,path:'.env.test'})).body.file.sensitive,true);
 });
 await test('Missing/invalid capability, foreign Origin and Host rejected',async()=>{
   const target='/api/workspace/projects';
   assert.equal((await request(target,'GET',undefined,{'X-Shiyan-Workspace':''})).status,403);
   assert.equal((await request(target,'GET',undefined,{'X-Shiyan-Workspace':'not-valid'})).status,403);
   assert.equal((await request(target,'GET',undefined,{'Origin':'https://untrusted.example'})).status,403);
   assert.equal((await request(target,'GET',undefined,{'Host':'untrusted.example'})).status,403);
   assert.equal((await request('/api/workspace/bootstrap','POST',{}, {'X-Shiyan-Local':''})).status,403);
 });
 await test('New named project creates actual folder, duplicate directory not overwritten',async()=>{
   const name='new-project-'+Date.now();const r=await request('/api/workspace/projects','POST',{name,path:qa,create:true});assert.equal(r.status,200);assert(fs.statSync(path.join(qa,name)).isDirectory());
   const again=await request('/api/workspace/projects','POST',{name,path:qa,create:true});assert(again.status>=400);
 });
 await test('Real local PTY: project cwd, Unicode, streamed output, Ctrl-C',async()=>{
   await page.evaluate(()=>window.workbench.openTool('terminal'));await page.waitForFunction(()=>window.workbench.getLayout().terminals.length>0,null,{timeout:15000});
   const first=(await layout()).terminals.at(-1);assert(first.pid>1);assert(first.id);assert(await page.locator('.workspace-pane:not([hidden]) .xterm').isVisible());
   const input=page.locator('.workspace-pane:not([hidden]) .xterm-helper-textarea');await input.focus();
   await page.keyboard.type("pwd; printf '%s%s\\n' SHIYAN_ PTY_OK; python3 -c 'print(chr(20013)+chr(25991)+chr(32456)+chr(31471))'");await page.keyboard.press('Enter');
   await waitFor(()=>document.querySelector('.workspace-pane:not([hidden]) .xterm-screen')?.textContent.includes('SHIYAN_PTY_OK'));
   await waitFor(()=>document.querySelector('.workspace-pane:not([hidden]) .xterm-screen')?.textContent.includes('中文终端'));
   const output=await page.locator('.workspace-pane:not([hidden]) .xterm-screen').textContent();assert.equal(await page.locator('.workspace-pane:not([hidden]) .terminal-status').getAttribute('title'),config.fixtureProject);
   await page.keyboard.type('sleep 30');await page.keyboard.press('Enter');await page.waitForTimeout(300);await page.keyboard.press('Control+c');
   await page.keyboard.type("printf '%s%s\\n' CTRL_ C_OK");await page.keyboard.press('Enter');await waitFor(()=>document.querySelector('.workspace-pane:not([hidden]) .xterm-screen')?.textContent.includes('CTRL_C_OK'));
   await shot('terminal-real');
 });
 await test('Closing terminal terminates only its owned shell',async()=>{
   const l=await layout(),s=l.terminals.at(-1);await page.locator('[data-close-tab="'+l.activeTab+'"]').click();
   await waitFor(id=>!window.workbench.getLayout().terminals.some(t=>t.id===id),s.id);
   let exited=false;try{process.kill(s.pid,0);}catch(e){exited=e.code==='ESRCH';}assert(exited,'PTY shell still exists');
 });
 await test('Browser tabs new/close and history/settings are distinct from image history',async()=>{
   await page.locator('#addWorkspaceTab').click();const n=(await layout()).tabCount;await page.locator('#addWorkspaceTab').click();assert.equal((await layout()).tabCount,n+1);
   await page.locator('.workspace-tab.selected [data-close-tab]').click();assert.equal((await layout()).tabCount,n);
   await page.locator('.workspace-pane:not([hidden]) [data-workspace-tool="settings"]').click();assert(await page.locator('#searchEngineSelect').isVisible());
   await page.locator('#railHistory').click();assert.equal(await page.evaluate(()=>window.shiyan.getView()),'history');assert(await page.locator('#searchEngineSelect').isVisible());await page.locator('#railHome').click();
 });
 await test('Sidebar folding, projects, and tabs persist across reload',async()=>{
   await page.locator('#toggleLeftSidebar').click();await page.locator('#toggleRightWorkspace').click();await page.waitForTimeout(500);const old=await layout();
   await page.reload({waitUntil:'domcontentloaded'});await waitFor(()=>window.workbench?.ready);const got=await layout();assert.equal(got.leftOpen,false);assert.equal(got.rightOpen,false);assert.equal(got.tabCount,old.tabCount);assert(got.projects.some(p=>p.id===projectId));
   await page.locator('#toggleLeftSidebar').click();await page.locator('#toggleRightWorkspace').click();
 });
 await test('Visual proportions and adaptive window widths 1536 / 1440 / 1180 / 780',async()=>{
   for(const [width,height] of [[1536,986],[1440,900],[1180,840],[780,660]]) {
     await page.setViewportSize({width,height});await page.waitForTimeout(110);
     const l=await layout(),r=l.rects;
     const actual=await page.evaluate(()=>({left:!document.getElementById('leftContainer').hidden,right:!document.getElementById('rightWorkspace').hidden}));
     assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
     if(width>=1140){
       assert(actual.left&&actual.right,JSON.stringify({width,l,actual}));
       assert(r.mainWorkspace.width >= (width===1536?600:width===1440?590:500),JSON.stringify({width,l}));
       assert(r.mainWorkspace.x>=r.leftContainer.x+r.leftContainer.width-1,JSON.stringify({width,l}));
       assert(r.rightWorkspace.x>=r.mainWorkspace.x+r.mainWorkspace.width-1,JSON.stringify({width,l}));
       assert(r.mainWorkspace.width>r.rightWorkspace.width,JSON.stringify({width,l}));
       await page.locator('#addWorkspaceTab').click();
     }else{
       assert(actual.left&&!actual.right,JSON.stringify({width,l,actual}));
       assert(r.mainWorkspace.width>=470,JSON.stringify({width,l}));
       await shot('home-'+width);
       await page.locator('#toggleRightWorkspace').click();
       const opened=await page.evaluate(()=>({left:!document.getElementById('leftContainer').hidden,right:!document.getElementById('rightWorkspace').hidden}));
       assert(!opened.left&&opened.right,JSON.stringify(opened));
       assert((await layout()).rects.mainWorkspace.width>=390);
       await page.locator('#addWorkspaceTab').click();
       await shot('right-'+width);
       await page.locator('#toggleLeftSidebar').click();
       const restored=await page.evaluate(()=>({left:!document.getElementById('leftContainer').hidden,right:!document.getElementById('rightWorkspace').hidden}));
       assert(restored.left&&!restored.right,JSON.stringify(restored));
       continue;
     }
     await page.locator('#railHome').click();
     await shot('home-'+width);
   }
 });
 await test('Pure visual polish keeps code legible and duplicate logo removed',async()=>{
   assert.equal(await page.locator('#activityRail .rail-logo').count(),0);
   const font=await page.locator('.code-reader').first().evaluate(el=>getComputedStyle(el).fontSize).catch(()=>null);
   assert(font===null||parseFloat(font)>=12);
   await page.locator('#toggleRightWorkspace').click();
   const rightVisible=await page.locator('#rightWorkspace').isVisible();
   assert(rightVisible);
   await page.locator('#addWorkspaceTab').click();
   const metrics=await page.locator('.browser-start').last().evaluate(el=>{
     const a=el.querySelector('.browser-tool-grid button'),b=el.querySelector('.browser-shortcuts button');
     return {a:Math.round(a?.getBoundingClientRect().height||0),b:Math.round(b?.getBoundingClientRect().height||0)};
   });
   assert(Math.abs(metrics.a-metrics.b)<=2,JSON.stringify(metrics));
 });
 await test('Desktop colors remain readable under dark system setting',async()=>{
   await page.setViewportSize({width:1440,height:900});await page.emulateMedia({colorScheme:'dark'});assert.equal(await page.locator('#chatPanel').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');await shot('dark-system');await page.emulateMedia({colorScheme:'light'});
 });
 await test('No JavaScript runtime errors',async()=>{assert.deepEqual(errors,[]);});
 const result={tests,errors,passed:tests.filter(t=>t.ok).length,failed:tests.filter(t=>!t.ok).length,scope:'Isolated source backend with actual filesystem and PTY; native browser tested separately'};
 fs.writeFileSync(path.join(qa,'ui-polish-regression.json'),JSON.stringify(result,null,2));await browser.close();console.log(JSON.stringify({passed:result.passed,failed:result.failed,errors}));process.exit(result.failed?1:0);
})().catch(async e=>{console.error(e);fs.writeFileSync(path.join(qa,'regression-fatal.txt'),String(e)+'\n');await browser?.close();process.exit(2)});
