import { DeviceLogin } from './device-login.ts';
import { randomBytes, randomInt, createHash } from 'node:crypto';
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const opaque = x => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x);

// A scan grants no session. Only the creating desktop can exchange an approved
// challenge, and approval remains bound to a currently valid phone session.
export class QRLogin {
  accounts: any;
  devices: DeviceLogin;
  constructor(accounts) {
    this.accounts = accounts;
    this.devices = new DeviceLogin(accounts);
    accounts.db.exec(`CREATE TABLE IF NOT EXISTS account_qr_login (
      id TEXT PRIMARY KEY, scan_hash TEXT NOT NULL, poll_hash TEXT NOT NULL,
      code TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      approver_session TEXT, approver_user TEXT
    );
    CREATE TABLE IF NOT EXISTS account_qr_login_context (
      request_id TEXT PRIMARY KEY REFERENCES account_qr_login(id) ON DELETE CASCADE,
      platform TEXT NOT NULL CHECK(platform IN ('macos','web'))
    )`);
  }
  create({platform = 'macos'} = {}) {
    platform = platform === 'web' ? 'web' : 'macos';
    const a = this.accounts, now = a.now();
    return a.transaction(() => {
      a.db.prepare('DELETE FROM account_qr_login WHERE expires_at<=?').run(now);
      if (a.db.prepare('SELECT count(*) AS n FROM account_qr_login').get().n >= 1000) throw fail('扫码登录请求较多，请稍后再试', 429);
      const id = randomBytes(32).toString('base64url'), scanSecret = randomBytes(32).toString('base64url');
      const pollSecret = randomBytes(32).toString('base64url'), code = String(randomInt(100000, 1000000)), expiresAt = now + 120000;
      a.db.prepare('INSERT INTO account_qr_login(id,scan_hash,poll_hash,code,expires_at) VALUES(?,?,?,?,?)')
        .run(id, hash(scanSecret), hash(pollSecret), code, expiresAt);
      a.db.prepare('INSERT INTO account_qr_login_context VALUES(?,?)').run(id,platform);
      return { ok: true, id, pollSecret, code, expiresAt,
        payload: `shiyan://login?v=1&id=${id}&secret=${scanSecret}` };
    });
  }
  get(input, kind) {
    if (!opaque(input?.id) || !opaque(input?.[kind])) throw fail('二维码无效，请重新扫码');
    const row = this.accounts.db.prepare('SELECT * FROM account_qr_login WHERE id=?').get(input.id);
    if (!row || row[kind === 'scanSecret' ? 'scan_hash' : 'poll_hash'] !== hash(input[kind])) throw fail('二维码无效，请重新扫码', 404);
    if (row.expires_at <= this.accounts.now()) throw fail('二维码已过期，请在电脑上刷新', 410);
    return row;
  }
  preview(input) {
    const row = this.get(input, 'scanSecret');
    if (row.state !== 'pending') throw fail('二维码已处理，请在电脑上刷新', 409);
    const platform=this.accounts.db.prepare('SELECT platform FROM account_qr_login_context WHERE request_id=?').get(row.id)?.platform;
    return { ok: true, code: row.code, expiresAt: Number(row.expires_at), device: platform==='web'?'拾燕网页版':'拾燕 Mac 桌面端' };
  }
  approve(auth, input) {
    const a = this.accounts;
    return a.transaction(() => {
      const row = this.get(input, 'scanSecret');
      if (row.state !== 'pending') throw fail('二维码已处理，请在电脑上刷新', 409);
      const session = a.db.prepare(`SELECT s.id,u.id AS user_id FROM account_sessions s JOIN account_users u ON u.id=s.user_id
        WHERE s.id=? AND u.id=? AND s.expires_at>? AND u.status='active'`).get(auth.sessionId, auth.userId, a.now());
      if (!session) throw fail('登录已失效，请重新登录', 401);
      a.db.prepare('UPDATE account_qr_login SET state=?,approver_session=?,approver_user=? WHERE id=?')
        .run(input.approve === true ? 'approved' : 'denied', session.id, session.user_id, row.id);
      this.devices.setAvatar(auth.userId, input.avatar);
      a.audit(auth.userId, auth.userId, input.approve === true ? 'qr_login_approved' : 'qr_login_denied');
      return { ok: true };
    });
  }
  poll(input) {
    const a = this.accounts;
    return a.transaction(() => {
      const row = this.get(input, 'pollSecret');
      if (row.state === 'pending' || row.state === 'denied') return { ok: true, state: row.state, expiresAt: Number(row.expires_at) };
      if (row.state !== 'approved') throw fail('二维码已使用，请刷新', 409);
      const user = a.db.prepare(`SELECT u.* FROM account_sessions s JOIN account_users u ON u.id=s.user_id
        WHERE s.id=? AND u.id=? AND s.expires_at>? AND u.status='active'`).get(row.approver_session, row.approver_user, a.now());
      if (!user) throw fail('手机登录已失效，请重新扫码', 401);
      a.db.prepare("UPDATE account_qr_login SET state='consumed' WHERE id=?").run(row.id);
      a.audit(user.id, user.id, 'qr_login');
      const platform=a.db.prepare('SELECT platform FROM account_qr_login_context WHERE request_id=?').get(row.id)?.platform;
      return { ...a.newSession(user), device: this.devices.pair(user,{platform}), state: 'approved' };
    });
  }
}
