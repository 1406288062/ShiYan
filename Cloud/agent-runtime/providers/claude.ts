// Anthropic Claude provider（@anthropic-ai/claude-agent-sdk）。
// 认证：ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN 等环境变量，或 ~/.config/shiyan/claude.env，或 Claude CLI 登录凭据。
// 未配置认证时 available() 为 false，Claude 模型不会出现在选择器里，其它 provider 不受影响。
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClaudeEventMapper } from './claude-events.ts';
import { transcriptText } from './transcript.ts';
import { extractJson, validateJson, schemaInstruction, addUsage } from './json-output.ts';
import { MEMBER_AGENT_TOOLS, memberInstructions, prepareIsolatedJob, executeMemberTool, finishIsolatedJob } from '../member-agent.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK = process.env.SHIYAN_CLAUDE_SDK || '@anthropic-ai/claude-agent-sdk';
const ENV_FILE = process.env.SHIYAN_CLAUDE_ENV_FILE || path.join(os.homedir(), '.config', 'shiyan', 'claude.env');
const CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];
const CLOUD_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const ISOLATED_SERVER = 'workspace';
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const PRIVILEGED_APPEND = [
  '你在拾燕中为用户工作。使用用户的语言回答。',
  '生成或修改的文件保存在当前工作目录内；只有用户明确要求交付文件时才创建文件；不要为了展示内容而生成 TXT、JSON、MD 等文件，回答直接写在回复里。需要交付的文件保存在当前工作目录内，并用 Markdown 链接引用其路径。',
].join('\n');
let sdkPromise;
export const loadClaudeSdk = () => (sdkPromise ||= import(SDK));

// KEY=VALUE 文件（0600），便于之后配置认证而不改 systemd。
export function readEnvFile(file = ENV_FILE): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}
export function claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, ...readEnvFile(), DISABLE_AUTOUPDATER: '1', MCP_TOOL_TIMEOUT: '7200000', ...extra };
}
export function claudeCredentialsConfigured(env = claudeEnv()) {
  if (env.SHIYAN_CLAUDE_DISABLED === '1') return false;
  if (CREDENTIAL_KEYS.some(key => env[key])) return true;
  if (CLOUD_FLAGS.some(key => env[key] === '1')) return true;
  return existsSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'), '.credentials.json'));
}

export function effortOption(reasoning: any) { return reasoning && reasoning !== 'default' ? { effort: reasoning } : {}; }
export function toCatalogModel(info: any) {
  if (!info || info.value === 'default') return null;
  const id = info.resolvedModel || info.value;
  if (typeof id !== 'string' || !id) return null;
  const levels = info.supportsEffort === false ? [] : (Array.isArray(info.supportedEffortLevels) ? info.supportedEffortLevels : []);
  const reasoningEfforts = levels.length ? levels : ['default'];
  const defaultReasoning = levels.length ? (levels.includes('high') ? 'high' : levels[Math.floor((levels.length - 1) / 2)]) : 'default';
  return { id, displayName: info.displayName || id, reasoningEfforts, defaultReasoning };
}

// 在独立子进程中读取模型列表：SDK 进程生命周期与主服务隔离。
function listModelsInChild(timeoutMs = 25000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'claude-models.mjs')], { env: claudeEnv({ SHIYAN_CLAUDE_SDK: SDK }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude 模型能力读取超时')); }, timeoutMs); timer.unref?.();
    child.stdout.on('data', d => { out += d; if (out.length > 1 << 20) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try { const value = JSON.parse(out.trim().split('\n').pop() || '{}'); if (value.ok) return resolve(value.models); reject(new Error(value.error || err || 'Claude 模型能力读取失败')); }
      catch { reject(new Error((err || 'Claude 模型能力读取失败 code=' + code).slice(-300))); }
    });
  });
}

async function imageBlock(file: any) {
  const type = (IMAGE_TYPES as any)[path.extname(file).toLowerCase()];
  if (!type) return null;
  return { type: 'image', source: { type: 'base64', media_type: type, data: (await fs.readFile(file)).toString('base64') } };
}
// 统一输入（Codex UserInput：字符串或 text/local_image 数组）-> Claude content blocks。
export async function claudeContent(input: any) {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  const blocks: any[] = [];
  for (const part of Array.isArray(input) ? input : []) {
    if (part?.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
    else if (part?.type === 'local_image' && typeof part.path === 'string') { const block = await imageBlock(part.path); if (block) blocks.push(block); }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '请查看附件。' }];
}
// 统一 MCP 描述 -> Claude stdio 配置（secretEnv 只进子进程环境）。
export function claudeMcpConfig(mcpServers: any = {}) {
  const out: any = {};
  for (const [name, spec] of Object.entries(mcpServers) as [string, any][]) {
    out[name] = spec.url
      ? { type: 'http', url: spec.url, ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}) }
      : { type: 'stdio', command: spec.command, args: spec.args || [], env: { ...(spec.env || {}), ...(spec.secretEnv || {}) } };
  }
  return out;
}

// 运行一轮 Claude 对话并输出统一事件。prompt 流在收到 result 前保持打开，保证 MCP 工具可用。
interface StreamClaudeOptions { content: any; options: any; signal?: any; isolatedServer?: any; sdk?: () => any; }
export async function* streamClaude({ content, options, signal, isolatedServer, sdk = loadClaudeSdk }: StreamClaudeOptions): AsyncGenerator<any> {
  const { query } = await sdk();
  if (signal?.aborted) throw signal.reason || new Error('已停止处理');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let release: any; const done = new Promise(resolve => { release = resolve; });
  async function* prompt() { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }; await done; }
  const mapper = createClaudeEventMapper({ isolatedServer });
  const q = query({ prompt: prompt(), options: { ...options, abortController: controller } });
  try {
    for await (const message of q) {
      for (const event of mapper.map(message)) yield event;
      if (mapper.finished) break;
    }
    if (!mapper.finished) {
      if (controller.signal.aborted) throw signal?.reason || new Error('已停止处理');
      yield { type: 'turn.failed', error: { message: 'Claude 会话意外结束' } };
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    throw new Error('Claude 处理失败：' + String((error as any)?.message || error).slice(0, 500));
  } finally {
    release?.(); signal?.removeEventListener('abort', abort);
    try { await q.return?.(); } catch {}
  }
}

// zod 形状由 MEMBER_AGENT_TOOLS 的 JSON Schema 生成：普通账号工具只维护一份定义。
export function zodShape(z: any, parameters: any = {}) {
  const shape = {}, required = new Set(parameters.required || []);
  for (const [key, spec] of Object.entries(parameters.properties || {}) as [string, any][]) {
    let field = spec.type === 'integer' ? z.number().int() : spec.type === 'number' ? z.number() : spec.type === 'boolean' ? z.boolean()
      : spec.type === 'object' ? z.record(z.string(), z.any()) : spec.type === 'array' ? z.array(z.any()) : z.string();
    if (spec.type === 'integer' || spec.type === 'number') { if (Number.isFinite(spec.minimum)) field = field.min(spec.minimum); if (Number.isFinite(spec.maximum)) field = field.max(spec.maximum); }
    (shape as any)[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

// 开放联网时附加：搜索引擎对当天数据有延迟，实时数据要直接打开数据源。
const WEB_GUIDE = '\n\n联网须知：搜索引擎对当天的数据有延迟，搜索摘要经常是前几天的旧消息。用户问实时数据（股票指数与行情、汇率、金价、天气、比分等）时，不要只凭搜索摘要作答，要用 WebFetch 直接打开提供数据的页面或公开接口；页面如果只有未填充的模板（如 @now@）或乱码，就换一个来源。A 股、港股和指数行情可直接读腾讯行情接口，例如上证指数 https://qt.gtimg.cn/q=sh000001、深证成指 https://qt.gtimg.cn/q=sz399001、个股 https://qt.gtimg.cn/q=sh600519（字段以 ~ 分隔，依次为：市场、名称、代码、现价、昨收、今开……，倒数靠前处有 yyyyMMddHHmmss 时间戳）。回答时写明数据对应的日期和时间；收盘后（15:00 以后）的现价就是当天收盘价。确实查不到时再如实说明。';
// 用了 MCP 时附加：调用方自带系统提示（如 Dots 的固定规则）也照样附上。
const MCP_GUIDE = '你是拾燕 Dots 助手。你可以使用当前账号已连接的 MCP 服务。每个 MCP 服务都提供 mcp_list_tools 和 mcp_call_tool：先用 mcp_list_tools 按用户意图搜索真实工具，阅读返回的工具说明与参数 Schema，再用 mcp_call_tool 调用对应工具；工具结果返回后继续推理。不要臆造工具名或参数，也不得声称完成未实际成功的操作。';
const INFER_SYSTEM = '你是拾燕的推理服务。只依据请求中提供的内容完成任务并直接给出结果。除非请求明确提供了检索工具，否则你没有任何工具、文件或网络访问能力，不要声称读取了外部文件。要求结构化输出时，只输出符合要求的 JSON。';
const INFER_IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

// 运行一轮并收集文本与用量；无工具、不落盘会话。
async function collectClaudeText({ content, options, signal, sdk }: any) {
  const texts: string[] = []; let usage = null;
  for await (const event of streamClaude({ content, options, signal, sdk })) {
    if (event.type === 'turn.failed') throw Object.assign(new Error(event.error?.message || 'Claude 处理失败'), { status: 503, code: 'provider_error' });
    if (event.type === 'turn.completed') usage = event.usage;
    else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) texts.push(event.item.text);
  }
  return { text: texts.join('\n\n'), last: texts.at(-1) || '', usage };
}

// 纯推理（无工具）。history: [{role,text}] 作为上下文带入；schema: 按完整 JSON Schema 校验，不通过时带着错误重试一次。
// 推理调用（Dots 回复等，所有账号共用）：只用调用方传入的 MCP，不加载服务器 claude.ai 登录上挂的连接器。
interface InferClaudeOptions { model?: any; reasoning?: any; prompt?: any; images?: any[]; schema?: any; history?: any[]; system?: any; webSearch?: boolean; mcpServers?: any; mcpToolAllowlist?: any[]; signal?: any; sdk?: () => any; credentials?: () => boolean; }
export async function inferClaude({ model, reasoning, prompt, images = [], schema, history = [], system, webSearch = false, mcpServers = {}, mcpToolAllowlist = [], signal, sdk = loadClaudeSdk, credentials = claudeCredentialsConfigured }: InferClaudeOptions) {
  if (!credentials()) throw Object.assign(new Error('Claude 未配置认证'), { status: 503, code: 'unavailable' });
  const base = [transcriptText(history), String(prompt || '').trim(), schema ? schemaInstruction(schema) : ''].filter(Boolean).join('\n\n');
  const imageBlocks: any[] = [];
  for (const image of images) {
    const media = (INFER_IMAGE_TYPES as any)[String(image?.suffix || '.png').toLowerCase()];
    if (media && image?.data) imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: media, data: String(image.data) } });
  }
  if (!base && !imageBlocks.length) throw Object.assign(new Error('prompt or image is required'), { status: 400 });
  // 仅在调用方明确依赖联网核验时开放检索与网页读取；其余情况一律无工具。
  const web = webSearch === true ? ['WebSearch', 'WebFetch'] : [];
  const mcpNames = Object.keys(mcpServers || {});
  const allowedMcp = Array.isArray(mcpToolAllowlist) ? mcpToolAllowlist.filter(name => typeof name === 'string' && /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_.-]{1,128}$/.test(name)) : [];
  const allowedTools = [...new Set([...web, ...allowedMcp])];
  const options = { model, ...effortOption(reasoning), cwd: isolatedCwd(), tools: web, ...(allowedTools.length ? { allowedTools } : {}), ...(mcpNames.length ? { mcpServers: claudeMcpConfig(mcpServers) } : {}), settingSources: [], persistSession: false,
    permissionMode: 'dontAsk', maxTurns: mcpNames.length ? 20 : (web.length ? 10 : 2), systemPrompt: [system, mcpNames.length ? MCP_GUIDE : (system ? '' : INFER_SYSTEM)].filter(Boolean).join('\n\n') + (web.length ? WEB_GUIDE : ''), strictMcpConfig: true, env: claudeEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" }) };
  let usage: any = null, problem = '', previous = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = attempt ? `${base}\n\n你上一次的输出没有通过校验：${problem}\n上一次的输出：\n${previous.slice(0, 6000)}\n请只输出修正后的 JSON。` : base;
    const run = await collectClaudeText({ content: [{ type: 'text', text }, ...imageBlocks], options, signal, sdk });
    usage = addUsage(usage, run.usage);
    if (!run.text.trim()) throw Object.assign(new Error('Claude 返回了空内容'), { status: 502, code: 'provider_error' });
    if (!schema) return { text: run.text, usage, threadId: null };
    try {
      // 联网检索时前面几段多是“我去查一下”之类的说明，结果在最后一段；先看最后一段，再看全部。
      let value;
      try { value = extractJson(run.last); } catch { value = extractJson(run.text); }
      const check = await validateJson(schema, value);
      if (check.ok) return { text: JSON.stringify(value), usage, threadId: null };
      problem = check.errors;
    } catch (error) { problem = (error as any).message; }
    previous = run.last || run.text;
  }
  throw Object.assign(new Error('Claude 输出未通过 JSON 校验：' + problem), { status: 502, code: 'invalid_output' });
}

const isolatedCwd = () => { const dir = path.join(os.tmpdir(), 'shiyan-claude-isolated'); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };

interface RunIsolatedJobOptions { history?: any[]; memory?: string; signal?: any; onEvent?: (event: any) => void; onText?: (text: string) => void; onActivity?: () => void; root?: any; }
export default {
  id: 'anthropic',
  label: 'Claude',
  sdk: '@anthropic-ai/claude-agent-sdk',
  features: { images: true, files: true, imageGeneration: false },
  available: () => claudeCredentialsConfigured(),
  async listModels() { return (await listModelsInChild()).map(toCatalogModel).filter(Boolean); },
  infer: (params: any) => inferClaude(params),

  // 管理员（服务器权限）：Claude Code 内置工具在会话工作区运行，等价于 Codex 的 danger-full-access。
  async runTurn({ model, reasoning, cwd, resume, input, mcpServers, signal }: any) {
    const content = await claudeContent(input);
    const options = {
      model, cwd, ...(resume ? { resume } : {}), ...effortOption(reasoning),
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
      settingSources: [], includePartialMessages: true,
      disallowedTools: ['WebSearch', 'WebFetch'], // 与 Codex 路径一致：不开放联网检索
      mcpServers: claudeMcpConfig(mcpServers),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PRIVILEGED_APPEND },
      env: claudeEnv(),
    };
    return { events: streamClaude({ content, options, signal }) };
  },

  // 普通账号：禁用全部内置工具，只提供与 GPT 隔离路径相同的沙箱工具（经 SDK 进程内 MCP 调用 bwrap 沙箱）。
  async runIsolatedJob(job: any, { history = [], memory = '', signal, onEvent = () => {}, onText = () => {}, onActivity = () => {}, root }: RunIsolatedJobOptions = {}) {
    const { owner, cwd, before, attachments } = await prepareIsolatedJob(job, { signal, root });
    const sdk = await loadClaudeSdk();
    const { z } = await import('zod');
    const tools = MEMBER_AGENT_TOOLS.map(def => sdk.tool(def.name, def.description, zodShape(z, def.parameters), async (args: any) => {
      onActivity();
      try {
        const output = await executeMemberTool(owner, def.name, args || {}, { cwd, signal, root });
        return { content: [{ type: 'text', text: JSON.stringify(output).slice(0, 256000) }] };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { content: [{ type: 'text', text: JSON.stringify({ error: (error as any).message }) }], isError: true };
      } finally { onActivity(); }
    }));
    const server = sdk.createSdkMcpServer({ name: ISOLATED_SERVER, tools, alwaysLoad: true });
    const text = [memory, transcriptText(history), job.prompt || '请查看附件。'].filter(Boolean).join('\n\n');
    const content: any[] = [{ type: 'text', text }];
    for (const attachment of attachments) {
      content.push({ type: 'text', text: '用户上传的附件：' + attachment.path });
      if (attachment.image) content.push({ type: 'image', source: { type: 'base64', media_type: attachment.image.mime, data: attachment.image.data } });
    }
    const options = {
      model: job.model, ...effortOption(job.reasoning), cwd: isolatedCwd(),
      tools: [], mcpServers: { [ISOLATED_SERVER]: server },
      allowedTools: MEMBER_AGENT_TOOLS.map(def => `mcp__${ISOLATED_SERVER}__${def.name}`),
      permissionMode: 'dontAsk', settingSources: [], persistSession: false, includePartialMessages: true,
      // 成员账号不能拿到服务器 claude.ai 登录上挂的连接器。
      strictMcpConfig: true, systemPrompt: memberInstructions(cwd), env: claudeEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" }),
    };
    const threadId = 'isolated_' + crypto.randomUUID();
    onEvent({ type: 'thread.started', thread_id: threadId });
    const messages = new Map(), displayItems = new Map();
    let usage = null;
    const joined = () => [...messages.values()].filter(Boolean).join('\n\n');
    for await (const event of streamClaude({ content, options, signal, isolatedServer: ISOLATED_SERVER, sdk: async () => sdk })) {
      onActivity();
      if (event.type === 'thread.started') continue;
      if (event.type === 'turn.failed') throw Object.assign(new Error(event.error?.message || 'Claude 处理失败'), { status: 503 });
      if (event.type === 'turn.completed') { usage = event.usage; continue; }
      const item = event.item; if (!item) continue;
      if (item.type === 'agent_message') { messages.set(item.id, item.text || ''); onText(joined()); continue; }
      if (item.type === 'reasoning') continue;
      displayItems.set(item.id, item); onEvent(event);
    }
    const finalText = joined();
    if (!finalText.trim()) throw Object.assign(new Error('AI服务暂不可用，请稍后重试'), { status: 503 });
    const { fileChanges, artifacts } = await finishIsolatedJob(owner, { before, text: finalText, signal, root });
    return { text: finalText, usage, threadId, displayItems: [...displayItems.values()], fileChanges, artifacts };
  },
};
