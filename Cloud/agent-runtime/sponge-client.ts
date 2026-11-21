// Trusted owner-bound connector transport. OAuth credentials stay in the broker;
// this client never reads workspace MCP configuration or forwards caller headers.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.SHIYAN_ROOT || path.dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const reserved = value => typeof value === 'string' && ['sponge', '海绵宝宝'].includes(value.trim().toLowerCase());
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (message, status = 502, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const abortReason = signal => signal?.reason instanceof Error ? signal.reason : failure('操作已停止', 499);
const validOwner = owner => typeof owner === 'string' && owner.length > 0 && owner.length <= 512 && !/[\x00-\x1f\x7f]/.test(owner);

export function createSpongeClient({ socketPath = process.env.SHIYAN_SPONGE_SOCKET || path.join(ROOT, 'data', 'sponge', 'connector.sock'), timeoutMs = 60000 } = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0')) throw failure('海绵宝宝连接配置无效', 500);
  async function request(route, input, { signal }: {signal?: AbortSignal} = {}) {
    if (signal?.aborted) throw abortReason(signal);
    const uncertain = route === '/rpc' && input.method === 'tools/call';
    let body;
    try { body = Buffer.from(JSON.stringify(input)); } catch { throw failure('海绵宝宝请求格式无效', 400); }
    if (body.length > MAX_REQUEST_BYTES) throw failure('海绵宝宝请求过大', 413);
    return new Promise<any>((resolve, reject) => {
      let req, timer, response, done = false;
      const finish = (error: any, value?: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { response?.destroy(); req?.destroy(); reject(error); } else resolve(value);
      };
      const abort = () => finish(abortReason(signal));
      const transportError = () => finish(failure(uncertain ? '海绵宝宝连接中断，执行结果可能不确定；请先查询执行记录，勿重复提交。' : '海绵宝宝服务暂不可用，请稍后重试', 503, { uncertain }));
      try {
        req = http.request({ socketPath, path: route, method: 'POST', agent: false,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': body.length } }, res => {
          response = res;
          let size = 0;
          const chunks: Buffer[] = [];
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return finish(failure('海绵宝宝返回内容过大', 502, { uncertain }));
          res.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) return finish(failure('海绵宝宝返回内容过大', 502, { uncertain }));
            chunks.push(chunk);
          });
          res.once('aborted', transportError);
          res.once('error', transportError);
          res.once('end', () => {
            if (done) return;
            let value;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { return finish(failure('海绵宝宝服务返回无效结果', 502, { uncertain })); }
            if (!object(value)) return finish(failure('海绵宝宝服务返回无效结果', 502, { uncertain }));
            const statusCode = res.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300 || value.ok !== true) {
              const status = statusCode >= 400 && statusCode <= 599 ? statusCode : 502;
              const message = typeof value.error === 'string' ? value.error.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500) : '海绵宝宝调用失败';
              return finish(failure(message, status));
            }
            finish(null, route === '/status' ? value : value.result);
          });
        });
        req.once('error', transportError);
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(failure(uncertain ? '海绵宝宝响应超时，执行结果可能不确定；请先查询执行记录，勿重复提交。' : '海绵宝宝服务响应超时', 504, { uncertain })), timeoutMs);
        timer.unref?.();
        if (signal?.aborted) abort();
        if (!done) req.end(body);
      } catch { transportError(); }
    });
  }
  const ownerInput = owner => { if (!validOwner(owner)) throw failure('用户身份无效', 401); return owner; };
  return {
    status(owner, options: { signal?: AbortSignal } = {}) { return request('/status', { owner: ownerInput(owner) }, options); },
    start(auth, options: { signal?: AbortSignal } = {}) {
      if (!object(auth) || auth.accountSession !== true || !validOwner(auth.owner) ||
          typeof auth.userId !== 'string' || !auth.userId || typeof auth.sessionId !== 'string' || !auth.sessionId) throw failure('请先登录拾燕账号', 401);
      return request('/start', { auth: { owner: auth.owner, userId: auth.userId, sessionId: auth.sessionId, accountSession: true } }, options);
    },
    disconnect(owner, options: { signal?: AbortSignal } = {}) { return request('/disconnect', { owner: ownerInput(owner) }, options); },
    rpc(owner, method, params = {}, options: { signal?: AbortSignal } = {}) {
      if (!['tools/list', 'tools/call'].includes(method) || !object(params)) throw failure('海绵宝宝工具请求无效', 400);
      return request('/rpc', { owner: ownerInput(owner), method, params }, options);
    },
  };
}

// A reserved managed server is dispatched outside the member namespace, using
// only its server-derived owner. User-configured MCP servers retain their path.
export function createSpongeMcpAdapter({ sandboxOperation, client = createSpongeClient() }: {sandboxOperation?: (owner: any, input: any, options?: any) => Promise<any>; client?: ReturnType<typeof createSpongeClient>} = {}) {
  if (typeof sandboxOperation !== 'function') throw new TypeError('sandboxOperation is required');
  return async function memberMcpOperation(owner, input, options: {signal?: AbortSignal; [key: string]: any} = {}) {
    if (input.operation === 'list_servers') {
      const [configured, connection] = await Promise.all([
        sandboxOperation(owner, input, options),
        Promise.resolve().then(() => client.status(owner, { signal: options.signal })).catch(error => {
          if (options.signal?.aborted) throw abortReason(options.signal);
          return null; // Connector unavailability must not disable other MCPs.
        }),
      ]);
      const servers = (configured.servers || []).filter(server => !reserved(server.name));
      if (connection?.connected === true) servers.push({ name: 'sponge', transport: 'managed' });
      return { ...configured, servers };
    }
    if (!reserved(input.server)) return sandboxOperation(owner, input, options);
    if (input.operation === 'list_tools') return { result: await client.rpc(owner, 'tools/list', {}, { signal: options.signal }) };
    if (input.operation === 'call_tool') {
      if (typeof input.name !== 'string' || !input.name || !object(input.arguments || {})) throw failure('海绵宝宝工具请求无效', 400);
      return { result: await client.rpc(owner, 'tools/call', { name: input.name, arguments: input.arguments || {} }, { signal: options.signal }) };
    }
    throw failure('海绵宝宝工具请求无效', 400);
  };
}
