import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { authenticateDevice, digest } from './device-auth.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_BODY = 60 * 1024 * 1024;
const ID = '[A-Za-z0-9_-]{1,120}';
const routes = [
  ['GET|POST', /^spaces$/],
  ['GET|POST', new RegExp(`^spaces/${ID}/knowledge-bases$`)],
  ['GET|PATCH|DELETE', new RegExp(`^knowledge-bases/${ID}$`)],
  ['GET|POST', new RegExp(`^knowledge-bases/${ID}/documents$`)],
  ['GET', new RegExp(`^knowledge-bases/${ID}/(?:knowledge|tasks/active)$`)],
  ['GET|DELETE', new RegExp(`^documents/${ID}$`)],
  ['GET', new RegExp(`^tasks/${ID}$`)],
  ['POST', /^query$/],
  ['GET|DELETE', /^chat\/history$/],
];
export function knowledgeRoute(method, url) {
  const parsed = new URL(url, 'http://localhost');
  const prefix = '/shiyan/v1/knowledge/';
  const alternative = '/v1/knowledge/';
  const route = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length)
    : parsed.pathname.startsWith(alternative) ? parsed.pathname.slice(alternative.length) : '';
  if (parsed.search.length > 2048 || !routes.some(([methods, expression]) => methods.split('|').includes(method) && expression.test(route)))
    throw fail('知识库接口不存在', 404);
  for (const key of parsed.searchParams.keys()) if (key !== 'knowledge_base_id') throw fail('知识库参数无效');
  return '/api/' + route + parsed.search;
}
async function readBody(req) {
  const length = Number(req.headers['content-length'] || 0);
  if (!Number.isSafeInteger(length) || length < 0) throw fail('请求长度无效');
  if (length > MAX_BODY) throw fail('PDF 文件过大，请选择小于 50 MB 的文件', 413);
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY) throw fail('PDF 文件过大，请选择小于 50 MB 的文件', 413);
    parts.push(part);
  }
  const body = Buffer.concat(parts);
  if (digest(body) !== req.headers['x-shiyan-body-sha']) throw fail('请求校验失败', 401);
  return body;
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
export function createKnowledgeSidecar({ authenticate = authenticateDevice, upstream = 'http://127.0.0.1:18770', secret, timeout = 240000 } = {}) {
  if (!secret || typeof secret !== 'string' || secret.length < 32) throw new Error('Knowledge bridge secret missing');
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/' || target.search || target.username || target.password)
    throw new Error('Knowledge service must use a private loopback endpoint');
  return http.createServer(async (req, res) => {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const auth = authenticate(req);
      if (!auth || !/^[A-Za-z0-9_:-]{1,160}$/.test(auth.owner || '')) throw fail('请先登录', 401);
      const route = knowledgeRoute(req.method, req.url);
      const body = await readBody(req);
      const contentType = String(req.headers['content-type'] || 'application/json');
      const upload = req.method === 'POST' && /\/documents$/.test(route);
      if (body.length && !(upload ? /^multipart\/form-data;\s*boundary=[^\r\n]{1,200}$/i : /^application\/json(?:;|$)/i).test(contentType))
        throw fail('上传格式无效');
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await fetch(new URL(route, target), {
            method: req.method, redirect: 'error', signal: controller.signal,
            headers: { Authorization: 'Bearer ' + secret, 'X-Shiyan-Owner': auth.owner, 'Content-Type': contentType, Connection: 'close' },
            ...(body.length ? { body } : {}),
          });
          break;
        } catch (error) {
          if (req.method !== 'GET' || attempt || controller.signal.aborted) throw error;
        }
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 32 * 1024 * 1024) throw fail('知识库结果过大，请缩小查询范围', 502);
      if (!response.ok) {
        let detail;
        try { const value = JSON.parse(bytes); detail = value.error || value.detail; } catch {}
        const message = typeof detail === 'string' ? detail : response.status === 422 ? '请检查知识库名称、问题或 PDF 文件' : '知识库操作失败，请重试';
        return json(res, response.status, { ok: false, error: message, detail: message });
      }
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': bytes.length });
      res.end(bytes);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) json(res, error.status || 503, { ok: false, error: error.status ? error.message : '知识库服务暂时无法连接，请稍后重试' });
    } finally { clearTimeout(timer); res.off('close', disconnected); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.env.SHIYAN_RAG_CONFIG || '/home/ubuntu/.config/shiyan-rag/bridge.json', 'utf8'));
  createKnowledgeSidecar({ secret: config.secret, upstream: process.env.SHIYAN_KNOWLEDGE_UPSTREAM || 'http://127.0.0.1:18770' }).listen(Number(process.env.SHIYAN_KNOWLEDGE_PORT || 4332), '127.0.0.1', () => console.log('Shiyan knowledge API ready'));
}
