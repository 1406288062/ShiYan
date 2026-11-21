import { createSpongeClient } from './sponge-client.ts';

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const respond = (res, status, value) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
};
const visibleDevice = value => {
  const result = {};
  for (const key of ['id', 'deviceId', 'name', 'platform', 'status', 'lastSeenAt', 'online', 'ready']) {
    if (typeof value?.[key] === 'string' || typeof value?.[key] === 'boolean') result[key] = value[key];
  }
  return result;
};
const publicStatus = value => ({ connected: value?.connected === true,
  devices: Array.isArray(value?.devices) ? value.devices.map(visibleDevice) : [],
  ...(typeof value?.accountName === 'string' ? { accountName: value.accountName } : {}), needsPairing: value?.needsPairing === true });

// Mount only after request authentication. No submitted owner, token, service
// URL or socket path can select the connection affected by these routes.
export function createSpongeHTTPHandler({ client = createSpongeClient() } = {}) {
  return async function spongeRequest(req, res, auth, readBody) {
    const route = new URL(req.url || '/', 'http://localhost').pathname.replace(/^\/shiyan(?=\/)/, '');
    const base = '/v1/integrations/sponge';
    if (![base, base + '/status', base + '/start', base + '/disconnect'].includes(route)) return false;
    const abort = new AbortController();
    const stop = () => abort.abort(failure('请求已结束', 499));
    const close = () => { if (!res.writableEnded) stop(); };
    req.once('aborted', stop); res.once('close', close);
    try {
      if (typeof auth?.owner !== 'string' || !auth.owner) throw failure('请先登录', 401);
      const status = req.method === 'GET' && route === base + '/status';
      const start = req.method === 'POST' && route === base + '/start';
      const disconnect = req.method === 'DELETE' && route === base || req.method === 'POST' && route === base + '/disconnect';
      if (!status && !start && !disconnect) throw failure('连接操作无效', 405);
      if (start || req.method === 'POST') {
        const input = await readBody(req, 4096);
        if (!object(input) || Object.keys(input).length) throw failure('连接操作不接受自定义账号或服务地址');
      }
      const options = { signal: abort.signal };
      if (status) respond(res, 200, { ok: true, ...publicStatus(await client.status(auth.owner, options)) });
      else if (start) {
        const result = await client.start(auth, options);
        let target;
        try { target = new URL(result?.authorizeUrl); } catch { throw failure('海绵宝宝授权地址无效', 502); }
        if (target.protocol !== 'https:' || target.username || target.password) throw failure('海绵宝宝授权地址无效', 502);
        respond(res, 200, { ok: true, authorizeUrl: target.href });
      } else {
        await client.disconnect(auth.owner, options);
        respond(res, 200, { ok: true, connected: false, devices: [], needsPairing: false });
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) respond(res, Number.isInteger((error as any).status) && (error as any).status >= 400 && (error as any).status <= 599 ? (error as any).status : 502,
        { ok: false, error: (error as any).status ? (error as any).message : '海绵宝宝连接暂不可用，请稍后重试' });
    } finally { req.removeListener('aborted', stop); res.removeListener('close', close); }
    return true;
  };
}
