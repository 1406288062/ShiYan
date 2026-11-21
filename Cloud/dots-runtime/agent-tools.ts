// Host tools for sandboxed agents.
//
// A tool is { name, description, inputSchema (JSON Schema), handler(args) -> value | {content:[...]} }.
// For one agent run, openToolServers() exposes each named group of tools as an MCP server on its own
// unix socket in the account's rpc directory (mounted in the container at /run/shiyan). Inside the
// container the agent CLI starts /opt/shiyan/mcp-relay.mjs as a stdio MCP server, which pipes bytes
// to that socket. So the same tools work for the Claude Code CLI and the Codex app-server, while
// every handler runs on the host, bound (by closure) to the run's account and task.
//
// hostMcpTools() turns an existing host-side stdio MCP server (Sponge, account connectors) into such
// a tool group, so the container never needs host paths, sockets or credentials of those services.
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';

const MAX_TEXT = 200_000;
export const tool = (name: string, description: string, properties: Record<string, any> = {}, required: string[] = [], handler: (args: any) => any) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, handler });

// Normalizes a handler return value to MCP tool-call content.
export function toContent(value) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) return { content: value.content, ...(value.isError ? { isError: true } : {}) };
  if (value && typeof value === 'object' && typeof value.image === 'string') {
    const { image, mimeType, ...rest } = value;
    return { content: [{ type: 'image', data: image, mimeType: mimeType || 'image/jpeg' }, { type: 'text', text: JSON.stringify(rest).slice(0, MAX_TEXT) }] };
  }
  return { content: [{ type: 'text', text: (typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true })).slice(0, MAX_TEXT) }] };
}

function serveMcp(socket, { name, tools, onCall }) {
  const write = value => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    if (!Object.hasOwn(message, 'id')) return;
    const reply = result => write({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'shiyan-' + name, version: '1.0.0' } });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) });
    if (message.method === 'tools/call') {
      const def = tools.find(item => item.name === message.params?.name);
      if (!def) return reply({ isError: true, content: [{ type: 'text', text: '未知工具' }] });
      const args = message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {};
      const started = Date.now();
      Promise.resolve().then(() => def.handler(args)).then(value => {
        const out = toContent(value); onCall?.({ server: name, tool: def.name, args, ok: !out.isError, ms: Date.now() - started, result: out }); reply(out);
      }, error => {
        onCall?.({ server: name, tool: def.name, args, ok: false, ms: Date.now() - started, error: String(error?.message || error) });
        reply({ isError: true, content: [{ type: 'text', text: String(error?.message || error).slice(0, 4000) }] });
      });
      return;
    }
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  });
  socket.on('error', () => {});
  socket.on('end', () => socket.end());
}

function shut({ server, socketPath }) { for (const socket of server.sockets || []) socket.destroy(); server.close(); rmSync(socketPath, { force: true }); }

// Opens one socket per tool group. Returns MCP server configs as seen INSIDE the container (both the
// Claude and the Codex config shapes) and close() to remove the sockets after the run.
export async function openToolServers({ rpcDir, groups, relay = '/opt/shiyan/mcp-relay.mjs', onCall = null, toolTimeoutSec = 7200 }) {
  const run = randomBytes(6).toString('hex'), servers = [], claude = {}, codex = {};
  try {
    for (const [name, tools] of Object.entries(groups || {})) {
      if (!tools?.length) continue;
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error('invalid tool group ' + name);
      const file = `${run}-${name}.sock`, socketPath = path.join(rpcDir, file);
      const sockets = new Set();
      const server = net.createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); serveMcp(socket, { name, tools, onCall }); });
      server.sockets = sockets;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      servers.push({ server, socketPath });
      const args = [relay, '/run/shiyan/' + file];
      claude[name] = { type: 'stdio', command: 'node', args };
      codex[name] = { command: 'node', args, tool_timeout_sec: toolTimeoutSec };
    }
  } catch (error) { for (const item of servers) shut(item); throw error; }
  return { claude, codex, close() { for (const item of servers) shut(item); } };
}

// Minimal host-side stdio MCP client used to re-expose existing MCP servers as tool groups.
export async function hostMcpTools(spec, { timeoutMs = 20_000, prefix = '' } = {}) {
  const child = spawn(spec.command, spec.args || [], { env: { ...process.env, ...(spec.env || {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map(); let seq = 0, closed = false;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message || 'MCP error')) : p.resolve(m.result); } });
  const finish = () => { closed = true; for (const p of pending.values()) p.reject(new Error('MCP 服务已退出')); pending.clear(); };
  child.once('exit', finish); child.once('error', finish);
  const rpc = (method, params, ms = timeoutMs) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('MCP 服务不可用'));
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP 调用超时：' + method)); }, ms);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shiyan-agent-host', version: '1.0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = (await rpc('tools/list', {}))?.tools || [];
    const tools = listed.filter(item => /^[A-Za-z0-9_.-]{1,100}$/.test(item?.name || '')).map(item => ({
      name: prefix + item.name, description: String(item.description || '').slice(0, 4000), inputSchema: item.inputSchema && typeof item.inputSchema === 'object' ? item.inputSchema : { type: 'object' },
      handler: args => rpc('tools/call', { name: item.name, arguments: args }, 2 * 60 * 60_000),
    }));
    return { tools, close() { closed = true; try { child.stdin.end(); child.kill('SIGTERM'); } catch {} } };
  } catch (error) { try { child.kill('SIGKILL'); } catch {} throw error; }
}
