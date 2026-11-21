import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync, chmodSync, lstatSync, unlinkSync } from 'node:fs';

// SSH-authenticated local clients use a private Unix socket. No tokens leave the runtime.
export async function startLocalMcpSocket({ root, bridge }) {
  const dir = path.join(root, 'local-ipc');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const socketPath = path.join(dir, 'mcp.sock');
  let old;
  try { old = lstatSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (old) {
    if (!old.isSocket()) throw new Error('Refusing to replace a non-socket IPC path');
    const active = await new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
      probe.setTimeout(1000, () => { probe.destroy(); resolve(true); });
    });
    if (active) throw new Error('Local MCP socket already has an active listener');
    unlinkSync(socketPath);
  }
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404); res.end(); return;
    }
    bridge.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'local MCP request failed' }));
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 60000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      chmodSync(socketPath, 0o600);
      resolve();
    });
  });
  server.on('error', (e) => console.error('[local-mcp]', e.message));
  console.log('[local-mcp] private SSH client socket ready');
  return () => { server.close(); server.closeAllConnections(); };
}
