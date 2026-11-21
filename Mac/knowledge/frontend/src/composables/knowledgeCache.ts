// Bounded, account-scoped reading copies. Credentials and AI answers are never stored.
const PREFIX = 'shiyan.knowledge.read.v1:'
const MAX_BYTES = 4 * 1024 * 1024
const MAX_ITEM = 1024 * 1024
const MAX_AGE = 24 * 60 * 60 * 1000
let owner = '', epoch = 0
export function clearKnowledgeCache() {
  epoch++
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key) } catch {}
}
export function setKnowledgeCacheOwner(id: any) {
  const next = String(id || '')
  if (owner !== next) { epoch++; owner = next }
}
export const cacheContext = () => ({ owner, epoch })
export const contextCurrent = (ctx: any) => ctx.owner === owner && ctx.epoch === epoch
export const cacheable = (path: any) => /^\/api\/(spaces(?:\/[^/]+\/knowledge-bases)?|knowledge-bases\/[^/]+\/(documents|knowledge)|documents\/[^/]+)$/.test(path)
function keyFor(path: any, ctx: any) { return PREFIX + encodeURIComponent(ctx.owner) + ':' + encodeURIComponent(path) }
export function readKnowledgeCache(path: any, ctx = cacheContext()) {
  if (!ctx.owner || !contextCurrent(ctx) || !cacheable(path)) return null
  try {
    const key = keyFor(path, ctx), raw = localStorage.getItem(key)
    if (!raw) return null
    const item = JSON.parse(raw)
    if (item.version !== 1 || Date.now() - item.at > MAX_AGE || item.at > Date.now()) { localStorage.removeItem(key); return null }
    return item.value
  } catch { return null }
}
export function writeKnowledgeCache(path: any, value: any, ctx: any) {
  if (!ctx.owner || !contextCurrent(ctx) || !cacheable(path)) return
  try {
    const raw = JSON.stringify({version: 1, at: Date.now(), value})
    if (raw.length * 2 > MAX_ITEM) return
    const entries = Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).map(key => {
      const content = localStorage.getItem(key) || ''
      let at = 0; try { at = JSON.parse(content).at || 0 } catch {}
      return {key, bytes: content.length * 2, at}
    }).sort((a,b) => a.at-b.at)
    let total = entries.reduce((n,e) => n+e.bytes, 0)
    while (entries.length && (total + raw.length * 2 > MAX_BYTES || entries.length >= 60)) {
      const e = entries.shift(); if (!e) break; localStorage.removeItem(e.key); total -= e.bytes
    }
    localStorage.setItem(keyFor(path, ctx), raw)
  } catch { /* A full/disabled cache must never break reading. */ }
}
