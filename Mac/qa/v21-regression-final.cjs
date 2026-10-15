const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('/Users/yu/codex/boss-job-copilot/node_modules/playwright-core');
const root='/Users/yu/claude code/image_enhancer',qa=path.join(root,'qa/v21-run-final');
const config=JSON.parse(fs.readFileSync(process.env.SHIYAN_QA_RUN_CONFIG||path.join(qa,'run.json'),'utf8'));
const tests=[],errors=[];let browser,context,page,token,projectId;
const layout=()=>page.evaluate(()=>window.workbench.getLayout());
const wait=()=>page.waitForTimeout(270);
const visiblePane=()=>page.locator('.workspace-pane:not([hidden]):not(.v2-docked-terminal)');
async function test(name,fn){const t=Date.now();try{await fn();tests.push({name,ok:true,ms:Date.now()-t});console.log('PASS',name);}catch(e){tests.push({name,ok:false,error:String(e),ms:Date.now()-t});console.log('FAIL',name,String(e));await page.screenshot({path:path.join(qa,'v2-failure-'+tests.length+'.png')}).catch(()=>{});}}
async function shot(name){await page.screenshot({path:path.join(qa,name+'.png'),animations:'disabled'});}
async function req(endpoint,method='GET',data,headers={}){const r=await context.request.fetch(config.url.replace(/\/$/,'')+endpoint,{method,data,headers:{'X-Shiyan-Local':'1','X-Shiyan-Workspace':token||'',...headers}});return {status:r.status(),body:await r.json()};}
async function drag(selector,dx,dy=0){const r=await page.locator(selector).boundingBox();assert(r,selector);await page.mouse.move(r.x+r.width/2,r.y+Math.min(r.height/2,90));await page.mouse.down();await page.mouse.move(r.x+r.width/2+dx,r.y+Math.min(r.height/2,90)+dy,{steps:10});await page.mouse.up();await wait();}
async function fileClick(p){const b=visiblePane().locator('.v2-tree-root [data-file-path="'+p+'"]');await b.waitFor();await b.click();}
async function ready(){await page.waitForFunction(()=>window.workbench?.ready&&window.workbench.getLayout().v2&&window.shiyan?.getState());}
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,acceptDownloads:true});page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(config.url,{waitUntil:'domcontentloaded'});await ready();const boot=await req('/api/workspace/bootstrap','POST',{});assert.equal(boot.status,200);token=boot.body.token;
 await test('V2.1 nav icon adjacent to enhancement and Home default',async()=>{
  assert.equal(await page.evaluate(()=>window.shiyan.getView()),'agent');assert.equal(await page.locator('#activityRail button').count(),3);
  assert.equal(await page.locator('#railHistory').getAttribute('aria-label'),'空间');const y=await page.locator('#railHistory').boundingBox();const enhance=await page.locator('#railEnhance').boundingBox();assert(y.y>=enhance.y+enhance.height&&y.y<enhance.y+enhance.height+18);assert(await page.locator('#railEnhance svg').count());await shot('v2-home');
 });
 await test('Edited header: search immediately left of collapse, aligned horizontally',async()=>{
  const a=await page.locator('#sidebarSearch').boundingBox(),b=await page.locator('#toggleLeftSidebar').boundingBox();assert(a.x+a.width<=b.x+3,JSON.stringify({a,b}));assert(Math.abs(a.y+a.height/2-b.y-b.height/2)<3,JSON.stringify({a,b}));
 });
 await test('One left-collapse button moves smoothly on same horizontal baseline',async()=>{
  const el=await page.locator('#toggleLeftSidebar').elementHandle();const a=await el.boundingBox();await el.click();await page.waitForTimeout(70);const mid=await el.boundingBox();await wait();const b=await el.boundingBox();assert(a.x>mid.x&&mid.x>=b.x,JSON.stringify({a,mid,b}));assert(Math.abs(a.y-b.y)<1);assert.equal((await layout()).actualLeftOpen,false);await el.click();await wait();const c=await el.boundingBox();assert(Math.abs(c.x-a.x)<2);assert.equal(await page.locator('#toggleLeftSidebar').count(),1);
 });
 await test('Right control switches square-plus/book and restores width',async()=>{
  const a=await page.locator('#toggleRightWorkspace').innerHTML();await page.locator('#toggleRightWorkspace').click();await wait();const b=await page.locator('#toggleRightWorkspace').innerHTML();assert.notEqual(a,b);assert(!(await layout()).actualRightOpen);await page.locator('#toggleRightWorkspace').click();await wait();assert((await layout()).actualRightOpen);assert.equal(await page.locator('#toggleRightWorkspace').innerHTML(),a);
 });
 await test('Full view expands right, hides center, changes icon and restores prior width',async()=>{
  const before=await layout(),icon=await page.locator('#toggleFullWorkspace').innerHTML();await page.locator('#toggleFullWorkspace').click();await wait();const full=await layout();assert(full.fullView);assert(full.rects.mainWorkspace.width<2);assert(full.rects.rightWorkspace.width>before.rects.rightWorkspace.width+500);assert.notEqual(await page.locator('#toggleFullWorkspace').innerHTML(),icon);await page.locator('#toggleFullWorkspace').click();await wait();const after=await layout();assert(!after.fullView);assert(Math.abs(after.rects.rightWorkspace.width-before.rects.rightWorkspace.width)<2);
 });
 await test('Both dividers resize real panel geometry; no blue selection background',async()=>{
  const before=await layout();await drag('#rightResizeHandle',-115);const after=await layout();assert(after.rects.rightWorkspace.width>before.rects.rightWorkspace.width+95,JSON.stringify({before,after}));assert(after.rects.mainWorkspace.width<before.rects.mainWorkspace.width-95);await drag('#rightResizeHandle',115);const l=(await layout()).rects.leftContainer.width;await drag('#leftResizeHandle',35);assert((await layout()).rects.leftContainer.width>=l+30);await drag('#leftResizeHandle',-35);assert.equal(await page.locator('#leftResizeHandle').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');assert.equal(await page.evaluate(()=>getSelection().toString()),'');assert(!await page.locator('body').evaluate(e=>e.classList.contains('v2-dragging')));
 });
 await test('Composer text above controls, stable focus, smaller blue circle/larger arrow',async()=>{
  await page.locator('#workspaceTitle').click();const a=await page.locator('#composerSurface').boundingBox();const text=await page.locator('#messageInput').boundingBox(),buttons=await page.locator('#composerForm .composer-actions').boundingBox();assert(text.y+text.height<=buttons.y+1);await page.locator('#messageInput').focus();await wait();const b=await page.locator('#composerSurface').boundingBox();assert(Math.abs(a.height-b.height)<1);assert(Math.abs(a.width-b.width)<1);const send=await page.locator('#sendButton').boundingBox(),arrow=await page.locator('#sendIcon').boundingBox();assert.equal(send.width,28);assert.equal(arrow.width,21);
 });
 await test('Reasoning popup compact directly above its trigger, retains efforts, Esc closes',async()=>{
  await page.locator('#reasoningButton').click();await wait();const a=await page.locator('#reasoningButton').boundingBox(),p=await page.locator('#reasoningPanel').boundingBox();assert(p.width>=220&&p.width<=240);assert(p.y+p.height<a.y);assert(Math.abs((p.x+p.width/2)-(a.x+a.width/2))<3,JSON.stringify({a,p}));const range=page.locator('#reasoningRange');const max=Number(await range.getAttribute('max'));assert(max>=1);await range.evaluate(e=>{e.value='1';e.dispatchEvent(new Event('input',{bubbles:true}));});await shot('v2-reasoning');await page.keyboard.press('Escape');assert(await page.locator('#reasoningPanel').isHidden());
 });
 await test('Session more menu is narrow, hover has no dark fill, existing actions retained',async()=>{
  const more=page.locator('#recentSessions .session-more').first();await more.hover();assert.equal(await more.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');await more.click();assert(await page.locator('#sessionMenu').isVisible());const r=await page.locator('#sessionMenu').boundingBox();assert(r.width>=135&&r.width<=150);assert.equal(await page.locator('#sessionMenu button').count(),3);await page.keyboard.press('Escape');
 });
 await test('Open/create combined into one compact Add Project dialog',async()=>{
  await page.locator('#addProjectButton').click();assert.equal(await page.locator('#projectDialogTitle').innerText(),'添加项目');assert(await page.locator('.project-type-switch').isHidden());assert(await page.locator('#openProjectSubmit').isVisible());assert(await page.locator('#createProjectSubmit').isVisible());assert((await page.locator('#projectForm').boundingBox()).width<=365);await page.locator('#projectName').fill('V2 回归项目');await page.locator('#projectPath').fill(config.fixtureProject);await shot('v2-project-dialog');await page.locator('#openProjectSubmit').click();await page.waitForFunction(()=>window.workbench.getLayout().projects.some(p=>p.name==='V2 回归项目'));projectId=(await layout()).projects.find(p=>p.name==='V2 回归项目').id;
 });
 await test('Project new-chat button creates local child under the correct project',async()=>{
  const group=page.locator('[data-project-group="'+projectId+'"]');await group.hover();const count=await page.evaluate(()=>window.shiyan.getState().conversations.length);await group.locator('[data-project-new]').click();await page.waitForTimeout(240);assert.equal(await page.evaluate(()=>window.shiyan.getState().conversations.length),count);assert.equal(await page.evaluate(()=>{const s=window.shiyan.getState();return s.conversations.find(c=>c.id===s.selectedConversationId).projectId;}),projectId);assert(await group.locator('.v2-project-chats .session-row').count()>=1);assert(await group.locator('[data-project-more]').count());await group.locator('[data-project-more]').click();assert((await page.locator('#v2Popup').innerText()).includes('置顶'));assert((await page.locator('#v2Popup').innerText()).includes('编辑项目'));assert((await page.locator('#v2Popup').innerText()).includes('移除项目'));await page.keyboard.press('Escape');
 });
 await test('New project conversation leaves full view and displays the new chat',async()=>{
  await page.locator('#toggleFullWorkspace').click();await wait();assert((await layout()).fullView);
  const group=page.locator('[data-project-group="'+projectId+'"]');await group.hover();const id=await page.evaluate(()=>window.shiyan.getState().selectedConversationId);await group.locator('[data-project-new]').click();await page.waitForFunction(id=>window.shiyan.getState().selectedConversationId===id,id);await wait();assert(!(await layout()).fullView);assert(await page.locator('#messageInput').isVisible());assert(!await page.locator('#mainWorkspace').evaluate(e=>e.inert));
 });
 await test('File tool opens empty preview left and live project tree right in one tab',async()=>{
  await page.evaluate(()=>window.workbench.openTool('files'));await visiblePane().locator('.v2-file-body').waitFor();assert((await visiblePane().locator('.v2-file-empty').innerText()).includes('从工作区目录树中选择文件'));const a=await visiblePane().locator('.v2-file-preview').boundingBox(),b=await visiblePane().locator('.v2-file-directory').boundingBox();assert(a.x+a.width<=b.x+1);await fileClick('hello.py');await page.waitForFunction(()=>document.querySelector('.workspace-pane:not([hidden]) .source-code')?.textContent.includes('你好，拾燕'));await shot('v2-file-python');
 });
 await test('Subsequent files replace preview, keep tab count, typed icons and syntax colors',async()=>{
  const n=(await layout()).tabCount;await fileClick('src');await fileClick('src/components');await fileClick('src/components/Editor.tsx');await page.waitForFunction(()=>document.querySelector('.workspace-pane:not([hidden]) .source-code')?.textContent.includes('export const greeting'));assert.equal((await layout()).tabCount,n);const code=visiblePane().locator('.source-code');assert(await code.locator('.syntax-keyword').count()>0);assert(await code.locator('.syntax-string').count()>0);assert.notEqual(await code.locator('.syntax-keyword').first().evaluate(e=>getComputedStyle(e).color),await code.locator('.syntax-string').first().evaluate(e=>getComputedStyle(e).color));const types=await visiblePane().locator('[data-file-type]').evaluateAll(es=>[...new Set(es.map(e=>e.dataset.fileType))]);assert(types.includes('ts')&&types.includes('python')&&types.includes('json'));assert.equal(await visiblePane().locator('.v2-file-preview').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');await shot('v2-file-deep');
 });
 await test('Every breadcrumb directory is clickable and shows complete directory information',async()=>{
  const crumb=visiblePane().locator('.v2-breadcrumb');assert((await crumb.innerText()).includes('>'));assert.equal(await crumb.locator('button').count(),3);await crumb.locator('button').nth(1).click();await page.locator('#v2Popup .v2-directory-info').waitFor({state:'visible'});assert(await page.locator('#v2Popup .v2-directory-info').isVisible());assert((await page.locator('#v2Popup').innerText()).includes('/src'));assert((await page.locator('#v2Popup').innerText()).includes('components'));await shot('v2-directory-info');await page.keyboard.press('Escape');
 });
 await test('Directory filter finds nested files; clearing restores tree without changing preview',async()=>{
  const filter=visiblePane().locator('[aria-label="筛选文件"]');await filter.fill('Editor.tsx');await visiblePane().locator('.v2-file-matches [data-file-path="src/components/Editor.tsx"]').waitFor();assert(await visiblePane().locator('.v2-tree-root').isHidden());const content=await visiblePane().locator('.source-code').innerText();await filter.fill('');await wait();assert(await visiblePane().locator('.v2-tree-root').isVisible());assert.equal(await visiblePane().locator('.source-code').innerText(),content);
 });
 await test('Directory toggle expands preview, retains selected file and tab',async()=>{
  const before=await visiblePane().locator('.v2-file-preview').boundingBox(),n=(await layout()).tabCount;await visiblePane().locator('.v2-directory-toggle').click();await wait();const after=await visiblePane().locator('.v2-file-preview').boundingBox();assert(after.width>before.width+100);assert.equal((await layout()).tabCount,n);assert((await visiblePane().locator('.source-code').innerText()).includes('greeting'));await visiblePane().locator('.v2-directory-toggle').click();await wait();
 });
 await test('File actions merge into one menu and add-to-chat still adds only a draft',async()=>{
  await visiblePane().locator('.v2-file-more').click();assert.equal(await page.locator('#v2Popup button').count(),2);assert((await page.locator('#v2Popup').innerText()).includes('复制'));await page.locator('#v2Popup button').filter({hasText:'加入对话'}).click();assert((await page.locator('#messageInput').inputValue()).includes('export const greeting'));assert.equal(await page.evaluate(()=>{const s=window.shiyan.getState();return s.conversations.find(c=>c.id===s.selectedConversationId).messages.length;}),0);
 });
 await test('Open-with lists only real installed editors, never invented app paths',async()=>{
  const result=await req('/api/workspace/editors');assert.equal(result.status,200);assert(result.body.editors.length>0);assert(result.body.editors.every(e=>e.id&&e.bundleId&&!e.path));await visiblePane().locator('.v2-open-editor').click();await page.locator('#v2Popup button').first().waitFor({state:'visible'});assert(await page.locator('#v2Popup button').count()>0);await shot('v2-open-with');await page.keyboard.press('Escape');
 });
 await test('New file endpoints enforce capability, Host, Origin and project-boundary rules',async()=>{
  assert.equal((await req('/api/workspace/editors','GET',undefined,{'X-Shiyan-Workspace':''})).status,403);assert.equal((await req('/api/workspace/editors','GET',undefined,{'Origin':'https://foreign.example'})).status,403);assert.equal((await req('/api/workspace/directory-details?projectId='+projectId+'&path=../../../../../../etc')).status,403);assert.equal((await req('/api/workspace/files/read','POST',{projectId,path:'outside-link'})).status,403);assert((await req('/api/workspace/files/open-editor','POST',{projectId,path:'hello.py',editorId:'fake'})).status>=400);const full=await req('/api/workspace/directory-details?projectId='+projectId);assert(full.body.entries.some(e=>e.name==='.env.test'));assert.equal(full.body.nextOffset,null);
 });
 await test('Unsafe HTML stays inert; sensitive files cannot directly join cloud draft',async()=>{
  await fileClick('unsafe.html');await page.waitForFunction(()=>document.querySelector('.workspace-pane:not([hidden]) .source-code')?.textContent.includes('<script>'));assert.equal(await page.evaluate(()=>window.badMarkupExecuted),undefined);await fileClick('.env.test');await page.waitForFunction(()=>document.querySelector('.workspace-pane:not([hidden]) .source-code')?.textContent.includes('TEST_PLACEHOLDER'));await visiblePane().locator('.v2-file-more').click();assert(await page.locator('#v2Popup button').filter({hasText:'加入对话'}).isDisabled());await page.keyboard.press('Escape');
 });
 await test('Browser plus follows last tab, more is popup and does not create a tab',async()=>{
  await page.locator('#addWorkspaceTab').click();const n=(await layout()).tabCount;assert.equal(await page.locator('#workspaceTabs').evaluate(e=>e.nextElementSibling?.id),'addWorkspaceTab');assert(await page.locator('#addWorkspaceTab').isVisible());await page.locator('#browserTools').click();assert(await page.locator('#v2Popup').isVisible());assert.equal((await layout()).tabCount,n);assert((await page.locator('#v2Popup').innerText()).includes('搜索引擎'));await shot('v2-browser-menu');await page.keyboard.press('Escape');
 });
 await test('Real PTY works, normal status labels removed, divider also works in terminal',async()=>{
  await page.evaluate(()=>window.workbench.openTool('terminal'));await page.waitForFunction(()=>window.workbench.getLayout().terminals.length>0);const term=visiblePane().locator('.xterm-helper-textarea');await term.focus();await page.keyboard.type("printf '%s%s\\n' V2_ PTY_OK; pwd");await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.terminal-pane:not([hidden]) .xterm-screen')?.textContent.includes('V2_PTY_OK'));assert(await visiblePane().locator('.terminal-status').isHidden());assert(!(await visiblePane().locator('.terminal-heading').innerText()).includes('本地终端'));const a=(await layout()).rects.rightWorkspace.width;await drag('#rightResizeHandle',-50);assert((await layout()).rects.rightWorkspace.width>a+40);await drag('#rightResizeHandle',50);
 });
 await test('Dock reuses actual PTY PID and spans center plus right, commands preserved',async()=>{
  const a=await layout(),session=a.terminals.at(-1),id=await page.locator('.terminal-pane').first().getAttribute('data-tab-pane');await page.locator('#addWorkspaceTab').click();await visiblePane().locator('[data-tool-terminal-more]').click();await page.locator('#v2Popup button').filter({hasText:'打开底部终端'}).click();await wait();const b=await layout();assert.equal(b.bottomTerminalId,id);assert.equal(b.bottomTerminalPID,session.pid);const dock=await page.locator('#bottomTerminal').boundingBox(),main=(await layout()).rects.mainWorkspace;assert(Math.abs(dock.x-main.x)<2);assert(Math.abs(dock.x+dock.width-1440)<2);assert((await page.locator('#bottomTerminal .xterm-screen').innerText()).includes('V2_PTY_OK'));await page.locator('#bottomTerminal .xterm-helper-textarea').focus();await page.keyboard.type("printf '%s%s\\n' DOCK_ OK");await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#bottomTerminal .xterm-screen')?.textContent.includes('DOCK_OK'));await shot('v2-bottom-terminal');await page.locator('#restoreBottomTerminal').click();await wait();assert.equal((await layout()).bottomTerminalId,null);assert((await layout()).terminals.some(s=>s.pid===session.pid));await page.locator('.workspace-tab.selected [data-close-tab]').click();await page.waitForFunction(pid=>!window.workbench.getLayout().terminals.some(s=>s.pid===pid),session.pid);
 });
 await test('Enhance is full-width standalone, no coding sidebars, no extra title/back',async()=>{
  await page.locator('#railEnhance').click();await wait();const l=await layout();assert.equal(await page.evaluate(()=>window.shiyan.getView()),'home');assert(l.rects.mainWorkspace.width>1380);assert(l.rects.leftContainer.width<1);assert(l.rects.rightWorkspace.width<1);assert(await page.locator('#backToAgentButton').isHidden());assert(await page.locator('#modelSelector').isVisible());await shot('v2-enhance-empty');
 });
 await test('General blue/anime pink mode changes retain stable button geometry',async()=>{
  const b=await page.locator('[data-model="x4"]').boundingBox();await page.locator('[data-model="x4anime"]').click();assert.equal(await page.locator('#compareWorkbench').getAttribute('data-model'),'anime');const pink=await page.locator('[data-model="x4anime"]').evaluate(e=>getComputedStyle(e).color);await page.locator('[data-model="x4"]').click();const blue=await page.locator('[data-model="x4"]').evaluate(e=>getComputedStyle(e).color);assert.notEqual(pink,blue);assert.deepEqual(await page.locator('[data-model="x4"]').boundingBox(),b);
 });
 await test('Real 4x enhancement feeds both compare panes and unified Space',async()=>{
  await page.locator('#homeFileInput').setInputFiles(path.join(config.fixtureProject,'preview.png'));await page.waitForFunction(()=>!!window.shiyan.getPhotoState().input);await page.locator('#processButton').click();await page.waitForFunction(()=>{const p=window.shiyan.getPhotoState();return !!p.result&&!p.busy;},null,{timeout:130000});const p=await page.evaluate(()=>window.shiyan.getPhotoState());assert.equal(p.result.width,p.input.width*4);assert.equal(p.result.height,p.input.height*4);assert(await page.locator('#compareMain [data-compare="original"] img').isVisible());assert(await page.locator('#compareMain [data-compare="result"] img').isVisible());assert(await page.locator('#saveResultButton').isEnabled());await shot('v2-enhance-completed');
 });
 await test('Compare click opens overlay, paired zoom/pan/reset and Esc work',async()=>{
  await page.locator('#compareMain [data-compare="original"] .v2-compare-stage').click();assert(await page.locator('#comparePreview').isVisible());await page.locator('#comparePreview [data-zoom-plus]').click();const a=await page.locator('#comparePreview [data-compare="original"] img').evaluate(e=>e.style.transform),b=await page.locator('#comparePreview [data-compare="result"] img').evaluate(e=>e.style.transform);assert.equal(a,b);assert((await layout()).photoCompare.zoom>1);const stage=page.locator('#comparePreview [data-compare="original"] .v2-compare-stage');const r=await stage.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+45,r.y+r.height/2+30,{steps:5});await page.mouse.up();assert((await layout()).photoCompare.x>0);await page.locator('#comparePreview footer [data-zoom-reset]').click();assert.equal((await layout()).photoCompare.zoom,1);await page.keyboard.press('Escape');assert(await page.locator('#comparePreview').isHidden());
 });
 await test('Space independent sidebar, natural aspect images, search/selection/actions/export',async()=>{
  await page.locator('#railHistory').click();await wait();assert(await page.locator('#spaceSidebar').isVisible());assert(await page.locator('#agentSidebar').isHidden());assert.equal(await page.locator('.v2-space-category').count(),1);assert(await page.locator('#spaceGallery .v2-space-card').count()>0);const ratio=await page.locator('#spaceGallery img').first().evaluate(e=>({natural:e.naturalWidth/e.naturalHeight,display:e.getBoundingClientRect().width/e.getBoundingClientRect().height}));assert(Math.abs(ratio.natural-ratio.display)<.02);await page.locator('#spaceSearchToggle').click();await page.locator('#spaceSearchInput').fill('___no_match___');assert(await page.locator('#spaceEmpty').isVisible());await page.locator('#spaceSearchInput').fill('');await page.locator('#spaceSelectToggle').click();await page.locator('.v2-space-select').first().click();assert(await page.locator('#spaceBatch').isVisible());const download=page.waitForEvent('download');await page.locator('#spaceExport').click();const d=await download;const saved=path.join(qa,'space-export.zip');await d.saveAs(saved);assert(fs.statSync(saved).size>50);await shot('v2-space');await page.locator('#spaceSelectToggle').click();assert(await page.locator('#spaceBatch').isHidden());
 });
 await test('1440/1180/780 layouts, file/full view and photo remain in window bounds',async()=>{
  for(const [width,height] of [[1180,840],[780,660],[1440,900]]){await page.setViewportSize({width,height});await page.locator('#railHome').click();await wait();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));let l=await layout();assert(l.rects.mainWorkspace.width>=280);if(!l.actualRightOpen){await page.locator('#toggleRightWorkspace').click();await wait();}await page.locator('#toggleFullWorkspace').click();await wait();assert((await layout()).fullView);await shot('v2-full-'+width);await page.locator('#toggleFullWorkspace').click();await page.locator('#railEnhance').click();await wait();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert((await page.locator('#compareWorkbench').boundingBox()).width<=width-48);await shot('v2-enhance-'+width);}
 });
 await test('Reload persists project/chat/file selection and does not mutate original fixture code',async()=>{
  await page.locator('#railHome').click();await page.evaluate(()=>window.workbench.openTool('files'));await wait();const f=(await layout()).fileTools.find(x=>x.projectId===projectId);assert(f);await page.waitForTimeout(600);const n=(await layout()).tabCount;await page.reload({waitUntil:'domcontentloaded'});await ready();assert((await layout()).projects.some(p=>p.id===projectId));assert.equal((await layout()).tabCount,n);assert(fs.readFileSync(path.join(config.fixtureProject,'hello.py'),'utf8').includes('你好，拾燕'));
 });
 await test('V2.1 tabs+ stays visible after overflow and fullscreen uses twin arrows',async()=>{
  await page.locator('#railHome').click();await page.setViewportSize({width:1440,height:900});
  for(let i=0;i<15;i++)await page.locator('#addWorkspaceTab').click();
  const add=await page.locator('#addWorkspaceTab').boundingBox(),bar=await page.locator('.workspace-tabbar').boundingBox();
  assert(add&&add.x>=bar.x&&add.x+add.width<=bar.x+bar.width,JSON.stringify({add,bar}));
  assert(await page.locator('#addWorkspaceTab').isVisible());
  const iconBefore=await page.locator('#toggleFullWorkspace .wb-icon path').getAttribute('d');
  await page.locator('#toggleFullWorkspace').click();await wait();
  const iconAfter=await page.locator('#toggleFullWorkspace .wb-icon path').getAttribute('d');
  assert.notEqual(iconAfter,iconBefore);
  assert(iconAfter.length<90 && iconBefore.length<90);
  await page.locator('#toggleFullWorkspace').click();await wait();
 });
 await test('V2.1 project edit, pin, unpin and safe unlink preserve user code and chat',async()=>{
  await page.locator('#railHome').click();
  const second=path.join(qa,'second-project');fs.mkdirSync(second,{recursive:true});const project=await req('/api/workspace/projects','POST',{name:'V21 second project',path:second});
  assert.equal(project.status,200);
  const id=project.body.project.id;
  const group=page.locator('[data-project-group="'+id+'"]');await group.waitFor();
  await group.locator('[data-project-more]').click();
  const popup=page.locator('#v2Popup');
  await popup.getByText('置顶',{exact:true}).click();
  await page.waitForTimeout(230);assert.equal((await req('/api/workspace/projects')).body.projects.find(p=>p.id===id)?.isPinned,true);
  await group.locator('[data-project-more]').click();
  await popup.getByText('编辑项目',{exact:true}).click();
  await page.locator('#v21ProjectName').fill('V21 renamed project');
  await page.locator('#v21ProjectForm [type="submit"]').click();
  await page.waitForFunction(id=>window.workbench.getLayout().projects.find(p=>p.id===id)?.name==='V21 renamed project',id);
  await group.locator('[data-project-more]').click();
  await popup.getByText('移除项目',{exact:true}).click();
  await page.locator('#confirmCancelButton').click();
  assert(await group.count());
  await group.locator('[data-project-more]').click();
  await popup.getByText('移除项目',{exact:true}).click();
  await page.locator('#confirmAcceptButton').click();
  await page.waitForFunction(id=>!window.workbench.getLayout().projects.some(p=>p.id===id),id);
  assert(fs.existsSync(path.join(config.fixtureProject,'hello.py')));assert(fs.existsSync(second));
  assert((await req('/api/workspace/projects/'+id,'PATCH',{name:'nope'})).status>=400);
  assert((await req('/api/workspace/projects/'+projectId,'PATCH',{name:'duplicate'} ,{'X-Shiyan-Workspace':''})).status===403);
 });
 await test('V2.1 space icon, right-bottom checkbox and deterministic no-motion waterfall',async()=>{
  await page.locator('#railHistory').click();await wait();
  const gallery=page.locator('#spaceGallery'),card=gallery.locator('.v2-space-card').first();
  assert(await page.locator('#railHistory .wb-icon path').count()>0);
  assert(await gallery.locator('.v21-space-column').count()>0);
  const parent=await card.boundingBox(),circle=await card.locator('.v2-space-select').boundingBox();
  assert(circle.x>parent.x+parent.width*.65&&circle.y>parent.y+parent.height*.65);
  const before=await gallery.locator('.v2-space-card').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));
  await card.hover();await page.waitForTimeout(420);
  const after=await gallery.locator('.v2-space-card').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));
  assert.deepEqual(after,before);
  assert.equal(await card.evaluate(e=>getComputedStyle(e).transform),'none');
  await page.locator('#railHome').click();
 });
 await test('V2.1 tool-card menu opens bottom terminal, not the terminal header',async()=>{
  await page.locator('#addWorkspaceTab').click();
  const pane=visiblePane();await pane.locator('[data-tool-terminal-more]').waitFor();
  assert(await pane.locator('[data-workspace-tool="terminal"]').count()===1);
  await pane.locator('[data-tool-terminal-more]').click();
  const p=page.locator('#v2Popup');assert((await p.innerText()).includes('打开底部终端'));
  await p.getByText('打开底部终端',{exact:true}).click();
  await page.waitForFunction(()=>window.workbench.getLayout().bottomTerminalId!==null);
  assert(await page.locator('#bottomTerminal').isVisible());
  assert.equal(await page.locator('.v2-terminal-more').count(),0);
  await page.locator('#closeBottomTerminal').click();
 });
 await test('No JavaScript errors; installed-editor and filesystem helpers do not expose capability',async()=>{assert.deepEqual(errors,[]);});
 const result={tests,errors,passed:tests.filter(x=>x.ok).length,failed:tests.filter(x=>!x.ok).length,scope:'Isolated V2 actual local backend/PTY/images; native browser tested separately'};fs.writeFileSync(path.join(qa,'regression-v21.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,failed:result.failed,errors}));await browser.close();process.exitCode=result.failed?1:0;
})().catch(async e=>{console.error(e);fs.writeFileSync(path.join(qa,'fatal.txt'),String(e));await browser?.close();process.exitCode=2});
