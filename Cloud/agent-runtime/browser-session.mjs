import { spawn } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_CONTAINER = process.env.SHIYAN_BROWSER_CONTAINER || 'shiyan-browser-test';
const BROWSER_PROXY_SOCKET = '/tmp/shiyan-browser-proxy.sock';
const BROWSER_PROXY_PORT = 3128;
const BROWSER_CDP_PORT = 19222;
const BROWSER_TRANSPORT_PORT = 18180;
const BROWSER_TRANSPORT_HOST_PORT = 18181;
const BROWSER_DISPLAY_NUM = 99;
const VIEW_WIDTH = 1120, VIEW_HEIGHT = 720;
const TICKET_TTL_MS = 60_000;
const IDLE_TTL_MS = 20 * 60_000;
const MAX_SESSION_MS = 2 * 60 * 60_000;
const MAX_FRAME_BYTES = 1_500_000;
const MAX_TABS = 8;
const CAPTURE_TITLE = 'ShiYanCaptureTarget';
// 2 vCPU / 1 GB container: high-DPI capture saturates CPU (~1 fps). Default to 1x; raise via env on bigger hosts.
const MAX_VIEW_PIXELS = Number(process.env.SHIYAN_BROWSER_MAX_PIXELS) || 1;
const MAX_CLIENT_MESSAGE = 64 * 1024;
const ALLOWED_ORIGINS = new Set(['https://yandot.ai', 'https://129.226.81.110']);

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function runLxc(args, { timeoutMs = 15_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('lxc', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(fail('浏览器隔离环境操作超时', 503)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-64_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12_000); });
    child.once('error', error => finish(error));
    child.once('exit', code => {
      const result = { stdout, stderr, code };
      if (code === 0 || allowFailure) finish(null, result);
      else {
        // Never forward container/host stderr to the client; keep it in the server log only.
        process.stderr.write(`[browser] lxc ${args.slice(0, 2).join(' ')} failed exit=${code} cmd=${JSON.stringify(args.slice(2).join(' ').slice(0, 160))} stdout=${JSON.stringify(stdout.trim().slice(-300))} stderr=${stderr.split('\n').filter(line => !line.includes('libonion')).join(' ').trim().slice(-500)}\n`);
        finish(fail('浏览器隔离环境操作失败', 503));
      }
    });
  });
}

function createTurnCredentials(sessionId) {
  const configPath = process.env.SHIYAN_TURN_CONFIG || path.join(process.env.HOME || '/home/ubuntu', '.config', 'shiyan-turnserver.conf');
  let config;
  try { config = readFileSync(configPath, 'utf8'); } catch { throw fail('WebRTC 中继服务未配置', 503); }
  const secret = config.match(/^static-auth-secret=(.+)$/m)?.[1]?.trim();
  const port = Number(config.match(/^listening-port=(\d+)$/m)?.[1] || 3478);
  const externalIP = config.match(/^external-ip=([^/\s]+)/m)?.[1]?.trim();
  if (!secret || !externalIP || !Number.isInteger(port) || port < 1 || port > 65535) throw fail('WebRTC 中继服务配置不完整', 503);
  const expires = Math.floor(Date.now() / 1000) + Math.ceil(MAX_SESSION_MS / 1000) + 900;
  const makePeer = role => {
    const username = `${expires}:shiyan-browser-${role}:${sessionId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    return { username, credential };
  };
  const client = makePeer('client'), server = makePeer('server');
  return {
    clientIceServers: [{ urls: [`turn:${externalIP}:${port}?transport=udp`, `turn:${externalIP}:${port}?transport=tcp`], ...client }],
    serverIceServers: [{ urls: [`turn:127.0.0.1:${port}?transport=udp`], ...server }],
  };
}

function ipv4Number(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((out, part) => ((out << 8) | Number(part)) >>> 0, 0);
}
function inRange(ip, network, bits) {
  const value = ipv4Number(ip), base = ipv4Number(network);
  if (value === null || base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}
export function isPublicIPv4(ip) {
  if (!ipv4Number(ip)) return false;
  const blocked = [
    ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
    ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24],
    ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24],
    ['203.0.113.0',24], ['224.0.0.0',4], ['240.0.0.0',4],
  ];
  return !blocked.some(([network,bits]) => inRange(ip,network,bits));
}

export function normalizeBrowserURL(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 2048) throw fail('请输入网址或搜索内容');
  let url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try { url = new URL(raw); } catch { throw fail('网址格式不正确'); }
  } else if (/^(?:localhost|\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:\/.*)?$/i.test(raw) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i.test(raw)) {
    try { url = new URL('https://' + raw); } catch { throw fail('网址格式不正确'); }
  } else {
    url = new URL('https://www.google.com/search?q=' + encodeURIComponent(raw));
  }
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw fail('电脑浏览器只允许访问 HTTP 或 HTTPS 网站');
  }
  if (url.port && !['80','443'].includes(url.port)) throw fail('出于安全考虑，只允许访问标准网页端口');
  return url.href;
}

async function resolvePublicIPv4(host) {
  const literal = host.replace(/^\[|\]$/g, '');
  if (literal.includes(':')) throw fail('目标地址不允许访问', 403);
  if (/^\d+(?:\.\d+){0,3}$/.test(literal)) {
    if (!isPublicIPv4(literal)) throw fail('目标地址不允许访问', 403);
    return literal;
  }
  const answers = await lookup(literal, { all: true, verbatim: true });
  const ipv4 = answers.filter(item => item.family === 4).map(item => item.address);
  if (!ipv4.length || ipv4.some(address => !isPublicIPv4(address))) throw fail('目标网站解析到受限网络地址', 403);
  return ipv4[0];
}

function rejectProxyClient(client, status = 403) {
  try { client.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  client.destroy();
}

// Listeners owned by the most recent startup. Measured 14:19: a session closed while still
// starting left its transport listener open on 18181 and every later start failed (EADDRINUSE).
let liveTransportServer = null, liveProxy = null;
async function closeServer(server) {
  if (!server) return;
  try { server.closeAllConnections?.(); } catch {}
  await new Promise(resolve => { try { server.close(() => resolve()); } catch { resolve(); } setTimeout(resolve, 1500).unref?.(); });
}

export function createRestrictedProxy() {
  const sockets = new Set();
  let connectionSeq = 0;
  const log = (event, fields = {}) => process.stderr.write(`[browser-proxy] ${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`);
  const server = createHttpServer(async (req, res) => {
    const id = ++connectionSeq;
    let target;
    try {
      target = new URL(req.url, `http://${req.headers.host || ''}`);
      log('http-in', { id, method: req.method, host: target.hostname, activeSockets: sockets.size });
      if (target.protocol !== 'http:' || (target.port && target.port !== '80') || target.username || target.password) {
        log('http-block', { id, host: target.hostname, reason: 'unsupported-target' });
        return res.writeHead(403).end();
      }
      const ip = await resolvePublicIPv4(target.hostname);
      log('dns-ok', { id, host: target.hostname, ip, type: 'http' });
      const headers = { ...req.headers, host: target.host, connection: 'close' };
      delete headers['proxy-connection']; delete headers['proxy-authorization'];
      const upstream = httpRequest({ host: ip, port: 80, method: req.method, path: target.pathname + target.search, headers, agent: false }, response => {
        log('http-response', { id, host: target.hostname, status: response.statusCode, bytesExpected: response.headers['content-length'] || null });
        const responseHeaders = { ...response.headers };
        delete responseHeaders.connection; delete responseHeaders['proxy-connection'];
        res.writeHead(response.statusCode || 502, responseHeaders);
        response.on('error', error => { log('http-response-error', { id, host: target.hostname, code: error.code, message: error.message }); res.destroy(); });
        response.pipe(res);
      });
      upstream.on('error', error => {
        log('http-upstream-error', { id, host: target.hostname, code: error.code, message: error.message });
        if (!res.headersSent) res.writeHead(502).end(); else res.destroy();
      });
      req.on('aborted', () => log('http-client-aborted', { id, host: target.hostname }));
      req.pipe(upstream);
    } catch (error) {
      log('http-failed', { id, host: target?.hostname || null, code: error.code || null, status: error.status || null, message: error.message });
      if (!res.headersSent) res.writeHead(error.status || 403, { 'Content-Length':'0', 'Cache-Control':'no-store' }).end();
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    log('socket-open', { remote: socket.remoteAddress, activeSockets: sockets.size });
    socket.once('close', hadError => { sockets.delete(socket); log('socket-close', { hadError, activeSockets: sockets.size }); });
    socket.on('error', error => log('socket-error', { code: error.code, message: error.message }));
  });
  server.on('connect', async (req, client, head) => {
    const id = ++connectionSeq;
    const match = /^([^:]+):(\d+)$/.exec(req.url || '');
    const host = match?.[1] || String(req.url || '').slice(0, 120);
    log('connect-in', { id, host, port: match?.[2] || null, activeSockets: sockets.size });
    sockets.add(client); client.once('close', hadError => { sockets.delete(client); log('connect-client-close', { id, host, hadError, activeSockets: sockets.size }); });
    // Record resets on either side without allowing an unhandled socket error to crash sidecar.
    client.on('error', error => { log('connect-client-error', { id, host, code: error.code, message: error.message }); client.destroy(); });
    if (!match || Number(match[2]) !== 443) { log('connect-block', { id, host, reason: 'unsupported-port' }); return rejectProxyClient(client); }
    try {
      const ip = await resolvePublicIPv4(match[1]);
      log('dns-ok', { id, host, ip, type: 'connect' });
      if (client.destroyed) return;
      const upstream = tcpConnect({ host: ip, port: 443 });
      sockets.add(upstream);
      upstream.once('close', hadError => { sockets.delete(upstream); log('connect-upstream-close', { id, host, hadError, activeSockets: sockets.size }); client.destroy(); });
      client.once('close', () => upstream.destroy());
      let tunnelOpen = false;
      upstream.once('connect', () => {
        if (client.destroyed) { upstream.destroy(); return; }
        tunnelOpen = true;
        log('connect-established', { id, host, ip });
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: ShiYan\r\n\r\n');
        if (head?.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', error => {
        log('connect-upstream-error', { id, host, ip, code: error.code, message: error.message, tunnelOpen });
        if (tunnelOpen) client.destroy(); else rejectProxyClient(client, 502);
        upstream.destroy();
      });
    } catch (error) {
      log('connect-failed', { id, host, code: error.code || null, status: error.status || null, message: error.message });
      rejectProxyClient(client);
    }
  });
  server.on('upgrade', async (req, client, head) => {
    sockets.add(client); client.once('close', () => sockets.delete(client));
    client.on('error', () => { client.destroy(); });
    let target;
    try {
      target = new URL(req.url);
      if (target.protocol !== 'ws:' || (target.port && target.port !== '80')) return rejectProxyClient(client);
      const ip = await resolvePublicIPv4(target.hostname);
      const headers = { ...req.headers, host: target.host, connection: 'Upgrade' };
      delete headers['proxy-connection']; delete headers['proxy-authorization'];
      const upstream = httpRequest({ host: ip, port: 80, method: req.method, path: target.pathname + target.search, headers, agent: false });
      upstream.on('upgrade', (response, socket, upstreamHead) => {
        const lines = Object.entries(response.headers).map(([key,value]) => `${key}: ${value}`).join('\r\n');
        client.write(`HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || 'Switching Protocols'}\r\n${lines}\r\n\r\n`);
        if (upstreamHead?.length) client.write(upstreamHead);
        if (head?.length) socket.write(head);
        socket.on('error', () => { socket.destroy(); client.destroy(); });
        socket.once('close', () => client.destroy()); client.once('close', () => socket.destroy());
        client.pipe(socket); socket.pipe(client);
      });
      upstream.on('response', response => { rejectProxyClient(client, response.statusCode || 502); response.resume(); });
      upstream.on('error', () => rejectProxyClient(client, 502));
      upstream.end();
    } catch { rejectProxyClient(client); }
  });
  // Modern sites (ChatGPT, video sites) open dozens of parallel tunnels; 24 caused ERR_SOCKET_NOT_CONNECTED.
  server.maxConnections = 256;
  server.on('listening', () => log('listening', { address: server.address(), maxConnections: server.maxConnections }));
  server.on('error', error => log('server-error', { code: error.code, message: error.message }));
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  return {
    server,
    close() { log('closing', { activeSockets: sockets.size }); for (const socket of sockets) socket.destroy(); try { server.close(); } catch {} },
  };
}

class CDPConnection extends EventEmitter {
  constructor(webSocket, child) {
    super();
    this.webSocket = webSocket;
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    webSocket.addEventListener('message', event => this.#data(event.data));
    webSocket.addEventListener('close', () => this.#close(null));
    webSocket.addEventListener('error', () => this.#close(null));
    child.once('exit', code => this.#close(code));
  }
  #data(raw) {
    let message;
    try { message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(fail(message.error.message || 'Chrome 命令失败', 502));
      else pending.resolve(message.result || {});
    } else {
      if (process.env.SHIYAN_BROWSER_DEBUG === '1' && message.method === 'Page.screencastFrame') process.stderr.write(`[browser-cdp] frame event sid=${message.sessionId || 'none'}\n`);
      this.emit('event', message);
    }
  }
  #close(code) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(fail('服务器 Chrome 已断开', 503)); }
    this.pending.clear();
    this.emit('exit', code);
  }
  send(method, params = {}, sessionId = null, timeoutMs = 8000) {
    if (this.closed || this.webSocket.readyState !== 1) return Promise.reject(fail('服务器 Chrome 未连接', 503));
    const id = ++this.nextId, message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); if (process.env.SHIYAN_BROWSER_DEBUG === '1') process.stderr.write(`[browser-cdp] timeout ${method}\n`); reject(fail(`Chrome 响应超时：${method}`, 504)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.webSocket.send(JSON.stringify(message)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { try { this.webSocket.close(); } catch {} this.#close(null); }
}

async function connectChromeCDP(child) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw fail('隔离容器中的 Chrome 提前退出', 503);
    try {
      const response = await fetch(`http://127.0.0.1:${BROWSER_CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
      const info = await response.json();
      const endpoint = new URL(info.webSocketDebuggerUrl);
      endpoint.hostname = '127.0.0.1';
      endpoint.port = String(BROWSER_CDP_PORT);
      const webSocket = new WebSocket(endpoint.toString());
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 2500);
        webSocket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        webSocket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')); }, { once: true });
      });
      return new CDPConnection(webSocket, child);
    } catch (error) { lastError = error; await delay(250); }
  }
  process.stderr.write(`[browser] CDP connect failed: ${lastError?.message || 'timeout'}\n`);
  throw fail('服务器浏览器启动超时', 503);
}

function makeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) { header = Buffer.from([0x80 | opcode, data.length]); }
  else if (data.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([header, data]);
}

class WebSocketPeer {
  constructor(socket, head, onMessage, onClose) {
    this.socket = socket; this.onMessage = onMessage; this.onClose = onClose;
    this.buffer = Buffer.alloc(0); this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', chunk => this.#data(chunk));
    socket.on('close', () => this.#closed());
    socket.on('error', () => this.#closed());
    if (head?.length) this.#data(head);
  }
  #data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1], opcode = first & 0x0f, masked = !!(second & 0x80);
      if (!(first & 0x80) || !masked) return this.close(1002);
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; const n = this.buffer.readBigUInt64BE(2); if (n > BigInt(MAX_CLIENT_MESSAGE)) return this.close(1009); length = Number(n); offset = 10; }
      if (length > MAX_CLIENT_MESSAGE) return this.close(1009);
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4), payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      this.buffer = this.buffer.subarray(offset + 4 + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (opcode === 0x8) return this.close(1000);
      if (opcode === 0x9) { this.#send(0xA, payload); continue; }
      if (opcode !== 0x1) return this.close(1003);
      try { this.onMessage(JSON.parse(payload.toString('utf8'))); } catch { this.close(1007); return; }
    }
  }
  #send(opcode, payload) { if (!this.closed && !this.socket.destroyed) this.socket.write(makeFrame(opcode, payload)); }
  sendJSON(value) { this.#send(0x1, Buffer.from(JSON.stringify(value))); }
  sendBinary(value) { if (this.socket.writableLength < 1_000_000) this.#send(0x2, value); }
  close(code = 1000) {
    if (this.closed) return;
    this.#send(0x8, Buffer.from([code >> 8, code & 255]));
    this.closed = true; try { this.socket.end(); } catch {}
    this.onClose?.();
  }
  #closed() { if (this.closed) return; this.closed = true; this.onClose?.(); }
}

async function startChromeRuntime(session, { debug = process.env.SHIYAN_BROWSER_DEBUG === '1' } = {}) {
  const container = BROWSER_CONTAINER;
  session.container = container;
  const info = await runLxc(['info', container]);
  if (!/Status:\s*RUNNING/i.test(info.stdout)) await runLxc(['start', container], { timeoutMs: 30_000 });
  // Security gate: the browser container must have no network interface except loopback.
  // All web traffic goes through the restricted host proxy; a NIC would let page scripts
  // (e.g. WebRTC/UDP) reach the host bridge or the VPC directly.
  // Chrome's WebRTC ignores loopback-only hosts, so it gets one non-routable dummy address
  // (TEST-NET 192.0.2.10/32, no routes). Packets from it can only reach the container's own
  // loopback listeners (the LXD proxy devices for TURN/HTTP proxy) — nothing outside.
  const netSetup = "ip link show shiyan0 >/dev/null 2>&1 || ip link add shiyan0 type dummy; ip addr replace 192.0.2.10/32 dev shiyan0; ip link set shiyan0 up; for i in /sys/class/net/*; do n=${i##*/}; if ip -d -o link show dev \"$n\" | grep -q ' dummy '; then echo \"$n dummy\"; else echo \"$n\"; fi; done; echo ROUTES; ip -4 route show default; ip -6 route show default";
  const links = await runLxc(['exec', container, '--', 'bash', '-lc', netSetup]);
  const [linkPart, routePart = ''] = links.stdout.split('ROUTES');
  const nics = linkPart.split('\n').map(item => item.trim()).filter(item => item && item !== 'lo' && item !== 'shiyan0 dummy');
  if (nics.length || routePart.trim()) {
    process.stderr.write(`[browser] refusing to start: container network not isolated nics=${nics.join(',')} routes=${routePart.trim()}\n`);
    throw fail('服务器浏览器安全隔离检查未通过', 503);
  }

  if (session.closing) throw fail('服务器浏览器启动已取消', 409);
  if (liveProxy) { try { liveProxy.close(); } catch {} liveProxy = null; }
  const proxy = createRestrictedProxy();
  liveProxy = proxy;
  session.proxy = proxy;
  try { unlinkSync(BROWSER_PROXY_SOCKET); } catch {}
  await new Promise((resolve, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(BROWSER_PROXY_SOCKET, () => {
      try { chmodSync(BROWSER_PROXY_SOCKET, 0o600); } catch (error) { process.stderr.write(`[browser-lifecycle] proxy socket chmod failed: ${error.message}\n`); }
      process.stderr.write(`[browser-lifecycle] proxy socket ready path=${BROWSER_PROXY_SOCKET} mode=0600\n`);
      resolve();
    });
  });
  session.proxySocket = BROWSER_PROXY_SOCKET;

  const transportToken = randomBytes(24).toString('base64url');
  const transportPath = `/transport/${transportToken}`;
  const transportHtml = readFileSync(path.join(HERE, 'browser-transport.html'));
  const transportServer = createHttpServer((req, res) => {
    if (req.method !== 'GET' || req.url !== transportPath) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self' stun: turn: turns:; base-uri 'none'; form-action 'none'",
    });
    res.end(transportHtml);
  });
  session.transportServer = transportServer;
  if (session.closing) throw fail('服务器浏览器启动已取消', 409);
  if (liveTransportServer) { await closeServer(liveTransportServer); liveTransportServer = null; }
  await new Promise((resolve, reject) => {
    transportServer.once('error', reject);
    transportServer.listen(BROWSER_TRANSPORT_HOST_PORT, '127.0.0.1', resolve);
  });
  liveTransportServer = transportServer;

  await runLxc(['config', 'device', 'remove', container, 'hostproxy'], { allowFailure: true });
  await runLxc(['config', 'device', 'add', container, 'hostproxy', 'proxy', `listen=tcp:127.0.0.1:${BROWSER_PROXY_PORT}`, `connect=unix:${BROWSER_PROXY_SOCKET}`, 'bind=container']);
  process.stderr.write(`[browser-lifecycle] container proxy attached container=${container} listen=127.0.0.1:${BROWSER_PROXY_PORT} connect=${BROWSER_PROXY_SOCKET}\n`);

  const pulseEnv = ['env', 'HOME=/home/browser', 'XDG_RUNTIME_DIR=/tmp/pulse-browser', 'PULSE_RUNTIME_PATH=/tmp/pulse-browser', 'PULSE_SERVER=unix:/tmp/pulse-browser/native'];
  await runLxc(['exec', container, '--', 'runuser', '-u', 'browser', '--', ...pulseEnv, 'pulseaudio', '--start', '--exit-idle-time=-1']);
  const pulseSetup = `runuser -u browser -- env HOME=/home/browser XDG_RUNTIME_DIR=/tmp/pulse-browser PULSE_RUNTIME_PATH=/tmp/pulse-browser PULSE_SERVER=unix:/tmp/pulse-browser/native pactl list short sources | grep -q shiyan_capture_source || runuser -u browser -- env HOME=/home/browser XDG_RUNTIME_DIR=/tmp/pulse-browser PULSE_RUNTIME_PATH=/tmp/pulse-browser PULSE_SERVER=unix:/tmp/pulse-browser/native pactl load-module module-remap-source master=auto_null.monitor source_name=shiyan_capture_source source_properties=device.description=ShiYanBrowserAudio >/dev/null; runuser -u browser -- env HOME=/home/browser XDG_RUNTIME_DIR=/tmp/pulse-browser PULSE_RUNTIME_PATH=/tmp/pulse-browser PULSE_SERVER=unix:/tmp/pulse-browser/native pactl set-default-source shiyan_capture_source`;
  await runLxc(['exec', container, '--', 'bash', '-lc', pulseSetup]);

  const profilePath = `/home/browser/profiles/${session.id}`;
  session.profilePath = profilePath;
  const prepareBrowser = `pkill -TERM -u browser -x chrome 2>/dev/null || true; for i in $(seq 1 30); do pgrep -u browser -x chrome >/dev/null || break; sleep 0.2; done; pkill -KILL -u browser -x chrome 2>/dev/null || true; for i in $(seq 1 25); do pgrep -u browser -x chrome >/dev/null || break; sleep 0.2; done; rm -rf /home/browser/profiles/* /home/browser/profile-cdp-test /home/browser/profile 2>/dev/null || rm -rf /home/browser/profiles/* 2>/dev/null || true; mkdir -p '${profilePath}' && chown -R browser:browser /home/browser/profiles 2>/dev/null; chown browser:browser /home/browser/profiles '${profilePath}' && test -d '${profilePath}'`;
  await runLxc(['exec', container, '--', 'bash', '-lc', prepareBrowser]);
  // Real (headed) Chrome on a private virtual display. Headless Chrome advertises
  // "HeadlessChrome" and is stopped by Cloudflare (chatgpt.com) and similar checks.
  // Measured 09:57: the old Xvfb had not exited yet when the new one started, so the new one
  // refused the display and startup failed. Wait for the old one to be gone, and retry once.
  const startDisplay = `pkill -u browser -x Xvfb 2>/dev/null; for i in $(seq 1 30); do pgrep -u browser -x Xvfb >/dev/null || break; sleep 0.1; done; pkill -KILL -u browser -x Xvfb 2>/dev/null; for i in $(seq 1 20); do pgrep -u browser -x Xvfb >/dev/null || break; sleep 0.1; done; for attempt in 1 2; do rm -f /tmp/.X${BROWSER_DISPLAY_NUM}-lock /tmp/.X11-unix/X${BROWSER_DISPLAY_NUM}; runuser -u browser -- setsid Xvfb :${BROWSER_DISPLAY_NUM} -screen 0 1700x1300x24 -nolisten tcp -nolisten local -noreset </dev/null >/tmp/xvfb.log 2>&1 & for i in $(seq 1 50); do [ -S /tmp/.X11-unix/X${BROWSER_DISPLAY_NUM} ] && exit 0; sleep 0.1; done; pkill -KILL -u browser -x Xvfb 2>/dev/null; sleep 0.5; done; tail -3 /tmp/xvfb.log; exit 1`;
  await runLxc(['exec', container, '--', 'bash', '-lc', startDisplay], { timeoutMs: 15_000 });
  await delay(300);
  const chromeArgs = [
    '--disable-gpu', '--no-first-run', '--password-store=basic', '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--lang=zh-CN', '--accept-lang=zh-CN,zh,en-US,en', '--window-position=0,0', '--window-size=1400,1000', '--start-maximized', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-sync', '--disable-extensions', '--disable-default-apps', '--disable-component-update',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-notifications', '--disable-quic',
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--test-type', '--disable-infobars', '--auto-select-tab-capture-source-by-title=ShiYanCaptureTarget', '--remote-allow-origins=*',
    `--user-data-dir=${profilePath}`, '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1',
    `--proxy-server=http://127.0.0.1:${BROWSER_PROXY_PORT}`,
    '--proxy-bypass-list=<-loopback>;localhost:18180;127.0.0.1:3478',
    '--renderer-process-limit=8', 'about:blank',
  ];
  const child = spawn('lxc', [
    'exec', container, '--', 'runuser', '-u', 'browser', '--', ...pulseEnv,
    `DISPLAY=:${BROWSER_DISPLAY_NUM}`, 'TZ=Asia/Shanghai', 'PULSE_SOURCE=shiyan_capture_source', 'PULSE_SINK=auto_null', '/usr/bin/google-chrome', ...chromeArgs,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  session.child = child;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); if (debug) process.stderr.write(chunk); });
  child.on('error', error => { session.startReject?.(error); });
  const cdp = await connectChromeCDP(child);
  session.cdp = cdp;
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos?.find(item => item.type === 'page');
  if (!target) throw fail('服务器 Chrome 没有创建浏览器页面', 503);
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  session.targetSessionId = attached.sessionId;
  session.mainTargetId = target.targetId;
  const sid = session.targetSessionId;
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Network.enable', { maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 256_000 }, sid);
  await cdp.send('Page.setDeviceMetricsOverride', { width: VIEW_WIDTH, height: VIEW_HEIGHT, deviceScaleFactor: 1, mobile: false }, sid);
  // A native file picker would expose the container filesystem; intercept and never answer it.
  try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sid); } catch {}
  try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }); } catch {}
  // The transport page lives in its OWN window. As a second tab in the same window it pushed the
  // real page into the background (visibilityState=hidden): screencast nearly stopped (~0.2 fps)
  // and screenshots hung, which is what showed up as a white board.
  const transportTarget = await cdp.send('Target.createTarget', { url: `http://localhost:${BROWSER_TRANSPORT_PORT}${transportPath}`, newWindow: true, background: true });
  session.transportTargetId = transportTarget.targetId;
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: transportTarget.targetId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 1700, top: 0, width: 400, height: 300 } });
  } catch (error) { if (debug) process.stderr.write('[browser] transport window move failed: ' + error.message + '\n'); }
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: target.targetId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1400, height: 1000 } });
  } catch {}
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const transportAttached = await cdp.send('Target.attachToTarget', { targetId: transportTarget.targetId, flatten: true });
  session.transportSessionId = transportAttached.sessionId;
  await cdp.send('Page.enable', {}, session.transportSessionId);
  await cdp.send('Runtime.enable', {}, session.transportSessionId);
  await cdp.send('Browser.grantPermissions', { origin: `http://localhost:${BROWSER_TRANSPORT_PORT}`, permissions: ['audioCapture'] });
  let ready = null;
  for (let attempt = 0; attempt < 25 && !ready?.result?.value; attempt++) {
    if (attempt) await delay(200);
    ready = await cdp.send('Runtime.evaluate', { expression: 'typeof window.__shiyanStart === "function"', returnByValue: true }, session.transportSessionId).catch(() => null);
  }
  if (!ready?.result?.value) throw fail('浏览器音视频传输页没有正确加载', 503);

  let loadTimer;
  const pageLoaded = new Promise(resolve => {
    const onLoad = message => {
      if (message.sessionId !== sid || message.method !== 'Page.loadEventFired') return;
      clearTimeout(loadTimer); cdp.off('event', onLoad); resolve();
    };
    cdp.on('event', onLoad);
    loadTimer = setTimeout(() => { cdp.off('event', onLoad); resolve(); }, 15_000);
  });
  await cdp.send('Page.navigate', { url: 'https://www.google.com' }, sid);
  await pageLoaded;
  if (debug) process.stderr.write('[browser] isolated Chrome ready in LXD; proxy, PulseAudio and TURN are connected\n');
  return { cdp, child, proxy, proxySocket: BROWSER_PROXY_SOCKET, transportServer, profilePath, container };
}

function tab0title(session) { for (const tab of session.tabs?.values() || []) if (tab.sessionId === session.targetSessionId) return tab.title || ''; return ''; }

export class BrowserSessionManager {
  constructor({ launch = startChromeRuntime, allowOrigins = ALLOWED_ORIGINS, validateAccountToken = null, idleMs = IDLE_TTL_MS, maxSessionMs = MAX_SESSION_MS } = {}) {
    this.launch = launch; this.allowOrigins = allowOrigins; this.validateAccountToken = validateAccountToken;
    this.idleMs = idleMs; this.maxSessionMs = maxSessionMs; this.active = null; this.ticket = null;
  }
  async createTicket(owner, { accountToken = null } = {}) {
    if (!owner) throw fail('账号身份无效', 401);
    // The same account reopening (page refresh, closed tab without cleanup) takes over:
    // the stale session is closed instead of locking the user out until the idle timeout.
    if (this.ticket?.owner === String(owner)) { clearTimeout(this.ticketTimer); this.ticket = null; }
    if (this.active?.owner === String(owner)) {
      process.stderr.write(`[browser-session] session=${this.active.id} replaced by a new open from the same account\n`);
      await this.#destroy(this.active);
    }
    if (this.active || this.ticket) throw fail(this.active?.owner === owner ? '电脑已在其他窗口打开，请先关闭原窗口' : '服务器电脑当前正被使用，请稍后再试', 409);
    const ticket = randomBytes(32).toString('base64url');
    this.ticket = { value: ticket, owner: String(owner), accountToken, expiresAt: Date.now() + TICKET_TTL_MS };
    this.ticketTimer = setTimeout(() => { if (this.ticket?.value === ticket) this.ticket = null; }, TICKET_TTL_MS);
    this.ticketTimer.unref?.();
    return { ticket, expiresIn: TICKET_TTL_MS };
  }
  async exchangeTicket(value, origin = '') {
    const ticket = this.ticket;
    if (!ticket || typeof value !== 'string' || value.length < 32 || value !== ticket.value || ticket.expiresAt < Date.now()) throw fail('电脑入口已过期，请重新打开', 401);
    if (origin && !this.allowOrigins.has(origin)) throw fail('来源校验失败', 403);
    clearTimeout(this.ticketTimer); this.ticket = null;
    if (this.active) throw fail('服务器电脑当前正被使用，请稍后再试', 409);
    const session = {
      id: randomBytes(8).toString('hex'), owner: ticket.owner,
      token: randomBytes(32).toString('base64url'), accountToken: ticket.accountToken,
      createdAt: Date.now(), lastActivity: Date.now(), ws: null, pendingMessages: [], statusSent: false, closing: false,
      targetSessionId: null, lastFrameAt: 0,
    };
    this.active = session;
    // One startup at a time: a quick reopen must wait for the previous (possibly cancelled) start.
    const previousStart = this.startTail;
    let releaseStart;
    this.startTail = new Promise(resolve => { releaseStart = resolve; });
    try {
      await previousStart?.catch?.(() => {});
      if (session.closing) throw fail('服务器浏览器启动已取消', 409);
      session.turn = createTurnCredentials(session.id);
      const runtime = await this.launch(session);
      Object.assign(session, runtime);
      if (session.closing) {
        process.stderr.write(`[browser-session] session=${session.id} closed during startup; releasing its resources\n`);
        try { runtime.child?.kill('SIGTERM'); } catch {}
        try { runtime.proxy?.close(); } catch {}
        await closeServer(runtime.transportServer);
        if (liveTransportServer === runtime.transportServer) liveTransportServer = null;
        throw fail('服务器浏览器启动已取消', 409);
      }
      releaseStart();
      session.tabs = new Map(); session.tabSeq = 0; session.adopting = new Map();
      session.view = { width: VIEW_WIDTH, height: VIEW_HEIGHT, scale: 1 }; session.colorScheme ||= 'light';
      this.#registerTab(session, session.mainTargetId, session.targetSessionId);
      if (session.accountToken && this.validateAccountToken) {
        session.authTimer = setInterval(() => {
          if (!this.validateAccountToken(session.accountToken)) void this.#destroy(session);
        }, 5000);
        session.authTimer.unref?.();
      }
      session.idleTimer = setInterval(() => {
        if (Date.now() - session.lastActivity > this.idleMs || Date.now() - session.createdAt > this.maxSessionMs) void this.#destroy(session);
      }, 15_000);
      session.idleTimer.unref?.();
      session.orphanTimer = setTimeout(() => {
        if (!session.statusSent && !session.ws && !session.closing) { process.stderr.write(`[browser-session] session=${session.id} never connected after start; closing\n`); void this.#destroy(session); }
      }, 45_000);
      session.orphanTimer.unref?.();
      session.cdp.on('event', message => this.#cdpEvent(session, message));
      session.cdp.on('exit', () => { if (!session.closing) void this.#destroy(session); });
      // Keep the real page in front and visible; the transport page sits in its own off-screen window.
      await session.cdp.send('Page.bringToFront', {}, session.targetSessionId);
      return { sessionToken: session.token, width: 1120, height: 720, iceServers: session.turn.clientIceServers };
    } catch (error) {
      await this.#destroy(session).catch(() => {});
      releaseStart();
      if (process.env.SHIYAN_BROWSER_DEBUG === '1') process.stderr.write('[browser] startup failed: ' + (error?.stack || error) + '\n');
      process.stderr.write('[browser] session start failed: ' + (error?.message || error) + '\n');
      throw error.status ? error : fail('服务器浏览器启动失败，请稍后重试', 503);
    }
  }
  acceptWebSocket(req, socket, head) {
    const session = this.active;
    const origin = req.headers.origin || '';
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
    const protocol = protocols.find(value => value.startsWith('shiyan-browser.'));
    const token = protocol?.slice('shiyan-browser.'.length) || '';
    const sameToken = session && token.length === session.token.length && timingSafeEqual(Buffer.from(token), Buffer.from(session.token));
    if (!session || session.closing || !sameToken || (origin && !this.allowOrigins.has(origin)) || session.ws) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers['sec-websocket-version'] !== '13') { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: ' + protocol + '\r\n\r\n');
    clearTimeout(session.disconnectTimer); session.lastActivity = Date.now();
    session.ws = new WebSocketPeer(socket, head, message => this.#clientMessage(session, message), () => {
      if (session.ws) session.ws = null;
      if (session.closing) return;
      session.disconnectTimer = setTimeout(() => { if (!session.ws) void this.#destroy(session); }, 15_000);
      session.disconnectTimer.unref?.();
    });
    void this.#sendStatus(session);
  }
  closeOwner(owner) {
    if (this.ticket?.owner === owner) { clearTimeout(this.ticketTimer); this.ticket = null; }
    if (this.active?.owner === owner) return this.#destroy(this.active);
    return Promise.resolve();
  }
  async close() { clearTimeout(this.ticketTimer); this.ticket = null; if (this.active) await this.#destroy(this.active); }
  async #destroy(session) {
    if (!session) return;
    if (session.destroyPromise) return session.destroyPromise;
    session.closing = true;
    session.destroyPromise = (async () => {
      clearTimeout(session.disconnectTimer); clearTimeout(session.orphanTimer); clearInterval(session.idleTimer); clearInterval(session.authTimer); clearInterval(session.frameTimer); clearInterval(session.screencastWatchdog);
      try { session.ws?.close(1001); } catch {}
      if (session.cdp && session.transportSessionId) {
        try { await session.cdp.send('Runtime.evaluate', { expression: 'window.__shiyanClose?.()', returnByValue: true }, session.transportSessionId, 1500); } catch {}
      }
      if (session.cdp && session.targetSessionId && session.screencastStarted) {
        try { await session.cdp.send('Page.stopScreencast', {}, session.targetSessionId, 1500); } catch {}
      }
      if (session.container && session.profilePath) {
        const cleanup = `pkill -TERM -u browser -x chrome 2>/dev/null || true; sleep 1; pkill -KILL -u browser -x chrome 2>/dev/null || true; pkill -u browser -x Xvfb 2>/dev/null || true; rm -rf '${session.profilePath}'`;
        try { await runLxc(['exec', session.container, '--', 'bash', '-lc', cleanup], { timeoutMs: 12_000 }); } catch {}
      }
      try { session.cdp?.close(); } catch {}
      try { session.child?.kill('SIGTERM'); } catch {}
      process.stderr.write(`[browser-session] session=${session.id} destroy reason=${session.destroyReason || 'closed'} ageMs=${Date.now() - session.createdAt}\n`);
      try { session.proxy?.close(); } catch {}
      if (session.proxySocket) { try { unlinkSync(session.proxySocket); } catch {} }
      if (session.transportServer) {
        try { session.transportServer.closeAllConnections?.(); } catch {}
        await new Promise(resolve => { try { session.transportServer.close(resolve); } catch { resolve(); } });
      }
      if (this.active === session) this.active = null;
    })();
    return session.destroyPromise;
  }
  #sendJSON(session, value) {
    if (!session || session.closing) return;
    if (session.ws) { session.ws.sendJSON(value); return; }
    session.pendingMessages ||= [];
    session.pendingMessages.push(value);
    if (session.pendingMessages.length > 100) session.pendingMessages.splice(0, session.pendingMessages.length - 100);
    this.#wakePollers(session);
  }
  #wakePollers(session) {
    const waiters = session.frameWaiters;
    if (!waiters?.length) return;
    session.frameWaiters = [];
    for (const wake of waiters) wake();
  }
  #httpSessionByToken(token) {
    const session = this.active;
    if (!session || session.closing || typeof token !== 'string' || token.length !== session.token.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))) throw fail('服务器电脑会话无效或已过期', 401);
    return session;
  }
  #httpSession(owner, token) {
    const session = this.#httpSessionByToken(token);
    if (session.owner !== String(owner)) throw fail('服务器电脑会话无效或已过期', 401);
    return session;
  }
  async pollMessagesForToken(token, { wantFrames = false, frameSeq = 0 } = {}) {
    const session = this.#httpSessionByToken(token);
    if (!session.statusSent) { session.statusSent = true; await this.#sendStatus(session); this.#sendTabs(session); }
    const seq = Number(frameSeq) || 0;
    if (wantFrames === true) {
      session.lastActivity = Date.now();
      if (!session.fallbackFrames) { session.fallbackFrames = true; process.stderr.write(`[browser-frame] session=${session.id || 'active'} fallback-poll-start target=${session.targetSessionId || 'none'}\n`); this.#startFrameCapture(session); this.#startScreenshotFallback(session); }
      // Long-poll: answer as soon as a new frame or message exists instead of fixed client sleeps.
      if (!session.pendingMessages?.length && (!session.latestFrame || (session.frameSeq || 0) === seq)) {
        await new Promise(resolve => {
          let timer = null;
          const done = () => { clearTimeout(timer); resolve(); };
          timer = setTimeout(done, 1000);
          session.frameWaiters ||= [];
          if (session.frameWaiters.length > 50) session.frameWaiters.splice(0, session.frameWaiters.length - 50);
          session.frameWaiters.push(done);
        });
      }
    }
    const out = { ok: true, messages: (session.pendingMessages || []).splice(0, 100) };
    if (wantFrames === true && session.latestFrame && (session.frameSeq || 0) !== seq) { out.frame = session.latestFrame; out.frameSeq = session.frameSeq; }
    return out;
  }
  async handleHttpMessagesForToken(token, messages) {
    const session = this.#httpSessionByToken(token);
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 50) throw fail('浏览器操作批次无效');
    // Slow operations (WebRTC setup, navigation, tab changes) must never hold the HTTP control
    // channel: measured 09:48 a pending rtc-start left 59 user inputs queued for ~80 s.
    const SLOW = new Set(['navigate', 'rtc-start', 'rtc-answer', 'tab-new', 'tab-switch', 'tab-close', 'reload', 'back', 'forward', 'color-scheme']);
    for (const message of messages) {
      if (SLOW.has(message?.type) && message.type !== 'navigate') {
        const started = Date.now();
        void this.#clientMessage(session, message, true).then(() => {
          const ms = Date.now() - started; if (ms > 1500) process.stderr.write(`[browser-slow] session=${session.id} ${message.type} took ${ms}ms\n`);
        }).catch(error => this.#sendJSON(session, { type:'error', message:error?.message || '浏览器操作失败' }));
      } else if (message?.type === 'navigate') {
        // Navigation can take longer than the HTTP proxy timeout. Acknowledge immediately;
        // #clientMessage reports Chrome failures over the already-authenticated browser socket.
        void this.#clientMessage(session, message).catch(error => {
          this.#sendJSON(session, { type:'error', message:error?.message || '网页导航失败' });
        });
      } else {
        await this.#clientMessage(session, message, true);
      }
    }
    return { ok: true };
  }
  async pollMessages(owner, token) { this.#httpSession(owner, token); return this.pollMessagesForToken(token); }
  async handleHttpMessages(owner, token, messages) { this.#httpSession(owner, token); return this.handleHttpMessagesForToken(token, messages); }
  async #sendStatus(session) {
    // Web clients use HTTP polling (no WebSocket); status must still reach them via the queue.
    if (!session.cdp || !session.targetSessionId) return;
    try {
      const result = await session.cdp.send('Runtime.evaluate', { expression: '({url:location.href,title:document.title})', returnByValue: true }, session.targetSessionId);
      const value = result.result?.value || {};
      if (value.title === CAPTURE_TITLE) value.title = tab0title(session);
      this.#sendJSON(session, { type: 'status', url: value.url || 'about:blank', title: value.title || 'Google Chrome' });
      const tab = this.#tabBySession(session, session.targetSessionId);
      if (tab && (tab.url !== (value.url || '') || tab.title !== (value.title || ''))) { tab.url = value.url || ''; tab.title = value.title || ''; this.#sendTabs(session); }
    } catch {}
  }
  #registerTab(session, targetId, sessionId) {
    const tab = { id: 't' + (++session.tabSeq), targetId, sessionId, url: '', title: '' };
    session.tabs.set(targetId, tab);
    return tab;
  }
  #tabByTarget(session, targetId) { return session.tabs?.get(targetId) || null; }
  #tabBySession(session, sid) { for (const tab of session.tabs?.values() || []) if (tab.sessionId === sid) return tab; return null; }
  #tabById(session, id) { for (const tab of session.tabs?.values() || []) if (tab.id === id) return tab; return null; }
  #sendTabs(session) {
    if (!session.tabs || session.closing || session.tabsTimer) return;
    session.tabsTimer = setTimeout(() => {
      session.tabsTimer = null;
      if (session.closing || !session.tabs) return;
      const active = this.#tabByTarget(session, session.mainTargetId);
      // Only opaque ids, titles and URLs leave the server; Chrome target/session ids stay internal.
      this.#sendJSON(session, { type: 'tabs', active: active?.id || null, tabs: [...session.tabs.values()].map(tab => ({ id: tab.id, title: String(tab.title || '').slice(0, 120), url: String(tab.url || '').slice(0, 600) })) });
    }, 120);
    session.tabsTimer.unref?.();
  }
  async #applyView(session, sid) {
    // Real window sizing instead of Emulation: an emulated viewport is drawn in the top-left of the
    // full 1400x1000 surface, which tab capture/screenshots then show as a small "thumbnail".
    const view = session.view || { width: VIEW_WIDTH, height: VIEW_HEIGHT, scale: 1 };
    const tab = this.#tabBySession(session, sid);
    const targetId = tab?.targetId || (sid === session.targetSessionId ? session.mainTargetId : null);
    await session.cdp.send('Emulation.clearDeviceMetricsOverride', {}, sid, 3000).catch(() => {});
    if (!targetId) return;
    const { windowId } = await session.cdp.send('Browser.getWindowForTarget', { targetId }, null, 4000);
    session.windowUi ||= new Map();
    let ui = session.windowUi.get(windowId);
    if (!ui) {
      await session.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, null, 4000).catch(() => {});
      const m = await session.cdp.send('Runtime.evaluate', { expression: '[outerWidth-innerWidth, outerHeight-innerHeight]', returnByValue: true }, sid, 4000);
      const [uw, uh] = m.result?.value || [0, 0];
      ui = { w: Math.max(0, Math.min(40, Number(uw) || 0)), h: Number(uh) >= 60 && Number(uh) <= 240 ? Number(uh) : (session.uiDefault?.h ?? 143) };
      session.windowUi.set(windowId, ui);
    }
    // Resizing is asynchronous and inner/outer sizes update at different moments (measured:
    // outer 1200x841 while inner still read 1400x913). Wait until outer matches the request and
    // inner is stable before deriving the toolbar size; then correct once if needed.
    const readSize = async () => (await session.cdp.send('Runtime.evaluate', { expression: '[innerWidth, innerHeight, outerWidth, outerHeight]', returnByValue: true }, sid, 4000).catch(() => null))?.result?.value || null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wantW = view.width + ui.w, wantH = view.height + ui.h;
      await session.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: wantW, height: wantH } }, null, 4000);
      let size = null, previous = null;
      for (let i = 0; i < 15; i++) {
        await delay(80);
        size = await readSize();
        if (size && size[2] === wantW && size[3] === wantH && previous && previous[0] === size[0] && previous[1] === size[1]) break;
        previous = size;
      }
      const [iw, ih, ow, oh] = size || [view.width, view.height, wantW, wantH];
      process.stderr.write(`[browser-view] session=${session.id} tab=${tab?.id || '?'} attempt=${attempt} want=${view.width}x${view.height} ui=${ui.w}x${ui.h} inner=${iw}x${ih} outer=${ow}x${oh}\n`);
      if (iw === view.width && ih === view.height) { if (ui.h >= 60) session.uiDefault = { ...ui }; break; }
      // A Chrome window always has a tab strip + toolbar (measured 143 px). A smaller value means the
      // page reported a stale viewport (e.g. while loading) -> use the last good measurement.
      const candidate = { w: ow - iw, h: oh - ih };
      ui.w = candidate.w >= 0 && candidate.w <= 60 ? candidate.w : (session.uiDefault?.w ?? 0);
      ui.h = candidate.h >= 60 && candidate.h <= 260 ? candidate.h : (session.uiDefault?.h ?? 143);
      if (candidate.h < 60) await delay(300);
    }
  }
  async #applyColorScheme(session, sid) {
    await session.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: session.colorScheme === 'dark' ? 'dark' : 'light' }] }, sid, 4000);
  }
  async #prepareTab(session, sid) {
    const cdp = session.cdp;
    // File chooser interception first: a picker would expose the container filesystem.
    try { await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sid); } catch {}
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Network.enable', { maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 256_000 }, sid).catch(() => {});
    await this.#applyView(session, sid).catch(() => {});
    await this.#applyColorScheme(session, sid).catch(() => {});
  }
  #denyPermissions(session, url) {
    const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
    if (!origin || !origin.startsWith('http')) return;
    for (const permission of ['geolocation','notifications','camera','microphone','clipboard-read','clipboard-write']) {
      void session.cdp.send('Browser.setPermission', { origin, permission: { name: permission }, setting: 'denied' }).catch(() => {});
    }
  }
  async #adoptTarget(session, targetId, { activate = true } = {}) {
    if (!session.tabs || session.closing || !targetId || targetId === session.transportTargetId) return null;
    const existing = session.tabs.get(targetId);
    if (existing) { if (activate) await this.#activateTab(session, existing); return existing; }
    if (session.adopting.has(targetId)) return session.adopting.get(targetId);
    const work = (async () => {
      if (session.tabs.size >= MAX_TABS) {
        await session.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
        this.#sendJSON(session, { type: 'error', message: `最多同时打开 ${MAX_TABS} 个标签页` });
        return null;
      }
      try {
        const { windowId } = await session.cdp.send('Browser.getWindowForTarget', { targetId });
        await session.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1400, height: 1000 } });
      } catch {}
      const attached = await session.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const tab = this.#registerTab(session, targetId, attached.sessionId);
      await this.#prepareTab(session, attached.sessionId);
      if (activate) await this.#activateTab(session, tab);
      this.#sendTabs(session);
      return tab;
    })();
    session.adopting.set(targetId, work);
    try { return await work; }
    catch (error) { process.stderr.write(`[browser-tab] session=${session.id} adopt failed: ${error?.message || error}\n`); return null; }
    finally { session.adopting.delete(targetId); }
  }
  #shotParams(session, quality = 72) {
    const view = session.view || { width: VIEW_WIDTH, height: VIEW_HEIGHT, scale: 1 };
    const params = { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false };
    // Chrome hands screenshots/screencast back at CSS size; clip.scale yields true device pixels.
    if (view.scale > 1) params.clip = { x: 0, y: 0, width: view.width, height: view.height, scale: session.clipScale?.view === view ? session.clipScale.value : view.scale };
    return params;
  }
  #restartCapture(session) {
    if (session.closing || !(session.rtcReady || session.fallbackFrames)) return;
    const sid = session.targetSessionId;
    if (session.screencastStarted && sid) void session.cdp.send('Page.stopScreencast', {}, sid, 1500).catch(() => {});
    clearInterval(session.screencastWatchdog); session.screencastWatchdog = null;
    if (session.frameTimer) { clearInterval(session.frameTimer); session.frameTimer = null; }
    session.screencastStarted = false; session.frameCaptureStarted = false;
    this.#startFrameCapture(session);
  }
  async #withCaptureTitle(session, fn) {
    const sid = session.targetSessionId;
    await session.cdp.send('Runtime.evaluate', { expression: `(()=>{if(document.title!==${JSON.stringify(CAPTURE_TITLE)})window.__shiyanSavedTitle=document.title;document.title=${JSON.stringify(CAPTURE_TITLE)};return 1;})()`, returnByValue: true }, sid, 4000).catch(() => {});
    try { return await fn(); }
    finally { await session.cdp.send('Runtime.evaluate', { expression: `(()=>{if(document.title===${JSON.stringify(CAPTURE_TITLE)})document.title=window.__shiyanSavedTitle||'';return 1;})()`, returnByValue: true }, sid, 4000).catch(() => {}); }
  }
  async #retargetCapture(session) {
    if (!session.tabCapture || !session.transportSessionId) return;
    const started = Date.now();
    const result = await this.#withCaptureTitle(session, () => session.cdp.send('Runtime.evaluate', { expression: 'window.__shiyanUseTab()', awaitPromise: true, returnByValue: true, userGesture: true }, session.transportSessionId, 15_000));
    setTimeout(() => { void session.cdp?.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__shiyanPeer?.getSenders().find(x=>x.track?.kind==="video")?.track?.getSettings()||{})', returnByValue: true }, session.transportSessionId, 3000).then(r => process.stderr.write(`[browser-rtc] session=${session.id} capture-after-1s ${r?.result?.value}\n`)).catch(() => {}); }, 1000).unref?.();
    process.stderr.write(`[browser-rtc] session=${session.id} capture-retarget ${result?.exceptionDetails ? 'failed ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text || '').slice(0, 160) : JSON.stringify(result?.result?.value || {})} ms=${Date.now() - started}\n`);
  }
  #captureOnce(session) {
    const sid = session.targetSessionId;
    void session.cdp.send('Page.captureScreenshot', this.#shotParams(session), sid, 5000).then(shot => {
      if (sid === session.targetSessionId && typeof shot?.data === 'string' && shot.data.length <= Math.ceil(MAX_FRAME_BYTES * 4 / 3)) { this.#pushFrame(session, shot.data); session.lastFrameAt = Date.now(); }
    }).catch(() => {});
  }
  async #activateTab(session, tab) {
    if (!tab || session.closing) return;
    if (session.mainTargetId === tab.targetId && session.targetSessionId === tab.sessionId) { this.#sendTabs(session); return; }
    const previous = session.targetSessionId;
    if (session.screencastStarted && previous) await session.cdp.send('Page.stopScreencast', {}, previous, 1500).catch(() => {});
    clearInterval(session.screencastWatchdog); session.screencastWatchdog = null;
    if (session.frameTimer) { clearInterval(session.frameTimer); session.frameTimer = null; }
    session.screencastStarted = false; session.frameCaptureStarted = false;
    session.targetSessionId = tab.sessionId; session.mainTargetId = tab.targetId; session.currentURL = tab.url || '';
    await session.cdp.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {});
    await session.cdp.send('Page.bringToFront', {}, tab.sessionId, 3000).catch(() => {});
    await this.#applyView(session, tab.sessionId).catch(() => {});
    if ((session.rtcReady && !session.tabCapture) || session.fallbackFrames) { this.#startFrameCapture(session); this.#captureOnce(session); }
    if (session.tabCapture) await this.#retargetCapture(session).catch(() => {});
    void this.#sendStatus(session);
    this.#sendTabs(session);
  }
  async #openTab(session, url = 'about:blank') {
    const created = await session.cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const tab = await this.#adoptTarget(session, created.targetId, { activate: true });
    if (tab && url && url !== 'about:blank') {
      void session.cdp.send('Page.navigate', { url }, tab.sessionId, 15_000).then(result => {
        if (result?.errorText) this.#sendJSON(session, { type: 'error', message: `Chrome 无法打开网页：${result.errorText}` });
      }).catch(error => this.#sendJSON(session, { type: 'error', message: error?.message || '网页导航失败' }));
    }
    return tab;
  }
  async #removeTab(session, targetId) {
    const tab = this.#tabByTarget(session, targetId);
    if (!tab || session.closing) return;
    session.tabs.delete(targetId);
    if (session.mainTargetId === targetId) {
      const next = [...session.tabs.values()].at(-1);
      if (next) await this.#activateTab(session, next);
      else await this.#openTab(session, 'about:blank').catch(() => {});
    }
    this.#sendTabs(session);
  }
  #handlePopup(session, info, method) {
    // Links with target=_blank / window.open now become real tabs (previously folded into the page).
    if (!session.tabs || !info || info.type !== 'page' || info.targetId === session.transportTargetId) return;
    const tab = session.tabs.get(info.targetId);
    if (tab) {
      const url = String(info.url || ''), title = info.title === CAPTURE_TITLE ? tab.title : String(info.title || '');
      if (url !== tab.url || title !== tab.title) { tab.url = url; tab.title = title; this.#sendTabs(session); }
      return;
    }
    if (method === 'Target.targetCreated') void this.#adoptTarget(session, info.targetId, { activate: true });
  }
  #backgroundTabEvent(session, message) {
    const tab = this.#tabBySession(session, message.sessionId);
    if (!tab) return;
    if (message.method === 'Page.javascriptDialogOpening') {
      void session.cdp.send('Page.handleJavaScriptDialog', { accept: message.params?.type !== 'prompt' }, message.sessionId).catch(() => {});
    } else if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
      tab.url = message.params.frame.url || '';
      this.#denyPermissions(session, tab.url);
      this.#sendTabs(session);
    }
  }
  #cdpEvent(session, message) {
    if (session.closing || !session.targetSessionId) return;
    if (!message.sessionId && (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged')) {
      this.#handlePopup(session, message.params?.targetInfo, message.method);
      return;
    }
    if (!message.sessionId && message.method === 'Target.targetDestroyed') { void this.#removeTab(session, message.params?.targetId); return; }
    if (message.sessionId !== session.targetSessionId) { this.#backgroundTabEvent(session, message); return; }
    if (message.method === 'Page.javascriptDialogOpening') {
      // alert/confirm/beforeunload would freeze the page; prompt is dismissed.
      const accept = message.params?.type !== 'prompt';
      void session.cdp.send('Page.handleJavaScriptDialog', { accept }, session.targetSessionId).catch(() => {});
      return;
    }
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params?.request || {};
      session.networkRequests ||= new Map();
      session.networkRequests.set(message.params.requestId, request.url || '');
      if (message.params?.type === 'Document') {
        let host = ''; try { host = new URL(request.url).host; } catch {}
        process.stderr.write(`[browser-network] session=${session.id} document-request ${JSON.stringify({ host, method: request.method, loaderId: message.params.loaderId })}\n`);
      }
      return;
    }
    if (message.method === 'Network.responseReceived') {
      const response = message.params?.response || {};
      if (response.status >= 400 || message.params?.type === 'Document') {
        let host = ''; try { host = new URL(response.url).host; } catch {}
        process.stderr.write(`[browser-network] session=${session.id} response ${JSON.stringify({ host, status: response.status, type: message.params?.type, protocol: response.protocol, fromDiskCache: response.fromDiskCache })}\n`);
      }
      return;
    }
    if (message.method === 'Network.loadingFailed') {
      const params = message.params || {};
      let host = ''; try { host = new URL(params.requestId ? session.networkRequests?.get(params.requestId) || '' : '').host; } catch {}
      process.stderr.write(`[browser-network] session=${session.id} loading-failed ${JSON.stringify({ host, type: params.type, errorText: params.errorText, canceled: params.canceled, blockedReason: params.blockedReason })}\n`);
      session.networkRequests?.delete(params.requestId);
      return;
    }
    if (message.method === 'Network.loadingFinished') {
      session.networkRequests?.delete(message.params?.requestId);
      return;
    }
    if (message.method === 'Page.screencastFrame') {
      const frame = message.params || {};
      const screencastSessionId = Number(frame.sessionId);
      if (Number.isInteger(screencastSessionId)) void session.cdp.send('Page.screencastFrameAck', { sessionId: screencastSessionId }, session.targetSessionId).catch(() => {});
      if (typeof frame.data === 'string' && frame.data.length <= Math.ceil(MAX_FRAME_BYTES * 4 / 3)) {
        if ((session.view?.scale || 1) > 1) return;
        if (session.frameTimer) { clearInterval(session.frameTimer); session.frameTimer = null; }
        this.#pushFrame(session, frame.data);
        session.lastFrameAt = Date.now();
      }
      return;
    }
    if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
      session.currentURL = message.params.frame.url || '';
      { const tab = this.#tabBySession(session, message.sessionId); if (tab) { tab.url = session.currentURL; this.#sendTabs(session); } }
      void this.#sendStatus(session);
      const origin = (() => { try { return new URL(session.currentURL).origin; } catch { return ''; } })();
      if (origin && origin.startsWith('http')) {
        for (const permission of ['geolocation','notifications','camera','microphone','clipboard-read','clipboard-write']) {
          void session.cdp.send('Browser.setPermission', { origin, permission: { name: permission }, setting: 'denied' }).catch(() => {});
        }
      }
    } else if (message.method === 'Page.loadEventFired') {
      void this.#sendStatus(session);
      // Keep the original screencast running across navigations. Stopping and
      // restarting it on every load can race Chrome's frame acknowledgements
      // and leave the remote viewport showing a blank white surface.
      void (async () => {
        try {
          const shot = await session.cdp.send('Page.captureScreenshot', this.#shotParams(session), session.targetSessionId, 5000);
          if (typeof shot.data === 'string' && shot.data.length <= Math.ceil(MAX_FRAME_BYTES * 4 / 3)) {
            this.#pushFrame(session, shot.data);
            session.lastFrameAt = Date.now();
          }
        } catch (error) {
          if (process.env.SHIYAN_BROWSER_DEBUG === '1') process.stderr.write('[browser] post-navigation screenshot failed: ' + (error?.message || error) + '\n');
        }
      })();
    }
  }
  #startFrameCapture(session) {
    if (session.frameCaptureStarted || session.closing) return;
    session.frameCaptureStarted = true;
    const fallback = () => this.#startScreenshotFallback(session);
    // High-DPI viewers: screencast is capped at CSS size, so drive capture with scaled screenshots.
    if ((session.view?.scale || 1) > 1) { fallback(); return; }
    void session.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 85, maxWidth: 2800, maxHeight: 2000, everyNthFrame: 1,
    }, session.targetSessionId).then(() => {
      session.screencastStarted = true;
      if (process.env.SHIYAN_BROWSER_DEBUG === '1') process.stderr.write('[browser] CDP screencast started\n');
      session.screencastWatchdog = setInterval(() => {
        if (!session.closing && !session.frameTimer && Date.now() - (session.lastFrameAt || 0) > 2500) fallback();
      }, 1000);
      session.screencastWatchdog.unref?.();
    }).catch(error => {
      if (process.env.SHIYAN_BROWSER_DEBUG === '1') process.stderr.write('[browser] CDP screencast unavailable: ' + (error?.message || error) + '\n');
      fallback();
    });
  }
  #startScreenshotFallback(session) {
    if (session.frameTimer || session.closing) return;
    const capture = async () => {
      if (session.closing || !(session.rtcReady || session.fallbackFrames) || session.frameCaptureBusy) return;
      session.frameCaptureBusy = true;
      try {
        const shot = await session.cdp.send('Page.captureScreenshot', this.#shotParams(session), session.targetSessionId, 5000);
        const base64 = shot.data;
        if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3)) return;
        const image = Buffer.from(base64, 'base64');
        if (!image.length || image.length > MAX_FRAME_BYTES) return;
        this.#pushFrame(session, base64);
        session.lastFrameAt = Date.now();
        if (!session.fallbackCaptureLogged) { session.fallbackCaptureLogged = true; process.stderr.write(`[browser-frame] screenshot-success bytes=${image.length} seq=${session.frameSeq || 0} target=${session.targetSessionId || 'none'}\n`); }
      } catch (error) {
        process.stderr.write('[browser-frame] screenshot-error target=' + (session.targetSessionId || 'none') + ' ' + (error?.message || error) + '\n');
      } finally { session.frameCaptureBusy = false; }
    };
    session.frameTimer = setInterval(() => void capture(), (session.view?.scale || 1) > 1 ? 60 : 125);
    session.frameTimer.unref?.();
    void capture();
  }
  #calibrateClip(session, base64) {
    // clip.scale interacts with the emulated device scale differently across Chrome builds; measure
    // the produced JPEG once and correct, so output = CSS size x viewer pixel ratio (no wasted bytes).
    const view = session.view;
    if (!view || view.scale <= 1 || session.clipScale?.view === view && session.clipScale.done) return;
    let width = 0;
    try {
      const head = Buffer.from(base64.slice(0, 120_000), 'base64');
      for (let i = 2; i < head.length - 9; i++) if (head[i] === 0xFF && (head[i + 1] === 0xC0 || head[i + 1] === 0xC2)) { width = head.readUInt16BE(i + 7); break; }
    } catch {}
    if (!width) return;
    const target = view.width * view.scale, current = session.clipScale?.view === view ? session.clipScale.value : view.scale;
    if (Math.abs(width - target) / target <= 0.04) { session.clipScale = { view, value: current, done: true }; return; }
    session.clipScale = { view, value: Math.max(0.5, Math.min(2, current * target / width)), done: false };
  }
  #pushFrame(session, base64) {
    if (session.closing) return;
    this.#calibrateClip(session, base64);
    // Latest JPEG is also kept for the HTTP-poll fallback picture (used when WebRTC cannot connect).
    if (base64 === session.latestFrame) return;
    session.latestFrame = base64; session.frameSeq = (session.frameSeq || 0) + 1;
    this.#wakePollers(session);
    if (!session.transportSessionId || !session.cdp || !session.rtcReady || session.tabCapture) return;
    session.pendingFrame = base64;
    if (session.frameSending) return;
    session.frameSending = true;
    void (async () => {
      let next = session.pendingFrame;
      session.pendingFrame = null;
      while (next && !session.closing) {
        try {
          const result = await session.cdp.send('Runtime.evaluate', {
            expression: `window.__shiyanFrame(${JSON.stringify(next)})`, awaitPromise: true, returnByValue: true,
          }, session.transportSessionId, 5000);
          if (result.exceptionDetails) throw fail(result.exceptionDetails.text || '视频帧解码失败', 502);
          if (process.env.SHIYAN_BROWSER_DEBUG === '1') process.stderr.write('[browser] video frame decode ' + JSON.stringify(result.result?.value || {}) + '\n');
        } catch (error) { if (process.env.SHIYAN_BROWSER_DEBUG === '1') process.stderr.write('[browser] frame push failed: ' + (error?.message || error) + '\n'); break; }
        next = session.pendingFrame;
        session.pendingFrame = null;
      }
      session.frameSending = false;
      if (session.pendingFrame && !session.closing) this.#pushFrame(session, session.pendingFrame);
    })();
  }
  async #clientMessage(session, message, throwErrors = false) {
    if (session.closing || !session.cdp || !session.targetSessionId || !message || typeof message.type !== 'string') return;
    session.lastActivity = Date.now();
    const sid = session.targetSessionId;
    try {
      switch (message.type) {
        case 'rtc-start': {
          if (session.rtcStarting || session.rtcReady) break;
          if (!session.transportSessionId || !session.turn?.serverIceServers) throw fail('浏览器音视频通道尚未就绪', 503);
          session.rtcStarting = true;
          const config = { iceServers: session.turn.serverIceServers, iceTransportPolicy: process.env.SHIYAN_BROWSER_ICE_POLICY === 'all' ? 'all' : 'relay' };
          process.stderr.write(`[browser-rtc] session=${session.id} server-offer-start policy=${config.iceTransportPolicy}\n`);
          const rtcStarted = Date.now();
          const result = await this.#withCaptureTitle(session, () => session.cdp.send('Runtime.evaluate', {
            expression: `window.__shiyanStart(${JSON.stringify({ ...config, tabCapture: process.env.SHIYAN_BROWSER_TAB_CAPTURE !== '0' })})`, awaitPromise: true, returnByValue: true, userGesture: true,
          }, session.transportSessionId, 30_000));
          { const v = result.result?.value || {}; session.tabCapture = v.tabCapture === true;
            process.stderr.write(`[browser-rtc] session=${session.id} offer-ready ms=${Date.now() - rtcStarted} tabCapture=${session.tabCapture} video=${JSON.stringify({ w: v.video?.width, h: v.video?.height, fps: v.video?.frameRate })} audio=${v.audio} ${v.tabError ? 'tabError=' + String(v.tabError).slice(0, 160) : ''}\n`); }
          if (result.exceptionDetails) throw fail(result.exceptionDetails.text || '无法启动浏览器音视频', 503);
          const offer = result.result?.value;
          if (!offer?.sdp) throw fail('服务器 Chrome 没有生成 WebRTC offer', 503);
          this.#sendJSON(session, { type: 'rtc-offer', sdp: offer.sdp });
          break;
        }
        case 'rtc-answer': {
          const sdp = String(message.sdp || '');
          if (!session.rtcStarting || !sdp.startsWith('v=0') || sdp.length > 48_000) throw fail('WebRTC 应答无效', 400);
          const result = await session.cdp.send('Runtime.evaluate', {
            expression: `window.__shiyanApplyAnswer(${JSON.stringify(sdp)})`, awaitPromise: true, returnByValue: true,
          }, session.transportSessionId, 20_000);
          if (result.exceptionDetails) throw fail(result.exceptionDetails.text || 'WebRTC 应答设置失败', 502);
          if (process.env.SHIYAN_BROWSER_DEBUG === '1') {
            const candidateCount = (sdp.match(/^a=candidate:/gm) || []).length;
            process.stderr.write('[browser-rtc] client answer candidates=' + candidateCount + ' transport=' + JSON.stringify(result.result?.value || {}) + '\n');
          }
          session.rtcReady = true;
          process.stderr.write(`[browser-rtc] session=${session.id} answer-applied serverTransport=${JSON.stringify(result.result?.value || {})}\n`);
          this.#sendJSON(session, { type: 'rtc-ready' });
          if (!session.tabCapture) this.#startFrameCapture(session);
          break;
        }
        case 'navigate': {
          const url = normalizeBrowserURL(message.url);
          const result = await session.cdp.send('Page.navigate', { url }, sid, 15_000);
          if (result.errorText) throw fail(`Chrome 无法打开网页：${result.errorText}`, 502);
          let host = ''; try { host = new URL(url).host; } catch {}
          process.stderr.write(`[browser-navigation] session=${session.id} accepted ${JSON.stringify({ host, frameId: result.frameId || null })}\n`);
          this.#sendJSON(session, { type:'navigation', url, frameId:result.frameId || null });
          break;
        }
        case 'back': case 'forward': {
          const history = await session.cdp.send('Page.getNavigationHistory', {}, sid);
          const index = history.currentIndex + (message.type === 'back' ? -1 : 1);
          const entry = history.entries?.[index];
          if (entry) await session.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sid);
          break;
        }
        case 'reload': await session.cdp.send('Page.reload', { ignoreCache: false }, sid); break;
        case 'resize': {
          const width = Math.max(320, Math.min(1400, Math.round(Number(message.width) || 1120)));
          const height = Math.max(420, Math.min(1000, Math.round(Number(message.height) || 720)));
          // Render at the viewer's pixel density (Retina = 2x) so text is sharp, within a pixel budget.
          let scale = Math.max(1, Math.min(2, Math.round((Number(message.scale) || 1) * 4) / 4));
          while (scale > 1 && width * height * scale * scale > MAX_VIEW_PIXELS) scale = Math.round((scale - 0.25) * 4) / 4;
          const scaleChanged = (session.view?.scale || 1) !== scale;
          session.view = { width, height, scale };
          const tabs = session.tabs?.size ? [...session.tabs.values()] : [{ sessionId: sid }];
          for (const tab of tabs) await this.#applyView(session, tab.sessionId).catch(() => {});
          if (session.transportSessionId) await session.cdp.send('Runtime.evaluate', { expression: `window.__shiyanResize(${Math.round(width * scale)},${Math.round(height * scale)})`, returnByValue: true }, session.transportSessionId);
          if (scaleChanged) this.#restartCapture(session);
          break;
        }
        case 'tab-new': {
          const raw = typeof message.url === 'string' ? message.url.trim().slice(0, 2048) : '';
          await this.#openTab(session, raw ? normalizeBrowserURL(raw) : 'about:blank');
          break;
        }
        case 'tab-switch': {
          const tab = this.#tabById(session, String(message.id || '').slice(0, 12));
          if (tab) await this.#activateTab(session, tab);
          break;
        }
        case 'tab-close': {
          const tab = this.#tabById(session, String(message.id || '').slice(0, 12));
          if (!tab) break;
          if (session.tabs.size <= 1) {
            await session.cdp.send('Page.navigate', { url: 'about:blank' }, tab.sessionId, 15_000).catch(() => {});
            tab.url = 'about:blank'; tab.title = ''; this.#sendTabs(session); void this.#sendStatus(session);
            break;
          }
          await session.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
          await this.#removeTab(session, tab.targetId);
          break;
        }
        case 'color-scheme': {
          session.colorScheme = message.value === 'dark' ? 'dark' : 'light';
          for (const tab of session.tabs?.values() || []) await this.#applyColorScheme(session, tab.sessionId).catch(() => {});
          break;
        }
        case 'mouse': {
          const x = Math.max(0, Math.min(1400, Number(message.x) || 0));
          const y = Math.max(0, Math.min(1000, Number(message.y) || 0));
          const type = ['mouseMoved','mousePressed','mouseReleased'].includes(message.eventType) ? message.eventType : null;
          const button = ['left','middle','right','none'].includes(message.button) ? message.button : 'left';
          if (type) await session.cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: message.clickCount === 2 ? 2 : 1 }, sid);
          break;
        }
        case 'wheel': {
          const x = Math.max(0, Math.min(1400, Number(message.x) || 0));
          const y = Math.max(0, Math.min(1000, Number(message.y) || 0));
          const deltaX = Math.max(-1200, Math.min(1200, Number(message.deltaX) || 0));
          const deltaY = Math.max(-1200, Math.min(1200, Number(message.deltaY) || 0));
          await session.cdp.send('Input.dispatchMouseEvent', { type:'mouseWheel', x, y, deltaX, deltaY }, sid);
          break;
        }
        case 'key': {
          const type = message.eventType === 'keyUp' ? 'keyUp' : 'keyDown';
          const key = String(message.key || '').slice(0, 40), code = String(message.code || '').slice(0, 40);
          const modifiers = Math.max(0, Math.min(15, Number(message.modifiers) || 0));
          await session.cdp.send('Input.dispatchKeyEvent', { type, key, code, modifiers, ...(type === 'keyDown' && typeof message.text === 'string' ? { text: message.text.slice(0,4) } : {}) }, sid);
          break;
        }
        case 'insertText': {
          const text = String(message.text || '').slice(0, 4000);
          if (text) await session.cdp.send('Input.insertText', { text }, sid);
          break;
        }
        case 'client-diag': {
          // Client-side progress markers (WebRTC stages, JS errors) so failures on the user's
          // browser are visible in the server log instead of being guessed.
          const stage = String(message.stage || '').replace(/[^\w.:-]/g, '').slice(0, 40);
          const detail = String(message.detail || '').replace(/[\r\n]+/g, ' ').slice(0, 240);
          process.stderr.write(`[browser-client] session=${session.id} t=${Math.round((Date.now() - session.createdAt) / 100) / 10}s ${stage} ${detail}\n`);
          break;
        }
        case 'close': await this.#destroy(session); break;
        case 'activity': break;
        default: break;
      }
    } catch (error) { this.#sendJSON(session, { type:'error', message: error.message || '浏览器操作失败' }); if (throwErrors) throw error; }
  }
}
