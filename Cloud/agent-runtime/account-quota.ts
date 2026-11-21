import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function quotaWindows(result: any = {}) {
  if (!result || typeof result !== 'object') return [];
  const buckets = (Object.values(result.rateLimitsByLimitId || {}) as any[]);
  if (!buckets.length && result.rateLimits) buckets.push(result.rateLimits);
  return buckets.flatMap(bucket => ['primary','secondary'].flatMap(key => {
    const w=bucket?.[key];
    if (!w || typeof w.usedPercent!=='number' || !Number.isFinite(w.usedPercent)) return [];
    const minutes=w.windowDurationMins;
    const period=minutes===10080?'每周':minutes>=60?`${minutes/60} 小时`:minutes>0?`${minutes} 分钟`:'当前周期';
    return [{bucket:bucket.limitName || 'Codex',period,remainingPercent:Math.max(0,Math.min(100,100-w.usedPercent)),resetsAt:typeof w.resetsAt==='number'?w.resetsAt:null}];
  }));
}

// The server can return only a count, full details, or no reset-credit data.
// Keep these distinct, and never infer the authoritative count from the list.
export function quotaResetCredits(result: any) {
  const value = result?.rateLimitResetCredits;
  if (!value || !Number.isSafeInteger(value.availableCount) || value.availableCount < 0) return null;
  const text = (value: any) => typeof value === 'string' ? value : null;
  const timestamp = (value: any) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const credits = Array.isArray(value.credits) ? value.credits
    .filter((credit: any) => credit && typeof credit === 'object' && !Array.isArray(credit))
    .map((credit: any) => ({
      id: text(credit.id),
      resetType: text(credit.resetType),
      status: text(credit.status),
      grantedAt: timestamp(credit.grantedAt),
      expiresAt: timestamp(credit.expiresAt),
      title: text(credit.title),
      description: text(credit.description)
    })) : null;
  return { availableCount: value.availableCount, credits };
}

export function readAccountLimits() {
  return new Promise<any>((resolve,reject)=>{
    const child=spawn(process.env.CODEX_BIN || '/home/ubuntu/.local/bin/codex',['app-server','--listen','stdio://'],{stdio:['pipe','pipe','pipe']});
    child.stderr.resume();const lines=readline.createInterface({input:child.stdout});let settled=false;
    const finish=(error: any,value?: any)=>{if(settled)return;settled=true;clearTimeout(timer);lines.close();child.stdin.end();child.kill();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('额度查询超时')),12000);
    child.on('error',()=>finish(new Error('额度查询服务暂不可用')));
    child.on('exit',()=>{if(!settled)finish(new Error('额度查询服务已退出'));});
    child.stdin.on('error',()=>finish(new Error('额度查询连接中断')));
    const send=(value: any)=>child.stdin.write(JSON.stringify(value)+'\n');
    lines.on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      if(message.id===1){if(message.error)return finish(new Error('额度查询初始化失败'));send({method:'initialized'});send({id:2,method:'account/rateLimits/read',params:{}});}
      if(message.id===2)message.error?finish(new Error('暂时无法获取账户额度')):finish(null,message.result);
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'shiyan_quota',version:'1.0'},capabilities:{experimentalApi:true}}});
  });
}

export function createQuotaReader(read=readAccountLimits) {
  let cached: any,pending: any;
  return async()=>{
    if(cached && Date.now()-cached.fetchedAt<60000)return cached;
    if(!pending)pending=read().then(result=>{
      const windows=quotaWindows(result);
      const resetCredits=quotaResetCredits(result);
      if(!windows.length && !resetCredits)throw new Error('账户未提供可显示的额度');
      return cached={available:true,windows,resetCredits,fetchedAt:Date.now()};
    }).finally(()=>{pending=null;});
    return pending;
  };
}
