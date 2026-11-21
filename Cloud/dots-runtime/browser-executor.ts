// Runs Dots browser tasks. The browser host (Dots sidecar) queues tasks created by browse; this loop
// claims them and runs one real agent per task (Claude Agent SDK or Codex, chosen by the model hub
// consumer "dots.browser") inside the account's Docker sandbox. The low-level browser tools are host
// tools bound to the claimed task; the agent also keeps its SDK's own tools (shell, files, code) for
// parsing pages or preparing data. Task events (results, questions, steps that need the user) are
// relayed into the owner's Dots conversation inbox so results come back automatically.
import http from 'node:http';
import path from 'node:path';

const ROOT = process.env.SHIYAN_ROOT || '/home/ubuntu/boss-codex-service/shiyan-v2';
export const BROWSER_SOCKET = process.env.SHIYAN_BROWSER_SOCKET || path.join(ROOT, 'data', 'browser', 'agent.sock');
// The Dots sidecar (browser host, MCP bridges, tool definitions) is deployed in SHIYAN_ROOT.
export const BROWSER_AGENT_DIR = process.env.SHIYAN_BROWSER_AGENT_DIR || ROOT;
let toolDefsPromise = null;
export const loadBrowserToolDefs = (dir = BROWSER_AGENT_DIR) => (toolDefsPromise ||= import(path.join(dir, 'browser-tool-defs.mjs')));
export const BROWSER_DOTS_TOOLS = ['browse', 'windows', 'search', 'open', 'find'];

export function request(route, body, { socketPath = BROWSER_SOCKET, timeoutMs = 30_000 } = {}) {
  const payload = Buffer.from(JSON.stringify(body || {}));
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { let data = {}; try { data = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {} if (res.statusCode < 300 && data.ok !== false) resolve(data); else reject(Object.assign(new Error(data.error || 'browser service error'), { status: res.statusCode })); });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('browser service timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

// MCP server definitions for a Dots conversation (or worker) thread.
export function browserMcpServer(owner, origin = 'chat') {
  return { command: process.execPath, args: [path.join(BROWSER_AGENT_DIR, 'browser-mcp-proxy.mjs')], env: { SHIYAN_ROOT: ROOT, SHIYAN_BROWSER_SOCKET: BROWSER_SOCKET, SHIYAN_MCP_OWNER: String(owner), SHIYAN_BROWSER_ORIGIN: origin }, tool_timeout_sec: 180 };
}
export const browserToolAllowlist = (server = 'browser') => BROWSER_DOTS_TOOLS.map(tool => `mcp__${server}__${tool}`);

export function executorPrompt(task, inputs = []) {
  const fresh = inputs.length ? '\n本轮新输入（追加要求、问题答复或交还说明）：\n' + inputs.map(item => `- [${item.kind}] ${item.text}`).join('\n') + '\n' : '';
  const intro = task.resumed
    ? `继续执行拾燕 Dots 浏览器任务「${task.title}」（task_id ${task.task_id}）。浏览器窗口和登录状态保留着，但页面可能已变化：先 get_task，再 snapshot 查看当前页面。${fresh}`
    : `你是拾燕 Dots 的浏览器执行者，在服务器上一台隔离的真实 Chrome 里替用户完成任务「${task.title}」（task_id ${task.task_id}，发起来源 ${task.origin}，浏览器身份 ${task.identity}）。${fresh}`;
  return `${intro}
工作方式
- 先调用 get_task 读取完整要求、限制条件、授权文件和权限。之后循环：snapshot 看页面 → 用 ref 操作（click/type/select/press/scroll/navigate）→ 再 snapshot 确认。看不清布局或内容在 iframe 里时用 screenshot，并可按坐标点击。
- 只做任务要求范围内的事，遵守限制条件；已知的确切选择照办，不擅自替换商品、日期、数量或收件信息。
- 有会影响结果而要求里没定的选择时，用 ask(kind="choice") 问；工具返回 new_instructions 时把它并入任务。
- 定期 report_progress 记录关键进展（不要写敏感信息）。
登录和隐私
- 登录先用 fill_saved_login（Secure Vault）。没有保存的登录或权限不允许时，用 request_secure_input 请用户加密录入。登不上、被禁用、被拒绝时如实汇报，不要据此说“没有保存登录”。
- 密码绝不能写进 type、progress、问题或 summary；密码框只能用 fill_saved_login / request_secure_input。用户在任务里给的卡号或一次性验证码可以用 type 填写；受保护的验证码引用用 enter_verification_code。
- 不支持的通行密钥或其他验证方式需要用户自己操作，不要承诺能替用户完成。
验证和拦截
- 遇到机器人验证、验证码或网站拦截：不要尝试破解或绕过。发起来源是 chat 时可以 request_takeover 请用户亲自完成，交还后先 snapshot 查看变化再继续；其他来源不能接管，用 finish(status="blocked") 说明哪一步走不通。
- 网站被用户的权限拦截或打不开时，在任务限制内找替代办法；用户明确要求只用那个网站的，保留这个要求并如实说明打不开。
- 用户接管期间你和用户不会同时操作；交还不等于批准购买、公开信息或重试未知操作。
购买和交付
- 一个窗口一次只跑一个结账。下单前先 ask(kind="cart_confirmation")，cart 里写清商品、规格、数量、单价、运费、合计和收货信息；得到确认后 request_payment_authorization，由用户在付款授权界面批准；然后只用 place_order 点击提交/付款按钮。
- 订单完成与否只以商家凭证（订单号、确认页、确认邮件）为准，写进 finish 的 merchant_confirmation。结果不明时如实说明，不要重试、换支付方式或重新下单。浏览器窗口不占库存、不锁价格；不承诺退款或取消一定成功。
- 用户要的文件用 download_file 或 save_screenshot 保存为受保护文件，并在 summary 里写明文件名。
结束
- 浏览器工具都在 mcp__browser__ 下。你还有自己的命令行和文件工具（工作目录是这个任务的临时目录），可以用来整理页面数据、计算或生成要上传的文件；不要用它们去访问网站，网站操作一律通过浏览器工具。
- 完成、失败或被卡住时都必须调用 finish，summary 写清实际看到的结果和依据（不要编造）。之后用一句话结束本轮。`;
}

export function createBrowserExecutor({ runAgent, route, report = () => {}, deliver, socketPath = BROWSER_SOCKET, toolDefs = loadBrowserToolDefs, concurrency = Number(process.env.SHIYAN_BROWSER_EXECUTORS || 1), pollMs = 2000, workerId = 'dots:' + process.pid, maxRunMs = 3 * 60 * 60_000, logger = console, call = request } = {}) {
  const running = new Map();
  let timer = null, closed = false, ticking = false, warned = 0;
  const rpc = (route_, body, options = {}) => call(route_, body, { socketPath, ...options });
  async function pumpEvents() {
    const { events = [] } = await rpc('/events/claim', { limit: 50 });
    if (!events.length) return;
    const delivered = [];
    for (const event of events) {
      try { await deliver(event.owner, event); delivered.push(event.id); }
      catch (error) { logger.warn?.('[browser-executor] deliver failed', error?.message || error); }
    }
    if (delivered.length) await rpc('/events/ack', { ids: delivered });
  }
  async function execute(claim) {
    const { task, token, new_inputs: inputs = [] } = claim;
    const renew = setInterval(() => { void rpc('/executor/renew', { task_id: task.task_id, token }).catch(() => {}); }, 60_000); renew.unref?.();
    const controller = new AbortController(), limit = setTimeout(() => controller.abort(new Error('浏览器任务单轮执行超过上限')), maxRunMs); limit.unref?.();
    const started = Date.now();
    let error = '', chosen = null, usage = null;
    try {
      chosen = await route('dots.browser');
      const { EXEC_TOOLS } = await toolDefs();
      // Each browser action is a host tool bound to this claim; the container never sees the token.
      const tools = EXEC_TOOLS.map(def => ({ ...def, handler: async args => (await rpc('/exec/call', { task_id: task.task_id, token, tool: def.name, args }, { timeoutMs: 2 * 60 * 60_000 })).result }));
      const out = await runAgent({ owner: task.owner, provider: chosen.provider, model: chosen.model, reasoning: chosen.reasoning, sessionRef: task.thread_id, cwd: '/workspace/dots/.browser/' + task.task_id,
        system: '你是拾燕 Dots 的浏览器执行者。按用户消息里的规则，用 mcp__browser__ 工具在服务器的真实 Chrome 中完成任务，结束前必须调用 mcp__browser__finish。', prompt: executorPrompt(task, inputs), groups: { browser: tools }, signal: controller.signal, maxTurns: 400 });
      usage = out.usage;
      await rpc('/executor/checkpoint', { task_id: task.task_id, token, thread_id: out.sessionRef }).catch(() => {});
    } catch (cause) { error = String(cause?.message || cause).slice(0, 600); logger.error?.('[browser-executor]', task.task_id, error); }
    finally {
      clearInterval(renew); clearTimeout(limit);
      try { report('dots.browser', { provider: chosen?.provider || '', model: chosen?.model || '', reasoning: chosen?.reasoning || '', account: task.owner, ok: !error, ms: Date.now() - started, error, usage }); } catch {}
      await rpc('/executor/complete', { task_id: task.task_id, token, error }).catch(cause => logger.warn?.('[browser-executor] complete failed', cause?.message || cause));
    }
  }
  async function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      await pumpEvents();
      while (running.size < concurrency && !closed) {
        const { claim } = await rpc('/executor/claim', { worker_id: workerId });
        if (!claim) break;
        const job = execute(claim).finally(() => { running.delete(claim.task.task_id); void tick(); });
        running.set(claim.task.task_id, job);
      }
      warned = 0;
    } catch (error) {
      // The sidecar may simply not be running yet; log once per outage.
      if (!warned++) logger.warn?.('[browser-executor] browser service unavailable:', error?.message || error);
    } finally { ticking = false; }
  }
  return {
    start() { if (!timer) { timer = setInterval(() => void tick(), pollMs); timer.unref?.(); void tick(); } return this; },
    tick, close() { closed = true; clearInterval(timer); timer = null; }, get running() { return running.size; },
  };
}

// How a browser task event is shown to Dots: it lands in NEW INPUT AND WORKER EVENTS.
export function inboxEvent(event) {
  const type = ['browser_task_update', 'browser_task_question', 'browser_task_needs_user'].includes(event.type) ? event.type : 'browser_task_update';
  return { type, payload: { ...event.payload, task_id: event.task_id || event.payload?.task_id } };
}
