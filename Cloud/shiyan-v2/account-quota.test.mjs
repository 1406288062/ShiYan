import assert from 'node:assert/strict';
import { quotaWindows, quotaResetCredits, createQuotaReader } from './account-quota.mjs';

assert.deepEqual(quotaWindows({rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:100},secondary:{usedPercent:105,windowDurationMins:10080,resetsAt:200}}}).map(x=>[x.period,x.remainingPercent]),[['5 小时',75],['每周',0]]);
assert.equal(quotaWindows({rateLimits:{primary:{usedPercent:null}}}).length,0);
assert.equal(quotaWindows(null).length,0);
assert.deepEqual(quotaWindows({rateLimitsByLimitId:{codex:{primary:null,secondary:{usedPercent:61,windowDurationMins:10080,resetsAt:1792650370}}}}),[{bucket:'Codex',period:'每周',remainingPercent:39,resetsAt:1792650370}]);

for (const input of [undefined, null, {}, {rateLimitResetCredits:null}, {rateLimitResetCredits:{availableCount:null}}, {rateLimitResetCredits:{availableCount:-1}}, {rateLimitResetCredits:{availableCount:1.5}}, {rateLimitResetCredits:{availableCount:'3'}}]) {
  assert.equal(quotaResetCredits(input),null,'Missing or invalid count must stay unknown');
}
assert.deepEqual(quotaResetCredits({rateLimitResetCredits:{availableCount:0,credits:[]}}),{availableCount:0,credits:[]});
assert.deepEqual(quotaResetCredits({rateLimitResetCredits:{availableCount:3,credits:null}}),{availableCount:3,credits:null});
assert.deepEqual(quotaResetCredits({rateLimitResetCredits:{availableCount:3}}),{availableCount:3,credits:null});
const detail={id:'reset-1',resetType:'weekly',status:'available',grantedAt:1792000000,expiresAt:1794000000,title:'周额度重置卡',description:'恢复周额度'};
assert.deepEqual(quotaResetCredits({rateLimitResetCredits:{availableCount:3,credits:[detail],privateField:'not-forwarded'},accountId:'not-forwarded'}),{availableCount:3,credits:[detail]},'Incomplete detail lists must not override the authoritative count or forward unrelated fields');
const usedDetail={...detail,id:'used-1',status:'used'};
assert.deepEqual(quotaResetCredits({rateLimitResetCredits:{availableCount:0,credits:[usedDetail]}}),{availableCount:0,credits:[usedDetail]},'Historical entries must not be counted as available or hidden');
assert.deepEqual(quotaResetCredits({rateLimitResetCredits:{availableCount:2,credits:[null,[],{id:'partial',title:42,expiresAt:Infinity}]}}),{availableCount:2,credits:[{id:'partial',resetType:null,status:null,grantedAt:null,expiresAt:null,title:null,description:null}]});

let reads=0;
const read=createQuotaReader(async()=>{reads++;return {rateLimits:{primary:{usedPercent:4,windowDurationMins:10080}},rateLimitResetCredits:{availableCount:3,credits:[detail]}}});
const results=await Promise.all([read(),read(),read()]);
await read();
assert.equal(reads,1,'Concurrent quota and reset-card reads must share one cached upstream request');
assert.strictEqual(results[0],results[1]);
assert.equal(results[0].windows[0].remainingPercent,96);
assert.deepEqual(results[0].resetCredits,{availableCount:3,credits:[detail]});
assert.equal(typeof results[0].fetchedAt,'number');

for (const resetCredits of [{availableCount:0,credits:[]},{availableCount:3,credits:null}]) {
  const cardsOnly=await createQuotaReader(async()=>({rateLimits:{primary:null},rateLimitResetCredits:resetCredits}))();
  assert.equal(cardsOnly.available,true,'Valid reset-card data must remain available when windows are absent');
  assert.deepEqual(cardsOnly.windows,[]);
  assert.deepEqual(cardsOnly.resetCredits,resetCredits);
}
const windowsOnly=await createQuotaReader(async()=>({rateLimits:{primary:{usedPercent:5,windowDurationMins:300}}}))();
assert.equal(windowsOnly.resetCredits,null,'Unreturned reset cards must not become a known zero');
await assert.rejects(createQuotaReader(async()=>({rateLimits:{primary:null}}))());
await assert.rejects(createQuotaReader(async()=>null)());
let retries=0;
const retry=createQuotaReader(async()=>{if(++retries===1)throw new Error('temporary');return {rateLimitResetCredits:{availableCount:0,credits:[]}};});
await assert.rejects(retry());
assert.equal((await retry()).resetCredits.availableCount,0);
assert.equal(retries,2,'Failed requests must not poison the cache');
console.log('PASS quota windows, weekly remaining, reset-card presence/count/details, whitelist, shared requests, caching and retry');
