import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DotsAdapter } from './dots-adapter.ts';

const fail=(message: any,status=400,code='invalid_schedule')=>Object.assign(new Error(message),{status,code});
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const day=(date: any)=>new Date(date+'T12:00:00Z');
const validDate=(date: any)=>typeof date==='string'&&datePattern.test(date)&&Number.isFinite(day(date).getTime())&&day(date).toISOString().slice(0,10)===date;
const shiftDate=(date: any,days: any)=>{const result=day(date);result.setUTCDate(result.getUTCDate()+days);return result.toISOString().slice(0,10);};
const parts=(timestamp: any,timezone: any)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(timestamp).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const localDate=(timestamp: any,timezone: any)=>{const p=parts(timestamp,timezone);return p.year+'-'+p.month+'-'+p.day;};
function localTime(date: any,time: any,timezone: any){
  const target=Date.parse(date+'T'+time+':00Z');let candidate=target;
  for(let i=0;i<4;i++){const p=parts(candidate,timezone),actual=Date.parse(p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':'+p.second+'Z'),difference=target-actual;if(!difference)break;candidate+=difference;}
  const p=parts(candidate,timezone);
  return p.year+'-'+p.month+'-'+p.day===date&&p.hour+':'+p.minute===time?candidate:null;
}
export function nextScheduleRun(schedule: any,after=Date.now()){
  if(!schedule.enabled)return null;
  let date=localDate(after,schedule.timezone);if(date<schedule.startDate)date=schedule.startDate;
  const anchor=day(schedule.startDate),anchorWeekday=anchor.getUTCDay(),anchorDay=anchor.getUTCDate();
  if(schedule.repeat==='once'&&date>schedule.startDate)return null;
  for(let i=0;i<740;i++,date=shiftDate(date,1)){
    if(schedule.endDate&&date>schedule.endDate)return null;
    if(schedule.repeat==='once'&&date!==schedule.startDate)return null;
    const current=day(date),weekday=current.getUTCDay();
    if(schedule.repeat==='weekdays'&&(weekday===0||weekday===6))continue;
    if(schedule.repeat==='weekly'&&weekday!==anchorWeekday)continue;
    if(schedule.repeat==='monthly'){const lastDay=new Date(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()+1,0)).getUTCDate();if(current.getUTCDate()!==Math.min(anchorDay,lastDay))continue;}
    const candidate=localTime(date,schedule.time,schedule.timezone);if(candidate!==null&&candidate>after)return candidate;
  }
  return null;
}

export class DotsSchedules {
  adapter: DotsAdapter;
  db: DatabaseSync;
  now: () => number;
  running: boolean;
  timer: NodeJS.Timeout | null;
  constructor(adapter: any,{pollMs=15000,now=()=>Date.now()}={}){
    this.adapter=adapter;this.db=adapter.store.db;this.now=now;this.running=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS dots_schedules(id TEXT PRIMARY KEY,owner TEXT NOT NULL,title TEXT NOT NULL,instruction TEXT NOT NULL,enabled INTEGER NOT NULL,repeat TEXT NOT NULL,time TEXT NOT NULL,timezone TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT,next_run_at INTEGER,last_run_at INTEGER,last_task_id INTEGER,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS dots_schedules_due ON dots_schedules(owner,enabled,next_run_at);
      CREATE TABLE IF NOT EXISTS dots_schedule_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,schedule_id TEXT NOT NULL,revision INTEGER NOT NULL,due_at INTEGER NOT NULL,goal_id INTEGER,state TEXT NOT NULL,updated_at INTEGER NOT NULL,last_error TEXT NOT NULL DEFAULT '');`);
    this.timer=pollMs>0?setInterval(()=>void this.tick().catch(()=>{}),pollMs):null;this.timer?.unref();
  }
  close(){if(this.timer!==null)clearInterval(this.timer);}
  public(row: any){return {id:row.id,title:row.title,instruction:row.instruction,enabled:Boolean(row.enabled),repeat:row.repeat,time:row.time,timezone:row.timezone,startDate:row.start_date,endDate:row.end_date,nextRunAt:row.next_run_at,lastRunAt:row.last_run_at,lastTaskId:row.last_task_id,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,status:row.enabled?'active':'paused'};}
  row(owner: any,id: any){this.adapter.authorize(owner);if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))throw fail('定时任务不存在',404);const row=this.db.prepare('SELECT * FROM dots_schedules WHERE owner=? AND id=?').get(owner,id);if(!row)throw fail('定时任务不存在',404);return row;}
  get(owner: any,id: any){return {ok:true,schedule:this.public(this.row(owner,id))};}
  list(owner: any){this.adapter.authorize(owner);return {ok:true,schedules:this.db.prepare('SELECT * FROM dots_schedules WHERE owner=? ORDER BY updated_at DESC LIMIT 500').all(owner).map(row=>this.public(row)),scheduler:{available:true,durable:true,transport:'server',pollIntervalMs:15000,managerPauseBlocksRuns:true,missedRuns:'one-catch-up-run'}};}
  validate(input: any,prior: ReturnType<DotsSchedules['public']> | null=null){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['requestId','title','instruction','enabled','repeat','time','timezone','startDate','endDate'].includes(k)))throw fail('定时任务包含不支持的字段');
    const timezone=input.timezone??prior?.timezone??'Asia/Shanghai';
    try{if(typeof timezone!=='string'||timezone.length>100)throw new Error();new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw fail('时区无效');}
    const value={title:input.title??prior?.title,instruction:input.instruction??prior?.instruction,enabled:input.enabled??prior?.enabled??true,repeat:input.repeat??prior?.repeat??'daily',time:input.time??prior?.time??'21:00',timezone,startDate:input.startDate??prior?.startDate??localDate(this.now(),timezone),endDate:input.endDate===undefined?prior?.endDate??null:input.endDate};
    for(const [key,max] of [['title',200],['instruction',20000]] as const){if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>max)throw fail('定时任务'+(key==='title'?'标题':'指令')+'无效');value[key]=value[key].trim();}
    if(typeof value.enabled!=='boolean'||!['once','daily','weekdays','weekly','monthly'].includes(value.repeat)||typeof value.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))throw fail('重复频率或执行时间无效');
    if(!validDate(value.startDate)||value.endDate!==null&&(!validDate(value.endDate)||value.endDate<value.startDate))throw fail('开始或结束日期无效');
    return value;
  }
  emit(owner: any,schedule: any,requestId: any){this.adapter.publish(this.adapter.store.append(owner,0,'schedule',{schedule},'schedule:'+owner+':'+requestId),owner);}
  commitMutation(owner: any,requestId: any,change: any){
    let event;
    const response=this.adapter.store.transaction(()=>{
      const result=change();
      const payload=result.deleted?{id:result.id,deleted:true}:{schedule:result.schedule};
      event=this.adapter.store.append(owner,0,'schedule',payload,'schedule:'+owner+':'+requestId);
      // The local data and replay receipt share one commit. A process crash
      // therefore leaves either no mutation, or the exact completed response.
      this.adapter.store.finish(owner,requestId,result);
      return result;
    });
    this.adapter.publish(event,owner);
    return response;
  }
  async create(owner: any,input: any){
    this.adapter.authorize(owner);const value=this.validate(input);
    return this.adapter.mutation(owner,input.requestId,'schedule:create',value,()=>this.commitMutation(owner,input.requestId,()=>{
      const id=randomUUID(),timestamp=this.now(),next=nextScheduleRun(value,timestamp-1);if(value.enabled&&!next)throw fail('执行时间已过去，请选择未来的时间');
      this.db.prepare('INSERT INTO dots_schedules(id,owner,title,instruction,enabled,repeat,time,timezone,start_date,end_date,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,owner,value.title,value.instruction,Number(value.enabled),value.repeat,value.time,value.timezone,value.startDate,value.endDate,next,timestamp,timestamp);
      return this.get(owner,id);
    }),{replaySafe:true});
  }
  async update(owner: any,id: any,input: any){
    const current=this.public(this.row(owner,id)),value=this.validate(input,current);
    return this.adapter.mutation(owner,input.requestId,'schedule:update:'+id,value,()=>this.commitMutation(owner,input.requestId,()=>{
      const next=nextScheduleRun(value,this.now()-1);if(value.enabled&&!next)throw fail('执行时间已过去，请选择未来的时间');
      this.db.prepare('UPDATE dots_schedules SET title=?,instruction=?,enabled=?,repeat=?,time=?,timezone=?,start_date=?,end_date=?,next_run_at=?,revision=revision+1,updated_at=? WHERE owner=? AND id=?').run(value.title,value.instruction,Number(value.enabled),value.repeat,value.time,value.timezone,value.startDate,value.endDate,next,this.now(),owner,id);
      return this.get(owner,id);
    }),{replaySafe:true});
  }
  async control(owner: any,id: any,input: any){
    this.adapter.authorize(owner);if(!input||Object.keys(input).some(k=>!['requestId','action'].includes(k))||!['pause','resume','cancel'].includes(input.action))throw fail('定时任务操作无效');
    if(input.action==='cancel')return this.adapter.mutation(owner,input.requestId,'schedule:cancel:'+id,{},()=>this.commitMutation(owner,input.requestId,()=>{this.row(owner,id);this.db.prepare('DELETE FROM dots_schedules WHERE owner=? AND id=?').run(owner,id);return {ok:true,id,deleted:true};}),{replaySafe:true});
    return this.update(owner,id,{requestId:input.requestId,enabled:input.action==='resume'});
  }
  async tick(){
    if(this.running)return;this.running=true;
    try{
      const due=this.db.prepare('SELECT * FROM dots_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 100').all(this.now());
      if(!due.length)return;
      // Query the runtime before dispatch; cached state cannot resume a manager.
      const managers=new Map();
      for(const row of due){
        const owner=row.owner;
        if(!managers.has(owner)){try{managers.set(owner,await this.adapter.managerSnapshot(owner));}catch{managers.set(owner,null);}}
        if(managers.get(owner)?.status!=='active')continue;
        const current=this.row(owner,row.id);if(!current.enabled||current.revision!==row.revision||current.next_run_at!==row.next_run_at)continue;
        const requestId='schedule-run:'+row.id+':'+row.next_run_at;
        this.db.prepare("INSERT OR IGNORE INTO dots_schedule_runs(id,owner,schedule_id,revision,due_at,state,updated_at) VALUES(?,?,?,?,?,'pending',?)").run(requestId,owner,row.id,row.revision,row.next_run_at,this.now());
        try{
          const result=await this.adapter.create(owner,{requestId,conversationId:requestId,title:row.title,instruction:row.instruction,runNow:true,host:'shiyan_desktop'});
          this.db.prepare("UPDATE dots_schedule_runs SET goal_id=?,state='completed',updated_at=?,last_error='' WHERE id=?").run(result.goal.id,this.now(),requestId);
          const next=nextScheduleRun(this.public(row),this.now());
          this.db.prepare('UPDATE dots_schedules SET next_run_at=?,last_run_at=?,last_task_id=?,enabled=CASE WHEN ? IS NULL THEN 0 ELSE enabled END,updated_at=? WHERE owner=? AND id=? AND revision=? AND next_run_at=?').run(next,this.now(),result.goal.id,next,this.now(),owner,row.id,row.revision,row.next_run_at);
          const fresh=this.db.prepare('SELECT * FROM dots_schedules WHERE owner=? AND id=?').get(owner,row.id);if(fresh)this.emit(owner,this.public(fresh),requestId);
        }catch(error){this.db.prepare('UPDATE dots_schedule_runs SET last_error=?,updated_at=? WHERE id=?').run(String(error instanceof Error?error.message:error).slice(0,500),this.now(),requestId);}
      }
    }finally{this.running=false;}
  }
}
