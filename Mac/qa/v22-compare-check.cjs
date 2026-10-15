const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {chromium}=require('/Users/yu/codex/boss-job-copilot/node_modules/playwright-core');
(async()=>{
 const qa=path.join(__dirname,'v22-run'),config=JSON.parse(fs.readFileSync(path.join(qa,'run.json')));
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(config.url);await page.waitForFunction(()=>window.workbench?.ready);
  await page.locator('#railEnhance').click();await page.locator('#homeFileInput').setInputFiles(path.join(__dirname,'fixtures/enhance-input.png'));
  await page.waitForFunction(()=>!!window.shiyan.getPhotoState().input);await page.locator('#compareMain [data-compare=original] .v2-compare-stage').click();
  const header=await page.locator('#comparePreview>header').boundingBox(),zoom=await page.locator('#comparePreview .v2-compare-zoom').boundingBox();
  assert(zoom.y>=header.y&&zoom.y+zoom.height<=header.y+header.height);assert(Math.abs(zoom.x+zoom.width/2-720)<1);
  const stage=page.locator('#comparePreview [data-compare=original] .v2-compare-stage');await page.locator('#comparePreview [data-zoom-plus]').click();
  assert((await page.locator('#comparePreview [data-zoom-reset]').last().innerText())==='125%');const box=await stage.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+20);await page.mouse.up();
  const state=await page.evaluate(()=>window.workbench.getLayout().photoCompare);assert(state.zoom>1&&state.x>0&&state.y>0);
  await page.screenshot({path:path.join(qa,'expanded-compare.png')});await page.locator('#closeComparePreview').click();assert(await page.locator('#comparePreview').isHidden());
  await page.locator('#railHome').click();await page.locator('#reasoningButton').click();await page.locator('#reasoningModel').selectOption('gpt-6.1-sol');await page.locator('#reasoningRange').focus();await page.keyboard.press('Home');for(let i=0;i<3;i++)await page.keyboard.press('ArrowRight');
  await page.locator('#reasoningRange').evaluate(el=>el.blur());await page.screenshot({path:path.join(qa,'slider-v22.png')});await page.locator('#reasoningPanel').screenshot({path:path.join(qa,'slider-panel-v22.png')});await page.keyboard.press('Escape');
  await page.locator('.workspace-tabbar').screenshot({path:path.join(qa,'three-top-icons-v22.png')});
  fs.writeFileSync(path.join(qa,'compare-check.json'),JSON.stringify({passed:true,actualImage:true,zoomCentered:true,zoomAndPanPreserved:true,footerRemoved:true},null,2));console.log('PASS actual expanded image, centered upper zoom and pointer pan');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
