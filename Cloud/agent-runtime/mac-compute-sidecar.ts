// Narrow, owner-bound inference queue. This service has no shell or arbitrary path API.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, chmodSync, statSync, readFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIB = 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const IMAGE_LIMIT = 40 * MIB;
const RESULT_LIMIT = 512 * MIB;
const JSON_LIMIT = 4 * MIB;
const fail = (status: any, code: any, message: any) => Object.assign(new Error(message), { status, code });
const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: any) => createHash('sha256').update(value).digest();
const equalToken = (value: any, expected: any) => typeof value === 'string' && typeof expected === 'string' &&
  timingSafeEqual(digest(value), digest(expected));
const keysOnly = (value: any, keys: any) => object(value) && Object.keys(value).every(key => keys.includes(key));
const strictText = (value: any, max: any) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
const validOwner = (value: any) => strictText(value, 256) && value !== '*';
const validId = (id: any) => typeof id === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id);

function sendJson(res: any, status: any, value: any) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
}
async function jsonBody(req: any) {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > JSON_LIMIT) throw fail(413, 'BODY_TOO_LARGE', '请求内容过大');
    parts.push(part);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw fail(400, 'INVALID_JSON', '请求格式无效'); }
  if (!object(value)) throw fail(400, 'INVALID_JSON', '请求格式无效');
  return value;
}
function lengthHeader(req: any, limit: any) {
  const raw = req.headers['content-length'];
  if (typeof raw !== 'string') throw fail(411, 'LENGTH_REQUIRED', '必须提供文件长度');
  if (!/^\d+$/.test(raw)) throw fail(400, 'INVALID_LENGTH', '文件长度无效');
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length <= 0 || length > limit) throw fail(413, 'FILE_TOO_LARGE', '文件大小超过限制');
  return length;
}

// Header inspection avoids decoding an untrusted image on the small server.
function imageHeader(data: any) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
      data.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) break;
      while (offset < data.length && data[offset] === 0xff) offset++;
      if (offset >= data.length) break;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) {
        return { format: 'jpeg', height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { format: 'webp', width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return { format: 'webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
  }
  throw fail(422, 'INVALID_IMAGE', '图片格式或尺寸信息无效');
}
async function receiveFile(req: any, filename: any, limit: any, beforeChunk: any) {
  const expected = lengthHeader(req, limit);
  const handle = await open(filename, 'wx', 0o600);
  const hash = createHash('sha256');
  let count = 0, headSize = 0, head: Buffer[] = [], tail = Buffer.alloc(0);
  try {
    for await (const chunk of req) {
      await beforeChunk();
      count += chunk.length;
      if (count > expected || count > limit) throw fail(413, 'FILE_TOO_LARGE', '文件大小超过限制');
      hash.update(chunk);
      if (headSize < MIB) { const part = chunk.subarray(0, MIB - headSize); head.push(part); headSize += part.length; }
      tail = Buffer.concat([tail, chunk]).subarray(-2);
      await handle.writeFile(chunk);
    }
    if (count !== expected) throw fail(422, 'LENGTH_MISMATCH', '文件长度不符');
    await handle.sync();
    return { bytes: count, sha256: hash.digest('hex'), header: Buffer.concat(head), tail };
  } catch (error) { await unlink(filename).catch(() => {}); throw error; }
  finally { await handle.close(); }
}
function validateParams(kind: any, value: any) {
  if (kind === 'enhance') {
    if (!keysOnly(value, ['model', 'width', 'height', 'input_sha256', 'input_bytes']) ||
        !['general', 'anime'].includes(value.model) ||
        !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 3000 ||
        !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 3000 ||
        !Number.isSafeInteger(value.input_bytes) || value.input_bytes < 1 || value.input_bytes > IMAGE_LIMIT ||
        typeof value.input_sha256 !== 'string' || !/^[a-f\d]{64}$/.test(value.input_sha256)) {
      throw fail(400, 'INVALID_PARAMS', '图片参数无效');
    }
    return { model: value.model, width: value.width, height: value.height,
      input_sha256: value.input_sha256, input_bytes: value.input_bytes };
  }
  if (kind === 'embed') {
    if (!keysOnly(value, ['texts', 'operation', 'instruction']) || !Array.isArray(value.texts) || value.texts.length < 1 || value.texts.length > 8 ||
        value.texts.some((text: any) => typeof text !== 'string' || text.length > 16384 || !text.trim()) ||
        value.texts.reduce((sum: any, text: any) => sum + text.length, 0) > 65536 ||
        !['document_embedding', 'question_embedding'].includes(value.operation) ||
        typeof value.instruction !== 'string' || value.instruction.length > 16384) {
      throw fail(400, 'INVALID_PARAMS', '向量参数无效');
    }
    return { texts: value.texts, operation: value.operation, instruction: value.instruction };
  }
  throw fail(400, 'INVALID_KIND', '只支持图片增强和文本向量计算');
}
function validateEmbeddings(value: any, count: any) {
  if (!keysOnly(value, ['embeddings', 'device', 'dimensions']) || value.device !== 'mps' || value.dimensions !== 1024 ||
      !Array.isArray(value.embeddings) || value.embeddings.length !== count || value.embeddings.some((vector: any) =>
        !Array.isArray(vector) || vector.length !== 1024 || vector.some(number => typeof number !== 'number' || !Number.isFinite(number)) ||
        !vector.some(number => number !== 0))) {
    throw fail(422, 'INVALID_EMBEDDINGS', 'Mac 返回的向量结果无效');
  }
  return { embeddings: value.embeddings, device: 'mps', dimensions: 1024 };
}

/** Returns a normal http.Server. Tests may inject authorization callbacks and a clock. */
interface ComputeBrokerOptions { clientToken: string; workerToken: string; deviceId: string; allowedOwners: string[]; now?: () => number; leaseMs?: number; taskTimeoutMs?: number; dataDir: string; authorizeOwner?: (owner: string) => boolean | Promise<boolean>; accountsDb?: string; authorizeDevice?: (deviceId: string) => boolean | Promise<boolean>; deviceRegistryPath?: string; deviceAccountId?: string | null; }
export function createComputeBroker(options: ComputeBrokerOptions) {
  const { clientToken, workerToken, deviceId } = options;
  if (typeof clientToken !== 'string' || clientToken.length < 32 || typeof workerToken !== 'string' || workerToken.length < 32 ||
      equalToken(clientToken, workerToken) || !strictText(deviceId, 256) || !Array.isArray(options.allowedOwners) ||
      options.allowedOwners.length < 1 || options.allowedOwners.length > 32 || options.allowedOwners.some(owner => !validOwner(owner))) {
    throw new Error('Invalid private compute broker configuration');
  }
  const owners = new Set(options.allowedOwners);
  const now = options.now || Date.now;
  const leaseMs = options.leaseMs ?? 120000;
  const taskTimeoutMs = options.taskTimeoutMs ?? 0;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 600000 || !Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs < 0) throw new Error('Invalid compute lease configuration');
  const dataDir = path.resolve(options.dataDir);
  const fileDir = path.join(dataDir, 'files');
  mkdirSync(fileDir, { recursive: true, mode: 0o700 }); chmodSync(dataDir, 0o700); chmodSync(fileDir, 0o700);
  const dbPath = path.join(dataDir, 'tasks.sqlite3');
  const db = new DatabaseSync(dbPath); chmodSync(dbPath, 0o600);
  // No upload connection survives process restart; remove only our generated temporary files.
  for (const name of readdirSync(fileDir)) {
    if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.(?:input|result)-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.tmp$/.test(name)) {
      const filename = path.join(fileDir, name);
      if (lstatSync(filename).isFile()) unlinkSync(filename);
    }
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS compute_tasks (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL, params_json TEXT NOT NULL, state TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0, label TEXT NOT NULL DEFAULT '', details_json TEXT NOT NULL DEFAULT '{}',
      lease_token TEXT, lease_expires_at INTEGER, first_started_at INTEGER,
      result_json TEXT, result_bytes INTEGER, result_sha256 TEXT, error TEXT, error_code TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(owner_id,request_id));
    CREATE INDEX IF NOT EXISTS compute_ready ON compute_tasks(state,created_at);`);
  let accounts: any;
  if (!options.authorizeOwner) {
    try { accounts = new DatabaseSync(options.accountsDb!, { readOnly: true }); }
    catch (error) { db.close(); throw new Error('Cannot open account authorization database', { cause: error }); }
  }
  const accountStatement = accounts?.prepare('SELECT status FROM account_users WHERE owner=?');
  const authorizeOwner = options.authorizeOwner || (owner => accountStatement.get(owner)?.status === 'active');
  let cachedRegistry: any, cachedIdentity: any;
  const authorizeDevice = options.authorizeDevice || (() => {
    const stat = statSync(options.deviceRegistryPath!);
    if (!stat.isFile() || stat.size > 128 * MIB) return false;
    const identity = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (identity !== cachedIdentity) {
      cachedRegistry = JSON.parse(readFileSync(options.deviceRegistryPath!, 'utf8'));
      cachedIdentity = identity;
    }
    const device = cachedRegistry?.devices?.find((record: any) => record.deviceId === deviceId);
    return !!device && !device.revokedAt && device.platform === 'darwin' &&
      (!options.deviceAccountId || device.accountId === options.deviceAccountId);
  });
  const find = (id: any) => db.prepare('SELECT * FROM compute_tasks WHERE id=?').get(id);
  const file = (id: any, suffix: any) => path.join(fileDir, `${id}.${suffix}`);
  let lastHeartbeat = -Infinity;
  async function ownerAllowed(owner: any) {
    if (!owners.has(owner)) return false;
    try { return await authorizeOwner(owner) === true; } catch { return false; }
  }
  async function deviceAllowed() { try { return await authorizeDevice(deviceId) === true; } catch { return false; } }
  function invalidate(row: any, code: any, message: any, state = 'cancelled') {
    if (TERMINAL.has(row.state)) return;
    db.prepare(`UPDATE compute_tasks SET state=?,lease_token=NULL,lease_expires_at=NULL,error=?,error_code=?,updated_at=? WHERE id=? AND state NOT IN ('completed','failed','cancelled')`)
      .run(state, message, code, now(), row.id);
  }
  async function requireOwner(owner: any) {
    if (!await ownerAllowed(owner)) throw fail(403, 'OWNER_FORBIDDEN', '账号未授权或已停用');
  }
  async function requireDevice() {
    if (!await deviceAllowed()) {
      lastHeartbeat = -Infinity;
      db.prepare(`UPDATE compute_tasks SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,error='Mac 设备授权已撤销',error_code='DEVICE_REVOKED',updated_at=? WHERE state NOT IN ('completed','failed','cancelled')`).run(now());
      throw fail(403, 'DEVICE_REVOKED', 'Mac 设备未授权或授权已撤销');
    }
  }
  async function requireTaskOwner(owner: any, id: any) {
    await requireOwner(owner); await requireDevice();
    const row = find(id);
    if (!row || row.owner_id !== owner) throw fail(404, 'TASK_NOT_FOUND', '任务不存在');
    return expireTask(row);
  }
  function expireTask(row: any) {
    if (!TERMINAL.has(row.state) && row.first_started_at !== null && taskTimeoutMs && now() - row.first_started_at >= taskTimeoutMs) {
      invalidate(row, 'COMPUTE_TIMEOUT', 'Mac 计算超时', 'failed'); return find(row.id);
    }
    return row;
  }
  async function requireLease(id: any, token: any) {
    await requireDevice();
    const row = find(id);
    if (!row) throw fail(404, 'TASK_NOT_FOUND', '任务不存在');
    if (!await ownerAllowed(row.owner_id)) {
      invalidate(row, 'OWNER_FORBIDDEN', '账号未授权或已停用');
      throw fail(403, 'OWNER_FORBIDDEN', '账号未授权或已停用');
    }
    expireTask(row);
    const current = find(id)!;
    if (current.state !== 'running' || !equalToken(token, current.lease_token) || Number(current.lease_expires_at) <= now()) {
      throw fail(409, 'STALE_LEASE', '计算租约已失效');
    }
    return current;
  }
  function taskView(row: any, online: any) {
    const task: any = { id: row.id, state: row.state, progress: row.progress,
      label: row.state === 'queued' ? online ? '等待 Mac 处理' : '等待 Mac 上线' : row.label,
      details: JSON.parse(row.details_json) };
    if (row.state === 'completed') task.result = { kind: row.kind, ...(row.kind === 'enhance' ? {
      width: JSON.parse(row.params_json).width * 4, height: JSON.parse(row.params_json).height * 4, bytes: row.result_bytes,
    } : { dimensions: 1024, count: JSON.parse(row.params_json).texts.length, device: 'mps' }) };
    if (row.error) { task.error = row.error; task.error_code = row.error_code; }
    return task;
  }
  const online = () => now() - lastHeartbeat <= 60000;
  async function streamFile(res: any, filename: any, type: any, authorize: any) {
    let stat;
    try { stat = statSync(filename); } catch { throw fail(503, 'RESULT_UNAVAILABLE', '任务文件暂不可用'); }
    await authorize();
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const stream = createReadStream(filename);
    try {
      for await (const chunk of stream) {
        await authorize();
        if (!res.write(chunk)) await new Promise<void>((resolve, reject) => {
          const done = () => { cleanup(); resolve(); };
          const gone = () => { cleanup(); reject(fail(499, 'CLIENT_CLOSED', '连接已断开')); };
          const cleanup = () => { res.off('drain', done); res.off('close', gone); };
          res.once('drain', done); res.once('close', gone);
        });
      }
      res.end();
    } finally { stream.destroy(); }
  }
  const server = http.createServer(async (req, res) => {
    let temporary;
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.search || url.pathname.includes('%')) throw fail(400, 'INVALID_ROUTE', '请求路径无效');
      const bearer = /^Bearer ([^\r\n]+)$/.exec(req.headers.authorization || '')?.[1];
      const isWorker = equalToken(bearer, workerToken), isClient = equalToken(bearer, clientToken);
      if (!isWorker && !isClient) throw fail(401, 'UNAUTHORIZED', '需要有效的计算凭据');
      const workerRoute = url.pathname.startsWith('/v1/worker/');
      if (workerRoute && !isWorker || !workerRoute && url.pathname !== '/v1/health' && !isClient) throw fail(403, 'WRONG_CREDENTIAL', '计算凭据类型不匹配');
      const owner = req.headers['x-shiyan-owner'];
      if (!workerRoute && url.pathname !== '/v1/health') await requireOwner(owner);
      await requireDevice();
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        if (isClient && owner !== undefined) await requireOwner(owner);
        sendJson(res, 200, { ok: true, workerOnline: online(), deviceId,
          queued: Number(db.prepare("SELECT COUNT(*) AS count FROM compute_tasks WHERE state='queued'").get()?.count || 0) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/tasks') {
        const input = await jsonBody(req);
        if (!keysOnly(input, ['kind', 'request_id', 'params']) || !strictText(input.request_id, 256)) throw fail(400, 'INVALID_TASK', '任务参数无效');
        const params = validateParams(input.kind, input.params);
        const fingerprint = createHash('sha256').update(JSON.stringify([input.kind, params])).digest('hex');
        await requireOwner(owner); await requireDevice();
        let row = db.prepare('SELECT * FROM compute_tasks WHERE owner_id=? AND request_id=?').get(String(owner), input.request_id);
        if (row && row.fingerprint !== fingerprint) throw fail(409, 'REQUEST_CONFLICT', '同一请求编号的内容不一致');
        if (!row) {
          const id = randomUUID(), timestamp = now();
          db.prepare(`INSERT INTO compute_tasks(id,owner_id,request_id,fingerprint,kind,params_json,state,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(id, String(owner), input.request_id, fingerprint, input.kind, JSON.stringify(params), input.kind === 'enhance' ? 'uploading' : 'queued', timestamp, timestamp);
          row = find(id);
        }
        sendJson(res, 200, { ok: true, task: taskView(expireTask(row), online()) }); return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/worker/claim') {
        const input = await jsonBody(req);
        if (Object.keys(input).length) throw fail(400, 'INVALID_CLAIM', '领取参数无效');
        await requireDevice();
        lastHeartbeat = now();
        const rows = db.prepare("SELECT * FROM compute_tasks WHERE state IN ('running','queued') ORDER BY created_at,id").all();
        for (const row of rows) {
          if (!await ownerAllowed(row.owner_id)) { invalidate(row, 'OWNER_FORBIDDEN', '账号未授权或已停用'); continue; }
          if (expireTask(row).state !== row.state) continue;
          if (row.state === 'running' && Number(row.lease_expires_at) <= now()) {
            db.prepare("UPDATE compute_tasks SET state='queued',progress=0,lease_token=NULL,lease_expires_at=NULL,label='等待 Mac 重新连接',updated_at=? WHERE id=? AND state='running'").run(now(), row.id);
          }
        }
        if (db.prepare("SELECT id FROM compute_tasks WHERE state='running' AND lease_expires_at>? LIMIT 1").get(now())) {
          sendJson(res, 200, { ok: true, task: null }); return;
        }
        // All awaited authorization happens before the synchronous compare-and-set claim.
        const ready = db.prepare("SELECT * FROM compute_tasks WHERE state='queued' ORDER BY created_at,id").all();
        for (const candidate of ready) {
          if (!await ownerAllowed(candidate.owner_id)) continue;
          await requireDevice();
          if (db.prepare("SELECT id FROM compute_tasks WHERE state='running' AND lease_expires_at>? LIMIT 1").get(now())) break;
          const token = randomBytes(32).toString('hex');
          const changed = db.prepare("UPDATE compute_tasks SET state='running',lease_token=?,lease_expires_at=?,first_started_at=COALESCE(first_started_at,?),label='Mac 正在处理',updated_at=? WHERE id=? AND state='queued'")
            .run(token, now() + leaseMs, now(), now(), candidate.id).changes;
          if (!changed) continue;
          sendJson(res, 200, { ok: true, task: { id: candidate.id, kind: candidate.kind, owner_id: candidate.owner_id,
            params: JSON.parse(String(candidate.params_json)), lease_token: token } }); return;
        }
        sendJson(res, 200, { ok: true, task: null }); return;
      }
      const clientMatch = /^\/v1\/tasks\/([^/]+)(?:\/(input|result))?$/.exec(url.pathname);
      if (clientMatch && validId(clientMatch[1])) {
        const [, id, action] = clientMatch;
        let row = await requireTaskOwner(owner, id);
        if (req.method === 'GET' && !action) { sendJson(res, 200, { ok: true, task: taskView(row, online()) }); return; }
        if (req.method === 'DELETE' && !action) {
          if (row.state === 'completed' || row.state === 'failed') throw fail(409, 'TASK_TERMINAL', '任务已结束');
          invalidate(row, 'CANCELLED', '任务已取消');
          sendJson(res, 200, { ok: true, task: taskView(find(id), online()) }); return;
        }
        if (req.method === 'PUT' && action === 'input') {
          if (row.kind !== 'enhance' || ['cancelled', 'failed'].includes(row.state)) throw fail(409, 'INPUT_NOT_ALLOWED', '任务不能接收图片');
          const params = JSON.parse(String(row.params_json));
          if (lengthHeader(req, IMAGE_LIMIT) !== params.input_bytes) throw fail(422, 'LENGTH_MISMATCH', '图片长度不符');
          temporary = file(id, `input-${randomUUID()}.tmp`);
          const received = await receiveFile(req, temporary, IMAGE_LIMIT, async () => {
            const current = await requireTaskOwner(owner, id);
            if (['cancelled', 'failed'].includes(current.state)) throw fail(409, 'INPUT_NOT_ALLOWED', '任务已结束');
          });
          const dimensions = imageHeader(received.header);
          if (received.sha256 !== params.input_sha256 || dimensions.width !== params.width || dimensions.height !== params.height) throw fail(422, 'INPUT_MISMATCH', '图片内容或尺寸不符');
          row = await requireTaskOwner(owner, id);
          if (row.state === 'uploading') {
            await rename(temporary, file(id, 'input')); temporary = undefined;
            // Re-check after filesystem await so cancellation cannot resurrect the task.
            row = await requireTaskOwner(owner, id);
            if (row.state === 'uploading') db.prepare("UPDATE compute_tasks SET state='queued',updated_at=? WHERE id=? AND state='uploading'").run(now(), id);
          }
          sendJson(res, 200, { ok: true, task: taskView(find(id), online()) }); return;
        }
        if (req.method === 'GET' && action === 'result') {
          if (row.state !== 'completed') throw fail(409, 'RESULT_NOT_READY', '结果尚未完成');
          if (row.kind === 'embed') { sendJson(res, 200, JSON.parse(row.result_json)); return; }
          await streamFile(res, file(id, `${row.result_sha256}.result.jpg`), 'image/jpeg', () => requireTaskOwner(owner, id)); return;
        }
      }
      const workerMatch = /^\/v1\/worker\/tasks\/([^/]+)\/(input|progress|result|fail)$/.exec(url.pathname);
      if (workerMatch && validId(workerMatch[1])) {
        const [, id, action] = workerMatch;
        const lease = req.headers['x-task-lease'];
        let row = await requireLease(id, lease);
        if (req.method === 'GET' && action === 'input' && row.kind === 'enhance') {
          await streamFile(res, file(id, 'input'), 'application/octet-stream', () => requireLease(id, lease)); return;
        }
        if (req.method === 'POST' && action === 'progress') {
          const input = await jsonBody(req);
          if (!keysOnly(input, ['progress', 'label', 'details']) || typeof input.progress !== 'number' || !Number.isFinite(input.progress) ||
              input.progress < 0 || input.progress > 1 || typeof input.label !== 'string' || input.label.length > 160 || /[\0\r\n]/.test(input.label) ||
              input.details !== undefined && (!object(input.details) || input.details.device !== undefined && input.details.device !== 'mps')) {
            throw fail(400, 'INVALID_PROGRESS', '进度参数无效');
          }
          const details = { device: 'mps' };
          for (const [key, value] of Object.entries(input.details || {})) {
            if (/^[a-z_]{1,40}$/.test(key) && (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean')) (details as any)[key] = value;
          }
          row = await requireLease(id, lease); lastHeartbeat = now();
          db.prepare("UPDATE compute_tasks SET progress=MAX(progress,?),label=?,details_json=?,lease_expires_at=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?")
            .run(input.progress, input.label, JSON.stringify(details), now() + leaseMs, now(), id, String(lease));
          sendJson(res, 200, { ok: true }); return;
        }
        if (req.method === 'POST' && action === 'fail') {
          const input = await jsonBody(req);
          if (!keysOnly(input, ['error', 'code']) || typeof input.error !== 'string' || input.error.length > 2000 || !/^[A-Z0-9_]{1,64}$/.test(input.code || '')) throw fail(400, 'INVALID_FAILURE', '失败参数无效');
          row = await requireLease(id, lease); lastHeartbeat = now();
          invalidate(row, input.code, `Mac 计算失败（${input.code}）`, 'failed');
          sendJson(res, 200, { ok: true }); return;
        }
        if (req.method === 'PUT' && action === 'result') {
          const params = JSON.parse(String(row.params_json));
          if (row.kind === 'embed') {
            const result = validateEmbeddings(await jsonBody(req), params.texts.length);
            row = await requireLease(id, lease);
            db.prepare("UPDATE compute_tasks SET state='completed',progress=1,label='Mac 处理完成',result_json=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=?")
              .run(JSON.stringify(result), now(), id, String(lease));
          } else {
            temporary = file(id, `result-${randomUUID()}.tmp`);
            const received = await receiveFile(req, temporary, RESULT_LIMIT, () => requireLease(id, lease));
            const dimensions = imageHeader(received.header);
            if (dimensions.format !== 'jpeg' || !received.tail.equals(Buffer.from([0xff,0xd9])) || dimensions.width !== params.width * 4 || dimensions.height !== params.height * 4) {
              throw fail(422, 'RESULT_MISMATCH', 'Mac 返回的图片格式或尺寸不符');
            }
            row = await requireLease(id, lease);
            // Content-addressed output prevents a stale upload overwriting a new lease's result.
            await rename(temporary, file(id, `${received.sha256}.result.jpg`)); temporary = undefined;
            await requireLease(id, lease);
            db.prepare("UPDATE compute_tasks SET state='completed',progress=1,label='Mac 处理完成',result_bytes=?,result_sha256=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=?")
              .run(received.bytes, received.sha256, now(), id, String(lease));
          }
          lastHeartbeat = now(); sendJson(res, 200, { ok: true }); return;
        }
      }
      throw fail(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (!res.headersSent) sendJson(res, (error as any).status || 503, { ok: false,
        code: (error as any).status ? (error as any).code : 'COMPUTE_UNAVAILABLE', error: (error as any).status ? (error as any).message : '计算服务暂不可用' });
      else res.destroy();
    } finally { if (temporary) await unlink(temporary).catch(() => {}); }
  });
  server.requestTimeout = 10 * 60 * 1000; server.headersTimeout = 30000;
  server.on('close', () => { accounts?.close(); db.close(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const filename = process.env.SHIYAN_COMPUTE_BROKER_CONFIG;
  if (!filename) throw new Error('SHIYAN_COMPUTE_BROKER_CONFIG is required');
  const stat = statSync(filename);
  if (!stat.isFile() || stat.mode & 0o077) throw new Error('Compute configuration must be private (mode 600)');
  const config = JSON.parse(readFileSync(filename, 'utf8'));
  const server = createComputeBroker(config);
  server.listen(8785, '127.0.0.1', () => console.log('Mac compute broker listening on 127.0.0.1:8785'));
  const stop = () => { server.close(); server.closeIdleConnections(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
