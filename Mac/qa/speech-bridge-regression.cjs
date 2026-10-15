const fs=require('fs'),path=require('path'),assert=require('assert');
const {chromium}=require('/Users/yu/codex/boss-job-copilot/node_modules/playwright-core');
const qa='/Users/yu/claude code/image_enhancer/qa',results=[],errors=[];
let browser,page;
async function test(name,fn){try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(e){results.push({name,passed:false,error:String(e)});console.log('FAIL '+name+' '+e);}}
async function emit(sessionId,type,values={}){await page.evaluate(d=>window.dispatchEvent(new CustomEvent('shiyan-native',{detail:d})),{sessionId,type,...values});}
async function startSpeech(){await page.locator('#speechButton').click();return page.evaluate(()=>window.__speechNativeCalls.filter(c=>c.action==='startSpeech').slice(-1)[0].sessionId);}
async function selected(){return page.evaluate(()=>window.shiyan.getState().selectedConversationId);}
async function freshConversation(){const old=await selected();await page.locator('#newConversationButton').click();await page.waitForFunction(id=>window.shiyan.getState().selectedConversationId!==id,old);await page.locator('#messageInput').fill('');}
(async()=>{
 const ready=JSON.parse(fs.readFileSync('/tmp/shiyan-root-qa-ready.json','utf8'));
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1180,height:840}});
 await context.addInitScript(()=>{
  window.__speechNativeCalls=[];
  Object.defineProperty(window,'webkit',{configurable:true,value:{messageHandlers:{native:{postMessage:data=>window.__speechNativeCalls.push(data)}}}});
 });
 page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(ready.url,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.shiyan&&window.shiyan.getState());
 await page.locator('[data-feature="agent"]').click();
 await page.locator('#newConversationButton').click();
 await page.waitForFunction(()=>!document.getElementById('messageInput').disabled);
 await page.locator('#messageInput').fill('');
 await test('Stopping speech preserves the final trailing text and persisted draft',async()=>{
  const session=await startSpeech();assert(session);
  await emit(session,'speech',{text:'开头',isFinal:false});
  assert.strictEqual(await page.locator('#messageInput').inputValue(),'开头');
  await page.locator('#speechButton').click();
  await page.waitForFunction(id=>window.__speechNativeCalls.some(c=>c.action==='stopSpeech'&&c.sessionId===id),session);
  await emit(session,'speech',{text:'开头，最后几个字',isFinal:true});
  await emit(session,'speechState',{active:false});
  assert.strictEqual(await page.locator('#messageInput').inputValue(),'开头，最后几个字');
  await page.waitForFunction(()=>{const s=window.shiyan.getState();return s.conversations.find(c=>c.id===s.selectedConversationId).draft==='开头，最后几个字';});
  assert(!(await page.locator('#speechButton').evaluate(el=>el.classList.contains('is-recording'))));
 });
 await test('Switching conversation cancels capture and rejects queued callbacks from an older speech session',async()=>{
  await page.locator('#messageInput').fill('');
  const oldSession=await startSpeech();
  await emit(oldSession,'speech',{text:'应留在旧会话',isFinal:false});
  await freshConversation();
  assert(await page.evaluate(id=>window.__speechNativeCalls.some(c=>c.action==='cancelSpeech'&&c.sessionId===id),oldSession));
  const newSession=await startSpeech();assert.notStrictEqual(oldSession,newSession);
  await emit(oldSession,'speech',{text:'旧录音不应污染',isFinal:true});
  await emit(oldSession,'speechState',{active:false});
  assert.strictEqual(await page.locator('#messageInput').inputValue(),'');
  assert(await page.locator('#speechButton').evaluate(el=>el.classList.contains('is-recording')));
  await emit(newSession,'speech',{text:'新的完整句子',isFinal:true});
  assert.strictEqual(await page.locator('#messageInput').inputValue(),'新的完整句子');
 });
 await test('Sending during speech waits for the final result before building the request',async()=>{
  await freshConversation();await page.locator('#messageInput').fill('前缀');
  const session=await startSpeech();
  await emit(session,'speech',{text:'正在识别',isFinal:false});
  const id=await selected();let payload=null;
  const endpoint=ready.url+'api/conversations/'+id+'/send';
  await page.route(endpoint,async route=>{payload=route.request().postDataJSON();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});});
  await page.locator('#sendButton').click();
  await page.waitForFunction(value=>window.__speechNativeCalls.some(c=>c.action==='stopSpeech'&&c.sessionId===value),session);
  assert.strictEqual(payload,null);
  await emit(session,'speech',{text:'正在识别的尾字',isFinal:true});
  for(let i=0;i<50&&!payload;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert(payload);assert.strictEqual(payload.text,'前缀\n正在识别的尾字');
  await page.unroute(endpoint);
 });
 await test('Speech permission/error events preserve text and restore usable controls',async()=>{
  await page.locator('#messageInput').fill('不要丢掉这份草稿');
  const session=await startSpeech();
  await emit(session,'speechError',{message:'麦克风权限尚未授权'});
  assert.strictEqual(await page.locator('#messageInput').inputValue(),'不要丢掉这份草稿');
  assert(await page.locator('#agentNotice').isVisible());
  assert((await page.locator('#agentNotice').innerText()).includes('权限'));
  assert(!(await page.locator('#speechButton').isDisabled()));
  assert(!(await page.locator('#speechButton').evaluate(el=>el.classList.contains('is-recording'))));
 });
 results.push({name:'No uncaught JavaScript errors in speech bridge scenarios',passed:errors.length===0,errors});
 fs.writeFileSync(path.join(qa,'speech-bridge-regression.json'),JSON.stringify({createdAt:new Date().toISOString(),scope:'Controlled native bridge events against actual frontend and isolated local storage; microphone audio, Apple permission prompts and cloud generation were not exercised',requestInterception:'Only the speech send-payload case intercepts its own /send request; no simulated cloud success is claimed',results},null,2));
 console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length}));
 await browser.close();if(results.some(r=>!r.passed))process.exitCode=1;
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
