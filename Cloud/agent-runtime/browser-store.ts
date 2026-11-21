// Durable state for Dots browser tasks: task windows, questions/decisions, inputs for the
// executor, events for the Dots conversation, permissions, identities, Secure Vault entries,
// protected verification-code references and delivered files.
// Secrets (vault passwords, verification codes) are stored AES-256-GCM encrypted and are never
// returned by any read API; only the agent host decrypts them to type into a page.
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

const fail = (message: any, status = 400, code: any = undefined) => Object.assign(new Error(message), { status }, code ? { code } : {});
const now = () => Date.now();
const id = (prefix: any) => prefix + '_' + randomBytes(9).toString('base64url');
const json = (value: any) => JSON.stringify(value ?? null);
const parse = (value: any, fallback: any = null) => { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } };
const text = (value: any, max: any) => String(value ?? '').replace(/\u0000/g, '').slice(0, max);

export const PERMISSION_KEYS = ['siteAccess', 'downloads', 'uploads', 'savedPasswords'];
export const DEFAULT_PERMISSIONS = { siteAccess: 'allow', downloads: 'ask', uploads: 'ask', savedPasswords: 'ask' };
const PERMISSION_VALUES = { siteAccess: ['allow', 'ask', 'deny'], downloads: ['allow', 'ask', 'deny'], uploads: ['ask', 'deny'], savedPasswords: ['allow', 'ask', 'deny'] };
export const TASK_ORIGINS = ['chat', 'scheduled', 'push', 'webapp'];
export const ACTIVE_STATUSES = ['queued', 'running', 'waiting_user', 'taken_over', 'waiting_browser'];

export interface BrowserTask {
  id: any; owner: any; identity: any; title: any; origin: any;
  status: any; summary: any; result?: any; error: any; last_url: any;
  thread_id?: any; claimed_by?: any; claim_token?: any; lease_until?: any;
  checkout?: any; granted_files: any; allowed_origins: any;
  created_at: any; updated_at: any; finished_at?: any;
  [key: string]: any;
}

export interface BrowserQuestion {
  id: any; task_id: any; owner: any; kind: any; prompt: any;
  options: any; data: any; answer?: any;
  status: any; answered_by?: any; created_at: any; answered_at?: any;
  [key: string]: any;
}

export interface BrowserCode {
  id: any; owner: any; task_id: any; label: any; status: any;
  created_at: any; expires_at: any; used_at?: any;
  [key: string]: any;
}
// Question kinds Dots may answer with answer_to (after checking them against the user's request).
export const DOTS_ANSWERABLE = ['choice', 'cart_confirmation'];
// Question kinds answered only by the user in a dedicated interface — never through chat.
export const USER_ONLY = ['secure_input', 'payment_authorization', 'takeover', 'site_access', 'download', 'upload', 'saved_password', 'verification_code', 'verification_share'];

export function normalizeOrigin(value: any) {
  let url;
  try { url = new URL(String(value || '').includes('://') ? String(value) : 'https://' + String(value || '')); } catch { throw fail('网站地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw fail('网站地址无效');
  return url.origin.toLowerCase();
}
// A saved login for example.com also serves its subdomains (accounts.example.com).
export function originMatches(ruleOrigin: any, pageOrigin: any) {
  try {
    const rule = new URL(ruleOrigin), page = new URL(pageOrigin);
    if (rule.protocol !== page.protocol && !(rule.protocol === 'https:' && page.protocol === 'https:')) return false;
    return page.hostname === rule.hostname || page.hostname.endsWith('.' + rule.hostname.replace(/^www\./, ''));
  } catch { return false; }
}

export class SecretBox {
  key: Buffer;
  constructor({ keyPath, key = process.env.SHIYAN_BROWSER_VAULT_KEY || '' }: {keyPath?: string; key?: string} = {}) {
    if (key) this.key = Buffer.from(key, 'base64');
    else {
      const kp = keyPath!;
      mkdirSync(path.dirname(kp), { recursive: true, mode: 0o700 });
      if (!existsSync(kp)) writeFileSync(kp, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
      try { chmodSync(kp, 0o600); } catch {}
      this.key = Buffer.from(readFileSync(kp, 'utf8').trim(), 'base64');
    }
    if (this.key.length !== 32) throw new Error('Secure Vault key must be 32 bytes');
  }
  seal(plain: any, aad = '') {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  open(sealed: any, aad = '') {
    const raw = Buffer.from(String(sealed), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

export class BrowserStore {
  root: string;
  db: DatabaseSync;
  box: SecretBox;
  constructor(root: string, { databasePath = path.join(root, 'browser.sqlite3'), secretBox = null }: {databasePath?: string; secretBox?: SecretBox | null} = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = root;
    this.db = new DatabaseSync(databasePath);
    this.box = secretBox || new SecretBox({ keyPath: path.join(root, 'vault.key') });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS browser_tasks(id TEXT PRIMARY KEY, owner TEXT NOT NULL, identity TEXT NOT NULL DEFAULT 'default', title TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'chat',
        status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', result TEXT, error TEXT NOT NULL DEFAULT '', last_url TEXT NOT NULL DEFAULT '', thread_id TEXT,
        claimed_by TEXT, claim_token TEXT, lease_until INTEGER, checkout TEXT, granted_files TEXT NOT NULL DEFAULT '[]', allowed_origins TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_browser_tasks_owner ON browser_tasks(owner, updated_at);
      CREATE INDEX IF NOT EXISTS idx_browser_tasks_status ON browser_tasks(status, updated_at);
      CREATE TABLE IF NOT EXISTS browser_inputs(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, question_id TEXT, created_at INTEGER NOT NULL, consumed_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_browser_inputs ON browser_inputs(task_id, consumed_at, id);
      CREATE TABLE IF NOT EXISTS browser_questions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending', answer TEXT, answered_by TEXT, created_at INTEGER NOT NULL, answered_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_browser_questions ON browser_questions(owner, status, created_at);
      CREATE TABLE IF NOT EXISTS browser_events(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_browser_events ON browser_events(delivered_at, id);
      CREATE TABLE IF NOT EXISTS browser_progress(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_browser_progress ON browser_progress(task_id, id);
      CREATE TABLE IF NOT EXISTS browser_settings(owner TEXT PRIMARY KEY, permissions TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_site_rules(owner TEXT NOT NULL, origin TEXT NOT NULL, setting TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner, origin));
      CREATE TABLE IF NOT EXISTS browser_identities(owner TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY(owner, id));
      CREATE TABLE IF NOT EXISTS browser_vault(id TEXT PRIMARY KEY, owner TEXT NOT NULL, origin TEXT NOT NULL, username TEXT NOT NULL, secret TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', identity TEXT NOT NULL DEFAULT 'default', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER);
      CREATE INDEX IF NOT EXISTS idx_browser_vault ON browser_vault(owner, origin);
      CREATE TABLE IF NOT EXISTS browser_codes(id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT, label TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS browser_files(id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, attachment_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_browser_files ON browser_files(owner, task_id);`);
  }
  close() { try { this.db.close(); } catch {} }
  transaction(fn: any) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  // ---- tasks ------------------------------------------------------------------------------------
  row(taskId: any): BrowserTask | null { const r = this.db.prepare('SELECT * FROM browser_tasks WHERE id=?').get(String(taskId || '')); return r ? r as unknown as BrowserTask : null; }
  task(owner: any, taskId: any) {
    const row = this.row(taskId);
    if (!row || row.owner !== String(owner)) throw fail('没有找到这个浏览器任务（task_id 无效）', 404, 'task_not_found');
    return row;
  }
  createTask(owner: any, { title = '', identity = 'default', origin = 'chat', instruction = '', status = 'queued', grantedFiles = [] }: {title?: string; identity?: string; origin?: string; instruction?: string; status?: string; grantedFiles?: any[]} = {}) {
    if (!TASK_ORIGINS.includes(origin)) origin = 'chat';
    const taskId = id('bt'), at = now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO browser_tasks(id,owner,identity,title,origin,status,granted_files,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(taskId, String(owner), identity, text(title || instruction, 120), origin, status, json(grantedFiles), at, at);
      if (instruction) this.db.prepare('INSERT INTO browser_inputs(task_id,kind,text,created_at) VALUES(?,?,?,?)').run(taskId, 'instruction', text(instruction, 20000), at);
    });
    return this.row(taskId)!;
  }
  updateTask(taskId: any, fields: any) {
    const allowed = ['title', 'status', 'summary', 'result', 'error', 'last_url', 'thread_id', 'claimed_by', 'claim_token', 'lease_until', 'checkout', 'granted_files', 'allowed_origins', 'finished_at', 'identity'];
    const keys = Object.keys(fields).filter(key => allowed.includes(key));
    if (!keys.length) return this.row(taskId);
    this.db.prepare(`UPDATE browser_tasks SET ${keys.map(key => key + '=?').join(',')},updated_at=? WHERE id=?`).run(...keys.map(key => fields[key] ?? null), now(), String(taskId));
    return this.row(taskId);
  }
  listTasks(owner: any, { limit = 50, active = false } = {}) {
    const rows = active
      ? this.db.prepare(`SELECT * FROM browser_tasks WHERE owner=? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT ?`).all(String(owner), ...ACTIVE_STATUSES, Math.min(200, Number(limit) || 50))
      : this.db.prepare('SELECT * FROM browser_tasks WHERE owner=? ORDER BY updated_at DESC LIMIT ?').all(String(owner), Math.min(200, Number(limit) || 50));
    return rows;
  }
  addInput(taskId: any, kind: any, value: any, questionId = null) {
    this.db.prepare('INSERT INTO browser_inputs(task_id,kind,text,question_id,created_at) VALUES(?,?,?,?,?)').run(String(taskId), kind, text(value, 20000), questionId, now());
  }
  pendingInputs(taskId: any) { return this.db.prepare('SELECT id,kind,text,question_id,created_at FROM browser_inputs WHERE task_id=? AND consumed_at IS NULL ORDER BY id').all(String(taskId)); }
  consumeInputs(taskId: any, upto: any) { this.db.prepare('UPDATE browser_inputs SET consumed_at=? WHERE task_id=? AND id<=? AND consumed_at IS NULL').run(now(), String(taskId), Number(upto) || 0); }
  allInstructions(taskId: any) { return this.db.prepare("SELECT kind,text,created_at FROM browser_inputs WHERE task_id=? AND kind IN ('instruction','answer','handback') ORDER BY id").all(String(taskId)); }
  progress(taskId: any, value: any) { this.db.prepare('INSERT INTO browser_progress(task_id,text,created_at) VALUES(?,?,?)').run(String(taskId), text(value, 600), now()); }
  progressList(taskId: any, limit = 30) { return this.db.prepare('SELECT text,created_at FROM browser_progress WHERE task_id=? ORDER BY id DESC LIMIT ?').all(String(taskId), limit).reverse(); }

  // Executor claims: one live executor per task; an expired lease is never silently re-run because
  // the page may have changed (an order may have been placed). It is surfaced as interrupted.
  claimNext(workerId: any, { leaseMs = 5 * 60_000, exclude = [] }: {leaseMs?: number; exclude?: string[]} = {}) {
    return this.transaction(() => {
      const at = now();
      const expired = this.db.prepare("SELECT * FROM browser_tasks WHERE status='running' AND lease_until IS NOT NULL AND lease_until<?").all(at);
      for (const row of expired) {
        this.db.prepare("UPDATE browser_tasks SET status='interrupted',claimed_by=NULL,claim_token=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=?").run('执行进程中断，网页上的结果可能不确定', at, row.id);
        this.event(row.owner, row.id, 'browser_task_update', { task_id: row.id, status: 'interrupted', summary: '浏览器执行中断。网页上的操作结果可能不确定，先核对页面和商家凭证再决定是否重试。' });
      }
      const skip = exclude.length ? ` AND owner NOT IN (${exclude.map(() => '?').join(',')})` : '';
      const row = this.db.prepare(`SELECT * FROM browser_tasks WHERE status='queued'${skip} ORDER BY updated_at LIMIT 1`).get(...exclude);
      if (!row) return null;
      const token = randomBytes(24).toString('base64url');
      this.db.prepare("UPDATE browser_tasks SET status='running',claimed_by=?,claim_token=?,lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(String(workerId), token, at + leaseMs, at, row.id);
      return { task: this.row(row.id), token };
    });
  }
  verifyClaim(taskId: any, token: any) {
    const row = this.row(taskId);
    if (!row || !token || row.claim_token !== token) throw fail('浏览器任务执行凭证无效', 401);
    return row;
  }
  renewClaim(taskId: any, token: any, leaseMs = 5 * 60_000) {
    const row = this.verifyClaim(taskId, token);
    this.db.prepare('UPDATE browser_tasks SET lease_until=?,updated_at=? WHERE id=?').run(now() + leaseMs, now(), row.id);
    return this.row(row.id);
  }
  releaseClaim(taskId: any) { this.db.prepare('UPDATE browser_tasks SET claimed_by=NULL,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(now(), String(taskId)); }

  // ---- questions ----------------------------------------------------------------------------------
  createQuestion(owner: any, taskId: any, { kind, prompt, options = [], data = {} }: {kind: string; prompt: string; options?: string[]; data?: any}) {
    const questionId = id('q');
    this.db.prepare('INSERT INTO browser_questions(id,task_id,owner,kind,prompt,options,data,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(questionId, String(taskId), String(owner), kind, text(prompt, 2000), json(options), json(data), now());
    return this.question(questionId);
  }
  question(questionId: any): BrowserQuestion | null {
    const row = this.db.prepare('SELECT * FROM browser_questions WHERE id=?').get(String(questionId || ''));
    return row ? { ...row, options: parse(row.options, []), data: parse(row.data, {}), answer: parse(row.answer, null) } as BrowserQuestion : null;
  }
  ownedQuestion(owner: any, questionId: any) {
    const row = this.question(questionId);
    if (!row || row.owner !== String(owner)) throw fail('没有找到这个问题（question_id 无效）', 404, 'question_not_found');
    return row;
  }
  answerQuestion(questionId: any, answer: any, by: any) {
    const changed = this.db.prepare("UPDATE browser_questions SET status='answered',answer=?,answered_by=?,answered_at=? WHERE id=? AND status='pending'").run(json(answer), by, now(), String(questionId)).changes;
    if (!changed) throw fail('这个问题已经回答过或已关闭', 409, 'question_closed');
    return this.question(questionId);
  }
  cancelQuestions(taskId: any) { this.db.prepare("UPDATE browser_questions SET status='cancelled',answered_at=? WHERE task_id=? AND status='pending'").run(now(), String(taskId)); }
  pendingQuestions(owner: any, taskId = null) {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM browser_questions WHERE owner=? AND task_id=? AND status='pending' ORDER BY created_at").all(String(owner), String(taskId))
      : this.db.prepare("SELECT * FROM browser_questions WHERE owner=? AND status='pending' ORDER BY created_at").all(String(owner));
    return rows.map(row => ({ ...row, options: parse(row.options, []), data: parse(row.data, {}) } as BrowserQuestion));
  }

  // ---- events for the Dots conversation ------------------------------------------------------------
  event(owner: any, taskId: any, type: any, payload: any) {
    this.db.prepare('INSERT INTO browser_events(owner,task_id,type,payload,created_at) VALUES(?,?,?,?,?)').run(String(owner), taskId, type, json(payload), now());
  }
  undeliveredEvents(limit = 50): any[] { return this.db.prepare('SELECT * FROM browser_events WHERE delivered_at IS NULL ORDER BY id LIMIT ?').all(limit).map(row => ({ ...row, payload: parse(row.payload, {}) })); }
  markDelivered(ids: any) { const stmt = this.db.prepare('UPDATE browser_events SET delivered_at=? WHERE id=? AND delivered_at IS NULL'); for (const value of ids) stmt.run(now(), Number(value)); }

  // ---- permissions (users change them in Settings; agents only read them) ---------------------------
  permissions(owner: any) {
    const row = this.db.prepare('SELECT permissions FROM browser_settings WHERE owner=?').get(String(owner));
    return { ...DEFAULT_PERMISSIONS, ...parse(row?.permissions, {}) };
  }
  setPermissions(owner: any, input: any) {
    const next = this.permissions(owner);
    for (const key of PERMISSION_KEYS) if (input?.[key] !== undefined) {
      if (!(PERMISSION_VALUES as any)[key].includes(input[key])) throw fail('浏览器权限设置无效');
      next[key] = input[key];
    }
    this.db.prepare('INSERT INTO browser_settings(owner,permissions,updated_at) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET permissions=excluded.permissions,updated_at=excluded.updated_at').run(String(owner), json(next), now());
    return next;
  }
  siteRules(owner: any) { return this.db.prepare('SELECT origin,setting,updated_at FROM browser_site_rules WHERE owner=? ORDER BY origin').all(String(owner)); }
  setSiteRule(owner: any, origin: any, setting: any) {
    origin = normalizeOrigin(origin);
    if (setting === null || setting === 'default') { this.db.prepare('DELETE FROM browser_site_rules WHERE owner=? AND origin=?').run(String(owner), origin); return null; }
    if (!['allow', 'ask', 'deny'].includes(setting)) throw fail('网站权限设置无效');
    this.db.prepare('INSERT INTO browser_site_rules(owner,origin,setting,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,origin) DO UPDATE SET setting=excluded.setting,updated_at=excluded.updated_at').run(String(owner), origin, setting, now());
    return { origin, setting };
  }
  // Effective site-access decision: a site rule wins over the default; a task-level approval
  // (the user answered "allow" for this task) turns "ask" into "allow" for that task only.
  siteDecision(owner: any, origin: any, task: BrowserTask | null = null) {
    const rules = this.siteRules(owner);
    const rule = rules.find(item => originMatches(item.origin, origin) && new URL(String(item.origin)).hostname === new URL(origin).hostname) || rules.find(item => originMatches(item.origin, origin));
    const setting = rule?.setting || this.permissions(owner).siteAccess;
    if (setting === 'ask' && task && parse(task.allowed_origins, []).includes(origin)) return 'allow';
    return setting;
  }

  // ---- identities --------------------------------------------------------------------------------
  identities(owner: any) {
    const rows = this.db.prepare('SELECT id,label,note,created_at FROM browser_identities WHERE owner=? ORDER BY created_at').all(String(owner));
    return [{ id: 'default', label: '默认身份', note: '所有窗口默认共用', created_at: 0 }, ...rows];
  }
  hasIdentity(owner: any, identity: any) { return identity === 'default' || Boolean(this.db.prepare('SELECT 1 FROM browser_identities WHERE owner=? AND id=?').get(String(owner), identity)); }
  addIdentity(owner: any, { id: identity, label, note = '' }: any) {
    if (identity === 'default') throw fail('默认身份已存在');
    this.db.prepare('INSERT INTO browser_identities(owner,id,label,note,created_at) VALUES(?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET label=excluded.label,note=excluded.note').run(String(owner), identity, text(label || identity, 60), text(note, 200), now());
    return this.identities(owner).find(item => item.id === identity);
  }
  removeIdentity(owner: any, identity: any) { if (identity === 'default') throw fail('默认身份不能删除'); this.db.prepare('DELETE FROM browser_identities WHERE owner=? AND id=?').run(String(owner), identity); }

  // ---- Secure Vault ------------------------------------------------------------------------------
  vaultList(owner: any) {
    return this.db.prepare('SELECT id,origin,username,label,identity,created_at,updated_at,last_used_at FROM browser_vault WHERE owner=? ORDER BY origin,username').all(String(owner));
  }
  vaultSave(owner: any, { id: entryId = null, origin, username, password, label = '', identity = 'default' }: any) {
    origin = normalizeOrigin(origin);
    username = text(username, 256).trim();
    if (!username) throw fail('请填写账号');
    if (entryId) {
      const prior = this.db.prepare('SELECT * FROM browser_vault WHERE id=? AND owner=?').get(String(entryId), String(owner));
      if (!prior) throw fail('没有找到这条保存的登录', 404);
      const secret = typeof password === 'string' && password ? this.box.seal(password, 'vault:' + owner + ':' + prior.id) : prior.secret;
      this.db.prepare('UPDATE browser_vault SET origin=?,username=?,secret=?,label=?,identity=?,updated_at=? WHERE id=?').run(origin, username, secret, text(label, 80), identity, now(), prior.id);
      return this.vaultList(owner).find(item => item.id === prior.id);
    }
    if (typeof password !== 'string' || !password || password.length > 1024) throw fail('请填写密码');
    const entry = id('vault');
    this.db.prepare('INSERT INTO browser_vault(id,owner,origin,username,secret,label,identity,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(entry, String(owner), origin, username, this.box.seal(password, 'vault:' + owner + ':' + entry), text(label, 80), identity, now(), now());
    return this.vaultList(owner).find(item => item.id === entry);
  }
  vaultDelete(owner: any, entryId: any) { this.db.prepare('DELETE FROM browser_vault WHERE id=? AND owner=?').run(String(entryId), String(owner)); }
  vaultCandidates(owner: any, pageOrigin: any, identity = 'default') {
    return this.vaultList(owner).filter(item => item.identity === identity && originMatches(item.origin, pageOrigin));
  }
  // Only the agent host calls this, to type the password into the page. Never returned to a model.
  vaultReveal(owner: any, entryId: any) {
    const row = this.db.prepare('SELECT * FROM browser_vault WHERE id=? AND owner=?').get(String(entryId), String(owner));
    if (!row) throw fail('没有找到这条保存的登录', 404);
    this.db.prepare('UPDATE browser_vault SET last_used_at=? WHERE id=?').run(now(), row.id);
    return { username: row.username, password: this.box.open(row.secret, 'vault:' + owner + ':' + row.id), origin: row.origin };
  }

  // ---- protected verification codes: single use, bound to one task, released only after approval ---
  createCode(owner: any, { taskId = null, code, label = '', approved = false, ttlMs = 10 * 60_000 }: any) {
    const value = text(code, 64).trim();
    if (!/^[A-Za-z0-9-]{3,32}$/.test(value)) throw fail('验证码格式无效');
    const ref = id('vc');
    this.db.prepare('INSERT INTO browser_codes(id,owner,task_id,label,secret,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(ref, String(owner), taskId, text(label, 80), this.box.seal(value, 'code:' + owner + ':' + ref), approved ? 'approved' : 'pending_approval', now(), now() + ttlMs);
    return this.code(owner, ref);
  }
  code(owner: any, ref: any): BrowserCode {
    const row = this.db.prepare('SELECT id,owner,task_id,label,status,created_at,expires_at,used_at FROM browser_codes WHERE id=? AND owner=?').get(String(ref || ''), String(owner));
    if (!row) throw fail('验证码引用无效', 404, 'code_not_found');
    if (row.status !== 'used' && Number(row.expires_at) < now()) { this.db.prepare("UPDATE browser_codes SET status='expired' WHERE id=?").run(row.id); row.status = 'expired'; }
    return row as unknown as BrowserCode;
  }
  bindCode(owner: any, ref: any, taskId: any) {
    const row = this.code(owner, ref);
    if (row.task_id && row.task_id !== taskId) throw fail('这个验证码引用属于另一次验证，不能用于此任务', 403, 'code_scope');
    if (['used', 'expired', 'denied'].includes(String(row.status))) throw fail('这个验证码引用已失效', 409, 'code_closed');
    this.db.prepare('UPDATE browser_codes SET task_id=? WHERE id=?').run(taskId, row.id);
    return this.code(owner, ref);
  }
  setCodeStatus(owner: any, ref: any, status: any) { this.db.prepare('UPDATE browser_codes SET status=? WHERE id=? AND owner=?').run(status, String(ref), String(owner)); }
  consumeCode(owner: any, ref: any, taskId: any) {
    const row = this.code(owner, ref);
    if (row.task_id !== taskId) throw fail('验证码引用不属于这个任务', 403, 'code_scope');
    if (row.status !== 'approved') throw fail(row.status === 'pending_approval' ? '用户还没有批准把验证码分享给浏览器' : '验证码引用已失效', 409, 'code_closed');
    const sealed = this.db.prepare('SELECT secret FROM browser_codes WHERE id=?').get(row.id)!.secret;
    this.db.prepare("UPDATE browser_codes SET status='used',used_at=? WHERE id=? AND status='approved'").run(now(), row.id);
    return this.box.open(sealed, 'code:' + owner + ':' + row.id);
  }

  // ---- files ---------------------------------------------------------------------------------------
  addFile(owner: any, taskId: any, { kind, filename, mime, size, sha256, attachmentId }: any) {
    const fileId = id('bf');
    this.db.prepare('INSERT INTO browser_files(id,owner,task_id,kind,filename,mime,size,sha256,attachment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(fileId, String(owner), String(taskId), kind, text(filename, 180), text(mime, 120), Number(size) || 0, sha256, attachmentId || null, now());
    return this.db.prepare('SELECT * FROM browser_files WHERE id=?').get(fileId)!;
  }
  files(owner: any, taskId: any) { return this.db.prepare('SELECT id,kind,filename,mime,size,attachment_id,created_at FROM browser_files WHERE owner=? AND task_id=? ORDER BY created_at').all(String(owner), String(taskId)); }
}
