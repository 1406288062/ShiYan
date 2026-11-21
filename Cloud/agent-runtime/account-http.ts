// Standalone account routes can also be mounted before the existing device transport.
import { getAccountStore, requestBearer, PRIVATE_OWNER } from './accounts.ts';
import { authenticateLegacyDevice, digest } from './device-auth.ts';
import { isIP } from 'node:net';
import { RegistrationEmail } from './registration-email.ts';
import { QRLogin } from './qr-login.ts';
import { createAccountAvatarHandler } from './account-avatar.ts';
const qrStores = new WeakMap(), emailStores = new WeakMap(), resetStores = new WeakMap();
const emailFor = store => { if (!emailStores.has(store)) emailStores.set(store, new RegistrationEmail(store)); return emailStores.get(store); };
const resetFor = store => { if (!resetStores.has(store)) resetStores.set(store, new RegistrationEmail(store, { purpose: 'password-reset' })); return resetStores.get(store); };
const qrFor = store => { if (!qrStores.has(store)) qrStores.set(store, new QRLogin(store)); return qrStores.get(store); };

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (res, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
};
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw failure('账户请求过大', 413); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (req.headers['x-shiyan-body-sha'] !== undefined && req.headers['x-shiyan-body-sha'] !== digest(bytes)) throw failure('请求校验失败', 401);
  try { const value = JSON.parse(bytes.toString() || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
  catch { throw failure('账户请求格式无效'); }
}
export function createAccountHandler({ store, registrationEmail, passwordResetEmail, authenticateLegacy = authenticateLegacyDevice } = {}) {
  const avatarHandler = createAccountAvatarHandler({ store });
  return async function handleAccountRequest(req, res) {
    if (await avatarHandler(req, res)) return true;
    const pathname = new URL(req.url || '/', 'http://localhost').pathname.replace(/^\/shiyan(?=\/)/, '');
    if (!pathname.startsWith('/v1/auth/') && !pathname.startsWith('/v1/admin/')) return false;
    const accounts = store || getAccountStore();
    try {
      if (req.method === 'GET' && pathname === '/v1/auth/status') {
        const bootstrapRequired = accounts.bootstrapRequired();
        const legacy = bootstrapRequired && req.headers['x-shiyan-device'] ? authenticateLegacy(req) : null;
        json(res, 200, { ok: true, registrationEnabled: true, bootstrapRequired, canBootstrap: legacy?.owner === PRIVATE_OWNER, emailVerificationRequired: true, emailDeliveryAvailable: (registrationEmail || emailFor(accounts)).configured() }); return true;
      }
      if (req.method === 'POST' && ['/v1/auth/password-reset-code','/v1/auth/password-reset'].includes(pathname)) {
        const peer = req.socket?.remoteAddress || 'unknown', real = req.headers['x-real-ip'];
        const ip = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) && typeof real === 'string' && isIP(real) ? real : peer;
        const mail = passwordResetEmail || resetFor(accounts), input = await body(req);
        if (pathname.endsWith('-code')) json(res, 200, await mail.request(input, ip));
        else {
          accounts.consumeLimit('password-reset-ip:' + ip, 30, 15 * 60000);
          json(res, 200, await accounts.resetPassword(input, { verifyEmail: mail.check(input) }));
        }
        return true;
      }
      if (req.method === 'POST' && pathname === '/v1/auth/register-code') {
        const peer = req.socket?.remoteAddress || 'unknown', real = req.headers['x-real-ip'];
        const ip = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) && typeof real === 'string' && isIP(real) ? real : peer;
        json(res, 200, await (registrationEmail || emailFor(accounts)).request(await body(req), ip)); return true;
      }
      if (req.method === 'POST' && ['/v1/auth/register', '/v1/auth/bootstrap', '/v1/auth/login'].includes(pathname)) {
        // Do not store raw IP addresses or attempted identifiers in limiter records.
        const peer=req.socket?.remoteAddress||'unknown',real=req.headers['x-real-ip'];
        const clientIP=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&typeof real==='string'&&isIP(real)?real:peer;
        accounts.consumeLimit('auth-ip:' + clientIP, 120, 15 * 60000);
        const input = await body(req);
        if (pathname === '/v1/auth/login') {
          const result = await accounts.login(input);
          if (['macos','web'].includes(req.headers['x-shiyan-platform'])) {
            const row=accounts.db.prepare("SELECT * FROM account_users WHERE id=? AND status='active'").get(result.user.id);
            if (!row) throw failure('账户不可用',401);
            const devices=qrFor(accounts).devices;
            result.device=accounts.transaction(()=>devices.pair(row,{platform:req.headers['x-shiyan-platform']}));
          }
          json(res, 200, result);
        }
        else if (pathname === '/v1/auth/bootstrap') {
          const legacy = authenticateLegacy(req);
          if (legacy?.owner !== PRIVATE_OWNER) throw failure('仅原管理员设备可以绑定管理账户', 403);
          json(res, 201, await accounts.register(input, { bootstrap: true, trustedOwner: legacy.owner, verifyEmail: (registrationEmail || emailFor(accounts)).check(input) }));
        } else {
          const result=await accounts.register(input, { verifyEmail: (registrationEmail || emailFor(accounts)).check(input) });
          if (req.headers['x-shiyan-platform'] === 'web') {
            const row=accounts.db.prepare("SELECT * FROM account_users WHERE id=? AND status='active'").get(result.user.id);
            if (!row) throw failure('账户不可用',401);
            result.device=accounts.transaction(()=>qrFor(accounts).devices.pair(row,{platform:'web'}));
          }
          json(res, 201, result);
        }
        return true;
      }
      if (req.method === 'POST' && ['/v1/auth/device/request','/v1/auth/device/poll'].includes(pathname)) {
        const peer=req.socket?.remoteAddress||'unknown',real=req.headers['x-real-ip'];
        const ip=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&typeof real==='string'&&isIP(real)?real:peer;
        accounts.consumeLimit('device:'+pathname+':'+ip,pathname.endsWith('/request')?30:600,60000);
        const input=await body(req), devices=qrFor(accounts).devices;
        json(res,200,pathname.endsWith('/request')?devices.create(input):devices.poll(input));return true;
      }
      if (req.method === 'POST' && ['/v1/auth/qr/create', '/v1/auth/qr/poll'].includes(pathname)) {
        const peer=req.socket?.remoteAddress||'unknown',real=req.headers['x-real-ip'];
        const ip=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)&&typeof real==='string'&&isIP(real)?real:peer;
        accounts.consumeLimit('qr:' + pathname + ':' + ip, pathname.endsWith('/create') ? 30 : 600, 60000);
        const input = await body(req), qr = qrFor(accounts);
        json(res, 200, pathname.endsWith('/create') ? qr.create({platform:req.headers['x-shiyan-platform']}) : qr.poll(input)); return true;
      }
      const token = requestBearer(req), auth = token && accounts.authenticate(token);
      if (!auth) throw failure('请先登录', 401);
      if (req.method === 'GET' && pathname === '/v1/auth/device/requests') { json(res,200,qrFor(accounts).devices.inbox(auth));return true; }
      if (req.method === 'POST' && pathname === '/v1/auth/device/approve') { json(res,200,qrFor(accounts).devices.approve(auth,await body(req)));return true; }
      if (req.method === 'POST' && ['/v1/auth/qr/preview', '/v1/auth/qr/approve'].includes(pathname)) {
        accounts.consumeLimit('qr-confirm:' + auth.sessionId, 120, 60000);
        const input = await body(req), qr = qrFor(accounts);
        if (pathname.endsWith('/approve') && typeof input.approve !== 'boolean') throw failure('请确认或取消登录');
        json(res, 200, pathname.endsWith('/preview') ? qr.preview(input) : qr.approve(auth, input)); return true;
      }
      if (req.method === 'GET' && pathname === '/v1/auth/me') { json(res, 200, { ok: true, user: auth.user, expiresAt: auth.expiresAt }); return true; }
      if (req.method === 'POST' && pathname === '/v1/auth/logout') { await body(req); json(res, 200, accounts.logout(token)); return true; }
      if (req.method === 'GET' && pathname === '/v1/admin/users') { json(res, 200, accounts.listUsers(auth)); return true; }
      const user = pathname.match(/^\/v1\/admin\/users\/([0-9a-f-]{36})$/i);
      if (req.method === 'PATCH' && user) { json(res, 200, accounts.updateUser(auth, user[1], await body(req))); return true; }
      throw failure('接口不存在', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { ok: false, error: error.status ? error.message : '账户操作暂时不可用，请重试' });
      else res.end();
      return true;
    }
  };
}
export const handleAccountRequest = createAccountHandler();
