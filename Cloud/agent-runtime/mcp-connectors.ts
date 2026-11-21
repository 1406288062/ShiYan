// 连接器：常用插件一键连接（MCP OAuth：动态注册 + PKCE）+ 手动绑定任意 MCP 地址。
// 凭据只保存在服务器上，按账号隔离；模型调用工具时由服务器带上凭据去请求，不进沙箱、不进对话。
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { resolveSandboxDestination } from './member-sandbox.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REDIRECT_URI = process.env.SHIYAN_MCP_REDIRECT_URI || 'https://hub.yandot.ai/oauth/mcp/callback';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = () => Date.now();
const MAX_PER_OWNER = 30, PENDING_TTL = 15 * 60_000;

// 精选插件：优先官方或平台维护的 MCP，覆盖开发、办公、地图出行、物流与旅行；不收录个人维护且稳定性/授权边界不清晰的服务。
// oauth = 浏览器里授权；token = 需要填令牌（tokenParam 表示令牌放在地址参数里，否则走 Bearer）；none = 直接可用。
export const MCP_CATALOG = [
  { id: 'github', name: 'GitHub', category: '开发与技术', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', summary: '仓库、Issue、PR 和代码搜索', tokenHint: '在 GitHub › Settings › Developer settings › Personal access tokens 创建', abilities: ["查看和搜索你的仓库、代码和提交记录", "新建、回复和整理 Issue", "查看 PR 改动、帮你审查并发表评论"], example: "看看 ShiYan 仓库最近还有哪些没关的 Issue", howto: "需要一个 GitHub 访问令牌（Personal access token）。获取方法：GitHub › Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token，选好允许访问的仓库和权限，复制后粘贴到这里。Key 是服务商发给你的一串字符，相当于让 Dots 代表你使用这个服务的通行证。它只保存在拾燕服务器上，不会出现在对话里；断开连接时一并删除。" },
  { id: 'gitee', name: 'Gitee', category: '开发与技术', url: 'https://api.gitee.com/mcp', auth: 'token', summary: '仓库、Issue、PR 和代码', tokenHint: '在 Gitee › 设置 › 安全设置 › 私人令牌 生成', abilities: ["查看和搜索你的 Gitee 仓库和代码", "新建、回复 Issue，查看 PR"], example: "列出我在 Gitee 上最近更新的仓库", howto: "需要一个 Gitee 私人令牌。获取方法：Gitee › 设置 › 安全设置 › 私人令牌 › 生成新令牌，复制后粘贴到这里。Key 是服务商发给你的一串字符，相当于让 Dots 代表你使用这个服务的通行证。它只保存在拾燕服务器上，不会出现在对话里；断开连接时一并删除。" },
  { id: 'tencent-docs', name: '腾讯文档', category: '办公与协作', url: 'https://docs.qq.com/openapi/mcp', auth: 'oauth', summary: '搜索、读取和编辑在线文档', abilities: ["搜索和阅读你的腾讯文档", "新建文档，把聊天内容整理成文档", "修改已有文档的内容"], example: "把今天的待办整理成一个腾讯文档", howto: "点「去授权」会打开腾讯文档官网，用你的 QQ 或微信登录并同意授权，完成后回到拾燕就连上了。拾燕拿不到你的密码，可以随时断开。" },
  { id: 'atlassian', name: 'Jira 与 Confluence', category: '办公与协作', url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth', summary: 'Jira 工单和 Confluence 文档', abilities: ["搜索 Jira 工单并查看详情", "新建工单、更新状态", "搜索和阅读 Confluence 文档"], example: "查一下 Jira 里分配给我的高优先级工单", howto: "点「去授权」会打开 Atlassian 官网，用你的 Atlassian 账号登录并同意授权，完成后回到拾燕就连上了。拾燕拿不到你的密码，可以随时断开。" },
  { id: 'canva', name: 'Canva', category: '办公与协作', url: 'https://mcp.canva.com/mcp', auth: 'oauth', summary: '查找、生成和编辑设计', abilities: ["搜索你在 Canva 里的设计", "按你的描述生成海报、封面等设计", "导出设计文件"], example: "帮我做一张周末读书会的海报", howto: "点「去授权」会打开 Canva 官网，用你的 Canva 账号登录并同意授权，完成后回到拾燕就连上了。拾燕拿不到你的密码，可以随时断开。" },
  { id: 'zapier', name: 'Zapier', category: '办公与协作', url: 'https://mcp.zapier.com/api/mcp/mcp', auth: 'oauth', summary: '调用上千个应用的自动化动作', abilities: ["调用你在 Zapier 里设置好的自动化动作，比如发邮件、写表格、发消息", "通过 Zapier 连接上千个其他应用"], example: "用 Zapier 把这段内容记到我的 Google 表格里", howto: "点「去授权」会打开 Zapier 官网，用你的 Zapier 账号登录并同意授权，完成后回到拾燕就连上了。拾燕拿不到你的密码，可以随时断开。授权时可以选择允许 Dots 使用哪些动作。" },
  { id: 'huggingface', name: 'Hugging Face', category: '开发与技术', url: 'https://huggingface.co/mcp', auth: 'none', summary: '模型、数据集和 Spaces', abilities: ["搜索模型、数据集和 Spaces", "查看模型说明和用法"], example: "找几个适合中文的小参数语音合成模型", howto: "不需要账号和 Key，点「连接」即可使用。" },
  { id: 'deepwiki', name: 'DeepWiki', category: '开发与技术', url: 'https://mcp.deepwiki.com/mcp', auth: 'none', summary: '读懂 GitHub 开源仓库', abilities: ["读懂任意 GitHub 开源仓库：目录结构、各模块的作用、怎么使用"], example: "讲讲 vercel/next.js 这个仓库是怎么组织的", howto: "不需要账号和 Key，点「连接」即可使用。" },
  { id: 'exa', name: 'Exa 搜索', category: '搜索与资讯', url: 'https://mcp.exa.ai/mcp', auth: 'none', summary: '面向 AI 的网页搜索', abilities: ["联网搜索网页，帮你找资料并给出来源"], example: "搜一下最近关于 MCP 协议的英文文章", howto: "不需要账号和 Key，点「连接」即可使用。" },
  // 国内生活：地图出行、快递、旅行、生活常用查询，各管一类，不重复。
  { id: 'amap', name: '高德地图', category: '出行与生活', url: 'https://mcp.amap.com/mcp', auth: 'token', tokenParam: 'key', summary: '地点搜索、路线规划和天气', tokenHint: '在高德开放平台 › 控制台 › 应用管理 › 我的应用 创建「Web 服务」Key', abilities: ["搜地点、查附近有什么", "规划驾车、公交、步行和骑行路线", "查天气"], example: "从望京到首都机场开车要多久？", howto: "需要一个高德开放平台的 Key（免费）。获取方法：登录 lbs.amap.com › 控制台 › 应用管理 › 我的应用 › 创建新应用 › 添加 Key，服务平台选「Web 服务」，复制 Key 粘贴到这里。Key 是服务商发给你的一串字符，相当于让 Dots 代表你使用这个服务的通行证。它只保存在拾燕服务器上，不会出现在对话里；断开连接时一并删除。" },
  { id: 'douyin', name: '抖音', category: '内容与娱乐', url: 'https://open.douyin.com/sse', auth: 'token', tokenParam: 'token', transport: 'sse', tokenLabel: '访问令牌', summary: '抖音视频搜索、图文搜索与官方跳转能力', tokenHint: '在抖音开放平台的应用管理中生成 client_token；需要用户授权的工具使用 access_token', abilities: ["搜索抖音视频和图文（以应用已开通的工具为准）", "获取抖音视频、主页等官方跳转链接", "调用已获批的经营任务等官方能力"], example: "搜索抖音上关于 AI 智能体的热门视频，并整理相关跳转链接", howto: "需要抖音开放平台的授权 Token。先在 developer.open-douyin.com 创建并审核移动/网站应用，再进入「MCP 服务广场」开通抖音官方能力。无需用户授权的工具使用 client_token；需要用户授权的工具使用 access_token。复制 Token 粘贴到这里。官方 MCP 地址为 https://open.douyin.com/sse，拾燕会使用 SSE 传输连接。官方能力可能需要审核，未开通的工具不会自动获得。Token 只保存在拾燕服务器上。" },
  { id: 'kuaidi100', name: '快递100', category: '物流与生活', url: 'https://api.kuaidi100.com/mcp/streamable', auth: 'token', tokenParam: 'key', summary: '查快递、物流轨迹和寄件时效', tokenHint: '在快递100 API 开放平台（api.kuaidi100.com）注册后，在「我的信息」里复制授权 Key', abilities: ["输入单号查快递物流轨迹", "估算寄件时效和运费"], example: "帮我查一下这个快递单号到哪了：SF1234567890", howto: "需要快递100的授权 Key。获取方法：在 api.kuaidi100.com 注册并登录 › 管理后台 › 我的信息，复制「授权 key」粘贴到这里。Key 是服务商发给你的一串字符，相当于让 Dots 代表你使用这个服务的通行证。它只保存在拾燕服务器上，不会出现在对话里；断开连接时一并删除。" },
  { id: 'fliggy', name: '飞猪旅行', category: '出行与生活', url: 'https://flyai.open.fliggy.com/mcp', auth: 'token', summary: '机票、酒店、景点门票和行程', tokenHint: '在飞猪 AI 开放平台（flyai.open.fliggy.com）创建应用后获取 API Key', abilities: ["查机票、酒店、景点门票的价格和余票", "帮你比价、规划出行行程"], example: "下周五北京到成都的机票哪班最便宜？", howto: "需要飞猪 AI 开放平台的 API Key。获取方法：登录 flyai.open.fliggy.com › 创建应用 › 复制 API Key 粘贴到这里。Key 是服务商发给你的一串字符，相当于让 Dots 代表你使用这个服务的通行证。它只保存在拾燕服务器上，不会出现在对话里；断开连接时一并删除。" },
];
const catalogEntry = id => MCP_CATALOG.find(c => c.id === id);
// 令牌放在地址参数里的服务（高德、百度等）：保存的地址不含令牌，请求时再拼上。
const endpointFor = c => { if (c.auth?.type !== 'query') return c.url; const u = new URL(c.url); u.searchParams.set(c.auth.param, c.auth.token); return u.toString(); };

function checkURL(value) {
  let u; try { u = new URL(String(value || '').trim()); } catch { throw fail('MCP 地址无效'); }
  if (u.protocol !== 'https:') throw fail('只支持 https 地址');
  if (u.username || u.password) throw fail('MCP 地址不能包含账号密码');
  return u;
}
async function safeFetch(url, init = {}, timeout = 20_000) {
  const u = checkURL(url);
  await resolveSandboxDestination(u.hostname); // 只允许公网地址
  return fetch(u, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
}
async function getJSON(url) {
  try { const r = await safeFetch(url, { headers: { accept: 'application/json' } }, 12_000); return r.ok ? await r.json() : null; } catch { return null; }
}

// —— MCP（Streamable HTTP）请求 ——
function parseBody(text, type) {
  if (/event-stream/i.test(type || '')) {
    let found = null;
    for (const line of String(text).split('\n')) if (line.startsWith('data:')) { try { const v = JSON.parse(line.slice(5)); if (v && v.id !== undefined) found = v; } catch {} }
    return found;
  }
  try { return JSON.parse(text); } catch { return null; }
}
async function rpc(url, headers, message, session) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers };
  if (session) h['mcp-session-id'] = session;
  const r = await safeFetch(url, { method: 'POST', headers: h, body: JSON.stringify(message) }, 45_000);
  const text = await r.text();
  if (text.length > 8 * 1024 * 1024) throw fail('MCP 返回内容过大', 502);
  return { status: r.status, www: r.headers.get('www-authenticate') || '', session: r.headers.get('mcp-session-id') || session || '', value: parseBody(text, r.headers.get('content-type')) };
}
async function openSseSession(url, headers) {
  const base = new URL(url);
  await resolveSandboxDestination(base.hostname);
  const safeFetchImpl = async (input, init = {}) => {
    const target = new URL(input);
    checkURL(target.toString());
    await resolveSandboxDestination(target.hostname);
    // 抖音文档将 token 放在 SSE URL 查询参数中；消息 POST 端点也必须携带同一 Token。
    if (target.origin === base.origin && base.searchParams.has('token') && !target.searchParams.has('token')) target.searchParams.set('token', base.searchParams.get('token'));
    return fetch(target, { ...init, redirect: 'manual' });
  };
  const transport = new SSEClientTransport(base, { requestInit: { headers }, fetch: safeFetchImpl, eventSourceInit: { fetch: safeFetchImpl } });
  const client = new McpClient({ name: 'shiyan', version: '1.0' });
  try {
    await client.connect(transport);
    return { client, transport };
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
}
async function openSession(url, headers, transportType = 'streamable') {
  if (transportType === 'sse') {
    const opened = await openSseSession(url, headers);
    try { await opened.client.listTools(); return { session: 'sse' }; }
    finally { await opened.client.close().catch(() => {}); }
  }
  const init = await rpc(url, headers, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shiyan', version: '1.0' } } });
  if (init.status === 401 || init.status === 403) return { unauthorized: true, www: init.www, status: init.status };
  if (init.status < 200 || init.status >= 300 || init.value?.error || !init.value?.result) throw fail('无法连接这个 MCP 服务（' + (init.value?.error?.message || init.value?.info || init.value?.msg || ('HTTP ' + init.status)) + '）', 502);
  await rpc(url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session).catch(() => {});
  return { session: init.session };
}
export async function mcpCall(url, headers, method, params = {}, transportType = 'streamable') {
  if (transportType === 'sse') {
    const opened = await openSseSession(url, headers);
    try {
      if (method === 'tools/list') return await opened.client.listTools();
      if (method === 'tools/call') return await opened.client.callTool({ name: String(params.name || ''), arguments: params.arguments || {} });
      throw fail('SSE MCP 暂不支持该操作', 400);
    } finally { await opened.client.close().catch(() => {}); }
  }
  const opened = await openSession(url, headers, transportType);
  if (opened.unauthorized) throw fail('连接授权已失效，请在连接器里重新连接', 401);
  const result = await rpc(url, headers, { jsonrpc: '2.0', id: 2, method, params }, opened.session);
  if (result.status === 401) throw fail('连接授权已失效，请在连接器里重新连接', 401);
  if (result.value?.error) throw fail(String(result.value.error.message || 'MCP 调用失败'), 502);
  return result.value?.result;
}

// —— OAuth：受保护资源元数据 → 授权服务器元数据 → 动态注册 → PKCE ——
async function discover(url, www) {
  const u = new URL(url), pathPart = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const hinted = /resource_metadata="([^"]+)"/.exec(www || '')?.[1];
  const prm = (hinted && await getJSON(hinted)) || await getJSON(u.origin + '/.well-known/oauth-protected-resource' + pathPart) || await getJSON(u.origin + '/.well-known/oauth-protected-resource');
  const issuer = prm?.authorization_servers?.[0] || u.origin;
  const a = new URL(issuer), p = a.pathname === '/' ? '' : a.pathname.replace(/\/$/, '');
  const meta = await getJSON(a.origin + '/.well-known/oauth-authorization-server' + p) || await getJSON(a.origin + '/.well-known/openid-configuration' + p)
    || (p ? await getJSON(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration') : null) || await getJSON(a.origin + '/.well-known/oauth-authorization-server');
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw fail('这个服务没有提供自动授权，请填写访问令牌');
  const scope = (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(' ') : '') || /scope="([^"]+)"/.exec(www || '')?.[1] || '';
  return { resource: prm?.resource || url, issuer: meta.issuer || issuer, meta, scope };
}
async function tokenRequest(endpoint, client, form) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = { ...form, client_id: client.client_id };
  if (client.client_secret) {
    if (client.token_endpoint_auth_method === 'client_secret_post') body.client_secret = client.client_secret;
    else headers.authorization = 'Basic ' + Buffer.from(encodeURIComponent(client.client_id) + ':' + encodeURIComponent(client.client_secret)).toString('base64');
  }
  const r = await safeFetch(endpoint, { method: 'POST', headers, body: new URLSearchParams(body) });
  const text = await r.text(); let data = null;
  try { data = JSON.parse(text); } catch { data = Object.fromEntries(new URLSearchParams(text)); }
  if (!r.ok || !data?.access_token) throw fail('授权没有完成：' + String(data?.error_description || data?.error || ('HTTP ' + r.status)).slice(0, 200), 502);
  return { access_token: data.access_token, refresh_token: data.refresh_token || form.refresh_token || null, expires_at: data.expires_in ? now() + Number(data.expires_in) * 1000 : null };
}

const html = (title, text, ok) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f8;color:#1d1d1f}main{max-width:360px;padding:32px;text-align:center}
.i{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;margin:0 auto 16px;color:#fff;font-size:28px;background:${ok ? '#34c759' : '#ff9f0a'}}h1{font-size:20px;margin:0 0 8px}p{color:#6e6e73;margin:0}</style></head>
<body><main><div class="i">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${text}</p></main></body></html>`;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = v => String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function createMcpConnectors({ file = process.env.SHIYAN_MCP_DB || path.join(ROOT, 'data', 'mcp-connectors.sqlite3') } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS connectors(owner TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,url TEXT NOT NULL,catalog_id TEXT,auth TEXT NOT NULL,state TEXT NOT NULL,error TEXT,tools TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS oauth_pending(state TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_clients(key TEXT PRIMARY KEY,data TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  const row = (owner, id) => db.prepare('SELECT * FROM connectors WHERE owner=? AND id=?').get(owner, id);
  const save = (owner, c) => db.prepare(`INSERT INTO connectors(owner,id,name,url,catalog_id,auth,state,error,tools,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner,id) DO UPDATE SET name=excluded.name,url=excluded.url,catalog_id=excluded.catalog_id,auth=excluded.auth,state=excluded.state,error=excluded.error,tools=excluded.tools,updated_at=excluded.updated_at`)
    .run(owner, c.id, c.name, c.url, c.catalogId || null, JSON.stringify(c.auth || { type: 'none' }), c.state, c.error || null, JSON.stringify(c.tools || []), c.createdAt || now(), now());
  const decode = r => ({ id: r.id, name: r.name, url: r.url, catalogId: r.catalog_id, transport: catalogEntry(r.catalog_id)?.transport || 'streamable', auth: JSON.parse(r.auth), state: r.state, error: r.error, tools: JSON.parse(r.tools || '[]'), createdAt: r.created_at, updatedAt: r.updated_at });
  const present = c => ({ id: c.id, name: c.name, url: c.url, catalogId: c.catalogId || null, state: c.state, error: c.error || '', authType: c.auth?.type || 'none',
    tools: (c.tools || []).slice(0, 60), toolCount: (c.tools || []).length, updatedAt: c.updatedAt });

  async function headersFor(owner, c) {
    const auth = c.auth || {};
    if (auth.type === 'bearer') return { authorization: 'Bearer ' + auth.token };
    if (auth.type === 'query') return {};
    if (auth.type !== 'oauth' || !auth.token?.access_token) return {};
    if (auth.token.expires_at && auth.token.expires_at - now() < 120_000 && auth.token.refresh_token) {
      try {
        auth.token = await tokenRequest(auth.tokenEndpoint, auth.client, { grant_type: 'refresh_token', refresh_token: auth.token.refresh_token, ...(auth.resource ? { resource: auth.resource } : {}) });
        save(owner, { ...c, auth, state: 'connected', error: '' });
      } catch (error) { save(owner, { ...c, state: 'error', error: '授权已过期，请重新连接' }); throw fail('连接授权已过期，请在连接器里重新连接', 401); }
    }
    return { authorization: 'Bearer ' + auth.token.access_token };
  }
  async function refreshTools(owner, c) {
    try {
      const result = await mcpCall(endpointFor(c), await headersFor(owner, c), 'tools/list', {}, c.transport || 'streamable');
      c.tools = (result?.tools || []).slice(0, 200).map(t => String(t.name || '')).filter(Boolean); c.state = 'connected'; c.error = '';
    } catch (error) { c.state = 'error'; c.error = String(error.message || error).slice(0, 200); }
    save(owner, c); return c;
  }
  async function client(d) {
    const key = d.issuer + '|' + REDIRECT_URI, existing = db.prepare('SELECT data FROM oauth_clients WHERE key=?').get(key);
    if (existing) return JSON.parse(existing.data);
    if (!d.meta.registration_endpoint) throw fail('这个服务不支持自动连接，请填写访问令牌');
    const r = await safeFetch(d.meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_name: '拾燕', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(d.scope ? { scope: d.scope } : {}) }) });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.client_id) throw fail('这个服务暂不允许自动连接：' + String(data?.error_description || data?.error || ('HTTP ' + r.status)).slice(0, 160), 502);
    const value = { client_id: data.client_id, client_secret: data.client_secret || null, token_endpoint_auth_method: data.token_endpoint_auth_method || (data.client_secret ? 'client_secret_basic' : 'none') };
    db.prepare('INSERT OR REPLACE INTO oauth_clients(key,data,created_at) VALUES(?,?,?)').run(key, JSON.stringify(value), now());
    return value;
  }

  return {
    list(owner) {
      const own = db.prepare('SELECT * FROM connectors WHERE owner=? ORDER BY created_at').all(owner).map(decode);
      const byCatalog = new Map(own.filter(c => c.catalogId).map(c => [c.catalogId, c]));
      return {
        plugins: MCP_CATALOG.map(entry => { const c = byCatalog.get(entry.id); return { ...entry, state: c?.state || 'available', ...(c ? { connector: present(c) } : {}) }; }),
        custom: own.filter(c => !c.catalogId || !catalogEntry(c.catalogId)).map(present),
      };
    },
    async connect(owner, input = {}) {
      const entry = input.catalogId ? catalogEntry(String(input.catalogId)) : null;
      if (input.catalogId && !entry) throw fail('不支持的插件');
      const url = checkURL(entry ? entry.url : input.url).toString();
      const id = entry ? entry.id : 'mcp-' + (slug(input.name) || crypto.createHash('sha256').update(url).digest('hex').slice(0, 8));
      const name = entry ? entry.name : String(input.name || '').trim().slice(0, 40) || new URL(url).hostname;
      const existing = row(owner, id) ? decode(row(owner, id)) : null;
      if (!existing && db.prepare('SELECT COUNT(*) n FROM connectors WHERE owner=?').get(owner).n >= MAX_PER_OWNER) throw fail('连接数量已达上限');
      if (!entry && existing && existing.url !== url) throw fail('已有同名的 MCP，请换个名称');
      const token = String(input.token || '').trim();
      if (token && (token.length > 4096 || /[\r\n]/.test(token))) throw fail('令牌格式无效');
      const base = { id, name, url, catalogId: entry?.id || null, transport: entry?.transport || 'streamable', createdAt: existing?.createdAt };
      if (entry?.tokenParam && !token) throw fail(entry.name + ' 需要填写 Key：' + entry.tokenHint, 400);
      const auth = token ? (entry?.tokenParam ? { type: 'query', param: entry.tokenParam, token } : { type: 'bearer', token }) : { type: 'none' };
      let opened;
      try { opened = await openSession(endpointFor({ url, auth }), auth.type === 'bearer' ? { authorization: 'Bearer ' + token } : {}, entry?.transport || 'streamable'); }
      catch (error) { if (token) throw fail('令牌无效或权限不足：' + String(error.message || error).replace(/^无法连接这个 MCP 服务/, '').slice(0, 120)); throw error; }
      if (!opened.unauthorized) {
        const c = { ...base, auth, state: 'connected' };
        await refreshTools(owner, c);
        if (token && c.state !== 'connected') { if (existing) save(owner, existing); else db.prepare('DELETE FROM connectors WHERE owner=? AND id=?').run(owner, id); throw fail('令牌无效或权限不足：' + c.error); }
        return { ok: true, state: c.state, connector: present(c) };
      }
      if (token) throw fail('令牌无效或权限不足');
      if (entry?.auth === 'token') throw fail(entry.name + ' 需要访问令牌：' + entry.tokenHint, 400);
      const d = await discover(url, opened.www), oauthClient = await client(d);
      const verifier = b64url(crypto.randomBytes(32)), state = b64url(crypto.randomBytes(24));
      db.prepare('DELETE FROM oauth_pending WHERE created_at<?').run(now() - PENDING_TTL);
      db.prepare('INSERT INTO oauth_pending(state,owner,data,created_at) VALUES(?,?,?,?)').run(state, owner, JSON.stringify({ base, verifier, resource: d.resource, tokenEndpoint: d.meta.token_endpoint, client: oauthClient }), now());
      const q = new URLSearchParams({ response_type: 'code', client_id: oauthClient.client_id, redirect_uri: REDIRECT_URI, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource: d.resource });
      if (d.scope) q.set('scope', d.scope);
      if (!existing || existing.state !== 'connected') save(owner, { ...base, auth: existing?.auth || { type: 'none' }, state: 'authorizing', error: '', tools: existing?.tools });
      return { ok: true, state: 'authorizing', authorizeUrl: d.meta.authorization_endpoint + (d.meta.authorization_endpoint.includes('?') ? '&' : '?') + q };
    },
    // 浏览器从授权页跳回：用授权码换令牌，保存后返回一个提示页面。
    async callback(params) {
      const state = String(params.get('state') || ''), pending = state && db.prepare('SELECT * FROM oauth_pending WHERE state=?').get(state);
      if (!pending || now() - pending.created_at > PENDING_TTL) return { status: 400, html: html('授权已过期', '请回到拾燕的连接器里重新连接。', false) };
      db.prepare('DELETE FROM oauth_pending WHERE state=?').run(state);
      const data = JSON.parse(pending.data), owner = pending.owner, existing = row(owner, data.base.id);
      if (params.get('error')) {
        if (existing && decode(existing).state === 'authorizing') db.prepare('DELETE FROM connectors WHERE owner=? AND id=?').run(owner, data.base.id);
        return { status: 400, html: html('没有完成授权', esc(params.get('error_description') || '已取消授权。') + ' 可以回到拾燕重新连接。', false) };
      }
      try {
        const token = await tokenRequest(data.tokenEndpoint, data.client, { grant_type: 'authorization_code', code: String(params.get('code') || ''), redirect_uri: REDIRECT_URI, code_verifier: data.verifier, resource: data.resource });
        const c = { ...data.base, auth: { type: 'oauth', token, client: data.client, tokenEndpoint: data.tokenEndpoint, resource: data.resource }, state: 'connected' };
        save(owner, c); await refreshTools(owner, c);
        return { status: 200, html: html('已连接 ' + esc(c.name), '现在可以回到拾燕，让 Dots 使用它了。这个页面可以关闭。', true) };
      } catch (error) {
        if (existing) save(owner, { ...decode(existing), state: 'error', error: String(error.message || error).slice(0, 200) });
        return { status: 502, html: html('没有完成授权', esc(error.message || '请稍后重试。'), false) };
      }
    },
    async refresh(owner, id) { const r = row(owner, String(id)); if (!r) throw fail('连接不存在', 404); return { ok: true, connector: present(await refreshTools(owner, decode(r))) }; },
    remove(owner, id) { db.prepare('DELETE FROM connectors WHERE owner=? AND id=?').run(owner, String(id)); return { ok: true }; },
    // 运行时：当前账号已连接的 MCP 及请求头（必要时先刷新令牌）。
    async runtimeServers(owner) {
      const out = [];
      for (const c of db.prepare("SELECT * FROM connectors WHERE owner=? AND state='connected'").all(owner).map(decode)) {
        try { out.push({ id: c.id, name: c.name, url: endpointFor(c), headers: await headersFor(owner, c), transport: c.transport || 'streamable', tools: c.tools }); } catch {}
      }
      return out;
    },
    async call(owner, id, method, params) {
      const r = row(owner, String(id)); if (!r) throw fail('当前账号没有这个连接', 404);
      const c = decode(r); return await mcpCall(endpointFor(c), await headersFor(owner, c), method, params, c.transport || 'streamable');
    },
    has(owner, id) { return Boolean(row(owner, String(id))); },
  };
}
let shared = null;
export const mcpConnectors = () => (shared ||= createMcpConnectors());
