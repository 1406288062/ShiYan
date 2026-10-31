import { randomInt, randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export function registrationEmail(value) {
  const email = typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure('请输入有效邮箱');
  return email;
}
// Reuse the configured QQ mail file without copying its authorization code into
// service definitions, source, bundles, or a second credentials file.
export function registrationMailEnvironment(env = process.env) {
  if (!env.SHIYAN_SMTP_CONFIG) return env;
  try {
    const config = JSON.parse(readFileSync(env.SHIYAN_SMTP_CONFIG, 'utf8'));
    if (config.enabled !== true || typeof config.address !== 'string' ||
        typeof config.authorizationCode !== 'string' || !config.authorizationCode.trim()) return env;
    const address = registrationEmail(config.address);
    return { ...env,
      SHIYAN_MAIL_FROM: env.SHIYAN_MAIL_FROM || address,
      SHIYAN_SMTP_HOST: env.SHIYAN_SMTP_HOST || 'smtp.qq.com',
      SHIYAN_SMTP_PORT: env.SHIYAN_SMTP_PORT || '465',
      SHIYAN_SMTP_SECURE: env.SHIYAN_SMTP_SECURE || 'true',
      SHIYAN_SMTP_USER: env.SHIYAN_SMTP_USER || address,
      SHIYAN_SMTP_PASSWORD: env.SHIYAN_SMTP_PASSWORD || config.authorizationCode.trim()
    };
  } catch { return env; }
}
export function mailConfigured(env = process.env) {
  env = registrationMailEnvironment(env);
  return Boolean(env.SHIYAN_MAIL_FROM && (env.SHIYAN_RESEND_API_KEY ||
    (env.SHIYAN_SMTP_HOST && env.SHIYAN_SMTP_USER && env.SHIYAN_SMTP_PASSWORD)));
}
const smtpScript = `import json,sys,os,smtplib,ssl
from email.message import EmailMessage
p=json.load(sys.stdin);e=os.environ;m=EmailMessage()
m['From']=e['SHIYAN_MAIL_FROM'];m['To']=p['to'];m['Subject']=p['subject'];m.set_content(p['text'])
secure=e.get('SHIYAN_SMTP_SECURE','true').lower()=='true'
host=e['SHIYAN_SMTP_HOST'];port=int(e.get('SHIYAN_SMTP_PORT','465' if secure else '587'))
ctx=ssl.create_default_context()
with (smtplib.SMTP_SSL(host,port,timeout=15,context=ctx) if secure else smtplib.SMTP(host,port,timeout=15)) as s:
 if not secure:s.starttls(context=ctx)
 s.login(e['SHIYAN_SMTP_USER'],e['SHIYAN_SMTP_PASSWORD']);s.send_message(m)
`;
export async function sendRegistrationEmail(message, env = process.env) {
  env = registrationMailEnvironment(env);
  if (!mailConfigured(env)) throw failure('验证码邮件服务尚未配置，请稍后再试', 503);
  try {
    if (env.SHIYAN_RESEND_API_KEY) {
      const response = await fetch('https://api.resend.com/emails', { method: 'POST',
        headers: { Authorization: 'Bearer ' + env.SHIYAN_RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.SHIYAN_MAIL_FROM, to: [message.to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('delivery');
    } else {
      await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/python3', ['-c', smtpScript], { env, stdio: ['pipe', 'ignore', 'ignore'] });
        const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 25000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('delivery')); });
        child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(message));
      });
    }
  } catch { throw failure('验证码邮件发送失败，请稍后重试', 503); }
}

export class RegistrationEmail {
  constructor(store, { send = sendRegistrationEmail, configured = () => mailConfigured(), secret, purpose = 'register' } = {}) {
    if (!['register', 'password-reset'].includes(purpose)) throw failure('验证码用途无效');
    this.reset = purpose === 'password-reset';
    this.table = this.reset ? 'password_reset_email_codes' : 'registration_email_codes';
    this.store = store; this.send = send; this.configured = configured;
    if (!secret) {
      const root = path.dirname(store.db.prepare('PRAGMA database_list').get().file);
      const filename = path.join(root, 'registration-email.key');
      try { secret = readFileSync(filename); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { writeFileSync(filename, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        secret = readFileSync(filename);
      }
    }
    this.secret = secret;
    store.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      email TEXT PRIMARY KEY, id TEXT NOT NULL, digest TEXT NOT NULL,
      expires_at INTEGER NOT NULL, resend_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      ready INTEGER NOT NULL DEFAULT 0
    )`);
  }
  digest(email, id, code) { return createHmac('sha256', this.secret).update(JSON.stringify(this.reset ? ['password-reset', email, id, code] : [email, id, code])).digest('hex'); }
  async request(input, ip) {
    const email = registrationEmail(input?.email), store = this.store;
    if (!this.configured()) throw failure('验证码邮件服务尚未配置，请稍后再试', 503);
    store.consumeLimit((this.reset ? 'password-reset-mail-ip:' : 'registration-mail-ip:') + ip, 10, 3600000);
    store.consumeLimit((this.reset ? 'password-reset-mail-email:' : 'registration-mail-email:') + email, 5, 3600000);
    const id = randomUUID(), code = String(randomInt(1000000)).padStart(6, '0'), now = store.now();
    let eligible = true;
    store.transaction(() => {
      store.db.prepare(`DELETE FROM ${this.table} WHERE expires_at<=?`).run(now);
      const prior = store.db.prepare(`SELECT resend_at FROM ${this.table} WHERE email=?`).get(email);
      if (prior?.resend_at > now) throw failure('请稍后再获取验证码', 429);
      const user = store.db.prepare('SELECT id,status FROM account_users WHERE email=?').get(email);
      if (!this.reset && user) throw failure('该邮箱已注册，请直接登录', 409);
      eligible = !this.reset || user?.status === 'active';
      store.db.prepare(`INSERT OR REPLACE INTO ${this.table} VALUES(?,?,?,?,?,0,0)`)
        .run(email, id, this.digest(email, id, code), now + 600000, now + 60000);
    });
    // Use the same public response and cooldown for unknown or disabled addresses.
    if (this.reset && !eligible) {
      store.db.prepare(`UPDATE ${this.table} SET ready=1 WHERE email=? AND id=?`).run(email, id);
      return { ok: true, expiresIn: 600, resendAfter: 60 };
    }
    try {
      await this.send({ to: email, subject: this.reset ? '拾燕密码重置验证码' : '拾燕注册验证码',
        text: this.reset
          ? '你的拾燕密码重置验证码是：' + code + '\n\n验证码 10 分钟内有效，仅用于重置密码。请勿将验证码提供给他人。\n如果不是你本人操作，请忽略此邮件。'
          : '你的拾燕注册验证码是：' + code + '\n\n验证码 10 分钟内有效，仅用于注册。请勿将验证码提供给他人。\n如果不是你本人操作，请忽略此邮件。' });
      store.db.prepare(`UPDATE ${this.table} SET ready=1 WHERE email=? AND id=?`).run(email, id);
    } catch (error) {
      store.db.prepare(`DELETE FROM ${this.table} WHERE email=? AND id=?`).run(email, id);
      throw error;
    }
    return { ok: true, expiresIn: 600, resendAfter: 60 };
  }
  check(input) {
    const email = registrationEmail(input?.email), code = String(input?.verificationCode ?? '');
    const row = this.store.db.prepare(`SELECT * FROM ${this.table} WHERE email=?`).get(email);
    if (!row || !row.ready || row.expires_at <= this.store.now()) throw failure(this.reset ? '验证码无效或已过期，请重新获取' : '验证码已过期，请重新获取');
    if (row.attempts >= 5) throw failure('验证码尝试次数过多，请重新获取', 429);
    if (!/^\d{6}$/.test(code) || !timingSafeEqual(Buffer.from(row.digest, 'hex'), Buffer.from(this.digest(email, row.id, code), 'hex'))) {
      this.store.db.prepare(`UPDATE ${this.table} SET attempts=attempts+1 WHERE email=? AND id=?`).run(email, row.id);
      throw failure(this.reset ? '验证码无效或已过期，请重新获取' : '验证码不正确');
    }
    // Consume inside the account update transaction after the asynchronous password hash.
    // A concurrent update, resend or expiry must never reuse this challenge.
    return () => {
      const result = this.store.db.prepare(`DELETE FROM ${this.table} WHERE email=? AND id=? AND ready=1 AND attempts<5 AND expires_at>?`)
        .run(email, row.id, this.store.now());
      if (result.changes !== 1) throw failure('验证码已失效，请重新获取');
    };
  }
}
