import test from 'node:test'
import assert from 'node:assert/strict'
function storage() {
 const s = {}
 Object.defineProperties(s, {
  getItem: {value: key => Object.hasOwn(s,key) ? s[key] : null},
  setItem: {value: (key,value) => { s[key] = String(value) }},
  removeItem: {value: key => { delete s[key] }}
 })
 return s
}
let serial = 0
async function fixture() {
 globalThis.localStorage = storage()
 return import('../src/composables/knowledgeCache.js?test=' + serial++)
}
test('cache persists reading data and isolates accounts without persisting credentials', async () => {
 const c = await fixture(); c.setKnowledgeCacheOwner('alice')
 c.writeKnowledgeCache('/api/spaces', [{id:'s'}], c.cacheContext())
 assert.deepEqual(c.readKnowledgeCache('/api/spaces'), [{id:'s'}])
 c.setKnowledgeCacheOwner('bob'); assert.equal(c.readKnowledgeCache('/api/spaces'), null)
 c.setKnowledgeCacheOwner('alice'); assert.deepEqual(c.readKnowledgeCache('/api/spaces'), [{id:'s'}])
 c.clearKnowledgeCache(); assert.equal(Object.keys(localStorage).length, 0)
})
test('invalidation prevents in-flight requests from restoring deleted reading copies', async () => {
 const c = await fixture(); c.setKnowledgeCacheOwner('alice'); const before = c.cacheContext()
 c.clearKnowledgeCache(); c.writeKnowledgeCache('/api/spaces', ['stale'], before)
 assert.equal(c.readKnowledgeCache('/api/spaces'), null)
})
test('expired and corrupt entries are ignored and AI answers/tasks are excluded', async () => {
 const c = await fixture(); c.setKnowledgeCacheOwner('alice')
 c.writeKnowledgeCache('/api/spaces', [], c.cacheContext()); const key=Object.keys(localStorage)[0]
 localStorage.setItem(key, JSON.stringify({version:1,at:Date.now()-86400001,value:['old']}))
 assert.equal(c.readKnowledgeCache('/api/spaces'), null)
 localStorage.setItem(key,'broken'); assert.equal(c.readKnowledgeCache('/api/spaces'),null)
 for (const path of ['/api/query','/api/chat/history','/api/tasks/t','https://other/api/spaces']) assert.equal(c.cacheable(path), false)
})
test('capacity and entry count remain bounded, and disabled storage never breaks reading', async () => {
 const c = await fixture(); c.setKnowledgeCacheOwner('alice')
 for(let i=0;i<80;i++) c.writeKnowledgeCache('/api/documents/'+i, 'x'.repeat(40000), c.cacheContext())
 assert.ok(Object.keys(localStorage).length <= 60)
 assert.ok(Object.keys(localStorage).reduce((n,k)=>n+localStorage.getItem(k).length*2,0) <= 4*1024*1024)
 globalThis.localStorage = {getItem(){throw Error('disabled')},setItem(){throw Error('disabled')}}
 assert.equal(c.readKnowledgeCache('/api/spaces'),null)
 assert.doesNotThrow(()=>c.writeKnowledgeCache('/api/spaces',[],c.cacheContext()))
})
