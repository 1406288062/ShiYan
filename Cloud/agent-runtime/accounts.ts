// Account identity is authoritative; client-supplied owner/role values are never used.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { accountRegistrationOutbox, enqueueAccountRegistration, REGISTRATION_SOCKET } from './registration-events.ts';

export const PRIVATE_OWNER = 'shiyan-private-owner';
const ROOT = process.env.SHIYAN_ROOT || '/home/ubuntu/boss-codex-service/shiyan-v2';
const DAY = 86400000;
const derive: any = promisify(scrypt);
const hash = (value: any) => createHash('sha256').update(value).digest('hex');
const failure = (message: any, status = 400) => Object.assign(new Error(message), { status });
const normalized = (value: any) => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
const passwordValid = (value: any) => typeof value === 'string' && value.length >= 8 && value.length <= 128 && Buffer.byteLength(value) <= 512;
const dummySalt = Buffer.alloc(16, 19).toString('hex');
let deriving = 0;
async function passwordHash(password: any, salt: any) {
  if (deriving >= 4) throw failure('登录请求较多，请稍后再试', 429);
  deriving++;
  try { return (await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex'); }
  finally { deriving--; }
}
const fields = (input: any) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('账户信息无效');
  const email = normalized(input.email);
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw failure('请输入有效邮箱');
  // An omitted username remains deterministic and unique without disclosing the email.
  const username = normalized(input.username) || (email ? 'u_' + hash(email).slice(0, 20) : '');
  if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(username)) throw failure('用户名须为3至64位字母、数字、中文或 ._-');
  const displayName = String(input.displayName ?? input.display_name ?? '').trim() || (email ? email.split('@')[0] : username);
  if (!displayName || displayName.length > 80 || /[\x00-\x1f\x7f]/.test(displayName)) throw failure('显示名称须为1至80字');
  if (!passwordValid(input.password)) throw failure('密码须为8至128位');
  if (input.confirmPassword !== undefined && input.confirmPassword !== input.password) throw failure('两次密码不一致');
  return { username, email, displayName, password: input.password };
};

export class AccountStore {
  now: () => number;
  sessionDays: number;
  db: DatabaseSync;
  registrationEvents: any;
  closed = false;
  constructor(root = path.join(ROOT, 'data'), { now = Date.now, sessionDays = 30,
    registrationSocketPath = path.resolve(root) === path.resolve(ROOT, 'data') ? REGISTRATION_SOCKET : false } = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.now = now; this.sessionDays = sessionDays;
    const filename = path.join(root, 'accounts.sqlite3');
    this.db = new DatabaseSync(filename); chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS account_users (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL, password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
        status TEXT NOT NULL CHECK(status IN ('active','disabled')), server_access INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS account_email_unique ON account_users(email) WHERE email<>'';
      CREATE TABLE IF NOT EXISTS account_sessions (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES account_users(id),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
      CREATE TABLE IF NOT EXISTS account_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, subject_id TEXT NOT NULL,
        action TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL
      );`);
    this.registrationEvents = accountRegistrationOutbox(this, registrationSocketPath);
  }
  close() { if (!this.closed) { this.closed = true; this.registrationEvents.close(); this.db.close(); } }
  transaction(action: any) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  public(row: any) {
    return { id: row.id, owner: row.owner, username: row.username, email: row.email,
      displayName: row.display_name, role: row.role, status: row.status, serverAccess: Boolean(row.server_access),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), revision: Number(row.revision),
      protected: row.owner === PRIVATE_OWNER };
  }
  bootstrapRequired() { return !this.db.prepare('SELECT id FROM account_users WHERE owner=?').get(PRIVATE_OWNER); }
  audit(actor: any, subject: any, action: any, details = {}) {
    this.db.prepare('INSERT INTO account_audit(actor_id,subject_id,action,details,created_at) VALUES(?,?,?,?,?)')
      .run(actor, subject, action, JSON.stringify(details), this.now());
  }
  consumeLimit(key: any, limit = 20, windowMs = 15 * 60000) {
    return this.transaction(() => {
      const now = this.now();
      this.db.prepare('DELETE FROM account_limits WHERE reset_at<=?').run(now);
      const opaque = hash(key), prior = this.db.prepare('SELECT count FROM account_limits WHERE key=?').get(opaque);
      if (prior && Number(prior.count) >= limit) throw failure('尝试次数较多，请稍后再试', 429);
      this.db.prepare('INSERT INTO account_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(opaque, now + windowMs);
    });
  }
  clearLimit(key: any) { this.db.prepare('DELETE FROM account_limits WHERE key=?').run(hash(key)); }
  newSession(row: any) {
    const token = randomBytes(32).toString('base64url'), now = this.now(), expiresAt = now + this.sessionDays * DAY;
    this.db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(now);
    // Keep bounded sessions per account. Every session remains independently revocable.
    const sessions = this.db.prepare('SELECT id FROM account_sessions WHERE user_id=? ORDER BY created_at DESC,id DESC').all(row.id);
    for (const session of sessions.slice(19)) this.db.prepare('DELETE FROM account_sessions WHERE id=?').run(session.id);
    this.db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?)').run(randomUUID(), hash(token), row.id, now, expiresAt, now);
    return { ok: true, token, expiresAt, user: this.public(row) };
  }
  async register(input: any, { bootstrap = false, trustedOwner = null, verifyEmail = null }: { bootstrap?: boolean; trustedOwner?: string | null; verifyEmail?: (() => void) | null } = {}) {
    const value = fields(input);
    if (bootstrap && trustedOwner !== PRIVATE_OWNER) throw failure('仅原管理员设备可以绑定管理账户', 403);
    const salt = randomBytes(16).toString('hex'), password = await passwordHash(value.password, salt);
    const result = this.transaction(() => {
      if (bootstrap && !this.bootstrapRequired()) throw failure('管理员账户已经绑定，请直接登录', 409);
      if (this.db.prepare("SELECT id FROM account_users WHERE username=? OR (email<>'' AND email=?)").get(value.username, value.email))
        throw failure('用户名或邮箱已被使用', 409);
      verifyEmail?.();
      const id = randomUUID(), owner = bootstrap ? PRIVATE_OWNER : 'account:' + id, now = this.now();
      this.db.prepare(`INSERT INTO account_users(id,owner,username,email,display_name,password_salt,password_hash,role,status,server_access,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, owner, value.username, value.email, value.displayName, salt, password, bootstrap ? 'admin' : 'user', 'active', bootstrap ? 1 : 0, now, now);
      this.audit(id, id, bootstrap ? 'owner_bootstrap' : 'register');
      const session = this.newSession(this.db.prepare('SELECT * FROM account_users WHERE id=?').get(id));
      if (!bootstrap) enqueueAccountRegistration(this, session.user);
      return session;
    });
    this.registrationEvents.notify();
    return result;
  }
  async resetPassword(input: any, { verifyEmail }: { verifyEmail?: () => void } = {}) {
    const email = normalized(input?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure('请输入有效邮箱');
    if (!passwordValid(input?.password)) throw failure('密码须为8至128位');
    if (input.confirmPassword !== input.password) throw failure('两次密码不一致');
    if (typeof verifyEmail !== 'function') throw failure('请先完成邮箱验证');
    const row = this.db.prepare("SELECT * FROM account_users WHERE email=? AND status='active'").get(email);
    const salt = randomBytes(16).toString('hex'), password = await passwordHash(input.password, salt);
    return this.transaction(() => {
      const current = row && this.db.prepare("SELECT * FROM account_users WHERE id=? AND email=? AND status='active'").get(row.id, email);
      if (!current) throw failure('验证码无效或已过期，请重新获取');
      verifyEmail();
      this.db.prepare('UPDATE account_users SET password_salt=?,password_hash=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(salt, password, this.now(), current.id);
      this.db.prepare('DELETE FROM account_sessions WHERE user_id=?').run(current.id);
      this.clearLimit('login:' + current.email); this.clearLimit('login:' + current.username);
      this.audit(current.id, current.id, 'password_reset', { sessionsRevoked: true });
      return { ok: true };
    });
  }
  async login(input: any) {
    const identifier = normalized(input?.identifier ?? input?.email ?? input?.username);
    const password = input?.password;
    if (!identifier || identifier.length > 254 || typeof password !== 'string' || password.length > 128 || Buffer.byteLength(password) > 512)
      throw failure('邮箱、用户名或密码不正确', 401);
    this.consumeLimit('login:' + identifier, 12);
    const row = this.db.prepare("SELECT * FROM account_users WHERE username=? OR (email<>'' AND email=?)").get(identifier, identifier);
    const actual = Buffer.from(await passwordHash(password, row?.password_salt || dummySalt), 'hex');
    const expected = row ? Buffer.from(String(row.password_hash), 'hex') : Buffer.alloc(64);
    if (!timingSafeEqual(actual, expected) || !row || row.status !== 'active') throw failure('邮箱、用户名或密码不正确', 401);
    return this.transaction(() => {
      // An administrator can disable an account while the password hash is being calculated.
      const current = this.db.prepare('SELECT * FROM account_users WHERE id=?').get(row.id);
      if (!current || current.status !== 'active' || current.password_hash !== row.password_hash) throw failure('邮箱、用户名或密码不正确', 401);
      this.clearLimit('login:' + identifier); this.audit(current.id, current.id, 'login');
      return this.newSession(current);
    });
  }
  authenticate(token: any) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare(`SELECT u.*,s.id AS session_id,s.expires_at,s.last_seen_at
      FROM account_sessions s JOIN account_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'`).get(hash(token), this.now());
    if (!row) return null;
    if (this.now() - Number(row.last_seen_at) > 60000) this.db.prepare('UPDATE account_sessions SET last_seen_at=? WHERE id=?').run(this.now(), row.session_id);
    return { owner: row.owner, userId: row.id, role: row.role, serverAccess: Boolean(row.server_access),
      deviceID: row.session_id, sessionId: row.session_id, expiresAt: Number(row.expires_at), user: this.public(row), accountSession: true };
  }
  logout(token: any) {
    if (typeof token === 'string') this.db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(hash(token));
    return { ok: true };
  }
  access(owner: any) {
    const row = this.db.prepare('SELECT * FROM account_users WHERE owner=?').get(owner);
    if (row) return { owner, userId: row.id, role: row.role, status: row.status, serverAccess: row.status === 'active' && Boolean(row.server_access) };
    if (owner === PRIVATE_OWNER && this.bootstrapRequired()) return { owner, role: 'admin', status: 'active', serverAccess: true, legacy: true };
    return { owner, role: 'user', status: 'disabled', serverAccess: false };
  }
  requireAdmin(auth: any) {
    // Recheck the database, never trust role flags from a prior request or a caller's JSON.
    const current = auth?.userId && this.db.prepare('SELECT * FROM account_users WHERE id=?').get(auth.userId);
    if (!auth?.accountSession || !current || current.status !== 'active' || current.role !== 'admin') throw failure('需要管理员权限', 403);
    return current;
  }
  listUsers(auth: any) {
    this.requireAdmin(auth);
    return { ok: true, users: this.db.prepare('SELECT * FROM account_users ORDER BY created_at,id LIMIT 1000').all().map(row => this.public(row)) };
  }
  updateUser(auth: any, id: any, input: any) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !['role','status','serverAccess','displayName','revision'].includes(key))) throw failure('权限更新无效');
    if (input.role !== undefined && !['admin','user'].includes(input.role) || input.status !== undefined && !['active','disabled'].includes(input.status) || input.serverAccess !== undefined && typeof input.serverAccess !== 'boolean') throw failure('权限更新无效');
    if (input.displayName !== undefined && (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.displayName))) throw failure('显示名称无效');
    return this.transaction(() => {
      const actor = this.requireAdmin(auth), row = this.db.prepare('SELECT * FROM account_users WHERE id=?').get(id);
      if (!row) throw failure('用户不存在', 404);
      if (input.revision !== undefined && input.revision !== row.revision) throw failure('用户权限已经更新，请刷新后重试', 409);
      const role = input.role ?? row.role, status = input.status ?? row.status;
      const serverAccess = input.serverAccess ?? (role === 'admin' ? Boolean(row.server_access) : false);
      if (serverAccess && role !== 'admin') throw failure('服务器访问权限仅可授予管理员');
      if (serverAccess && !row.server_access && !actor.server_access) throw failure('需要服务器访问权限才能授予此权限', 403);
      if (row.owner === PRIVATE_OWNER && (role !== 'admin' || status !== 'active' || !serverAccess)) throw failure('不能停用或降低原管理员权限', 409);
      if (row.role === 'admin' && row.status === 'active' && (role !== 'admin' || status !== 'active') && Number(this.db.prepare("SELECT COUNT(*) AS count FROM account_users WHERE role='admin' AND status='active'").get()?.count || 0) <= 1) throw failure('至少保留一位可用管理员', 409);
      const changedAccess = role !== row.role || status !== row.status || serverAccess !== Boolean(row.server_access);
      this.db.prepare('UPDATE account_users SET role=?,status=?,server_access=?,display_name=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(role, status, Number(serverAccess), input.displayName?.trim() ?? row.display_name, this.now(), id);
      if (changedAccess) this.db.prepare('DELETE FROM account_sessions WHERE user_id=?').run(id);
      this.audit(actor.id, id, 'permissions_update', { role, status, serverAccess, sessionsRevoked: changedAccess });
      return { ok: true, user: this.public(this.db.prepare('SELECT * FROM account_users WHERE id=?').get(id)), sessionsRevoked: changedAccess };
    });
  }
}

let defaultStore;
export const getAccountStore = () => defaultStore ||= new AccountStore();
export const accountAccess = (owner: any) => getAccountStore().access(owner);
export function requestBearer(req: any) {
  const value = req.headers.authorization;
  return typeof value === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/i.test(value) ? value.slice(7) : null;
}
