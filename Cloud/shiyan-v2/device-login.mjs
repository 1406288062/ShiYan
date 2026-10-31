import { randomBytes, randomInt, createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export class DeviceLogin {
  constructor(accounts) {
    this.a = accounts;
    accounts.db.exec(`CREATE TABLE IF NOT EXISTS account_desktop_devices (
      id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES account_users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_login_requests (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, poll_hash TEXT NOT NULL, code TEXT NOT NULL,
      expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', approver_session TEXT);
      CREATE TABLE IF NOT EXISTS account_login_avatars (user_id TEXT PRIMARY KEY, avatar TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_login_device_context (
      device_id TEXT PRIMARY KEY REFERENCES account_desktop_devices(id) ON DELETE CASCADE,
      platform TEXT NOT NULL CHECK(platform IN ('macos','web')));`);
  }
  setAvatar(userId, value) {
    if (value === undefined) return;
    if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail('头像格式无效');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > 6144 || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw fail('头像格式无效');
    this.a.db.prepare('INSERT INTO account_login_avatars VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET avatar=excluded.avatar').run(userId, value);
  }
  pair(user, {platform = 'macos'} = {}) {
    platform = platform === 'web' ? 'web' : 'macos';
    const a = this.a, id = randomBytes(32).toString('base64url'), secret = randomBytes(32).toString('base64url');
    a.db.prepare('DELETE FROM account_desktop_devices WHERE expires_at<=?').run(a.now());
    const prior=a.db.prepare(`SELECT d.id FROM account_desktop_devices d LEFT JOIN account_login_device_context c ON c.device_id=d.id
      WHERE d.user_id=? AND COALESCE(c.platform,'macos')=? ORDER BY d.expires_at DESC,d.id DESC`).all(user.id,platform);
    for(const row of prior.slice(9)) a.db.prepare('DELETE FROM account_desktop_devices WHERE id=?').run(row.id);
    a.db.prepare('INSERT INTO account_desktop_devices VALUES(?,?,?,?)').run(id,hash(secret),user.id,a.now()+90*86400000);
    a.db.prepare('INSERT INTO account_login_device_context VALUES(?,?)').run(id,platform);
    return { id, secret, userId: user.id, name: user.display_name, avatar: a.db.prepare('SELECT avatar FROM account_login_avatars WHERE user_id=?').get(user.id)?.avatar || null };
  }
  device(input) {
    if (!opaque(input?.deviceId) || !opaque(input?.deviceSecret)) throw fail('电脑关联已失效，请重新扫码',401);
    const row = this.a.db.prepare(`SELECT d.id AS device_id,u.* FROM account_desktop_devices d JOIN account_users u ON u.id=d.user_id
      WHERE d.id=? AND d.secret_hash=? AND d.expires_at>? AND u.status='active'`).get(input.deviceId,hash(input.deviceSecret),this.a.now());
    if(!row) throw fail('电脑关联已失效，请重新扫码',401);
    return row;
  }
  create(input) {
    const user=this.device(input),a=this.a;
    a.consumeLimit('device-login:'+user.device_id,3,60000);
    return a.transaction(()=>{
      a.db.prepare('DELETE FROM account_login_requests WHERE expires_at<=?').run(a.now());
      a.db.prepare("UPDATE account_login_requests SET state='superseded' WHERE device_id=? AND state='pending'").run(user.device_id);
      const id=randomBytes(32).toString('base64url'),pollSecret=randomBytes(32).toString('base64url'),code=String(randomInt(100000,1000000)),expiresAt=a.now()+120000;
      a.db.prepare('INSERT INTO account_login_requests(id,device_id,poll_hash,code,expires_at) VALUES(?,?,?,?,?)').run(id,user.device_id,hash(pollSecret),code,expiresAt);
      return {ok:true,id,pollSecret,code,expiresAt};
    });
  }
  inbox(auth) {
    return {ok:true,requests:this.a.db.prepare(`SELECT r.id,r.code,r.expires_at AS expiresAt,COALESCE(c.platform,'macos') AS platform FROM account_login_requests r
      JOIN account_desktop_devices d ON d.id=r.device_id LEFT JOIN account_login_device_context c ON c.device_id=d.id
      WHERE d.user_id=? AND d.expires_at>? AND r.expires_at>? AND r.state='pending'
      ORDER BY r.expires_at DESC LIMIT 5`).all(auth.userId,this.a.now(),this.a.now()).map(({platform,...r})=>({...r,device:platform==='web'?'拾燕网页版':'拾燕 Mac 桌面端'}))};
  }
  approve(auth,input) {
    if(!opaque(input?.id)||typeof input.approve!=='boolean')throw fail('登录确认无效');
    const a=this.a;
    return a.transaction(()=>{
      const r=a.db.prepare(`SELECT r.* FROM account_login_requests r JOIN account_desktop_devices d ON d.id=r.device_id
        WHERE r.id=? AND d.user_id=? AND d.expires_at>?`).get(input.id,auth.userId,a.now());
      if(!r)throw fail('登录请求不存在',404);
      if(r.expires_at<=a.now())throw fail('登录请求已过期',410);
      if(r.state!=='pending')throw fail('登录请求已处理',409);
      const session=a.db.prepare("SELECT id FROM account_sessions WHERE id=? AND user_id=? AND expires_at>?").get(auth.sessionId,auth.userId,a.now());
      if(!session)throw fail('请重新登录',401);
      a.db.prepare('UPDATE account_login_requests SET state=?,approver_session=? WHERE id=?').run(input.approve?'approved':'denied',session.id,r.id);
      a.audit(auth.userId,auth.userId,input.approve?'desktop_login_approved':'desktop_login_denied');
      return {ok:true};
    });
  }
  poll(input) {
    const user=this.device(input),a=this.a;
    if(!opaque(input.id)||!opaque(input.pollSecret))throw fail('登录请求无效');
    return a.transaction(()=>{
      const r=a.db.prepare('SELECT * FROM account_login_requests WHERE id=? AND device_id=? AND poll_hash=?').get(input.id,user.device_id,hash(input.pollSecret));
      if(!r)throw fail('登录请求不存在',404);
      if(r.expires_at<=a.now())throw fail('登录请求已过期',410);
      if(['pending','denied','superseded'].includes(r.state))return {ok:true,state:r.state};
      if(r.state!=='approved')throw fail('登录请求已使用',409);
      const valid=a.db.prepare('SELECT id FROM account_sessions WHERE id=? AND user_id=? AND expires_at>?').get(r.approver_session,user.id,a.now());
      if(!valid)throw fail('手机登录已失效，请重新发起',401);
      a.db.prepare("UPDATE account_login_requests SET state='consumed' WHERE id=?").run(r.id);
      return {...a.newSession(user),state:'approved'};
    });
  }
}
