// 当前北京时间、星期和接下来 7 天的日期表：由代码算好，模型不用自己推星期几。
export const WEEKDAYS=['日','一','二','三','四','五','六'];
const beijing=ms=>new Date(ms+8*3600_000);
const pad2=n=>String(n).padStart(2,'0');
export const localTime=sec=>{if(!Number.isFinite(Number(sec)))return '';const d=beijing(Number(sec)*1000);return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} 周${WEEKDAYS[d.getUTCDay()]}`;};
export function timeContext(nowMs=Date.now()){
  const d=beijing(nowMs),days=[];
  for(let i=0;i<8;i++){const x=beijing(nowMs+i*86400_000);days.push(`${i===0?'今天':i===1?'明天':i===2?'后天':''}${x.getUTCMonth()+1}月${x.getUTCDate()}日 周${WEEKDAYS[x.getUTCDay()]}`.trim());}
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} 星期${WEEKDAYS[d.getUTCDay()]}（北京时间 UTC+8）。接下来几天：${days.join('；')}。用户没说别的时区时一律按北京时间理解“今天、明天、周五、早上8点”。星期几以这里为准，不要自己推算；更远的日期需要星期时让后台任务用 date 命令查。`;
}
