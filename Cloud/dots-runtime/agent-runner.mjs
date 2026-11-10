// One entry point to run a real agent session for Dots: the Claude Agent SDK (Claude Code harness)
// or the Codex app-server, chosen per call site by the model hub. Both run inside the account's
// Docker sandbox with their full built-in toolsets (shell, file edits, code, web) plus host tool
// groups exposed over MCP. Sessions persist in the sandbox home, so a task resumes its own session
// (context, files, plans) across wakes instead of re-sending summaries.
//
// runAgent(...) -> { provider, sessionId, text, usage, items, turns }
// items are normalized tool steps for timelines: { type:'tool', name, input, ok, output }.
import path from 'node:path';
import { openToolServers } from './agent-tools.mjs';
import { createManagerThread } from './manager-stream-transport.mjs';

const clip = (value, max = 1200) => { const s = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return s.length > max ? s.slice(0, max) + '…' : s; };
const SDK_PATH = process.env.SHIYAN_CLAUDE_SDK || '/home/ubuntu/boss-codex-service/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
let sdkPromise = null;
export const loadClaudeSdk = () => (sdkPromise ||= import(SDK_PATH));
// Session ids carry their provider: a hub switch (Claude <-> Codex) starts a new session.
export const sessionRef = (provider, id) => (id ? provider + ':' + id : null);
export function parseSessionRef(value) { const m = /^(anthropic|openai):(.+)$/.exec(String(value || '')); return m ? { provider: m[1], id: m[2] } : null; }

// Only the agent's own variables enter the container: never the host service environment.
function claudeChildEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) if (/^(CLAUDE|ANTHROPIC|MCP_|DISABLE_|MAX_THINKING|BASH_|API_TIMEOUT)/.test(key)) out[key] = value;
  return { ...out, DISABLE_AUTOUPDATER: '1', MCP_TOOL_TIMEOUT: '7200000', BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '3600000', PATH: '/home/agent/.local/bin:/opt/shiyan/bin:/usr/local/bin:/usr/bin:/bin' };
}

export function createAgentRunner({ sandbox, claudeSdk = loadClaudeSdk, managerThread = createManagerThread, logger = console } = {}) {
  async function runClaude({ owner, model, reasoning, session, cwd, system, prompt, servers, signal, onEvent, maxTurns }) {
    const { query } = await claudeSdk();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let release; const done = new Promise(resolve => { release = resolve; });
    async function* input() { yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null }; await done; }
    const options = {
      model, ...(reasoning && reasoning !== 'default' ? { effort: reasoning } : {}), cwd, ...(session ? { resume: session } : {}),
      permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: system }, mcpServers: servers.claude, maxTurns,
      abortController: controller, env: claudeChildEnv(process.env),
      spawnClaudeCodeProcess: opts => sandbox.spawn(owner, { command: sandbox.paths.claude, args: opts.args, cwd, env: claudeChildEnv(opts.env) }),
    };
    const pendingTools = new Map(), items = [], texts = [];
    let sessionId = session || null, usage = null, result = null, turns = 0;
    const q = query({ prompt: input(), options });
    try {
      for await (const message of q) {
        if (message.session_id) sessionId = message.session_id;
        if (message.type === 'assistant') {
          turns++;
          for (const block of message.message?.content || []) {
            if (block.type === 'text' && block.text) { texts.push(block.text); onEvent?.({ type: 'text', text: block.text }); }
            else if (block.type === 'tool_use') { pendingTools.set(block.id, { name: block.name, input: block.input }); onEvent?.({ type: 'tool_call', name: block.name, input: block.input }); }
          }
        } else if (message.type === 'user') {
          for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
            if (block.type !== 'tool_result') continue;
            const call = pendingTools.get(block.tool_use_id) || { name: 'tool', input: null };
            pendingTools.delete(block.tool_use_id);
            const output = Array.isArray(block.content) ? block.content.map(part => part.type === 'text' ? part.text : '[' + part.type + ']').join('\n') : block.content;
            const item = { type: 'tool', name: call.name, input: call.input, ok: !block.is_error, output: clip(output) };
            items.push(item); onEvent?.({ ...item, type: 'tool_result' });
          }
        } else if (message.type === 'result') {
          result = message; usage = message.usage ? { input_tokens: message.usage.input_tokens || 0, cached_input_tokens: message.usage.cache_read_input_tokens || 0, output_tokens: message.usage.output_tokens || 0 } : null;
          break;
        }
      }
    } finally { release(); signal?.removeEventListener('abort', abort); try { await q.return?.(); } catch {} }
    if (!result) throw new Error(signal?.aborted ? String(signal.reason?.message || '已停止') : 'Claude 会话意外结束');
    if (result.is_error || result.subtype !== 'success') {
      const reason = result.subtype === 'error_max_turns' ? '达到本轮最大步数' : (result.errors || []).join('; ') || result.result || result.subtype;
      const error = new Error('Claude 智能体执行失败：' + clip(reason, 500)); error.sessionId = sessionId; error.items = items; throw error;
    }
    return { provider: 'anthropic', sessionId, text: String(result.result || texts.at(-1) || ''), usage, items, turns: result.num_turns || turns };
  }

  async function runCodex({ owner, model, reasoning, session, cwd, system, prompt, servers, signal, onEvent }) {
    const items = [];
    const onItem = raw => {
      const name = raw.type === 'commandExecution' ? 'shell' : raw.type === 'mcpToolCall' ? `mcp__${raw.server}__${raw.tool}` : raw.type === 'fileChange' ? 'file_change' : raw.type === 'webSearch' ? 'web_search' : raw.type;
      if (['reasoning', 'userMessage', 'contextCompaction'].includes(raw.type)) return;
      const input = raw.type === 'commandExecution' ? raw.command : raw.type === 'mcpToolCall' ? raw.arguments : raw.type === 'fileChange' ? (raw.changes || []).map(c => c.path) : raw.query;
      const output = raw.type === 'commandExecution' ? raw.aggregatedOutput : raw.type === 'mcpToolCall' ? (raw.result || raw.error) : raw.status;
      const item = { type: 'tool', name, input, ok: !['failed', 'declined'].includes(raw.status) && !raw.error, output: clip(output) };
      items.push(item); onEvent?.({ ...item, type: 'tool_result' });
    };
    const thread = managerThread({
      threadId: session || null, codexPath: sandbox.paths.codex,
      options: { model, modelReasoningEffort: reasoning && reasoning !== 'default' ? reasoning : undefined, workingDirectory: cwd, sandboxMode: 'danger-full-access', approvalPolicy: 'never',
        webSearchMode: 'live', threadSource: 'dots-agent', mcpServers: servers.codex, onItem },
      spawnProcess: (bin, args, spawnOptions = {}) => sandbox.spawn(owner, { command: bin, args, cwd: spawnOptions.cwd || cwd, env: { CODEX_HOME: '/home/agent/.codex', PATH: '/home/agent/.local/bin:/opt/shiyan/bin:/opt/shiyan/codex:/usr/local/bin:/usr/bin:/bin' } }),
      rpcTimeoutMs: 60_000,
    });
    const text = [system ? '<operating_instructions>\n' + system + '\n</operating_instructions>' : '', prompt].filter(Boolean).join('\n\n');
    const { events } = await thread.runStreamed(text, { signal });
    let final = '', usage = null;
    for await (const event of events) {
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') { final = event.item.text; onEvent?.({ type: 'text', text: final }); }
      else if (event.type === 'turn.completed') usage = event.usage || null;
    }
    return { provider: 'openai', sessionId: thread.id, text: final, usage, items, turns: items.length };
  }

  // groups: { name: tools[] } exposed to the agent as MCP servers (mcp__<name>__<tool>).
  async function runAgent({ owner, provider, model, reasoning, sessionRef: ref = null, cwd, system = '', prompt, groups = {}, signal, onEvent, onToolCall, maxTurns = 200 }) {
    if (!['anthropic', 'openai'].includes(provider)) throw new Error('不支持的智能体提供方：' + provider);
    const box = await sandbox.ensure(owner);
    await sandbox.exec(owner, ['mkdir', '-p', cwd]);
    const previous = parseSessionRef(ref);
    const session = previous && previous.provider === provider ? previous.id : null;
    const servers = await openToolServers({ rpcDir: box.layout.rpc, groups, relay: sandbox.paths.relay, onCall: onToolCall });
    try {
      const run = provider === 'anthropic' ? runClaude : runCodex;
      const out = await run({ owner, model, reasoning, session, cwd, system, prompt, servers, signal, onEvent, maxTurns });
      return { ...out, sessionRef: sessionRef(provider, out.sessionId), switchedProvider: Boolean(previous && previous.provider !== provider) };
    } finally { servers.close(); }
  }
  return { runAgent };
}
export const containerPath = (...parts) => path.posix.join(...parts);
