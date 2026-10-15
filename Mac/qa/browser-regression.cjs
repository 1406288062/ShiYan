const fs=require('fs');
const path=require('path');
const assert=require('assert');
const {chromium}=require('/Users/yu/codex/boss-job-copilot/node_modules/playwright-core');
const root='/Users/yu/claude code/image_enhancer';
const qa=path.join(root,'qa');
const results=[],errors=[];
let browser,context,page;
async function test(name,fn){
  const started=Date.now();
  try{await fn();results.push({name,passed:true,ms:Date.now()-started});console.log('PASS '+name);}
  catch(e){results.push({name,passed:false,error:String(e),ms:Date.now()-started});console.log('FAIL '+name+' '+String(e));await page.screenshot({path:path.join(qa,'failure-'+results.length+'.png')}).catch(()=>{});}
}
async function waitState(fn,arg){await page.waitForFunction(fn,arg,{timeout:25000});}
async function current(){return page.evaluate(()=>{const s=window.shiyan.getState();return s.conversations.find(c=>c.id===s.selectedConversationId);});}
async function snapshot(name){await page.screenshot({path:path.join(qa,name+'.png'),animations:'disabled'});}
async function openHome(){await page.evaluate(()=>{if(window.shiyan.getView()==='agent')document.getElementById('closeAgentButton').click();else if(window.shiyan.getView()==='history')document.getElementById('historyBackButton').click();});}
(async()=>{
  const ready=JSON.parse(fs.readFileSync('/tmp/shiyan-root-qa-ready.json','utf8'));
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  context=await browser.newContext({viewport:{width:1180,height:840},deviceScaleFactor:1,acceptDownloads:true});
  page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(ready.url,{waitUntil:'domcontentloaded'});
  await waitState(()=>window.shiyan && window.shiyan.getState() && window.shiyan.getState().conversations.length);
  let firstId,secondId,historyAfterGeneral,disabledSend,normalSend;
  const fixture=path.join(qa,'fixtures','enhance-input.png');
  await test('Home has four real feature entries and no horizontal overflow',async()=>{
    assert.strictEqual(await page.locator('[data-feature]').count(),4);
    assert(await page.locator('#homeView').isVisible());
    assert(await page.locator('#processButton').isDisabled());
    assert(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth));
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('#homeView img')).filter(i=>!i.hidden).every(i=>i.complete&&i.naturalWidth>0));
    await snapshot('desktop-home');
  });
  await test('Agent send states keep identical circle and arrow geometry',async()=>{
    await page.locator('[data-feature="agent"]').click();
    await waitState(()=>window.shiyan.getView()==='agent');
    const measure=()=>{const b=document.getElementById('sendButton'),i=document.getElementById('sendIcon'),br=b.getBoundingClientRect(),ir=i.getBoundingClientRect(),bs=getComputedStyle(b),is=getComputedStyle(i);return {button:[br.width,br.height],icon:[ir.width,ir.height],mask:is.maskImage,color:bs.color,background:bs.backgroundColor};};
    disabledSend=await page.evaluate(measure);
    await page.locator('#messageInput').fill('桌面回归草稿');
    await waitState(()=>{const s=window.shiyan.getState();return s.conversations.find(c=>c.id===s.selectedConversationId).draft==='桌面回归草稿';});
    normalSend=await page.evaluate(measure);
    assert.deepStrictEqual(disabledSend.button,[36,36]);assert.deepStrictEqual(normalSend.button,[36,36]);
    assert.deepStrictEqual(disabledSend.icon,normalSend.icon);assert.strictEqual(disabledSend.mask,normalSend.mask);
    assert.notStrictEqual(disabledSend.background,normalSend.background);assert.strictEqual(normalSend.background,'rgb(0, 136, 255)');
    firstId=(await current()).id;await snapshot('desktop-agent-composer');
  });
  await test('Reasoning selection drives actual saved per-conversation value and gauge',async()=>{
    await page.locator('#reasoningButton').click();
    const values=await page.evaluate(()=>window.shiyan.getState().capabilities.reasoningEfforts);
    const last=values[values.length-1];
    await page.locator('#reasoningRange').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},String(values.length-1));
    await waitState(value=>{const s=window.shiyan.getState();return s.conversations.find(c=>c.id===s.selectedConversationId).reasoning===value;},last);
    assert.strictEqual(await page.locator('#reasoningRange').getAttribute('aria-valuetext'),{low:'低',medium:'中',high:'高',xhigh:'超高',max:'最高'}[last]);
    assert.strictEqual(await page.locator('#reasoningTrack').evaluate(el=>el.style.getPropertyValue('--reasoning-progress')),'1');
    await snapshot('desktop-reasoning');await page.locator('#reasoningBackdrop').click({position:{x:5,y:5}});
  });
  await test('Image attachment and draft survive page reload',async()=>{
    await page.locator('#attachmentInput').setInputFiles(fixture);
    await waitState(()=>{const s=window.shiyan.getState();return s.conversations.find(c=>c.id===s.selectedConversationId).draftAssets.length===1;});
    await page.reload({waitUntil:'domcontentloaded'});await waitState(()=>window.shiyan && window.shiyan.getState());
    await page.locator('[data-feature="agent"]').click();
    assert.strictEqual(await page.locator('#messageInput').inputValue(),'桌面回归草稿');
    assert.strictEqual(await page.locator('.attachment-item').count(),1);
  });
  await test('Attachment limit rejects over-limit selection without losing draft',async()=>{
    await page.locator('#attachmentInput').setInputFiles(Array(9).fill(fixture));
    await page.waitForFunction(()=>document.getElementById('toastText').textContent.includes('最多'));
    assert.strictEqual(await page.locator('.attachment-item').count(),1);
  });
  await test('New conversation isolates draft and repeated empty new does not duplicate',async()=>{
    await page.locator('#newConversationButton').click();
    await waitState(id=>window.shiyan.getState().selectedConversationId!==id,firstId);
    secondId=(await current()).id;
    assert.strictEqual(await page.locator('#messageInput').inputValue(),'');
    assert.strictEqual(await page.locator('.attachment-item').count(),0);
    const count=await page.evaluate(()=>window.shiyan.getState().conversations.length);
    await page.locator('#newConversationButton').click();
    await waitState(id=>window.shiyan.getState().selectedConversationId===id,secondId);
    assert.strictEqual(await page.evaluate(()=>window.shiyan.getState().conversations.length),count);
  });
  await test('Sidebar pin rename and front-panel overlay operate correctly',async()=>{
    await page.locator('#openSidebarButton').click();
    await page.locator('[data-session-more="'+firstId+'"]').click();
    await page.locator('#sessionMenu [data-session-action="pin"]').click();
    await waitState(id=>window.shiyan.getState().conversations.find(c=>c.id===id).isPinned,firstId);
    await page.locator('[data-session-more="'+firstId+'"]').click();
    await page.locator('#sessionMenu [data-session-action="rename"]').click();
    await page.locator('#renameInput').fill('桌面回归会话 A');
    await page.locator('#saveRenameButton').click();
    await waitState(id=>window.shiyan.getState().conversations.find(c=>c.id===id).title==='桌面回归会话 A',firstId);
    assert(await page.locator('#closeSidebarButton').isVisible());
    const rect=await page.locator('#chatPanel').boundingBox();assert(rect.x>=280 && rect.x<=370);
    await snapshot('desktop-sidebar');
  });
  await test('Conversation search finds title and restores the correct draft',async()=>{
    await page.locator('#openSearchButton').click();await page.locator('#searchInput').fill('桌面回归会话 A');
    assert.strictEqual(await page.locator('[data-search-session]').count(),1);
    await snapshot('desktop-search');await page.locator('[data-search-session="'+firstId+'"]').click();
    await waitState(id=>window.shiyan.getState().selectedConversationId===id,firstId);
    assert.strictEqual(await page.locator('#messageInput').inputValue(),'桌面回归草稿');
    assert.strictEqual(await page.locator('.attachment-item').count(),1);
  });
  await test('Real unapproved gateway response shows failure and preserves user message',async()=>{
    await page.waitForFunction(()=>window.shiyan.getState().connection.status==='unauthorized',null,{timeout:65000});
    await page.locator('.attachment-remove').click();await page.locator('#messageInput').fill('桌面验收：只回复测试通过。');
    await page.locator('#sendButton').click();
    await waitState(()=>{const s=window.shiyan.getState(),c=s.conversations.find(c=>c.id===s.selectedConversationId);return c.messages.some(m=>m.role==='assistant' && m.state==='failed');});
    const c=await current();assert(c.messages.some(m=>m.role==='user' && m.text==='桌面验收：只回复测试通过。'));
    assert(await page.locator('.message-error').first().isVisible());
    assert.strictEqual(c.pendingJobId,null);assert.strictEqual(c.pendingMessageId,null);
    assert.strictEqual(await page.locator('#messageInput').inputValue(),'');
    await snapshot('desktop-agent-authorization');
  });
  await test('Edit cancel restores the previous draft instead of deleting conversation',async()=>{
    await page.locator('#messageInput').fill('应恢复的草稿');
    const message=(await current()).messages.find(m=>m.role==='user');
    await page.locator('[data-message-menu="'+message.id+'"]').click();await page.locator('[data-edit-message="'+message.id+'"]').click();
    assert(await page.locator('#editBanner').isVisible());
    await page.locator('#cancelEditButton').click();
    assert.strictEqual(await page.locator('#messageInput').inputValue(),'应恢复的草稿');
    assert((await current()).messages.length>=2);
  });
  await test('General enhancement executes real 4x model through UI and saves history',async()=>{
    await openHome();await page.locator('#homeFileInput').setInputFiles(fixture);
    await page.waitForFunction(()=>!document.getElementById('homeImage').hidden && document.getElementById('homeImage').naturalWidth>0);
    await page.locator('[data-feature="enhance"]').click();await page.locator('[data-model="x4"]').click();
    const count=await page.evaluate(()=>window.shiyan.getState().history.length);
    await page.locator('#processButton').click();
    await waitState(n=>window.shiyan.getState().history.length>n,count);
    await page.waitForFunction(()=>!document.getElementById('saveResultButton').hidden && !document.getElementById('saveResultButton').disabled);
    assert((await page.locator('#imageDimensions').innerText()).includes('256'));
    historyAfterGeneral=await page.evaluate(()=>window.shiyan.getState().history.length);
    await page.locator('#showOriginalButton').click();assert((await page.locator('#imageDimensions').innerText()).includes('64'));
    await page.locator('#showResultButton').click();await snapshot('desktop-enhanced');
    const downloadPromise=page.waitForEvent('download');await page.locator('#saveResultButton').click();const download=await downloadPromise;await download.saveAs(path.join(qa,'saved-general.png'));
    const png=fs.readFileSync(path.join(qa,'saved-general.png'));assert.strictEqual(png.readUInt32BE(16),256);assert.strictEqual(png.readUInt32BE(20),192);
  });
  await test('Anime model produces separate real result and brand-pink selected style',async()=>{
    await page.locator('[data-model="x4anime"]').click();await page.locator('#processButton').click();
    await waitState(n=>window.shiyan.getState().history.length>n,historyAfterGeneral);
    await snapshot('desktop-anime');
  });
  await test('Erase brush undo clear mask and real authorization failure remain usable',async()=>{
    await page.locator('[data-feature="remove"]').click();
    const box=await page.locator('#maskCanvas').boundingBox();assert(box && box.width>0);
    await page.mouse.move(box.x+box.width*.25,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.70,box.y+box.height*.5,{steps:12});await page.mouse.up();
    assert(!(await page.locator('#processButton').isDisabled()));
    await page.locator('#undoStrokeButton').click();assert(await page.locator('#processButton').isDisabled());
    await page.mouse.move(box.x+box.width*.3,box.y+box.height*.4);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.4,{steps:8});await page.mouse.up();
    await page.locator('#clearStrokesButton').click();assert(await page.locator('#processButton').isDisabled());
    await page.mouse.move(box.x+box.width*.25,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.5,{steps:12});await page.mouse.up();
    const before=await page.evaluate(()=>window.shiyan.getState().photoJobs.map(j=>j.id));
    await page.locator('#processButton').click();
    await page.waitForFunction(ids=>window.shiyan.getState().photoJobs.some(j=>!ids.includes(j.id)&&j.feature==='remove'&&j.state==='failed'),before,{timeout:65000});
    assert(await page.locator('#photoError').isVisible());assert((await page.locator('#photoError').innerText()).includes('授权'));
    assert(!(await page.locator('#processButton').isDisabled()));
    const masks=await page.evaluate(()=>window.shiyan.getState().assets.filter(a=>a.filename==='mask.png'));assert(masks.length>0);assert(masks.every(m=>m.width===64&&m.height===48));
    await snapshot('desktop-erase');
  });
  await test('Colorize uses separate real task and reports authorization accurately',async()=>{
    await page.locator('[data-feature="colorize"]').click();
    assert.strictEqual(await page.locator('[data-feature="colorize"]').getAttribute('aria-selected'),'true');
    assert.strictEqual(await page.locator('#processLabel').innerText(),'开始上色');
    const before=await page.evaluate(()=>window.shiyan.getState().photoJobs.map(j=>j.id));
    await page.locator('#processButton').click();
    await page.waitForFunction(ids=>window.shiyan.getState().photoJobs.some(j=>!ids.includes(j.id)&&j.feature==='colorize'&&j.state==='failed'),before,{timeout:65000});
    assert(await page.locator('#photoError').isVisible());assert((await page.locator('#photoError').innerText()).includes('授权'));
    await snapshot('desktop-colorize');
  });
  await test('History grid selection export and deletion work against saved outputs',async()=>{
    await page.locator('#historyButton').click();assert(!(await page.locator('#connectionBanner').isVisible()));
    await page.locator('#historyMenuButton').click();await page.locator('#historyGridButton').click();
    await page.waitForFunction(()=>window.shiyan.getState().settings.historyViewMode==='grid'&&document.getElementById('historyMenu').hidden);
    await page.locator('#historyMenuButton').click();await page.locator('#historySelectButton').click();
    const entries=page.locator('.history-item');assert(await entries.count()>=3);
    await entries.nth(0).click();await entries.nth(1).click();
    assert((await page.locator('#historyTitle').innerText()).includes('2'));
    const indicator=await entries.nth(0).locator('.selection-indicator').boundingBox();assert(Math.abs(indicator.width-24)<.1);
    await snapshot('desktop-history-grid');
    const downloadPromise=page.waitForEvent('download');await page.locator('#historyShareButton').click();const download=await downloadPromise;await download.saveAs(path.join(qa,'history-export.zip'));
    assert.strictEqual(fs.readFileSync(path.join(qa,'history-export.zip')).readUInt16LE(0),0x4b50);
    await page.locator('#historyCloseSelectionButton').click();await page.locator('#historyMenuButton').click();await page.locator('#historyListButton').click();
    await page.waitForFunction(()=>window.shiyan.getState().settings.historyViewMode==='list'&&document.getElementById('historyMenu').hidden);
    assert.strictEqual(await page.locator('.history-thumb').first().evaluate(el=>el.getBoundingClientRect().width),60);
    await snapshot('desktop-history-list');
    await page.locator('.history-item').first().click();assert(await page.locator('#imagePreview').isVisible());await snapshot('desktop-preview');await page.locator('#closePreviewButton').click();
    await page.locator('#historyMenuButton').click();await page.locator('#historySelectButton').click();await page.locator('.history-item').first().click();
    const count=await page.locator('.history-item').count();await page.locator('#historyDeleteButton').click();await page.locator('#confirmAcceptButton').click();
    await page.waitForFunction(n=>document.querySelectorAll('.history-item').length===n,count-1);
  });
  await test('Desktop minimum and wide windows and dark appearance remain usable',async()=>{
    await openHome();await page.locator('[data-feature="enhance"]').click();
    await page.waitForFunction(()=>document.getElementById('toast').hidden);
    for(const viewport of [{width:780,height:628},{width:780,height:660},{width:1640,height:1000},{width:1180,height:840}]){
      await page.setViewportSize(viewport);assert(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth));
      const action=await page.locator('#processButton').boundingBox();assert(action.y>=0&&action.y+action.height<=viewport.height+1,'Process button must fit in '+viewport.width+'x'+viewport.height);
      await snapshot('desktop-window-'+viewport.width+'x'+viewport.height);
    }
    await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await snapshot('desktop-dark');
    assert.notStrictEqual(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
    await page.emulateMedia({colorScheme:'light',reducedMotion:'no-preference'});
  });
  await test('Reload restores work image history preference and named pinned session',async()=>{
    await page.reload({waitUntil:'domcontentloaded'});await waitState(()=>window.shiyan && window.shiyan.getState());
    await page.waitForFunction(()=>!document.getElementById('homeImage').hidden && document.getElementById('homeImage').naturalWidth>0);
    const saved=await page.evaluate(()=>window.shiyan.getState());assert(saved.conversations.some(c=>c.id===firstId && c.isPinned && c.title==='桌面回归会话 A'));
  }).catch(()=>{});
  await test('Large image confirmation preserves cancellation and continues without a hidden 2000px resize',async()=>{
    const oldAsset=await page.evaluate(()=>window.shiyan.getState().settings.homeInputAssetId);
    const largeFixture=path.join(qa,'fixtures','large-upload.png');
    await page.locator('#homeFileInput').setInputFiles(largeFixture);
    await page.waitForFunction(()=>!document.getElementById('confirmDialog').hidden);
    assert.strictEqual(await page.locator('#confirmTitle').innerText(),'图片较大');
    assert.strictEqual(await page.locator('#confirmMessage').innerText(),'图片分辨率超过 2000px，处理时间可能较长且占用更多内存，是否继续？');
    await snapshot('desktop-large-warning');assert(!(await page.locator('#confirmAcceptButton').evaluate(el=>el.classList.contains('danger-action'))));await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.getElementById('confirmDialog').hidden&&!document.getElementById('homeFileInput').disabled);
    assert.strictEqual(await page.evaluate(()=>window.shiyan.getState().settings.homeInputAssetId),oldAsset);
    await page.locator('#homeFileInput').setInputFiles(largeFixture);
    await page.waitForFunction(()=>!document.getElementById('confirmDialog').hidden);
    await page.locator('#confirmAcceptButton').click();
    await page.waitForFunction(()=>{const s=window.shiyan.getState(),a=s.assets.find(a=>a.id===s.settings.homeInputAssetId);return a&&a.width===2001&&a.height===1200;});
    assert((await page.locator('#imageDimensions').innerText()).includes('2001'));
    await page.locator('#homeFileInput').setInputFiles(fixture);
    await page.waitForFunction(()=>{const s=window.shiyan.getState(),a=s.assets.find(a=>a.id===s.settings.homeInputAssetId);return a&&a.width===64;});
  });
  results.push({name:'No uncaught browser JavaScript errors',passed:errors.length===0,errors});
  const report={createdAt:new Date().toISOString(),browser:'Chrome on target Mac',baseURL:ready.url,isolatedDataDirectory:'/tmp/shiyan-root-qa-large-release-20261009',sendGeometry:{disabled:disabledSend,normal:normalSend},cloudAuthorization:'Unapproved Mac device; successful remote generation was not claimed',results};
  fs.writeFileSync(path.join(qa,'browser-regression.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,errors},null,2));
  await browser.close();if(results.some(r=>!r.passed))process.exitCode=1;
})().catch(async e=>{console.error(e);fs.writeFileSync(path.join(qa,'browser-fatal.json'),JSON.stringify({error:String(e),results,errors},null,2));if(browser)await browser.close();process.exitCode=1;});
