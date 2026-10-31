// Shared account profile image, deliberately independent from permissions and Dots pets.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getAccountStore, requestBearer } from './accounts.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);
const MAX_BODY = MAX_BASE64 + 2048;
const imageScript = fileURLToPath(new URL('./avatar-image.py', import.meta.url));
const stateForStore = new WeakMap();
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (res, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
};

function stateFor(accounts) {
  if (!stateForStore.has(accounts)) {
    accounts.db.exec(`CREATE TABLE IF NOT EXISTS account_avatars (
      user_id TEXT PRIMARY KEY REFERENCES account_users(id),
      data TEXT, revision INTEGER NOT NULL CHECK(revision > 0), updated_at INTEGER NOT NULL
    )`);
    stateForStore.set(accounts, { listeners: new Map() });
  }
  return stateForStore.get(accounts);
}

function snapshot(accounts, userId) {
  const row = accounts.db.prepare('SELECT data,revision,updated_at FROM account_avatars WHERE user_id=?').get(userId);
  return { ok: true, avatar: { data: row?.data ?? null, mimeType: 'image/jpeg',
    revision: Number(row?.revision ?? 0), updatedAt: row ? Number(row.updated_at) : null } };
}

async function body(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) throw failure('头像图片过大，请重新选择', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw failure('头像图片过大，请重新选择', 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (req.headers['x-shiyan-body-sha'] !== undefined &&
      req.headers['x-shiyan-body-sha'] !== createHash('sha256').update(raw).digest('hex'))
    throw failure('请求校验失败', 401);
  try {
    const value = JSON.parse(raw.toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch { throw failure('头像请求格式无效'); }
}

function decode(input) {
  if (typeof input !== 'string' || !input || input.length > MAX_BASE64)
    throw failure(input?.length > MAX_BASE64 ? '头像图片过大，请重新选择' : '头像数据无效', input?.length > MAX_BASE64 ? 413 : 400);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input))
    throw failure('头像数据无效');
  const bytes = Buffer.from(input, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== input)
    throw failure('头像数据无效');
  return bytes;
}

let decoding = 0;
export async function normalizeAvatarImage(bytes) {
  if (decoding >= 2) throw failure('头像更新较多，请稍后再试', 429);
  decoding++;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.env.SHIYAN_AVATAR_PYTHON || 'python3', [imageScript], { stdio: ['pipe', 'pipe', 'ignore'] });
      const output = []; let length = 0, complete = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(failure('头像处理超时，请重新选择', 422)); }, 8000);
      timer.unref();
      function finish(error) {
        if (complete) return;
        complete = true; clearTimeout(timer);
        if (error) reject(error); else resolve(Buffer.concat(output).toString('base64'));
      }
      child.once('error', () => finish(failure('头像处理暂不可用，请稍后重试', 503)));
      child.stdout.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_BYTES) { child.kill('SIGKILL'); finish(failure('头像图片过大，请重新选择', 413)); }
        else output.push(chunk);
      });
      child.once('close', code => finish(code === 0 && length ? null : failure('无法读取头像，请选择 JPEG 图片', 422)));
      child.stdin.on('error', () => {});
      child.stdin.end(bytes);
    });
  } finally { decoding--; }
}

export function createAccountAvatarHandler({ store, heartbeatMs = 15000, normalizeImage = normalizeAvatarImage } = {}) {
  return async function handleAccountAvatar(req, res) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname.replace(/^\/shiyan(?=\/)/, '');
    if (pathname !== '/v1/account/avatar' && pathname !== '/v1/account/avatar/events') return false;
    const accounts = store || getAccountStore();
    try {
      const token = requestBearer(req), auth = token && accounts.authenticate(token);
      if (!auth) throw failure('请先登录', 401);
      const state = stateFor(accounts), userId = auth.userId;
      if (pathname.endsWith('/events')) {
        if (req.method !== 'GET') throw failure('请求方式不支持', 405);
        let listeners = state.listeners.get(userId);
        if (!listeners) { listeners = new Set(); state.listeners.set(userId, listeners); }
        if (listeners.size >= 24) throw failure('头像实时连接过多，请关闭多余窗口', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
        res.flushHeaders();
        let closed = false, timer;
        const close = () => {
          if (closed) return;
          closed = true; clearInterval(timer); listeners.delete(send);
          if (!listeners.size) state.listeners.delete(userId);
          if (!res.writableEnded) res.end();
        };
        const authorized = () => {
          try { return !accounts.closed && accounts.authenticate(token)?.userId === userId; }
          catch { return false; }
        };
        const send = payload => {
          if (closed || res.destroyed || !authorized()) { close(); return; }
          const frame = `id: ${payload.avatar.revision}\nevent: avatar\ndata: ${JSON.stringify(payload)}\n\n`;
          if (res.writableLength + Buffer.byteLength(frame) > MAX_BODY * 2) { close(); return; }
          res.write(frame);
        };
        listeners.add(send);
        res.once('close', close); res.once('error', close);
        // Subscribe before taking the initial snapshot. No client polling is needed.
        send(snapshot(accounts, userId));
        if (!closed) {
          timer = setInterval(() => {
            if (closed || res.destroyed || !authorized()) close();
            else res.write(': heartbeat\n\n');
          }, heartbeatMs);
          timer.unref();
        }
        return true;
      }
      if (req.method === 'GET') { json(res, 200, snapshot(accounts, userId)); return true; }
      if (req.method !== 'PUT') throw failure('请求方式不支持', 405);
      const input = await body(req);
      const keys = ['data', 'expectedRevision'];
      if (Object.keys(input).some(key => !keys.includes(key)) ||
          (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)))
        throw failure('头像请求格式无效');
      accounts.consumeLimit('account-avatar:' + userId, 30, 60000);
      // Image decoding runs off the HTTP event loop; authenticate again afterwards.
      const data = await normalizeImage(decode(input.data));
      const result = accounts.transaction(() => {
        if (accounts.authenticate(token)?.userId !== userId) throw failure('请重新登录', 401);
        const previous = snapshot(accounts, userId).avatar;
        if (input.expectedRevision !== undefined && input.expectedRevision !== previous.revision)
          throw failure('头像已在其他设备更新，请刷新后重试', 409);
        accounts.db.prepare(`INSERT INTO account_avatars(user_id,data,revision,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(userId, data, previous.revision + 1, accounts.now());
        // Do not touch account_users.revision: avatar changes cannot revoke permissions or sessions.
        return snapshot(accounts, userId);
      });
      for (const listener of [...(state.listeners.get(userId) || [])]) listener(result);
      json(res, 200, result); return true;
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { ok: false, error: error.status ? error.message : '头像操作暂时不可用，请重试' });
      else res.end();
      return true;
    }
  };
}
