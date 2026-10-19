export const isShiYanEmbedded = () => import.meta.env.VITE_SHIYAN_EMBEDDED === '1'

const API_BASE = String(import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

function makeUrl(path) {
  if (isShiYanEmbedded() && path.startsWith('/api/')) {
    return path.startsWith('/api/auth/') ? path : '/api/knowledge/' + path.slice(5)
  }
  if (/^https?:\/\//.test(path)) return path
  return `${API_BASE}${path}`
}

export async function apiFetch(path, { token, ...options } = {}) {
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
  return body
}
