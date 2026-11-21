// Account-authenticated workspace operations. Every file/process operation is
// delegated to the member namespace; host paths and host process IDs never enter responses.
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const failure = (message: any, status = 400) => Object.assign(new Error(message), { status });
const hash = (value: any) => createHash('sha256').update(value).digest('hex');
const validID = (value: any) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
const name = (value: any) => {
  if (typeof value !== 'string' || !value.trim() || ['.', '..'].includes(value.trim()) || value.length > 100 || /[/\\\x00-\x1f]/.test(value)) throw failure('项目名称无效');
  return value.trim();
};
export function virtualPath(value = '/workspace') {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\\]/.test(value)) throw failure('工作区路径无效');
  const result = path.posix.resolve('/workspace', value);
  if (result !== '/workspace' && !result.startsWith('/workspace/')) throw failure('不能访问授权工作区之外的文件', 403);
  return result;
}
const writeJSON = (res: any, status: any, value: any) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
  res.end(bytes);
};
const defaultOperations = async () => import('./member-sandbox.ts');

interface WorkspaceHandlerOptions { operations?: any; revalidate?: (auth: any) => boolean; getAsset?: (owner: any, id: any) => any; }
export function createWorkspaceHandler({ operations = defaultOperations, revalidate = () => true, getAsset }: WorkspaceHandlerOptions = {}) {
  const terminals = new Map(), locks = new Map(), previews = new Map();
  const operate = async (owner: any, input: any) => (await operations()).workspaceOperation(owner, { ...(input.operation === 'mkdir' ? { recursive: true } : {}), ...input });
  const metadataPath = '/workspace/.shiyan/workspace.json';
  async function metadata(owner: any) {
    try {
      const result = await operate(owner, { operation: 'read', path: metadataPath });
      const text = typeof result.text === 'string' ? result.text : Buffer.from(result.data || '', 'base64').toString();
      const value = JSON.parse(text);
      if (!Array.isArray(value.projects) || !value.preferences || typeof value.preferences !== 'object') throw Error();
      value.projects = value.projects.filter((p: any) => validID(p.id) && typeof p.name === 'string').map((p: any) => ({ ...p, path: virtualPath(p.path) }));
      return value;
    } catch (error) {
      if ((error as any).status && (error as any).status !== 404) throw error;
      return { projects: [], preferences: {} };
    }
  }
  async function mutate(owner: any, action: any) {
    const previous = locks.get(owner) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const state = await metadata(owner), result = await action(state);
      await operate(owner, { operation: 'mkdir', path: '/workspace/.shiyan' });
      await operate(owner, { operation: 'write', path: metadataPath, content: JSON.stringify(state), data: Buffer.from(JSON.stringify(state)).toString('base64') });
      return result;
    });
    locks.set(owner, pending);
    try { return await pending; } finally { if (locks.get(owner) === pending) locks.delete(owner); }
  }
  function project(state: any, id: any) {
    const item = state.projects.find((p: any) => p.id === id);
    if (!item) throw failure('项目不存在', 404);
    return item;
  }
  function reference(state: any, input: any) {
    if (input.fileId) {
      if (typeof input.fileId !== 'string' || input.fileId.length > 6000) throw failure('文件引用无效');
      let value;
      try { value = JSON.parse(Buffer.from(input.fileId, 'base64url').toString()); } catch { throw failure('文件引用无效'); }
      return reference(state, { ...value, fileId: undefined });
    }
    if (!input.projectId) return virtualPath(input.path);
    const base = project(state, input.projectId).path;
    const target = path.posix.resolve(base, input.path || '.');
    if (target !== base && !target.startsWith(base + '/')) throw failure('不能访问项目之外的文件', 403);
    return virtualPath(target);
  }
  async function readFile(owner: any, state: any, input: any) {
    const target = reference(state, input), result = await operate(owner, { operation: 'read', path: target });
    const bytes = typeof result.data === 'string' ? Buffer.from(result.data, 'base64') : Buffer.from(result.text ?? result.content ?? '');
    const file = { name: path.posix.basename(target), path: target, size: result.size ?? bytes.length, projectId: input.projectId || null,
      fileId: Buffer.from(JSON.stringify({ path: target, projectId: input.projectId || null })).toString('base64url'), contentHash: hash(bytes), sensitive: false };
    const ext = path.posix.extname(target).toLowerCase(), mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
    if (mime) return { ...file, kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    if (ext === '.pdf' && bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return { ...file, kind: 'pdf', mimeType: 'application/pdf' };
    const text = bytes.toString('utf8');
    if (bytes.length > 2 * 1024 * 1024) return { ...file, kind: 'large', message: '文件超过内嵌预览上限' };
    if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) return { ...file, kind: 'binary', message: '此文件暂不支持文本预览' };
    return { ...file, kind: 'text', text, encoding: 'UTF-8', language: ext.slice(1) || 'text' };
  }
  const publicTerminal = (item: any) => ({ id: item.id, cwd: item.cwd, projectId: item.projectId, running: !item.closed });
  function terminal(owner: any, id: any) {
    const item = terminals.get(id);
    if (!item || item.owner !== owner) throw failure('终端不存在或已关闭', 404);
    return item;
  }
  function append(item: any, event: any) {
    const record = { seq: ++item.sequence, ...event };
    item.events.push(record);
    if (item.events.length > 512) item.events.shift();
    for (const res of item.listeners) if (!res.destroyed) res.write(`id: ${record.seq}\nevent: terminal\ndata: ${JSON.stringify(record)}\n\n`);
  }
  const close = (item: any) => { clearInterval(item.authorization);if (!item.closed) { item.closed = true; item.child.kill('SIGTERM'); } };
  return async function workspaceRequest(req: any, res: any, auth: any, readBody: any) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/^\/shiyan/, '').replace(/^\/v1\/workspace/, '');
    if (!/^\/(?:shiyan\/)?v1\/workspace(?:\/|$)/.test(url.pathname)) return false;
    if (!auth?.owner) throw failure('请先登录', 401);
    const owner = auth.owner;
    const respond = (value: any) => { writeJSON(res, 200, { ok: true, ...value }); return true; };
    const input = async () => {
      const value = await readBody(req, 12 * 1024 * 1024);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('工作区请求格式无效');
      return value;
    };
    if (route === '/bootstrap' && req.method === 'POST') {
      const state = await metadata(owner);
      return respond({ ...state, defaultDirectory: '/workspace', terminalTransport: 'SSE', executionMode: 'isolated' });
    }
    if (route === '/preferences' && req.method === 'PATCH') {
      const data = await input();
      if (JSON.stringify(data).length > 100000) throw failure('工作区配置过大');
      return respond(await mutate(owner, (state: any) => { state.preferences = { ...state.preferences, ...data }; return { preferences: state.preferences }; }));
    }
    if (route === '/projects' && req.method === 'GET') return respond({ projects: (await metadata(owner)).projects });
    if (route === '/projects' && req.method === 'POST') {
      const data = await input();
      return respond(await mutate(owner, async (state: any) => {
        const id = data.id || randomUUID();
        if (!validID(id) || state.projects.some((p: any) => p.id === id)) throw failure('项目标识无效或已存在');
        const projectName = name(data.name);
        const projectPath = data.path ? data.create === true ? path.posix.join(virtualPath(data.path), projectName) : virtualPath(data.path) : '/workspace/projects/' + id;
        const item = { id, name: projectName, path: virtualPath(projectPath), createdAt: new Date().toISOString() };
        await operate(owner, { operation: 'mkdir', path: item.path }); state.projects.push(item);
        return { project: item, projects: state.projects };
      }));
    }
    const projectRoute = route.match(/^\/projects\/([A-Za-z0-9_-]{8,100})(?:\/(select|bind))?$/);
    if (projectRoute && ['PATCH', 'POST', 'DELETE'].includes(req.method)) {
      const data = req.method === 'DELETE' ? {} : await input();
      return respond(await mutate(owner, async (state: any) => {
        const item = project(state, projectRoute[1]);
        if (req.method === 'DELETE') { state.projects = state.projects.filter((p: any) => p.id !== item.id); return { projects: state.projects }; }
        if (projectRoute[2] === 'select') state.preferences.selectedProjectId = item.id;
        else if (projectRoute[2] === 'bind') { item.path = virtualPath(data.path); await operate(owner, { operation: 'mkdir', path: item.path }); }
        else { if (data.name !== undefined) item.name = name(data.name); if (data.isPinned !== undefined) item.isPinned = data.isPinned === true; }
        return { project: item, projects: state.projects, preferences: state.preferences };
      }));
    }
    if (route === '/directory' && req.method === 'GET') {
      const state = await metadata(owner), projectId = url.searchParams.get('projectId'), relative = url.searchParams.get('path') || '';
      const target = reference(state, { projectId, path: relative });
      const result = await operate(owner, { operation: 'list', path: target });
      const base = projectId ? project(state, projectId).path : '/workspace';
      return respond({ path: path.posix.relative(base, target) || '.', truncated: Boolean(result.truncated), entries: (result.entries || []).filter((e: any) => e.name !== '.shiyan').slice(0, 600).map((e: any) => {
        const entryPath = virtualPath(path.posix.join(target, e.name));
        return { name: e.name, path: path.posix.relative(base, entryPath), directory: e.directory === true || e.type === 'directory', blocked: e.blocked === true, symlink: e.symlink === true };
      }) });
    }
    if (['/files/read', '/files/open'].includes(route) && req.method === 'POST') return respond({ file: await readFile(owner, await metadata(owner), await input()) });
    if (route === '/files/asset' && req.method === 'POST') {
      const data = await input();
      if (!validID(data.assetId) || !getAsset) throw failure('附件不存在', 404);
      const asset = await getAsset(owner, data.assetId); if (!asset) throw failure('附件不存在', 404);
      if (asset.bytes.length > 16 * 1024 * 1024) throw failure('附件超过工作区预览大小上限', 413);
      const target = '/workspace/attachments/' + data.assetId + '/' + path.posix.basename(asset.filename || 'attachment');
      await operate(owner, { operation: 'mkdir', path: path.posix.dirname(target) });
      await operate(owner, { operation: 'write', path: target, data: asset.bytes.toString('base64') });
      return respond({ file: await readFile(owner, await metadata(owner), { path: target }) });
    }
    if (route === '/files/pdf' && req.method === 'POST') {
      const data = await input(), state = await metadata(owner), target = reference(state, data);
      const file = await readFile(owner, state, data); if (file.kind !== 'pdf') throw failure('请选择有效的 PDF 文件');
      const ticket = randomUUID();
      for (const [key, value] of previews) if (value.expires < Date.now()) previews.delete(key);
      previews.set(ticket, { owner, path: target, expires: Date.now() + 5 * 60000 });
      return respond({ previewUrl: '/api/workspace/files/pdf/' + ticket });
    }
    const preview = route.match(/^\/files\/pdf\/([a-f0-9-]{36})$/);
    if (preview && req.method === 'GET') {
      const item = previews.get(preview[1]);
      if (!item || item.owner !== owner || item.expires < Date.now()) throw failure('PDF 预览已失效，请重新打开文件', 404);
      const result = await operate(owner, { operation: 'read', path: item.path }), bytes = Buffer.from(result.data, 'base64');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); return true;
    }
    if (['/files/save-text', '/files/write'].includes(route) && req.method === 'POST') {
      const data = await input(), state = await metadata(owner), target = reference(state, data);
      if (data.confirmed !== true || typeof data.text !== 'string') throw failure('请确认保存文件内容');
      if (Buffer.byteLength(data.text) > 2 * 1024 * 1024) throw failure('文本文件过大', 413);
      if (data.contentHash) { const before = await readFile(owner, state, data); if (before.contentHash !== data.contentHash) throw failure('文件已被其他操作修改，请刷新后重试', 409); }
      await operate(owner, { operation: 'write', path: target, content: data.text, data: Buffer.from(data.text).toString('base64') });
      return respond({ file: await readFile(owner, state, data) });
    }
    if (route === '/files/changes' && req.method === 'POST') {
      const data = await input(), file = await readFile(owner, await metadata(owner), data);
      if (file.kind !== 'text') throw failure('此文件不支持文本变更预览');
      if (typeof data.baselineText !== 'string') return respond({ changes: { name: file.name, available: false, diff: '', source: '请提供打开文件时的基准内容' } });
      if (Buffer.byteLength(data.baselineText) > 2 * 1024 * 1024) throw failure('基准内容过大', 413);
      const before = data.baselineText.split('\n'), after = (file as any).text.split('\n');
      const changed = data.baselineText !== (file as any).text;
      return respond({ changes: { name: file.name, available: true, source: '打开文件时', diff: changed ? ['--- 打开文件时', '+++ 当前文件', ...before.map((l: any) => '-' + l), ...after.map((l: any) => '+' + l)].join('\n') : '', added: changed ? after.length : 0, removed: changed ? before.length : 0 } });
    }
    if (route === '/terminals' && req.method === 'POST') {
      const data = await input(), state = await metadata(owner);
      if ([...terminals.values()].filter(t => t.owner === owner && !t.closed).length >= 8) throw failure('最多同时开启 8 个终端', 429);
      const cwd = virtualPath(data.cwd || (data.projectId ? project(state, data.projectId).path : '/workspace'));
      const child = await (await operations()).spawnSandbox(owner, { command: ['/bin/bash', '--noprofile', '--norc', '-i'], cwd, timeoutMs: 0 });
      const item: any = { id: randomUUID(), owner, cwd, projectId: data.projectId || null, child, closed: false, sequence: 0, events: [], listeners: new Set() };
      // Revocation must terminate a detached terminal as well as one with an
      // active SSE listener; no expired account keeps a background shell.
      item.authorization=setInterval(()=>{if(!revalidate(auth))close(item);},2000);item.authorization.unref();
      terminals.set(item.id, item);
      child.stdin.on('error', () => {});
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (bytes: any) => append(item, { type: 'data', data: Buffer.from(bytes).toString('base64') }));
      child.on('close', (code: any) => { clearInterval(item.authorization);item.closed = true; append(item, { type: 'exit', code }); for (const res of item.listeners) res.end();setTimeout(()=>terminals.delete(item.id),60000).unref(); });
      child.on('error', () => { clearInterval(item.authorization);item.closed = true; append(item, { type: 'exit', code: 1 });for(const res of item.listeners)res.end(); });
      const expiry = setTimeout(() => { close(item); terminals.delete(item.id); }, 8 * 3600000); expiry.unref();
      return respond({ terminal: publicTerminal(item) });
    }
    const term = route.match(/^\/terminals\/([0-9a-f-]{36})(?:\/(events|input|resize))?$/);
    if (term) {
      const item = terminal(owner, term[1]);
      if (req.method === 'DELETE' && !term[2]) { close(item); terminals.delete(item.id); return respond({}); }
      if (req.method === 'POST' && term[2] === 'input') {
        const data = await input();
        if (item.closed || typeof data.data !== 'string' || Buffer.byteLength(data.data) > 65536) throw failure('终端输入无效');
        item.child.stdin.write(data.data); return respond({});
      }
      if (req.method === 'POST' && term[2] === 'resize') {
        const data = await input();
        if (!Number.isInteger(data.cols) || data.cols < 20 || data.cols > 500 || !Number.isInteger(data.rows) || data.rows < 5 || data.rows > 200) throw failure('终端尺寸无效');
        item.child.resize?.(data.cols, data.rows); return respond({});
      }
      if (req.method === 'GET' && term[2] === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' }); res.flushHeaders?.();
        res.write(`event: terminal\ndata: ${JSON.stringify({ type: 'ready', ...publicTerminal(item) })}\n\n`);
        const after = Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0);
        for (const event of item.events) if (event.seq > after) res.write(`id: ${event.seq}\nevent: terminal\ndata: ${JSON.stringify(event)}\n\n`);
        if (item.closed) { res.end(); return true; }
        item.listeners.add(res);
        const heartbeat = setInterval(() => { if (!revalidate(auth)) { close(item); res.end(); } else res.write(': keepalive\n\n'); }, 2000); heartbeat.unref();
        res.on('close', () => { clearInterval(heartbeat); item.listeners.delete(res); }); return true;
      }
    }
    throw failure('工作区接口不存在', 404);
  };
}
