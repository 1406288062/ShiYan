// 模型提供方（SDK）统一注册表。
// 每个 SDK 接入写成一个 provider 模块，在 providers/index.mjs 注册；server.mjs 只认这里的统一接口。
// 合同详见 providers/README.md。
const providers = new Map();
const cache = new Map(); // id -> {models, checkedAt, error}
const inflight = new Map();
const TTL = Number(process.env.SHIYAN_MODEL_CATALOG_TTL_MS || 300000);
const LIST_TIMEOUT = Number(process.env.SHIYAN_MODEL_LIST_TIMEOUT_MS || 30000);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function registerProvider(provider) {
  if (!provider || typeof provider.id !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(provider.id)) throw new Error('provider id 无效');
  for (const key of ['listModels', 'runTurn', 'runIsolatedJob']) if (typeof provider[key] !== 'function') throw new Error(`provider ${provider.id} 缺少 ${key}`);
  if (provider.infer !== undefined && typeof provider.infer !== 'function') throw new Error(`provider ${provider.id} 的 infer 必须是函数`);
  if (providers.has(provider.id)) throw new Error(`provider ${provider.id} 重复注册`);
  providers.set(provider.id, provider);
  return provider;
}
export function unregisterProvider(id) { providers.delete(id); cache.delete(id); inflight.delete(id); }
export function listProviders() { return [...providers.values()]; }
export function getProvider(id) {
  const provider = providers.get(id);
  if (!provider) throw fail('所选模型的服务暂不可用', 503);
  return provider;
}

const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms); timer.unref?.();
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

export function normalizeModel(provider, model) {
  if (!model || typeof model.id !== 'string' || !model.id.trim()) return null;
  const levels = (Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : []).filter(x => typeof x === 'string' && x);
  if (!levels.length || !levels.includes(model.defaultReasoning)) return null;
  return {
    id: model.id, displayName: typeof model.displayName === 'string' && model.displayName ? model.displayName : model.id,
    reasoningEfforts: levels, defaultReasoning: model.defaultReasoning,
    provider: provider.id, providerLabel: provider.label || provider.id,
    features: { ...(provider.features || {}), ...(model.features || {}) },
  };
}

async function loadProvider(provider, force) {
  const entry = cache.get(provider.id);
  if (!force && entry && Date.now() - entry.checkedAt < TTL) return entry;
  if (inflight.has(provider.id)) return inflight.get(provider.id);
  const task = (async () => {
    let next;
    try {
      const available = typeof provider.available === 'function' ? await provider.available() : true;
      if (!available) next = { models: [], checkedAt: Date.now(), error: null, disabled: true };
      else {
        const raw = await withTimeout(Promise.resolve(provider.listModels()), LIST_TIMEOUT, `${provider.label || provider.id} 模型能力读取超时`);
        const models = (Array.isArray(raw) ? raw : []).map(m => normalizeModel(provider, m)).filter(Boolean);
        if (!models.length) throw new Error(`${provider.label || provider.id} 未返回可用模型`);
        next = { models, checkedAt: Date.now(), error: null };
      }
    } catch (error) {
      // 失败时保留上次成功的列表一段时间，避免单个 SDK 抖动让模型从选择器里消失。
      const keep = entry?.models?.length && Date.now() - entry.checkedAt < TTL * 6 ? entry.models : [];
      next = { models: keep, checkedAt: Date.now(), error };
      if (!keep.length) console.warn('[ModelCatalog]', provider.id, String(error?.message || error).slice(0, 300));
    }
    cache.set(provider.id, next);
    return next;
  })();
  inflight.set(provider.id, task);
  try { return await task; } finally { inflight.delete(provider.id); }
}

// 合并所有 provider 的模型；任何一个 provider 出错不影响其它 provider。
export async function refreshCatalog({ force = false } = {}) {
  const entries = await Promise.all(listProviders().map(p => loadProvider(p, force)));
  const catalog = verifiedCatalog();
  if (!catalog.length) {
    const error = entries.find(e => e.error)?.error;
    throw fail(error ? '模型能力读取失败：' + String(error.message || error).slice(0, 200) : '未返回可用模型', 503);
  }
  return catalog;
}

export function verifiedCatalog() {
  const seen = new Set(), out = [];
  for (const provider of listProviders()) {
    for (const model of cache.get(provider.id)?.models || []) {
      if (seen.has(model.id)) continue; // 先注册的 provider 优先，保证 id 全局唯一
      seen.add(model.id); out.push(model);
    }
  }
  return out;
}

export function modelEntry(modelId) { return verifiedCatalog().find(m => m.id === modelId) || null; }
export function providerForModel(modelId) {
  const model = modelEntry(modelId);
  if (!model) throw fail('当前服务不支持所选模型', 400);
  return getProvider(model.provider);
}
export function providerStatus() {
  return listProviders().map(p => {
    const entry = cache.get(p.id);
    return { id: p.id, label: p.label || p.id, sdk: p.sdk || null, available: Boolean(entry?.models?.length), disabled: Boolean(entry?.disabled), models: entry?.models?.length || 0 };
  });
}
