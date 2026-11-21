// Private, durable registration notices. This socket is never exposed by the web proxy
// or mounted into a user's execution environment. No Agent work is created here.
import http from 'node:http';
import net from 'node:net';
import { mkdir, lstat, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.SHIYAN_ROOT || '/home/ubuntu/boss-codex-service/shiyan-v2';
export const REGISTRATION_SOCKET = process.env.DOTS_REGISTRATION_SOCKET || path.join(ROOT, 'data', 'registration-events.sock');
export function validateRegistrationEvent(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['id,registeredAt,source,username', 'email,id,registeredAt,source,username'].includes(Object.keys(value).sort().join(',')) ||
      !['shiyan_web', 'spongebob_mcp_web'].includes(value.source) ||
      typeof value.id !== 'string' || !new RegExp('^registration:' + value.source + ':[A-Za-z0-9_-]{1,100}$').test(value.id) ||
      typeof value.username !== 'string' || !/^[\p{L}\p{N}_.-]{3,64}$/u.test(value.username) ||
      ('email' in value && (typeof value.email !== 'string' || value.email.length > 254 ||
        (value.email !== '' && !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(value.email)))) ||
      !Number.isSafeInteger(value.registeredAt) || value.registeredAt <= 0 || value.registeredAt > Date.now() + 300000) {
    throw Object.assign(new Error('Invalid registration event'), { status: 400 });
  }
  return { id: value.id, source: value.source, username: value.username, email: value.email ?? '', registeredAt: value.registeredAt };
}

export function postRegistrationEvent(socketPath: any, event: any) {
  const bytes = Buffer.from(JSON.stringify(validateRegistrationEvent(event)));
  return new Promise<void>((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/registration-events',
      headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length } }, res => {
      res.resume();
      res.on('error', reject);
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Registration delivery unavailable')));
    });
    req.setTimeout(3000, () => req.destroy(new Error('Registration delivery timeout')));
    req.on('error', reject); req.end(bytes);
  });
}

// Only the persistent outbox is retried; registration/account tables are never polled.
export class RegistrationEventSender {
  pending: () => any;
  acknowledge: (id: any) => any;
  socketPath: string | false;
  retryMs: number;
  maxRetryMs: number;
  backoff: number;
  running: boolean;
  stopped: boolean;
  timer: any = null;
  again = false;
  constructor({ pending, acknowledge, socketPath = REGISTRATION_SOCKET, retryMs = 1000, maxRetryMs = 60000 }: { pending: () => any; acknowledge: (id: any) => any; socketPath?: string | false; retryMs?: number; maxRetryMs?: number }) {
    this.pending = pending; this.acknowledge = acknowledge; this.socketPath = socketPath;
    this.retryMs = retryMs; this.maxRetryMs = maxRetryMs; this.backoff = retryMs;
    this.running = false; this.stopped = false;
  }
  notify() {
    if (this.stopped || !this.socketPath) return;
    clearTimeout(this.timer);
    if (this.running) { this.again = true; return; }
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, 0); this.timer.unref?.();
  }
  async drain() {
    if (this.running || this.stopped || !this.socketPath) return;
    this.running = true;
    try {
      do {
        this.again = false;
        const batch = await this.pending();
        for (const event of batch) {
          if (this.stopped) return;
          await postRegistrationEvent(this.socketPath, event);
          if (!this.stopped) await this.acknowledge(event.id);
        }
        if (batch.length === 100) this.again = true;
      } while (this.again && !this.stopped);
      this.backoff = this.retryMs;
    } catch {
      // Failure cannot undo a successful registration. The outbox survives restart.
      if (!this.stopped) {
        this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, this.backoff);
        this.timer.unref?.(); this.backoff = Math.min(this.maxRetryMs, this.backoff * 2);
      }
    } finally { this.running = false; }
  }
  close() { this.stopped = true; clearTimeout(this.timer); }
}

export function accountRegistrationOutbox(store: any, socketPath: any) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS account_registration_outbox (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', registered_at INTEGER NOT NULL
  );`);
  if (!store.db.prepare('PRAGMA table_info(account_registration_outbox)').all().some((column: any) => column.name === 'email')) {
    store.db.exec("ALTER TABLE account_registration_outbox ADD COLUMN email TEXT NOT NULL DEFAULT ''");
    // Upgrade queued notices once; normal delivery reads only the outbox.
    store.db.exec(`UPDATE account_registration_outbox SET email=COALESCE((
      SELECT email FROM account_users WHERE 'registration:shiyan_web:' || account_users.id=account_registration_outbox.id
    ),'') WHERE source='shiyan_web'`);
  }
  const sender = new RegistrationEventSender({ socketPath,
    pending: () => store.db.prepare('SELECT id,source,username,email,registered_at AS registeredAt FROM account_registration_outbox ORDER BY registered_at,id LIMIT 100').all(),
    acknowledge: id => store.db.prepare('DELETE FROM account_registration_outbox WHERE id=?').run(id) });
  sender.notify(); return sender;
}
export function enqueueAccountRegistration(store: any, user: any) {
  store.db.prepare('INSERT INTO account_registration_outbox(id,source,username,email,registered_at) VALUES(?,?,?,?,?)')
    .run('registration:shiyan_web:' + user.id, 'shiyan_web', user.username, user.email ?? '', user.createdAt);
}

export async function startRegistrationReceiver({ socketPath = REGISTRATION_SOCKET, ingest }: any) {
  if (typeof ingest !== 'function') throw new Error('Registration ingest is required');
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) throw new Error('Registration socket path is not a socket');
    const active = await new Promise(resolve => {
      const probe = net.connect(socketPath);
      probe.on('connect', () => { probe.destroy(); resolve(true); }); probe.on('error', () => resolve(false));
      probe.setTimeout(1000, () => { probe.destroy(); resolve(true); });
    });
    if (active) throw new Error('Registration receiver is already active');
    await unlink(socketPath);
  } catch (error) { if ((error as any).code !== 'ENOENT') throw error; }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/registration-events') { res.writeHead(404); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 2048) throw Object.assign(new Error('Body too large'), { status: 413 }); chunks.push(chunk); }
      let event;
      try { event = validateRegistrationEvent(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { throw Object.assign(new Error('Invalid event'), { status: 400 }); }
      await ingest(event);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ok":true}');
    } catch (error) { if (!res.headersSent) res.writeHead((error as any).status || 503); res.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve()); });
  await chmod(socketPath, 0o600);
  let closing;
  return { server, socketPath, close: () => closing ||= new Promise<void>((resolve, reject) =>
    server.close(error => error && (error as any).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())) };
}
