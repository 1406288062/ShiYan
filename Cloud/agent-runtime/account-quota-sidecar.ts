import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { authenticateDevice, digest } from './device-auth.ts';
import { createQuotaReader } from './account-quota.ts';
import { createAccountQuotaReader } from './claude-quota.ts';

const json = (res, status, value, headers = {}) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
};

// Keep account reads independent of the process that owns active Codex jobs.
// Authenticate the original signed URL before interpreting its route.
export function createQuotaSidecar({ authenticate = authenticateDevice, readQuota = createAccountQuotaReader({ codex: createQuotaReader() }) } = {}) {
  return http.createServer(async (req, res) => {
    req.resume();
    try {
      const auth = authenticate(req);
      if (!auth) return json(res, 401, { ok: false, error: '服务连接未获授权' });
      if (auth.role !== 'admin' || auth.serverAccess !== true) return json(res, 403, { ok: false, error: '需要服务器访问权限' });
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (!['/shiyan/v1/account/quota', '/v1/account/quota'].includes(pathname)) return json(res, 404, { ok: false, error: '接口不存在' });
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: '额度查询仅支持 GET' }, { Allow: 'GET' });
      if (req.headers['x-shiyan-body-sha'] !== digest(Buffer.alloc(0)) ||
          (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') || req.headers['transfer-encoding']) {
        return json(res, 400, { ok: false, error: '额度查询不接受请求内容' });
      }
      try {
        return json(res, 200, { ok: true, quota: await readQuota() });
      } catch {
        return json(res, 200, { ok: true, quota: { available: false, windows: [], resetCredits: null, error: '暂时无法获取账户额度与重置卡信息' } });
      }
    } catch {
      return json(res, 500, { ok: false, error: '账户查询暂时不可用' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createQuotaSidecar().listen(Number(process.env.SHIYAN_QUOTA_PORT || 4329), '127.0.0.1', () => console.log('Shiyan authenticated account quota ready'));
}
