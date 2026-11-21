// Dots browser agent host. It runs inside the Dots sidecar next to BrowserSessionManager and
// drives the same isolated Chrome for Dots: one Chrome window per browser task, a reader window
// for search/open/find, permission gates (site access, downloads, uploads, saved passwords),
// Secure Vault fills, protected verification codes, user takeover and file delivery.
//
// Two callers reach it over a private unix socket:
//   * the Dots-facing MCP bridge (browse / windows / search / open / find), bound to one owner;
//   * the executor MCP bridge, bound to one claimed task by a per-claim token.
// Secrets never pass through either bridge: passwords, secure input and codes are typed into the
// page here and are never returned in a tool result.
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { normalizeBrowserURL, normalizeIdentity, runLxc as defaultLxc, BROWSER_CONTAINER_NAME } from './browser-session.ts';
import { ACTIVE_STATUSES, DOTS_ANSWERABLE, USER_ONLY, originMatches } from './browser-store.ts';
import type { BrowserSessionManager } from './browser-session.ts';
import type { BrowserStore } from './browser-store.ts';
import type { DotsAttachments } from './dots-attachments.ts';

const fail = (message: any, status = 400, code: any = undefined) => Object.assign(new Error(message), { status }, code ? { code } : {});
const delay = (ms: any) => new Promise(resolve => setTimeout(resolve, ms));
const clip = (value: any, max: any) => { const s = String(value ?? ''); return s.length > max ? s.slice(0, max) + '…' : s; };
const originOf = (url: any) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin.toLowerCase() : ''; } catch { return ''; } };
const AGENT_MARK = 'about:blank#shiyan-agent-';
const WINDOW_IDLE_MS = 20 * 60_000;
const MAX_TASK_TABS = 6;
const PAGE_CHUNK = 8000;
const FINAL_STATUSES = ['done', 'failed', 'blocked', 'unverified', 'interrupted', 'cancelled'];
// Order/payment submit buttons: these clicks require an approved payment authorization (place_order).
const PURCHASE_RE = /(提交订单|确认订单并支付|立即支付|确认支付|确认付款|去支付|去付款|立即付款|立即购买并支付|place\s*(your\s*)?order|pay\s*now|complete\s*(purchase|order)|confirm\s*(and\s*)?pay|submit\s*order|buy\s*now)/i;
const KEYS = { Enter: [13, '\r'], Tab: [9, '\t'], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34], Space: [32, ' '] };

// Runs inside the page. Numbers interactive elements (data-shiyan-ref) and reports what a person
// would see: visible controls, text, scroll position and signs of a bot challenge.
const SNAPSHOT_JS = `(() => {
  const MAX = 160, gen = String(Date.now() % 100000);
  document.querySelectorAll('[data-shiyan-ref]').forEach(el => el.removeAttribute('data-shiyan-ref'));
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const box = el => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return null; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null; return r; };
  const clean = v => String(v || '').replace(/\\s+/g, ' ').trim();
  const label = el => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('title') || el.getAttribute('placeholder') || (el.tagName === 'INPUT' && ['submit','button'].includes(el.type) ? el.value : '') || el.innerText || el.getAttribute('alt') || el.getAttribute('name') || '').slice(0, 100);
  const items = [], later = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 3000)) {
    const r = box(el); if (!r) continue;
    const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    (inView ? items : later).push([el, r, inView]);
  }
  const out = [];
  for (const [el, r, inView] of items.concat(later)) {
    if (out.length >= MAX) break;
    const ref = String(++n); el.setAttribute('data-shiyan-ref', ref);
    const type = (el.getAttribute('type') || '').toLowerCase(), secure = type === 'password' || el.getAttribute('data-shiyan-secure') === '1';
    const item = { ref, tag: el.tagName.toLowerCase(), name: label(el), inView };
    const role = el.getAttribute('role'); if (role) item.role = role;
    if (type) item.type = type;
    if (secure) item.secure = true;
    if (['INPUT','TEXTAREA'].includes(el.tagName) && !secure && !['checkbox','radio','submit','button','file'].includes(type) && el.value) item.value = String(el.value).slice(0, 80);
    if (el.tagName === 'SELECT') item.value = clean(el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].innerText).slice(0, 80);
    if (el.checked !== undefined && ['checkbox','radio'].includes(type)) item.checked = el.checked;
    if (el.getAttribute('aria-checked')) item.checked = el.getAttribute('aria-checked') === 'true';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (el.tagName === 'A' && el.href) item.href = String(el.href).slice(0, 160);
    out.push(item);
  }
  const frames = Array.from(document.querySelectorAll('iframe')).map(f => String(f.src || '')).slice(0, 40);
  const body = clean(document.body ? document.body.innerText : '').slice(0, 400).toLowerCase();
  let challenge = null;
  if (frames.some(s => /recaptcha|hcaptcha|challenges\\.cloudflare\\.com|turnstile|geetest|captcha/i.test(s)) || /just a moment|checking your browser|verify you are human|请完成安全验证|人机验证|滑动验证|拖动滑块|安全验证|验证码/.test(document.title.toLowerCase() + ' ' + body)) challenge = 'bot_verification';
  const text = (document.body ? document.body.innerText : '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').slice(0, 5000);
  return { url: location.href, title: document.title, items: out, more: Math.max(0, items.length + later.length - out.length), text, challenge,
    hasPassword: !!document.querySelector('input[type=password]'), hasFileInput: !!document.querySelector('input[type=file]'),
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }, gen };
})()`;
const READ_JS = `(() => { const pick = document.querySelector('article') || document.querySelector('main') || document.body; const text = (pick ? pick.innerText : '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n');
  const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({ text: String(a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80), href: a.href })).filter(l => l.text && /^https?:/.test(l.href)).slice(0, 60);
  return { url: location.href, title: document.title, text: text.slice(0, 400000), links }; })()`;
const SEARCH_JS = `(() => { const out = [];
  for (const li of document.querySelectorAll('#b_results > li.b_algo')) { const a = li.querySelector('h2 a'); if (!a) continue; const p = li.querySelector('.b_caption p, p'); out.push({ title: a.innerText.trim(), url: a.href, snippet: p ? p.innerText.trim().slice(0, 300) : '' }); }
  if (!out.length) for (const r of document.querySelectorAll('.result')) { const a = r.querySelector('a.result__a'); if (!a) continue; const s = r.querySelector('.result__snippet'); out.push({ title: a.innerText.trim(), url: a.href, snippet: s ? s.innerText.trim().slice(0, 300) : '' }); }
  return { url: location.href, title: document.title, results: out.slice(0, 15), text: (document.body ? document.body.innerText : '').slice(0, 600) }; })()`;

interface BrowserAgentHostOptions {
  manager: BrowserSessionManager;
  store: BrowserStore;
  attachments?: DotsAttachments | null;
  lxc?: typeof defaultLxc;
  container?: string;
  logger?: (msg: string) => void;
  windowIdleMs?: number;
}

export class BrowserAgentHost {
  manager: BrowserSessionManager;
  store: BrowserStore;
  attachments: DotsAttachments | null;
  lxc: typeof defaultLxc;
  container: string;
  log: (msg: string) => void;
  windows: Map<string, any>;
  byTarget: Map<string, any>;
  bySession: Map<string, any>;
  readers: Map<string, any>;
  locks: Map<string, any>;
  waiters: Map<string, Set<any>>;
  downloads: Map<string, any>;
  takeover: { owner: string; taskId: string; previousStatus: string } | null;
  windowIdleMs: number;
  sweeper: ReturnType<typeof setInterval>;
  constructor({ manager, store, attachments = null, lxc = defaultLxc, container = BROWSER_CONTAINER_NAME, logger = msg => process.stderr.write(msg + '\n'), windowIdleMs = WINDOW_IDLE_MS }: BrowserAgentHostOptions) {
    this.manager = manager; this.store = store; this.attachments = attachments; this.lxc = lxc; this.container = container; this.log = logger;
    this.windows = new Map();      // taskId -> window state
    this.byTarget = new Map();     // Chrome targetId -> { owner, taskId|null (reader), tab }
    this.bySession = new Map();    // CDP sessionId -> same entry
    this.readers = new Map();      // owner -> reader state
    this.locks = new Map();        // taskId -> promise chain
    this.waiters = new Map();      // questionId -> Set(resolve)
    this.downloads = new Map();    // guid -> { resolve, taskId, filename }
    this.takeover = null;          // { owner, taskId }
    this.windowIdleMs = windowIdleMs;
    manager?.setAgentHook?.(this);
    this.sweeper = setInterval(() => void this.#sweepWindows(), 60_000); this.sweeper.unref?.();
  }
  close() { clearInterval(this.sweeper); }

  // ================================================================ BrowserSessionManager hooks
  claimTarget(session: any, info: any, method: any) {
    if (String(info.url || '').startsWith(AGENT_MARK)) return true;
    const known = this.byTarget.get(info.targetId);
    if (known) { known.tab.url = String(info.url || known.tab.url); if (info.title) known.tab.title = String(info.title); return true; }
    const opener = info.openerId && this.byTarget.get(info.openerId);
    if (opener && opener.taskId && method === 'Target.targetCreated') { void this.#adoptPopup(session, opener, info).catch(error => this.log(`[browser-agent] popup adopt failed: ${error?.message || error}`)); return true; }
    return false;
  }
  cdpEvent(session: any, message: any) {
    const method = message.method || '';
    if (!message.sessionId && method.startsWith('Browser.download')) { this.#downloadEvent(message); return true; }
    if (!message.sessionId && method === 'Target.targetDestroyed') {
      const entry = this.byTarget.get(message.params?.targetId);
      if (!entry) return false;
      this.#forgetTab(entry);
      return !session.tabs?.has(message.params.targetId);
    }
    const entry = message.sessionId && this.bySession.get(message.sessionId);
    if (!entry) return false;
    const tab = entry.tab, params = message.params || {};
    if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
      tab.url = params.frame.url || ''; tab.gen = 0;
      if (entry.taskId && originOf(tab.url)) this.store.updateTask(entry.taskId, { last_url: tab.url });
    } else if (method === 'Page.loadEventFired') {
      tab.loaded = Date.now(); for (const wake of tab.loadWaiters.splice(0)) wake();
    } else if (method === 'Page.javascriptDialogOpening') {
      tab.dialog = { type: params.type, message: clip(params.message, 300) };
      void session.cdp.send('Page.handleJavaScriptDialog', { accept: params.type !== 'prompt' }, message.sessionId).catch(() => {});
    } else if (method === 'Page.fileChooserOpened') {
      tab.fileChooser = { backendNodeId: params.backendNodeId, mode: params.mode, at: Date.now() };
    } else if (method === 'Fetch.requestPaused') {
      void this.#gateRequest(session, entry, params).catch(() => {});
    }
    return message.sessionId !== session.targetSessionId;
  }
  async onViewerAttached(session: any) {
    const takeover = this.takeover;
    if (!takeover || takeover.owner !== session.owner) return;
    const win = this.windows.get(takeover.taskId);
    if (win && win.session === session) await this.manager.showAgentTargets(session, [...win.tabs.values()].map(tab => ({ targetId: tab.targetId, sessionId: tab.sessionId })));
  }
  async onViewerDetached(session: any) {
    const takeover = this.takeover;
    if (takeover && takeover.owner === session.owner) await this.handback(session.owner, takeover.taskId, { note: '用户关闭了接管窗口。' }).catch(() => {});
  }
  onSessionDestroyed(session: any) {
    for (const [taskId, win] of this.windows) if (win.session === session) { for (const tab of win.tabs.values()) this.#unindex(tab); this.windows.delete(taskId); }
    for (const [owner, reader] of this.readers) if (reader.session === session) { if (reader.tab) this.#unindex(reader.tab); this.readers.delete(owner); }
    if (this.takeover && this.takeover.owner === session.owner) this.takeover = null;
  }

  // ================================================================ windows and tabs
  #index(owner: any, taskId: any, tab: any) { const entry = { owner, taskId, tab }; this.byTarget.set(tab.targetId, entry); this.bySession.set(tab.sessionId, entry); return entry; }
  #unindex(tab: any) { this.byTarget.delete(tab.targetId); this.bySession.delete(tab.sessionId); for (const wake of tab.loadWaiters?.splice(0) || []) wake(); }
  #forgetTab(entry: any) {
    this.#unindex(entry.tab);
    if (entry.taskId) {
      const win = this.windows.get(entry.taskId);
      if (win) { win.tabs.delete(entry.tab.id); if (win.active === entry.tab.id) win.active = [...win.tabs.keys()].at(-1) || null; }
    } else if (this.readers.get(entry.owner)?.tab === entry.tab) this.readers.delete(entry.owner);
  }
  async #prepareTab(session: any, sessionId: any, { gate = true } = {}) {
    const cdp = session.cdp;
    try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId); } catch {}
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    if (gate) await cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, sessionId).catch(() => {});
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId).catch(() => {});
  }
  async #newTarget(session: any, owner: any, taskId: any, url = 'about:blank') {
    const cdp = session.cdp;
    const created = await cdp.send('Target.createTarget', { url: AGENT_MARK + randomBytes(6).toString('hex'), newWindow: true, background: true });
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: created.targetId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1280, height: 1000 } });
    } catch {}
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const tab = { id: 'w' + randomBytes(3).toString('hex'), targetId: created.targetId, sessionId: attached.sessionId, url: 'about:blank', title: '', loadWaiters: [], gen: 0 };
    this.#index(owner, taskId, tab);
    await this.#prepareTab(session, attached.sessionId);
    if (url && url !== 'about:blank') await this.#navigate(session, tab, url, { taskId });
    return tab;
  }
  async #adoptPopup(session: any, opener: any, info: any) {
    const win = this.windows.get(opener.taskId);
    if (!win || win.tabs.size >= MAX_TASK_TABS) { await session.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {}); return; }
    const attached = await session.cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    const tab = { id: 'w' + randomBytes(3).toString('hex'), targetId: info.targetId, sessionId: attached.sessionId, url: String(info.url || ''), title: String(info.title || ''), loadWaiters: [], gen: 0 };
    this.#index(opener.owner, opener.taskId, tab);
    await this.#prepareTab(session, attached.sessionId);
    win.tabs.set(tab.id, tab); win.active = tab.id; win.notes.push(`页面打开了新标签页 ${tab.id}，已切换到它。`);
    if (this.takeover?.taskId === opener.taskId) await this.manager.showAgentTargets(session, [{ targetId: tab.targetId, sessionId: tab.sessionId }]);
  }
  // The task's window, (re)opened on demand. A window outlives a single executor run so the
  // conversation can continue in it; it closes after a quiet period and reopens at its last URL.
  async #window(task: any) {
    let win = this.windows.get(task.id);
    if (win && !win.session.closing && win.session === this.manager.activeSession && win.tabs.size) { win.lastUsed = Date.now(); return win; }
    if (win) { this.windows.delete(task.id); if (!win.session.closing) this.manager.releaseAgent(win.session); }
    let session;
    try { session = await this.manager.acquireAgent(task.owner, { identity: task.identity }); }
    catch (error) { if ((error as any).code === 'browser_busy') this.store.updateTask(task.id, { error: (error as any).message }); throw error; }
    win = { taskId: task.id, owner: task.owner, session, tabs: new Map(), active: null, notes: [], lastUsed: Date.now() };
    this.windows.set(task.id, win);
    try {
      const restore = task.last_url && originOf(task.last_url) ? task.last_url : 'about:blank';
      const tab = await this.#newTarget(session, task.owner, task.id, restore);
      win.tabs.set(tab.id, tab); win.active = tab.id;
      if (restore !== 'about:blank') win.notes.push(`窗口已重新打开到上次的网址 ${clip(restore, 160)}；之前未保存的页面状态可能已丢失，请先查看页面。`);
    } catch (error) { this.windows.delete(task.id); this.manager.releaseAgent(session); throw error; }
    return win;
  }
  async closeWindow(taskId: any) {
    const win = this.windows.get(taskId);
    if (!win) return;
    this.windows.delete(taskId);
    for (const tab of win.tabs.values()) { this.#unindex(tab); await win.session.cdp?.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {}); }
    if (this.takeover?.taskId === taskId) { await this.manager.hideAgentTargets(win.session, [...win.tabs.values()].map(tab => tab.targetId)).catch(() => {}); this.takeover = null; }
    this.manager.releaseAgent(win.session);
  }
  async #sweepWindows() {
    for (const [taskId, win] of this.windows) {
      const task = this.store.row(taskId);
      if (task && ACTIVE_STATUSES.includes(task.status)) continue;
      if (Date.now() - win.lastUsed > this.windowIdleMs) await this.closeWindow(taskId).catch(() => {});
    }
  }
  #activeTab(win: any) { const tab = win.tabs.get(win.active) || [...win.tabs.values()].at(-1); if (!tab) throw fail('任务窗口没有打开的标签页', 409); return tab; }
  async #eval(session: any, tab: any, expression: any, { awaitPromise = false, timeoutMs = 8000 } = {}) {
    const result = await session.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true }, tab.sessionId, timeoutMs);
    if (result.exceptionDetails) throw fail('页面脚本执行失败：' + clip(result.exceptionDetails.exception?.description || result.exceptionDetails.text, 200), 502);
    return result.result?.value;
  }
  async #waitLoad(tab: any, timeoutMs = 15_000) {
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, timeoutMs); tab.loadWaiters.push(() => { clearTimeout(timer); resolve(); }); });
  }
  async #navigate(session: any, tab: any, raw: any, { taskId = null, owner = null } = {}) {
    const url = normalizeBrowserURL(raw);
    tab.blocked = null;
    const waiting = this.#waitLoad(tab);
    const result = await session.cdp.send('Page.navigate', { url }, tab.sessionId, 20_000);
    if (result.errorText) {
      if (tab.blocked) return { url, blocked: tab.blocked };
      throw fail(`网页打开失败：${result.errorText}`, 502, 'navigation_failed');
    }
    await waiting;
    return { url };
  }
  // Site-access gate for main-frame documents (subframes such as payment iframes are not gated).
  async #gateRequest(session: any, entry: any, params: any) {
    const cdp = session.cdp, sid = entry.tab.sessionId;
    const url = params.request?.url || '', origin = originOf(url);
    const mainFrame = !params.frameId || params.frameId === entry.tab.targetId;
    const task = entry.taskId ? this.store.row(entry.taskId) : null;
    const decision = origin && mainFrame ? this.store.siteDecision(entry.owner, origin, task) : 'allow';
    if (decision === 'allow') return cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sid);
    let questionId = null;
    if (decision === 'ask' && task) {
      const prior = this.store.pendingQuestions(entry.owner, task.id).find(q => q.kind === 'site_access' && q.data.origin === origin);
      questionId = prior?.id || this.#ask(task, { kind: 'site_access', prompt: `浏览器任务想访问 ${origin}，是否允许？`, options: ['允许', '拒绝'], data: { origin, url: clip(url, 300) } }).id;
    }
    // Record the block before failing the request: Page.navigate resolves right after the failure.
    entry.tab.blocked = { origin, decision, question_id: questionId };
    await cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
  }

  // ================================================================ questions and waiting
  #ask(task: any, { kind, prompt, options = [], data = {} }: {kind: string; prompt: string; options?: string[]; data?: any}, { block = true }: {block?: boolean} = {}) {
    const question = this.store.createQuestion(task.owner, task.id, { kind, prompt, options, data })!;
    const userOnly = USER_ONLY.includes(kind);
    // An executor waiting on this answer shows the task as waiting for the user; an approval asked
    // ahead of time (sharing a code when the task is created) does not hold the task back.
    if (block && task.status !== 'taken_over') this.store.updateTask(task.id, { status: 'waiting_user' });
    this.store.event(task.owner, task.id, userOnly ? 'browser_task_needs_user' : 'browser_task_question', {
      task_id: task.id, question_id: question.id, kind, prompt: question.prompt, options, data: kind === 'cart_confirmation' || kind === 'choice' ? data : undefined,
      note: userOnly ? '这一步需要用户在拾燕的浏览器任务面板里亲自处理（专用界面），不要在聊天里索要密码、卡号或验证码。' : '先对照用户的原始要求核对；只把用户没定、会影响结果的选择拿给用户。回答时调用 browse，answer_to 填这个 question_id，回复写在 task 里。',
    });
    return question;
  }
  #wake(questionId: any) { const set = this.waiters.get(questionId); if (set) { this.waiters.delete(questionId); for (const wake of set) wake(); } }
  async waitAnswer(questionId: any, timeoutMs = 25 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const question = this.store.question(questionId);
      if (!question) throw fail('问题不存在', 404);
      if (question.status !== 'pending') return question;
      const task = this.store.row(question.task_id);
      if (!task || task.status === 'cancelled') return { ...question, status: 'cancelled' };
      const left = deadline - Date.now();
      if (left <= 0) return question;
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.min(left, 30_000));
        function done() { clearTimeout(timer); resolve(); }
        if (!this.waiters.has(questionId)) this.waiters.set(questionId, new Set());
        this.waiters.get(questionId)!.add(done);
      });
    }
  }
  #resumeAfterAnswer(task: any) {
    const fresh = this.store.row(task.id)!;
    if (!fresh || !['waiting_user', 'running', 'queued'].includes(fresh.status)) return;
    if (this.store.pendingQuestions(fresh.owner, fresh.id).length) return;
    // A live executor is still blocked inside a tool call and picks the answer up itself; otherwise
    // the task is queued again so the runtime resumes the executor thread with the answer.
    this.store.updateTask(fresh.id, { status: fresh.claim_token ? 'running' : 'queued' });
  }

  // ================================================================ Dots-facing tools
  async dotsCall(owner: any, origin: any, tool: any, args = {}) {
    owner = String(owner || ''); if (!owner) throw fail('账号身份无效', 401);
    switch (tool) {
      case 'browse': return this.browse(owner, origin, args);
      case 'windows': return this.windowsTool(owner, origin, args);
      case 'search': return this.search(owner, args);
      case 'open': return this.open(owner, args);
      case 'find': return this.find(owner, args);
      default: throw fail('未知的浏览器工具', 404);
    }
  }
  #grantFiles(owner: any, ids: any) {
    const out: any[] = [];
    for (const fileId of (Array.isArray(ids) ? ids : []).slice(0, 10)) {
      const value = String(fileId || '');
      if (!this.attachments) throw fail('文件授权不可用', 503);
      const file = this.attachments.download(owner, value);
      out.push({ id: value, filename: file.filename, mime: file.mimeType || 'application/octet-stream', size: file.data.length });
    }
    return out;
  }
  async browse(owner: any, origin: any, { task_id: taskId, task: instruction = '', answer_to: answerTo = null, verification_code: codeRef = null, files = [], identity = 'default', title = '' }: {task_id?: string; task?: string; answer_to?: string | null; verification_code?: string | null; files?: any[]; identity?: string; title?: string} = {}) {
    instruction = String(instruction || '').trim();
    if (!taskId) throw fail('请提供 task_id：继续已有窗口传它的 task_id，开新活传 "new"');
    if (answerTo) {
      const question = this.store.ownedQuestion(owner, answerTo);
      if (taskId !== 'new' && question.task_id !== taskId) throw fail('answer_to 对应的问题不属于这个 task_id', 409);
      if (!DOTS_ANSWERABLE.includes(question.kind)) throw fail('这个问题需要用户在拾燕的浏览器任务面板里通过专用界面处理（加密输入、付款授权、权限或接管），不能在聊天里代答。', 403, 'user_only');
      if (!instruction) throw fail('请把回复写在 task 里');
      const task = this.store.task(owner, question.task_id);
      this.store.answerQuestion(question.id, { text: instruction }, 'dots');
      this.store.addInput(task.id, 'answer', instruction, question.id);
      this.#wake(question.id); this.#resumeAfterAnswer(task);
      return { ok: true, task_id: task.id, question_id: question.id, status: 'answer_delivered', note: '回复已转给浏览器任务，任务会继续执行；结果会自动回到对话。' };
    }
    if (taskId === 'new') {
      if (!instruction) throw fail('请在 task 里写明要达到的结果、已知选择、限制条件和已授权的信息');
      identity = normalizeIdentity(identity);
      if (!this.store.hasIdentity(owner, identity)) throw fail(`没有名为 ${identity} 的浏览器身份。可用身份：${this.store.identities(owner).map(item => item.id).join('、')}`, 404);
      const granted = this.#grantFiles(owner, files);
      const task = this.store.createTask(owner, { title: title || instruction, identity, origin, instruction, grantedFiles: granted });
      if (codeRef) this.#attachCode(owner, task, codeRef);
      return { ok: true, task_id: task.id, status: 'accepted', note: '已受理（受理不等于完成）。浏览器会在后台执行，结果和需要决定的问题会自动回到这次对话；要修改、登录、核对购物车或结账，继续用这个 task_id。' };
    }
    const task = this.store.task(owner, taskId);
    if (task.status === 'cancelled') throw fail('这个任务窗口已关闭。需要继续请用 task_id: "new" 开新任务。', 409);
    if (!instruction && !codeRef && !files?.length) throw fail('请在 task 里写明新的要求');
    if (files?.length) { const granted = JSON.parse(task.granted_files || '[]'); for (const file of this.#grantFiles(owner, files)) if (!granted.some((item: any) => item.id === file.id)) granted.push(file); this.store.updateTask(task.id, { granted_files: JSON.stringify(granted) }); }
    if (codeRef) this.#attachCode(owner, task, codeRef);
    if (instruction) this.store.addInput(task.id, 'instruction', instruction);
    let status = task.status;
    if (!task.claim_token && !['taken_over', 'waiting_user'].includes(task.status)) { status = 'queued'; this.store.updateTask(task.id, { status, error: '', finished_at: null }); }
    return { ok: true, task_id: task.id, status: status === 'taken_over' ? 'queued_until_handback' : 'accepted', note: status === 'taken_over' ? '用户正在接管这个浏览器，交还后任务会先查看变化再继续。' : '已受理（受理不等于完成），结果会自动回到对话。' };
  }
  #attachCode(owner: any, task: any, ref: any) {
    const code = this.store.bindCode(owner, ref, task.id);
    if (code.status === 'pending_approval') this.#ask(task, { kind: 'verification_share', prompt: `是否允许把验证码${code.label ? '（' + code.label + '）' : ''}分享给这个浏览器任务？仅用于本次验证。`, options: ['允许', '拒绝'], data: { code_ref: code.id } }, { block: false });
  }
  windowSummary(task: any, { detail = false } = {}) {
    const win = this.windows.get(task.id);
    const out: any = { task_id: task.id, title: task.title, status: task.status, identity: task.identity, origin: task.origin, updated_at: task.updated_at,
      window_open: Boolean(win), tabs: win ? [...win.tabs.values()].map(tab => ({ tab_id: tab.id, url: clip(tab.url, 300), title: clip(tab.title, 120), active: tab.id === win.active })) : [],
      last_url: task.last_url || undefined, summary: task.summary || undefined, error: task.error || undefined,
      pending_questions: this.store.pendingQuestions(task.owner, task.id).map(q => ({ question_id: q.id, kind: q.kind, prompt: q.prompt, options: q.options, user_only: USER_ONLY.includes(q.kind) })) };
    if (detail) { out.progress = this.store.progressList(task.id, 20); out.files = this.store.files(task.owner, task.id); }
    return out;
  }
  async windowsTool(owner: any, origin: any, { action = 'list', task_id: taskId = null, tab_id: tabId = null, url = '', identity = 'default', title = '' } = {}) {
    if (action === 'list') {
      const tasks = taskId ? [this.store.task(owner, taskId)] : this.store.listTasks(owner, { limit: 30 });
      return { ok: true, identities: this.store.identities(owner).map(item => ({ id: item.id, label: item.label })), windows: tasks.map(task => this.windowSummary(task, { detail: Boolean(taskId) })) };
    }
    if (action === 'open') {
      identity = normalizeIdentity(identity);
      if (!this.store.hasIdentity(owner, identity)) throw fail(`没有名为 ${identity} 的浏览器身份`, 404);
      const task = this.store.createTask(owner, { title: title || url || '浏览器窗口', identity, origin, status: 'idle' });
      const win = await this.#window(task);
      if (url) await this.#navigate(win.session, this.#activeTab(win), url, { taskId: task.id });
      return { ok: true, ...this.windowSummary(this.store.row(task.id)) };
    }
    const task = this.store.task(owner, taskId);
    if (action === 'close') {
      const wasActive = ACTIVE_STATUSES.includes(task.status);
      const waiting = this.store.pendingQuestions(owner, task.id).map(q => q.id);
      this.store.cancelQuestions(task.id);
      this.store.updateTask(task.id, { status: 'cancelled', finished_at: Date.now() });
      for (const questionId of waiting) this.#wake(questionId);
      await this.closeWindow(task.id);
      return { ok: true, task_id: task.id, status: 'cancelled', note: wasActive ? '窗口已关闭，任务已停止；已经在网站上完成的操作不会被撤销。' : '窗口已关闭。' };
    }
    if (action === 'open_tab' || action === 'close_tab') {
      if (task.status === 'taken_over') throw fail('用户正在接管这个窗口', 409);
      return this.#serial(task.id, async () => {
        const win = await this.#window(task);
        if (action === 'open_tab') {
          if (win.tabs.size >= MAX_TASK_TABS) throw fail(`每个窗口最多 ${MAX_TASK_TABS} 个标签页`);
          const tab = await this.#newTarget(win.session, owner, task.id, url || 'about:blank');
          win.tabs.set(tab.id, tab); win.active = tab.id;
        } else {
          const tab = win.tabs.get(String(tabId || ''));
          if (!tab) throw fail('没有找到这个标签页', 404);
          if (win.tabs.size <= 1) await this.#navigate(win.session, tab, 'about:blank').catch(() => {});
          else { win.tabs.delete(tab.id); this.#unindex(tab); await win.session.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {}); if (win.active === tab.id) win.active = [...win.tabs.keys()].at(-1); }
        }
        return { ok: true, ...this.windowSummary(this.store.row(task.id)) };
      });
    }
    throw fail('windows 的 action 只能是 list、open、close、open_tab、close_tab');
  }

  // ---- reader: search / open / find (page text only; failures are reported as they happened)
  // The reader window holds a runtime lease only while an operation runs.
  async #withReader(owner: any, fn: any) {
    const session = await this.manager.acquireAgent(owner, { identity: 'default' });
    try {
      return await this.#serial('reader:' + owner, async () => {
        let reader = this.readers.get(owner);
        if (!reader || reader.session !== session || !this.byTarget.has(reader.tab.targetId)) {
          const pages = reader?.pages || new Map(), last = reader?.last || null;
          reader = { owner, session, tab: await this.#newTarget(session, owner, null), pages, last };
          this.readers.set(owner, reader);
        }
        return fn(reader);
      });
    } finally { this.manager.releaseAgent(session); }
  }
  async #readerLoad(owner: any, url: any) {
    return this.#withReader(owner, async (reader: any) => {
      const nav = await this.#navigate(reader.session, reader.tab, url, { owner });
      if (nav.blocked) throw fail(nav.blocked.decision === 'deny' ? `浏览器权限设置拒绝访问 ${nav.blocked.origin}` : `访问 ${nav.blocked.origin} 需要用户许可（设置 > 连接器 > 浏览器 中为“询问”）；读取工具不能发起询问，可改用 browse 任务。`, 403, 'site_blocked');
      return { reader, page: await this.#eval(reader.session, reader.tab, READ_JS, { timeoutMs: 10_000 }) };
    });
  }
  async search(owner: any, { query = '', max_results: max = 8 } = {}) {
    query = String(query || '').trim(); if (!query) throw fail('请提供搜索内容');
    const engines = [`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans`, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`];
    const failures: string[] = [];
    for (const url of engines) {
      try {
        const value = await this.#withReader(owner, async (reader: any) => {
          const nav = await this.#navigate(reader.session, reader.tab, url, { owner });
          if (nav.blocked) throw fail(`搜索引擎 ${nav.blocked.origin} 被浏览器权限设置拦截`, 403);
          return this.#eval(reader.session, reader.tab, SEARCH_JS, { timeoutMs: 10_000 });
        });
        if (value?.results?.length) return { ok: true, query, engine: new URL(url).host, results: value.results.slice(0, Math.max(1, Math.min(15, Number(max) || 8))) };
        failures.push(`${new URL(url).host} 没有返回可解析的结果（页面标题：${clip(value?.title, 60)}；开头文字：${clip(value?.text, 120)}）`);
      } catch (error) { failures.push(`${new URL(url).host}：${(error as any).message}`); }
    }
    return { ok: false, query, results: [], error: '搜索没有拿到结果：' + failures.join('；') + '。这只说明读取失败，不代表真实浏览器被拦截或网站需要登录。' };
  }
  async open(owner: any, { url = '', cursor = 0 } = {}) {
    if (!url) throw fail('请提供网址');
    cursor = Math.max(0, Number(cursor) || 0);
    const target = normalizeBrowserURL(url);
    let page = this.readers.get(owner)?.pages.get(target);
    if (!page || cursor === 0) {
      try { const loaded = await this.#readerLoad(owner, target); page = loaded.page; loaded.reader.pages.set(target, page); loaded.reader.last = target; if (loaded.reader.pages.size > 20) loaded.reader.pages.delete(loaded.reader.pages.keys().next().value); }
      catch (error) { return { ok: false, url: target, error: `读取页面文字失败：${(error as any).message}。这不代表真实浏览器被拦截，也不代表网站需要登录。` }; }
    }
    const textValue = page.text || '';
    const next = cursor + PAGE_CHUNK < textValue.length ? cursor + PAGE_CHUNK : null;
    return { ok: true, url: page.url, title: page.title, total_chars: textValue.length, cursor, next_cursor: next, text: textValue.slice(cursor, cursor + PAGE_CHUNK), links: cursor === 0 ? page.links.slice(0, 40) : undefined };
  }
  async find(owner: any, { query = '', url = '' } = {}) {
    query = String(query || '').trim(); if (!query) throw fail('请提供要查找的文字');
    const reader = this.readers.get(owner);
    let key = url ? normalizeBrowserURL(url) : reader?.last;
    if (!key) throw fail('还没有打开过页面；请提供 url 或先用 open 打开页面');
    let page = reader?.pages.get(key);
    if (!page) { const result = await this.open(owner, { url: key }); if (!result.ok) return result; page = this.readers.get(owner)?.pages.get(key); }
    const hay = page.text || '', lower = hay.toLowerCase(), needle = query.toLowerCase(), matches: any[] = [];
    for (let at = lower.indexOf(needle); at >= 0 && matches.length < 20; at = lower.indexOf(needle, at + needle.length)) matches.push({ position: at, context: hay.slice(Math.max(0, at - 200), at + needle.length + 200) });
    return { ok: true, url: page.url, query, count: matches.length, matches };
  }

  // ================================================================ executor tools
  async execCall(taskId: any, token: any, tool: any, args = {}) {
    const task = this.store.verifyClaim(taskId, token);
    if (task.status === 'cancelled') throw fail('这个任务窗口已被关闭，请停止执行并结束。', 410, 'task_cancelled');
    const passive = ['get_task', 'report_progress', 'wait', 'wait_for_answer', 'finish'];
    if (task.status === 'taken_over' && !passive.includes(tool)) throw fail('用户正在接管浏览器，你和用户不会同时操作。请调用 wait_for_answer 等待交还，或 wait 后再试。', 409, 'taken_over');
    const run = async () => {
      const value = await this.#exec(task, tool, args || {});
      const extra = this.#piggyback(task.id);
      return extra ? { ...value, ...extra } : value;
    };
    // Quick page actions are serialized per window. Tools that wait for a person must not hold the
    // window lock (secure input and takeover need it while the executor is waiting).
    const quick = ['snapshot', 'screenshot', 'navigate', 'back', 'forward', 'reload', 'click', 'type', 'press', 'select', 'scroll', 'switch_tab', 'read_text', 'find_text', 'place_order', 'save_screenshot'];
    return quick.includes(tool) ? this.#serial(task.id, run) : run();
  }
  #piggyback(taskId: any) {
    const inputs = this.store.pendingInputs(taskId).filter(item => item.kind === 'instruction');
    const win = this.windows.get(taskId);
    const notes = win?.notes.splice(0) || [];
    if (!inputs.length && !notes.length) return null;
    if (inputs.length) this.store.consumeInputs(taskId, inputs.at(-1)!.id);
    return { new_instructions: inputs.length ? inputs.map(item => item.text) : undefined, browser_notes: notes.length ? notes : undefined };
  }
  async #serial(key: any, fn: any) {
    const prior = this.locks.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.locks.set(key, next.catch(() => {}));
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  async #ref(session: any, tab: any, ref: any, { scroll = true } = {}) {
    const value = await this.#eval(session, tab, `(() => { const el = document.querySelector('[data-shiyan-ref="' + ${JSON.stringify(String(ref))} + '"]'); if (!el) return null;
      ${scroll ? "el.scrollIntoView({ block: 'center', inline: 'center' });" : ''} const r = el.getBoundingClientRect(); const type = (el.getAttribute('type') || '').toLowerCase();
      const name = String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: el.tagName.toLowerCase(), type, name, secure: type === 'password' || el.getAttribute('data-shiyan-secure') === '1', file: type === 'file', editable: el.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(el.tagName) }; })()`);
    if (!value) throw fail(`元素引用 ${ref} 已失效（页面可能已变化），请重新 snapshot`, 409, 'stale_ref');
    return value;
  }
  async #clickAt(session: any, tab: any, x: any, y: any, { clickCount = 1, button = 'left' } = {}) {
    const sid = tab.sessionId;
    await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sid);
    await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, sid);
    await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, sid);
  }
  async #typeInto(session: any, tab: any, ref: any, value: any, { clear = true } = {}) {
    const el = await this.#ref(session, tab, ref);
    await this.#clickAt(session, tab, el.x, el.y);
    await this.#eval(session, tab, `(() => { const el = document.querySelector('[data-shiyan-ref="' + ${JSON.stringify(String(ref))} + '"]'); if (!el) return false; el.focus();
      ${clear ? "if (typeof el.select === 'function' && ['INPUT','TEXTAREA'].includes(el.tagName)) el.select(); else if (el.isContentEditable) document.execCommand('selectAll');" : ''} return true; })()`);
    if (value) await session.cdp.send('Input.insertText', { text: value }, tab.sessionId);
  }
  async #key(session: any, tab: any, key: any, modifiers = 0) {
    const [code, textValue] = (KEYS as any)[key] || [0, key.length === 1 ? key : undefined];
    const base = { key: key === 'Space' ? ' ' : key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, windowsVirtualKeyCode: code || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0), modifiers };
    await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(textValue && !modifiers ? { text: textValue } : {}) }, tab.sessionId);
    await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab.sessionId);
  }
  #snapshotResult(tab: any, value: any, win: any) {
    tab.gen = value.gen; tab.url = value.url; tab.title = value.title;
    const out: any = { url: value.url, title: clip(value.title, 200), tab_id: tab.id, tabs: [...win.tabs.values()].map(t => ({ tab_id: t.id, url: clip(t.url, 200), title: clip(t.title, 80), active: t.id === win.active })),
      elements: value.items, more_elements: value.more || undefined, text: value.text, scroll: value.scroll };
    if (value.challenge) out.challenge = { kind: value.challenge, note: '页面出现了机器人验证/验证码。不要尝试破解或绕过。对话里发起的任务可用 request_takeover 请用户亲自完成；定时/推送/网页应用发起的任务不能接管，请 finish(status="blocked") 如实汇报。' };
    if (value.hasPassword) out.password_note = '页面有密码框：只能用 fill_saved_login 或 request_secure_input 填写，不能用 type。';
    if (tab.blocked) out.blocked_navigation = tab.blocked;
    if (tab.dialog) { out.dialog = tab.dialog; tab.dialog = null; }
    return out;
  }
  async #exec(task: any, tool: any, args: any) {
    const owner = task.owner;
    switch (tool) {
      case 'get_task': {
        const inputs = this.store.pendingInputs(task.id);
        if (inputs.length) this.store.consumeInputs(task.id, inputs.at(-1)!.id);
        const checkout = JSON.parse(task.checkout || 'null');
        return { task_id: task.id, title: task.title, origin: task.origin, identity: task.identity, status: task.status,
          takeover_available: task.origin === 'chat', instructions: this.store.allInstructions(task.id).map(item => ({ kind: item.kind, text: item.text })),
          new_inputs: inputs.map(item => ({ kind: item.kind, text: item.text, question_id: item.question_id || undefined })),
          granted_files: JSON.parse(task.granted_files || '[]'), permissions: this.store.permissions(owner), checkout: checkout || undefined,
          pending_questions: this.store.pendingQuestions(owner, task.id).map(q => ({ question_id: q.id, kind: q.kind, prompt: q.prompt })),
          window: this.windowSummary(task).tabs };
      }
      case 'report_progress': this.store.progress(task.id, String(args.text || '')); return { ok: true };
      case 'wait': await delay(Math.max(1, Math.min(30, Number(args.seconds) || 3)) * 1000); return { ok: true, status: this.store.row(task.id)!.status };
      case 'wait_for_answer': {
        const question = this.store.ownedQuestion(owner, args.question_id);
        if (question.task_id !== task.id) throw fail('这个问题不属于当前任务', 403);
        const done = await this.waitAnswer(question.id);
        if (done.status === 'pending') return { status: 'still_pending', note: '还没有答复；可以继续等待或汇报。' };
        return { status: done.status, kind: done.kind, answer: done.answer, answered_by: done.answered_by };
      }
      case 'snapshot': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        return this.#snapshotResult(tab, await this.#eval(win.session, tab, SNAPSHOT_JS, { timeoutMs: 10_000 }), win);
      }
      case 'screenshot': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const shot = await win.session.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: true }, tab.sessionId, 10_000);
        return { image: shot.data, mimeType: 'image/jpeg', url: tab.url, note: '截图坐标与 click(x,y) 使用同一视口坐标系。' };
      }
      case 'navigate': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const result = await this.#navigate(win.session, tab, args.url, { taskId: task.id });
        if (result.blocked) return { ok: false, blocked_navigation: result.blocked, note: result.blocked.decision === 'deny' ? '用户的浏览器权限拒绝访问这个网站。请在任务限制内找替代办法，或如实汇报打不开。' : '访问这个网站需要用户许可，已发起询问。调用 wait_for_answer(question_id) 等待，获准后再次 navigate。' };
        return { ok: true, url: result.url };
      }
      case 'back': case 'forward': case 'reload': {
        const win = await this.#window(task), tab = this.#activeTab(win), sid = tab.sessionId;
        const waiting = this.#waitLoad(tab, 10_000);
        if (tool === 'reload') await win.session.cdp.send('Page.reload', {}, sid);
        else {
          const history = await win.session.cdp.send('Page.getNavigationHistory', {}, sid);
          const entry = history.entries?.[history.currentIndex + (tool === 'back' ? -1 : 1)];
          if (!entry) return { ok: false, note: '没有可以' + (tool === 'back' ? '后退' : '前进') + '的页面' };
          await win.session.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sid);
        }
        await waiting; return { ok: true };
      }
      case 'click': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        let x = Number(args.x), y = Number(args.y), name = '';
        if (args.ref !== undefined && args.ref !== null && args.ref !== '') {
          const el = await this.#ref(win.session, tab, args.ref); x = el.x; y = el.y; name = el.name;
          if (el.file) return { ok: false, note: '这是文件选择框，请用 upload_file 上传已授权的文件。' };
        } else if (!Number.isFinite(x) || !Number.isFinite(y)) throw fail('请提供 ref 或 x、y 坐标');
        if (name && PURCHASE_RE.test(name)) return { ok: false, note: `“${clip(name, 40)}”看起来会提交订单或付款。必须先 request_payment_authorization 获得用户在专用界面的付款授权，再用 place_order 点击。` };
        await this.#clickAt(win.session, tab, x, y, { clickCount: args.double ? 2 : 1, button: args.button === 'right' ? 'right' : 'left' });
        await delay(400);
        return { ok: true, clicked: name || `(${Math.round(x)},${Math.round(y)})`, url: tab.url };
      }
      case 'type': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const el = await this.#ref(win.session, tab, args.ref);
        if (el.secure) throw fail('密码和加密字段不能用 type 填写：用 fill_saved_login（Secure Vault）或 request_secure_input（用户加密录入）。', 403, 'secure_field');
        await this.#typeInto(win.session, tab, args.ref, String(args.text ?? '').slice(0, 5000), { clear: args.clear !== false });
        if (args.submit) await this.#key(win.session, tab, 'Enter');
        return { ok: true };
      }
      case 'press': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const key = String(args.key || ''); if (!(KEYS as any)[key] && key.length !== 1) throw fail('不支持的按键');
        const mods = (args.modifiers || []).reduce((sum: any, item: any) => sum | (({ alt: 1, ctrl: 2, meta: 4, shift: 8 } as any)[item] || 0), 0);
        await this.#key(win.session, tab, key, mods); await delay(250); return { ok: true };
      }
      case 'select': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const value = await this.#eval(win.session, tab, `(() => { const el = document.querySelector('[data-shiyan-ref="' + ${JSON.stringify(String(args.ref))} + '"]'); if (!el || el.tagName !== 'SELECT') return { ok: false };
          const want = ${JSON.stringify(String(args.option ?? ''))}; const opt = Array.from(el.options).find(o => o.value === want) || Array.from(el.options).find(o => o.innerText.trim() === want) || Array.from(el.options).find(o => o.innerText.includes(want));
          if (!opt) return { ok: false, options: Array.from(el.options).map(o => o.innerText.trim()).slice(0, 50) }; el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, selected: opt.innerText.trim() }; })()`);
        return value?.ok ? value : { ok: false, note: '没有匹配的选项或不是下拉框', options: value?.options };
      }
      case 'scroll': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        if (args.ref) { await this.#ref(win.session, tab, args.ref); return { ok: true }; }
        const amount = Math.max(100, Math.min(3000, Number(args.amount) || 650)) * (args.direction === 'up' ? -1 : 1);
        await win.session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 450, deltaX: 0, deltaY: amount }, tab.sessionId);
        await delay(300); return { ok: true };
      }
      case 'switch_tab': {
        const win = await this.#window(task);
        if (!win.tabs.has(String(args.tab_id))) throw fail('没有找到这个标签页', 404);
        win.active = String(args.tab_id); return { ok: true, tab_id: win.active };
      }
      case 'new_tab': case 'close_tab': {
        const result = await this.windowsTool(owner, task.origin, { action: tool === 'new_tab' ? 'open_tab' : 'close_tab', task_id: task.id, tab_id: args.tab_id, url: args.url });
        return { ok: true, tabs: result.tabs };
      }
      case 'read_text': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const page = await this.#eval(win.session, tab, READ_JS, { timeoutMs: 10_000 });
        const cursor = Math.max(0, Number(args.cursor) || 0);
        return { url: page.url, title: page.title, total_chars: page.text.length, cursor, next_cursor: cursor + PAGE_CHUNK < page.text.length ? cursor + PAGE_CHUNK : null, text: page.text.slice(cursor, cursor + PAGE_CHUNK) };
      }
      case 'find_text': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const page = await this.#eval(win.session, tab, READ_JS, { timeoutMs: 10_000 });
        const needle = String(args.query || '').toLowerCase(); if (!needle) throw fail('请提供要查找的文字');
        const lower = page.text.toLowerCase(), matches: string[] = [];
        for (let at = lower.indexOf(needle); at >= 0 && matches.length < 15; at = lower.indexOf(needle, at + needle.length)) matches.push(page.text.slice(Math.max(0, at - 160), at + needle.length + 160));
        return { count: matches.length, matches };
      }
      case 'ask': {
        const kind = args.kind === 'cart_confirmation' ? 'cart_confirmation' : 'choice';
        if (kind === 'cart_confirmation' && this.store.pendingQuestions(owner, task.id).some(q => q.kind === 'cart_confirmation')) throw fail('这个窗口已有一个待确认的购物车；一个窗口一次只跑一个结账。', 409);
        const question = this.#ask(task, { kind, prompt: String(args.question || '').slice(0, 1500), options: (args.options || []).slice(0, 8).map((item: any) => String(item).slice(0, 120)), data: kind === 'cart_confirmation' ? { cart: args.cart || {} } : {} });
        if (kind === 'cart_confirmation') this.store.updateTask(task.id, { checkout: JSON.stringify({ stage: 'cart_pending', cart_question: question.id }) });
        const done = await this.waitAnswer(question.id);
        this.#afterWait(task);
        return done.status === 'answered' ? { question_id: question.id, answer: done.answer?.text ?? done.answer, answered_by: done.answered_by } : { question_id: question.id, status: done.status, note: '还没有答复。可以继续 wait_for_answer，或先完成不依赖这个选择的部分。' };
      }
      case 'request_secure_input': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        await this.#ref(win.session, tab, args.ref);
        await this.#eval(win.session, tab, `(() => { const el = document.querySelector('[data-shiyan-ref="' + ${JSON.stringify(String(args.ref))} + '"]'); if (el) el.setAttribute('data-shiyan-secure', '1'); return true; })()`);
        const kind = ['password', 'card', 'otp', 'other'].includes(args.kind) ? args.kind : 'other';
        const question = this.#ask(task, { kind: 'secure_input', prompt: `请在加密输入框里填写：${clip(args.label || '敏感信息', 80)}（${originOf(tab.url) || '当前网站'}）`, data: { label: clip(args.label, 80), input_kind: kind, origin: originOf(tab.url), tab_id: tab.id, ref: String(args.ref) } });
        const done = await this.waitAnswer(question.id);
        this.#afterWait(task);
        if (done.status !== 'answered') return { status: done.status, note: '用户还没有完成加密输入。' };
        return done.answer?.entered ? { ok: true, note: '用户已加密录入，内容已直接填进页面，未经过你。' } : { ok: false, note: done.answer?.error || '加密输入没有填进页面（页面可能已变化）。' };
      }
      case 'fill_saved_login': {
        const win = await this.#window(task), tab = this.#activeTab(win), pageOrigin = originOf(tab.url);
        if (!pageOrigin) throw fail('当前页面不是网站页面');
        const setting = this.store.permissions(owner).savedPasswords;
        if (setting === 'deny') return { ok: false, note: '用户在浏览器权限中禁用了“填写保存的账号密码”。这不代表没有保存登录。可请求 request_secure_input 让用户加密录入，或汇报。' };
        const candidates = this.store.vaultCandidates(owner, pageOrigin, task.identity);
        if (!candidates.length) return { ok: false, note: `Secure Vault 中没有匹配 ${pageOrigin}（身份 ${task.identity}）的保存登录。可请求 request_secure_input 让用户加密录入。` };
        const entry = args.entry_id ? candidates.find(item => item.id === args.entry_id) : candidates.length === 1 ? candidates[0] : null;
        if (!entry) return { ok: false, choose: candidates.map(item => ({ entry_id: item.id, username: item.username, label: item.label })), note: '有多条保存的登录，请用 entry_id 指定（或 ask 用户选哪个账号）。' };
        if (setting === 'ask') {
          const question = this.#ask(task, { kind: 'saved_password', prompt: `是否允许浏览器为 ${pageOrigin} 填写保存的账号 ${entry.username}？`, options: ['允许', '拒绝'], data: { entry_id: entry.id, origin: pageOrigin, username: entry.username } });
          const done = await this.waitAnswer(question.id);
          this.#afterWait(task);
          if (done.status !== 'answered' || done.answer?.decision !== 'allow') return { ok: false, note: done.status === 'answered' ? '用户拒绝填写保存的密码。' : '用户还没有答复。' };
        }
        const secret = this.store.vaultReveal(owner, entry.id);
        if (args.username_ref) await this.#typeInto(win.session, tab, args.username_ref, secret.username);
        if (args.password_ref) await this.#typeInto(win.session, tab, args.password_ref, secret.password);
        return { ok: true, username: secret.username, note: '已从 Secure Vault 填入；密码没有经过你。登录结果请看页面实际反馈，登不上要如实汇报。' };
      }
      case 'enter_verification_code': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const ref = args.code_ref || this.store.db.prepare("SELECT id FROM browser_codes WHERE owner=? AND task_id=? AND status IN ('approved','pending_approval') ORDER BY created_at DESC LIMIT 1").get(owner, task.id)?.id;
        if (!ref) return { ok: false, note: '这个任务没有可用的验证码引用。可用 request_secure_input(kind="otp") 请用户录入。' };
        const code = this.store.code(owner, ref);
        if (code.task_id !== task.id) throw fail('验证码引用不属于这个任务', 403);
        if (code.status === 'pending_approval') {
          const question = this.store.pendingQuestions(owner, task.id).find(q => q.kind === 'verification_share' && q.data.code_ref === ref) || this.#ask(task, { kind: 'verification_share', prompt: '是否允许把验证码分享给这个浏览器任务？仅用于本次验证。', options: ['允许', '拒绝'], data: { code_ref: ref } });
          const done = await this.waitAnswer(question.id); this.#afterWait(task);
          if (done.status !== 'answered' || done.answer?.decision !== 'allow') return { ok: false, note: '用户没有批准分享验证码。' };
        }
        const value = this.store.consumeCode(owner, ref, task.id);
        await this.#typeInto(win.session, tab, args.ref, value);
        return { ok: true, note: '验证码已填入（仅本次有效，未经过你）。' };
      }
      case 'request_payment_authorization': {
        const checkout = JSON.parse(task.checkout || 'null');
        if (checkout?.stage === 'authorized' && !checkout.used) return { ok: true, authorization_id: checkout.authorization_id, note: '已有一个未使用的付款授权。' };
        if (this.store.pendingQuestions(owner, task.id).some(q => q.kind === 'payment_authorization')) throw fail('已有一个待用户处理的付款授权', 409);
        const data = { merchant: clip(args.merchant, 120), amount: clip(args.amount, 40), currency: clip(args.currency || 'CNY', 8), items: (args.items || []).slice(0, 30).map((item: any) => clip(typeof item === 'string' ? item : JSON.stringify(item), 200)), payment_method: clip(args.payment_method, 80), url: clip(this.windows.get(task.id) ? this.#activeTab(this.windows.get(task.id)).url : task.last_url, 300) };
        const question = this.#ask(task, { kind: 'payment_authorization', prompt: `付款授权：${data.merchant} ${data.amount} ${data.currency}`, data });
        const done = await this.waitAnswer(question.id); this.#afterWait(task);
        if (done.status !== 'answered') return { status: done.status, note: '用户还没有处理付款授权。' };
        if (!done.answer?.approved) { this.store.updateTask(task.id, { checkout: JSON.stringify({ stage: 'declined' }) }); return { ok: false, note: '用户拒绝了付款授权，不能下单。' }; }
        this.store.updateTask(task.id, { checkout: JSON.stringify({ stage: 'authorized', authorization_id: question.id, used: false, amount: data.amount, currency: data.currency, merchant: data.merchant }) });
        return { ok: true, authorization_id: question.id, note: '用户已授权这一笔付款。用 place_order(ref, authorization_id) 提交；提交后必须核实商家订单凭证。' };
      }
      case 'place_order': {
        const checkout = JSON.parse(this.store.row(task.id)!.checkout || 'null');
        if (checkout?.used && checkout.authorization_id === args.authorization_id) throw fail('这个付款授权已经用过。结果不明时先核对订单，不要重复提交。', 409, 'authorization_used');
        if (!checkout || checkout.stage !== 'authorized' || checkout.authorization_id !== args.authorization_id) throw fail('没有有效的付款授权：先 request_payment_authorization，由用户在专用界面批准。交还控制权不等于批准购买。', 403, 'no_authorization');
        const win = await this.#window(task), tab = this.#activeTab(win);
        const el = await this.#ref(win.session, tab, args.ref);
        this.store.updateTask(task.id, { checkout: JSON.stringify({ ...checkout, used: true, stage: 'placed', placed_at: Date.now() }) });
        await this.#clickAt(win.session, tab, el.x, el.y);
        await delay(1500);
        return { ok: true, note: '已点击提交。订单是否完成只以商家页面/邮件中的订单号等凭证为准：请查看页面并在 finish 的 merchant_confirmation 里写明；看不到凭证就按“结果不明”汇报，不要重试。' };
      }
      case 'request_takeover': {
        if (task.origin !== 'chat') return { ok: false, note: '这个任务来自定时任务、主动推送或网页应用，不能提供接管。请 finish(status="blocked") 如实汇报哪一步走不通。' };
        const question = this.#ask(task, { kind: 'takeover', prompt: clip(args.reason || '需要你亲自在浏览器里完成这一步', 300), options: ['接管浏览器'], data: { reason: clip(args.reason, 300) } });
        const done = await this.waitAnswer(question.id, 60 * 60_000);
        this.#afterWait(task);
        if (done.status !== 'answered') return { status: done.status, note: '用户还没有接管或交还。' };
        return { ok: true, handed_back: true, note: '用户已交还控制。先 snapshot 查看用户做了哪些变化再继续。交还不等于批准购买、公开信息或重试未知操作。', user_note: done.answer?.note };
      }
      case 'download_file': {
        const setting = this.store.permissions(owner).downloads;
        if (setting === 'deny') return { ok: false, note: '用户的浏览器权限禁止下载文件。' };
        const win = await this.#window(task), tab = this.#activeTab(win);
        if (setting === 'ask') {
          const question = this.#ask(task, { kind: 'download', prompt: `是否允许浏览器任务从 ${originOf(tab.url) || '当前网站'} 下载文件？`, options: ['允许', '拒绝'], data: { origin: originOf(tab.url), what: clip(args.description || args.url || '', 200) } });
          const done = await this.waitAnswer(question.id); this.#afterWait(task);
          if (done.status !== 'answered' || done.answer?.decision !== 'allow') return { ok: false, note: '用户没有允许下载。' };
        }
        return this.#download(task, win, tab, args);
      }
      case 'upload_file': {
        const setting = this.store.permissions(owner).uploads;
        if (setting === 'deny') return { ok: false, note: '用户的浏览器权限禁止上传文件。' };
        const granted = JSON.parse(task.granted_files || '[]').find((item: any) => item.id === args.file_id);
        if (!granted) throw fail('这个文件没有授权给本任务。需要的文件要由 Dots 在 browse 的 files 里授权。', 403);
        const win = await this.#window(task), tab = this.#activeTab(win);
        const question = this.#ask(task, { kind: 'upload', prompt: `是否允许把文件“${granted.filename}”上传到 ${originOf(tab.url) || '当前网站'}？`, options: ['允许', '拒绝'], data: { file: granted.filename, origin: originOf(tab.url) } });
        const done = await this.waitAnswer(question.id); this.#afterWait(task);
        if (done.status !== 'answered' || done.answer?.decision !== 'allow') return { ok: false, note: '用户没有允许上传。' };
        return this.#upload(task, win, tab, args.ref, granted);
      }
      case 'save_screenshot': {
        const win = await this.#window(task), tab = this.#activeTab(win);
        const shot = await win.session.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, tab.sessionId, 10_000);
        const file = this.#deliver(task, { kind: 'screenshot', filename: `${clip(args.label || '浏览器截图', 40).replace(/[\\/:*?"<>|]/g, '_')}.png`, mime: 'image/png', data: Buffer.from(shot.data, 'base64') });
        return { ok: true, file_id: file.id, attachment_id: file.attachment_id, filename: file.filename };
      }
      case 'finish': {
        const status = ['done', 'failed', 'blocked'].includes(args.status) ? args.status : 'done';
        const fresh = this.store.row(task.id)!, checkout = JSON.parse(fresh.checkout || 'null');
        const unverified = status === 'done' && checkout?.used && !String(args.merchant_confirmation || '').trim();
        const finalStatus = unverified ? 'unverified' : status;
        const files = this.store.files(owner, task.id).map(item => ({ file_id: item.id, attachment_id: item.attachment_id, filename: item.filename, kind: item.kind }));
        const summary = clip(args.summary || '', 4000);
        this.store.updateTask(task.id, { status: finalStatus, summary, result: JSON.stringify({ merchant_confirmation: args.merchant_confirmation || null, files }), finished_at: Date.now(), error: '' });
        this.store.cancelQuestions(task.id);
        this.store.event(owner, task.id, 'browser_task_update', { task_id: task.id, status: finalStatus, summary, merchant_confirmation: args.merchant_confirmation || undefined, files: files.length ? files : undefined,
          note: unverified ? '已提交订单但没有核实到商家凭证：结果不明，先对清楚再决定重试、换支付方式或开新任务。' : files.length ? '用户要的文件需要在聊天里发给他们或存到资料库；虚拟机里的文件不会自动到用户设备上。' : undefined });
        return { ok: true, status: finalStatus };
      }
      default: throw fail('未知的浏览器操作：' + tool, 404);
    }
  }
  #afterWait(task: any) { const fresh = this.store.row(task.id); if (fresh && ['waiting_user'].includes(fresh.status) && !this.store.pendingQuestions(fresh.owner, fresh.id).length) this.store.updateTask(fresh.id, { status: 'running' }); }

  // ---- files
  #deliver(task: any, { kind, filename, mime, data }: any) {
    const sha256 = createHash('sha256').update(data).digest('hex');
    let attachmentId: string | null = null;
    if (this.attachments) {
      if (data.length > 20 * 1024 * 1024) throw fail('文件超过 20 MB，无法交付', 413);
      attachmentId = randomUUID();
      this.attachments.upload(task.owner, { id: attachmentId, filename, mimeType: mime, data: data.toString('base64') });
    }
    return this.store.addFile(task.owner, task.id, { kind, filename, mime, size: data.length, sha256, attachmentId });
  }
  #downloadEvent(message: any) {
    const params = message.params || {};
    if (message.method === 'Browser.downloadWillBegin') {
      const pending = [...this.downloads.values()].find(item => !item.guid);
      if (pending) { pending.guid = params.guid; pending.filename = params.suggestedFilename || 'download'; pending.url = params.url; this.downloads.set(params.guid, pending); }
    } else if (message.method === 'Browser.downloadProgress') {
      const item = this.downloads.get(params.guid);
      if (item && ['completed', 'canceled'].includes(params.state)) item.resolve(params.state);
    }
  }
  async #download(task: any, win: any, tab: any, args: any) {
    const session = win.session, dir = `/home/browser/downloads/${task.id}`;
    await this.lxc(['exec', this.container, '--', 'bash', '-lc', `mkdir -p '${dir}' && chown browser:browser '${dir}'`]);
    let resolveDone: any;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const key = 'pending:' + task.id;
    this.downloads.set(key, { resolve: resolveDone, taskId: task.id });
    await session.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
    try {
      if (args.ref) { const el = await this.#ref(session, tab, args.ref); await this.#clickAt(session, tab, el.x, el.y); }
      else if (args.url) await session.cdp.send('Page.navigate', { url: normalizeBrowserURL(args.url) }, tab.sessionId, 20_000).catch(() => {});
      else throw fail('请提供下载链接的 ref 或 url');
      const state = await Promise.race([done, delay(120_000).then(() => 'timeout')]);
      const item = [...this.downloads.values()].find(value => value.resolve === resolveDone);
      if (state !== 'completed' || !item?.guid) return { ok: false, note: state === 'timeout' ? '两分钟内没有下载完成（可能没有触发下载）。' : '下载被取消。' };
      const local = path.join(tmpdir(), 'shiyan-dl-' + randomBytes(6).toString('hex'));
      try {
        await this.lxc(['file', 'pull', `${this.container}${dir}/${item.guid}`, local], { timeoutMs: 60_000 });
        const data = readFileSync(local);
        const file = this.#deliver(task, { kind: 'download', filename: item.filename, mime: 'application/octet-stream', data });
        return { ok: true, file_id: file.id, attachment_id: file.attachment_id, filename: file.filename, size: file.size, note: '文件已保存为受保护文件；需要时在聊天里发给用户或存到资料库。' };
      } finally { try { unlinkSync(local); } catch {} void this.lxc(['exec', this.container, '--', 'rm', '-rf', dir], { allowFailure: true }).catch(() => {}); }
    } finally {
      for (const [k, value] of this.downloads) if (value.resolve === resolveDone) this.downloads.delete(k);
      await session.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    }
  }
  async #upload(task: any, win: any, tab: any, ref: any, granted: any) {
    const session = win.session, file = this.attachments!.download(task.owner, granted.id);
    const safe = path.basename(file.filename).replace(/[^\w.\-一-鿿]/g, '_').slice(0, 120) || 'upload.bin';
    const dir = `/home/browser/uploads/${task.id}`, remote = `${dir}/${safe}`;
    const local = path.join(tmpdir(), 'shiyan-up-' + randomBytes(6).toString('hex'));
    try {
      writeFileSync(local, file.data, { mode: 0o600 });
      await this.lxc(['exec', this.container, '--', 'bash', '-lc', `mkdir -p '${dir}' && chown browser:browser '${dir}'`]);
      await this.lxc(['file', 'push', local, `${this.container}${remote}`, '--mode', '0644'], { timeoutMs: 60_000 });
    } finally { try { unlinkSync(local); } catch {} }
    const el = await this.#ref(session, tab, ref);
    if (el.file) {
      const handle = await session.cdp.send('Runtime.evaluate', { expression: `document.querySelector('[data-shiyan-ref="${String(ref).replace(/"/g, '')}"]')` }, tab.sessionId);
      await session.cdp.send('DOM.setFileInputFiles', { files: [remote], objectId: handle.result.objectId }, tab.sessionId);
    } else {
      tab.fileChooser = null;
      await this.#clickAt(session, tab, el.x, el.y);
      for (let i = 0; i < 20 && !tab.fileChooser; i++) await delay(150);
      if (!tab.fileChooser) return { ok: false, note: '点击后没有出现文件选择；请找到页面上的文件输入框再试。' };
      await session.cdp.send('DOM.setFileInputFiles', { files: [remote], backendNodeId: tab.fileChooser.backendNodeId }, tab.sessionId);
    }
    return { ok: true, note: `已把“${granted.filename}”放进上传框，请确认页面已接收。` };
  }

  // ================================================================ user-side actions (frontend)
  async userAnswer(owner: any, questionId: any, input: any = {}) {
    const question = this.store.ownedQuestion(owner, questionId);
    if (question.status !== 'pending') throw fail('这个问题已经处理过', 409);
    const task = this.store.task(owner, question.task_id);
    let answer;
    switch (question.kind) {
      case 'choice': case 'cart_confirmation': {
        const textValue = String(input.text ?? input.answer ?? '').trim().slice(0, 4000);
        if (!textValue) throw fail('请填写回复');
        answer = { text: textValue };
        this.store.addInput(task.id, 'answer', textValue, question.id);
        break;
      }
      case 'payment_authorization': answer = { approved: input.approved === true }; break;
      case 'site_access': {
        const decision = input.decision === 'allow' ? 'allow' : 'deny';
        answer = { decision, remember: input.remember === true };
        if (decision === 'allow') { const allowed = JSON.parse(task.allowed_origins || '[]'); if (!allowed.includes(question.data.origin)) allowed.push(question.data.origin); this.store.updateTask(task.id, { allowed_origins: JSON.stringify(allowed) }); }
        if (input.remember === true) this.store.setSiteRule(owner, question.data.origin, decision);
        break;
      }
      case 'download': case 'upload': case 'saved_password': answer = { decision: input.decision === 'allow' ? 'allow' : 'deny' }; break;
      case 'verification_share': {
        const decision = input.decision === 'allow' ? 'allow' : 'deny';
        this.store.setCodeStatus(owner, question.data.code_ref, decision === 'allow' ? 'approved' : 'denied');
        answer = { decision }; break;
      }
      case 'secure_input': throw fail('加密输入请使用专用输入框提交', 400);
      case 'takeover': throw fail('请使用“接管浏览器”按钮', 400);
      default: throw fail('不支持的问题类型');
    }
    this.store.answerQuestion(question.id, answer, 'user');
    this.#wake(question.id); this.#resumeAfterAnswer(task);
    return { ok: true, question_id: question.id };
  }
  // Secure input: the value goes straight into the page and is never stored or returned.
  async submitSecureInput(owner: any, questionId: any, value: any) {
    const question = this.store.ownedQuestion(owner, questionId);
    if (question.kind !== 'secure_input' || question.status !== 'pending') throw fail('这个加密输入已处理或无效', 409);
    if (typeof value !== 'string' || !value || value.length > 1024) throw fail('请填写内容');
    const task = this.store.task(owner, question.task_id);
    let answer: {entered: boolean; error?: string} = { entered: false };
    try {
      await this.#serial(task.id, async () => {
        const win = this.windows.get(task.id);
        const tab = win?.tabs.get(question.data.tab_id);
        if (!win || !tab) throw fail('任务窗口已关闭，无法填入', 409);
        const el = await this.#ref(win.session, tab, question.data.ref);
        if (originOf(tab.url) !== question.data.origin) throw fail('页面已经跳到了别的网站，为安全起见没有填入', 409);
        void el;
        await this.#typeInto(win.session, tab, question.data.ref, value);
      });
      answer = { entered: true };
    } catch (error) { answer = { entered: false, error: (error as any).message }; }
    this.store.answerQuestion(question.id, answer, 'user');
    this.#wake(question.id); this.#resumeAfterAnswer(task);
    if (!answer.entered) throw fail(answer.error || '没有填入页面', 409);
    return { ok: true };
  }
  async startTakeover(owner: any, taskId: any, { accountToken = null }: { accountToken?: string | null } = {}) {
    const task = this.store.task(owner, taskId);
    if (task.origin !== 'chat') throw fail('定时任务、主动推送和网页应用发起的浏览器任务不提供接管', 403);
    if (this.takeover && this.takeover.taskId !== task.id && this.takeover.owner === owner) await this.handback(owner, this.takeover.taskId, { note: '用户转去接管另一个窗口。' }).catch(() => {});
    await this.#serial(task.id, async () => { await this.#window(task); });
    this.takeover = { owner, taskId: task.id, previousStatus: task.status };
    this.store.updateTask(task.id, { status: 'taken_over' });
    this.store.progress(task.id, '用户接管了浏览器');
    const ticket = await this.manager.createTicket(owner, { accountToken });
    return { ok: true, task_id: task.id, ...ticket };
  }
  async handback(owner: any, taskId: any, { note = '' } = {}) {
    const task = this.store.task(owner, taskId);
    const previous = this.takeover?.taskId === task.id ? this.takeover!.previousStatus : null;
    if (this.takeover?.taskId === task.id) {
      const win = this.windows.get(task.id);
      if (win) await this.manager.hideAgentTargets(win.session, [...win.tabs.values()].map(tab => tab.targetId)).catch(() => {});
      this.takeover = null;
    }
    if (task.status !== 'taken_over') return { ok: true, task_id: task.id, status: task.status };
    this.store.progress(task.id, '用户交还了浏览器');
    const pending = this.store.pendingQuestions(owner, task.id).filter(q => q.kind === 'takeover');
    for (const question of pending) { this.store.answerQuestion(question.id, { handed_back: true, note: clip(note, 300) }, 'user'); this.#wake(question.id); }
    this.store.addInput(task.id, 'handback', '用户交还了浏览器控制。' + (note ? ' ' + clip(note, 300) : '') + ' 先查看页面变化再继续；交还不等于批准购买、公开信息或重试未知操作。');
    const live = Boolean(task.claim_token);
    const others = this.store.pendingQuestions(owner, task.id).length;
    // A window the user took over while it was idle or finished goes back to that state.
    const resting = (previous === 'idle' || FINAL_STATUSES.includes(previous!)) && !live && !this.store.pendingInputs(task.id).some(item => item.kind === 'instruction');
    const status = others ? 'waiting_user' : resting ? previous : live ? 'running' : 'queued';
    this.store.updateTask(task.id, { status });
    return { ok: true, task_id: task.id, status };
  }
  async userClose(owner: any, taskId: any) { return this.windowsTool(owner, 'chat', { action: 'close', task_id: taskId }); }
  publicTask(task: any) { return { ...this.windowSummary(task, { detail: true }), created_at: task.created_at, finished_at: task.finished_at, checkout: JSON.parse(task.checkout || 'null'), result: JSON.parse(task.result || 'null') }; }

  // ================================================================ executor runtime coordination
  claim(workerId: any, { exclude = [] }: {exclude?: string[]} = {}) {
    // Owners whose browser is held by another account wait: skip them instead of failing the task.
    const busy = new Set(exclude);
    const active = this.manager.activeSession;
    if (active) for (const row of this.store.db.prepare("SELECT DISTINCT owner FROM browser_tasks WHERE status='queued'").all()) if (row.owner !== active.owner) busy.add(String(row.owner));
    const claimed = this.store.claimNext(workerId, { exclude: [...busy] });
    if (!claimed) return null;
    const task = claimed.task;
    const inputs = this.store.pendingInputs(task.id);
    return { task: { task_id: task.id, owner: task.owner, origin: task.origin, identity: task.identity, title: task.title, thread_id: task.thread_id || null, resumed: Boolean(task.thread_id) },
      token: claimed.token, new_inputs: inputs.map(item => ({ kind: item.kind, text: item.text })) };
  }
  renew(taskId: any, token: any) { this.store.renewClaim(taskId, token); return { ok: true, status: this.store.row(taskId)!.status }; }
  checkpoint(taskId: any, token: any, threadId: any) { this.store.verifyClaim(taskId, token); this.store.updateTask(taskId, { thread_id: String(threadId || '').slice(0, 200) }); return { ok: true }; }
  complete(taskId: any, token: any, { error = '' } = {}) {
    const task = this.store.verifyClaim(taskId, token);
    this.store.releaseClaim(task.id);
    const fresh = this.store.row(task.id)!;
    if (FINAL_STATUSES.includes(fresh.status) || fresh.status === 'idle') {
      // New instructions may have arrived after finish(): run them.
      if (fresh.status !== 'cancelled' && this.store.pendingInputs(task.id).some(item => item.kind === 'instruction')) this.store.updateTask(task.id, { status: 'queued', finished_at: null });
      return { ok: true, status: this.store.row(task.id)!.status };
    }
    if (['waiting_user', 'taken_over'].includes(fresh.status)) return { ok: true, status: fresh.status };
    if (fresh.status === 'queued') return { ok: true, status: 'queued' };
    const message = error ? clip(error, 600) : '执行者没有调用 finish 就结束了';
    this.store.updateTask(task.id, { status: 'failed', error: message, finished_at: Date.now() });
    this.store.event(task.owner, task.id, 'browser_task_update', { task_id: task.id, status: 'failed', summary: '浏览器任务没有完成：' + message });
    return { ok: true, status: 'failed' };
  }
  requeueBusy(taskId: any, token: any, reason: any) {
    this.store.verifyClaim(taskId, token); this.store.releaseClaim(taskId);
    this.store.updateTask(taskId, { status: 'queued', error: clip(reason, 300) });
  }
}

// ---------------------------------------------------------------------------------- private socket
// Only local processes of the service user can reach it (0600). The Dots bridge passes its owner
// from the runtime environment (never from model arguments); executor calls carry a claim token.
export function startBrowserAgentSocket(host: any, socketPath: any) {
  const send = (res: any, status: any, value: any) => { const data = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }); res.end(data); };
  const server = http.createServer(async (req, res) => {
    try {
      let size = 0; const chunks: any[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw fail('请求过大', 413); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const route = new URL(req.url || '/', 'http://local').pathname;
      if (req.method !== 'POST') return send(res, 405, { ok: false });
      if (route === '/dots/call') return send(res, 200, { ok: true, result: await host.dotsCall(input.owner, ['chat', 'scheduled', 'push', 'webapp'].includes(input.origin) ? input.origin : 'chat', String(input.tool || ''), input.args || {}) });
      if (route === '/exec/call') return send(res, 200, { ok: true, result: await host.execCall(String(input.task_id || ''), String(input.token || ''), String(input.tool || ''), input.args || {}) });
      if (route === '/executor/claim') return send(res, 200, { ok: true, claim: host.claim(String(input.worker_id || 'executor'), { exclude: input.exclude || [] }) });
      if (route === '/executor/renew') return send(res, 200, host.renew(String(input.task_id), String(input.token)));
      if (route === '/executor/checkpoint') return send(res, 200, host.checkpoint(String(input.task_id), String(input.token), input.thread_id));
      if (route === '/executor/complete') return send(res, 200, host.complete(String(input.task_id), String(input.token), { error: input.error || '' }));
      if (route === '/executor/requeue') { host.requeueBusy(String(input.task_id), String(input.token), input.reason || ''); return send(res, 200, { ok: true }); }
      if (route === '/events/claim') return send(res, 200, { ok: true, events: host.store.undeliveredEvents(Math.min(100, Number(input.limit) || 50)) });
      if (route === '/events/ack') { host.store.markDelivered(Array.isArray(input.ids) ? input.ids : []); return send(res, 200, { ok: true }); }
      return send(res, 404, { ok: false, error: 'not found' });
    } catch (error) { send(res, (error as any).status && (error as any).status < 600 ? (error as any).status : 500, { ok: false, error: (error as any).status ? (error as any).message : '浏览器服务内部错误', code: (error as any).code || undefined }); if (!(error as any).status) process.stderr.write('[browser-agent] ' + ((error as any)?.stack || error) + '\n'); }
  });
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { rmSync(socketPath, { force: true }); } catch {}
  return new Promise<any>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { try { chmodSync(socketPath, 0o600); } catch {} resolve(server); });
  });
}

// Shared client used by the MCP bridges and the Dots runtime executor.
export function browserAgentRequest(socketPath: any, route: any, body: any, { timeoutMs = 30 * 60_000 } = {}) {
  const payload = Buffer.from(JSON.stringify(body || {}));
  return new Promise<any>((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
      const chunks: any[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { let data: any = {}; try { data = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {} if (res.statusCode! >= 200 && res.statusCode! < 300 && data.ok !== false) resolve(data); else reject(Object.assign(new Error(data.error || '浏览器服务请求失败'), { status: res.statusCode, code: data.code })); });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('浏览器服务响应超时'), { status: 504 })));
    req.on('error', error => reject(Object.assign(new Error((error as any).code === 'ENOENT' || (error as any).code === 'ECONNREFUSED' ? '浏览器服务不可用（Dots 服务未运行）' : (error as any).message), { status: 503 })));
    req.end(payload);
  });
}
export const defaultBrowserSocket = (root: any) => path.join(root, 'data', 'browser', 'agent.sock');
export { originMatches };
