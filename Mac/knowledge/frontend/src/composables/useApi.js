import {cacheContext, contextCurrent, cacheable, readKnowledgeCache, writeKnowledgeCache, clearKnowledgeCache} from './knowledgeCache'
export const isShiYanEmbedded = () => import.meta.env.VITE_SHIYAN_EMBEDDED === '1'

const API_BASE = String(import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

function makeUrl(path) {
  if (isShiYanEmbedded() && path.startsWith('/api/')) {
    return path.startsWith('/api/auth/') ? path : '/api/knowledge/' + path.slice(5)
  }
  if (/^https?:\/\//.test(path)) return path
  return `${API_BASE}${path}`
}

export async function apiFetch(path, { token, onCached, ...options } = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const mutation = method !== 'GET' && /^\/api\/(spaces|knowledge-bases|documents)(\/|$)/.test(path)
  if (mutation) clearKnowledgeCache()
  const ctx = cacheContext(), cached = method === 'GET' ? readKnowledgeCache(path, ctx) : null
  if (cached !== null) onCached?.(cached)
  try {
  const headers = new Headers(options.headers || {})
  if (isShiYanEmbedded()) {
    headers.delete('Authorization')
    headers.set('X-Shiyan-Local', '1')
  } else if (token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  // The host transport rejects responses from a session that changed mid-request.
  const host = isShiYanEmbedded() && window.parent !== window ? window.parent : window
  const request = host.fetch.bind(host)
  const response = await request(makeUrl(path), { ...options, ...(isShiYanEmbedded() ? { credentials: 'same-origin', cache: 'no-store' } : {}), headers })
  const contentType = response.headers.get('content-type') || ''
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    const message = typeof body === 'object' && body?.detail
      ? body.detail
      : `请求失败（${response.status}）`
    const error = new Error(message)
    error.status = response.status
    error.body = body
    throw error
  }
  if (!contextCurrent(ctx)) throw new Error('账户或资料已变化，请重新加载')
  if (method === 'GET') writeKnowledgeCache(path, body, ctx)
  else if (mutation) clearKnowledgeCache()
  return body
  } catch (error) {
    if ([401,403,404].includes(error.status)) { clearKnowledgeCache(); throw error }
    // Keep the last readable copy on transient failure, never an auth failure.
    if (cached !== null && contextCurrent(ctx) && (!error.status || error.status >= 500)) return cached
    throw error
  }
}

// A native window gets a new loopback port after restart. Warm the new origin
// from the account-private backend instead of tying persistence to that port.
export async function primeKnowledgeCache() {
  if (!isShiYanEmbedded()) return
  const ctx = cacheContext(), host = window.parent !== window ? window.parent : window
  try {
    const response = await host.fetch('/api/knowledge-cache', {credentials:'same-origin', cache:'no-store'})
    if (!response.ok || !contextCurrent(ctx)) return
    const values = await response.json()
    for (const [path, value] of Object.entries(values)) writeKnowledgeCache(path, value, ctx)
  } catch { /* First run or an older host still reads normally. */ }
}
