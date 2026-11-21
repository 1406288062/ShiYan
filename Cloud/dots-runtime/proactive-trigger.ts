
import {randomUUID} from 'node:crypto';

// Cold-start coefficients, NOT trained TGL weights. No silence/task/relationship
// labels are inputs. A validated learned predictor can replace this interface.
export function scoreOpportunity(f){
  if(!f.evidence||!f.managerActive)return 0;
  const z=-4.5+3.8*Number(f.inputChanged)+3.7*Number(f.active>0)+4.3*Number(f.pending>0)+3.8*Number(f.explorationDue)+1.2*Number(f.contextChanged&&f.held>0);
  return 1/(1+Math.exp(-z));
}
export const PREDICTOR_INFO=Object.freeze({kind:'cold-start-logistic',trained:false,threshold:0.60,features:['evidence','managerActive','inputChanged','active','pending','explorationDue','contextChanged','held']});
const fault=(code,message,retryAt?: any)=>Object.assign(new Error(message),{code,retryAt});

// 硬性节流（2026-10-29）：
// 1. 北京时间 22:00–次日 09:00 不调用大模型。
// 2. 全服务器（所有账号共用）每 2 小时最多开启一个主动周期；周期在“准入”那一刻就占用名额，
//    无论之后成功、失败、超时、被取消还是上下文过期，都不会提前重开。
// 3. 每个周期最多 1 次模型调用（发现兴趣 或 认知整理，二选一）。
// 4. 多账号按排队先后轮流使用名额，避免某个账号独占。
export const QUIET_START_HOUR=22,QUIET_END_HOUR=9,GLOBAL_GAP_MS=7_200_000,CALLS_PER_CYCLE=1;
export function inQuietHours(ms){const h=new Date(ms+8*3600_000).getUTCHours();return h>=QUIET_START_HOUR||h<QUIET_END_HOUR;}

export interface ProactiveTriggerOptions {
  store: any;
  cognition: any;
  discovery?: any;
  epoch?: () => string;
  now?: () => number;
  score?: any;
  threshold?: number;
  intervalMs?: number;
  explorationMs?: number;
  globalGapMs?: number;
  callsPerCycle?: number;
  logger?: Console;
  setIntervalImpl?: any;
  clearIntervalImpl?: any;
}
export function createProactiveTrigger({store,cognition,discovery=null,epoch=()=>'',now=()=>Date.now(),score=scoreOpportunity,threshold=0.60,intervalMs=600_000,explorationMs=900_000,globalGapMs=GLOBAL_GAP_MS,callsPerCycle=CALLS_PER_CYCLE,logger=console,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}: ProactiveTriggerOptions){
  if(!Number.isFinite(threshold)||threshold<0||threshold>1||!Number.isFinite(intervalMs)||intervalMs<1000||!Number.isFinite(explorationMs)||explorationMs<1000||!Number.isFinite(globalGapMs)||globalGapMs<60_000||!Number.isInteger(callsPerCycle)||callsPerCycle<1)throw new Error('Invalid proactive trigger configuration');
  const {db,managerId}=store,owner=randomUUID();
  db.exec(`CREATE TABLE IF NOT EXISTS dots_proactive_trigger(manager_id TEXT PRIMARY KEY,window_start INTEGER NOT NULL,calls INTEGER NOT NULL DEFAULT 0,next_allowed_at INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_explore_at INTEGER NOT NULL DEFAULT -1,seen_input TEXT NOT NULL DEFAULT '',seen_context TEXT NOT NULL DEFAULT '',decisions INTEGER NOT NULL DEFAULT 0,last_score REAL NOT NULL DEFAULT 0,last_reason TEXT NOT NULL DEFAULT 'created')`);
  if(!db.prepare("SELECT 1 FROM pragma_table_info('dots_proactive_trigger') WHERE name='wants_since'").get())db.exec('ALTER TABLE dots_proactive_trigger ADD COLUMN wants_since INTEGER NOT NULL DEFAULT 0');
  db.prepare('INSERT OR IGNORE INTO dots_proactive_trigger(manager_id,window_start) VALUES(?,?)').run(managerId,now());
  // Server-wide gate shared by every owner. First creation starts with a full gap
  // so a deploy/restart never causes an immediate call.
  db.exec('CREATE TABLE IF NOT EXISTS dots_proactive_global(id INTEGER PRIMARY KEY CHECK(id=1),next_at INTEGER NOT NULL,last_at INTEGER NOT NULL DEFAULT 0,last_manager TEXT NOT NULL DEFAULT \'\')');
  db.prepare('INSERT OR IGNORE INTO dots_proactive_global(id,next_at) VALUES(1,?)').run(now()+globalGapMs);
  db.exec('CREATE TABLE IF NOT EXISTS dots_proactive_decisions(id INTEGER PRIMARY KEY,manager_id TEXT NOT NULL,created_at INTEGER NOT NULL,features TEXT NOT NULL,score REAL NOT NULL,reason TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_proactive_decision_recent ON dots_proactive_decisions(manager_id,id DESC)');
  const state=()=>db.prepare('SELECT * FROM dots_proactive_trigger WHERE manager_id=?').get(managerId);
  const gate=()=>db.prepare('SELECT * FROM dots_proactive_global WHERE id=1').get();
  let busy=false,closed=false,requested=false,queued=false,interval: any=null,admitted=false,turnEpoch='',lastFault: any=null,cycleCalls=0;
  const counters={signals:0,coalesced:0,runs:0,belowThreshold:0,gated:0,cycles:0,modelCalls:0};
  const active=()=>db.prepare('SELECT status FROM managers WHERE id=?').get(managerId)?.status==='active';
  const claim=()=>store.transaction(()=>Boolean(db.prepare('UPDATE dots_proactive_trigger SET lease_owner=?,lease_until=? WHERE manager_id=? AND (lease_owner=? OR lease_until<=?)').run(owner,now()+300_000,managerId,owner,now()).changes));
  const own=()=>state().lease_owner===owner&&state().lease_until>now();
  const release=()=>db.prepare('UPDATE dots_proactive_trigger SET lease_owner=NULL,lease_until=0 WHERE manager_id=? AND lease_owner=?').run(managerId,owner);
  const quietHours=()=>inQuietHours(now());
  const gateOpen=()=>now()>=gate().next_at;
  // Cheap pre-check (no model): quiet hours stop everything. The 2h gate is
  // enforced atomically in takeSlot() so waiting owners still queue fairly.
  const eligible=()=>!closed&&!quietHours()&&active();
  // Atomically take the server-wide slot. Fair FIFO: an owner that has been
  // waiting longer than us keeps priority.
  const takeSlot=()=>store.transaction(()=>{
    const t=now();if(inQuietHours(t))return false;
    let mine=state().wants_since;if(!mine){mine=t;db.prepare('UPDATE dots_proactive_trigger SET wants_since=? WHERE manager_id=?').run(mine,managerId);}
    if(t<gate().next_at)return false;
    const earlier=db.prepare("SELECT 1 FROM dots_proactive_trigger p JOIN managers m ON m.id=p.manager_id WHERE m.status='active' AND p.manager_id<>? AND p.wants_since>0 AND p.wants_since<?").get(managerId,mine);
    if(earlier)return false;
    db.prepare('UPDATE dots_proactive_global SET next_at=?,last_at=?,last_manager=? WHERE id=1').run(t+globalGapMs,t,managerId);
    db.prepare('UPDATE dots_proactive_trigger SET wants_since=0,window_start=?,calls=0 WHERE manager_id=?').run(t,managerId);
    return true;
  });
  function features(work,s){return {evidence:work.evidence??1,managerActive:active(),inputChanged:String(work.inputKey??'')!==s.seen_input,contextChanged:String(work.contextKey??'')!==s.seen_context,active:work.active||0,pending:work.pending||0,held:work.held||0,explorationDue:s.last_explore_at<0||now()-s.last_explore_at>=explorationMs};}
  // All proactive LLM calls, including source classification, must pass here.
  async function assess(fn,...args){
    try{
      if(!admitted||!busy||!own()||quietHours())throw fault('NOT_ADMITTED','Proactive model call not admitted');
      if(String(epoch())!==turnEpoch)throw fault('STALE_CONTEXT','Proactive input changed');
      if(cycleCalls>=callsPerCycle)throw fault('BUDGET','Proactive cycle already used its model call');
      cycleCalls++;
      store.transaction(()=>{
        if(state().lease_owner!==owner||state().lease_until<=now())throw fault('LEASE','Proactive lease lost');
        db.prepare('UPDATE dots_proactive_trigger SET calls=calls+1,lease_until=? WHERE manager_id=?').run(now()+300_000,managerId);
      });
      counters.modelCalls++;
      const result=await fn(...args);
      if(closed||!active()||!own()||String(epoch())!==turnEpoch)throw fault('STALE_CONTEXT','Proactive result became stale');
      return result;
    }catch(error){lastFault=error;throw error;}
  }
  function schedule(){
    if(queued||closed)return;queued=true;
    queueMicrotask(()=>{queued=false;if(!closed&&!busy)void runOnce('signal').catch(error=>logger.warn?.('[proactive-trigger-dispatch]',error?.message||error));});
  }
  function signal(kind='event'){
    if(closed)return;counters.signals++;
    if(requested||busy||queued)counters.coalesced++;
    requested=true;schedule();
  }
  async function runOnce(kind='manual'){
    if(closed||busy)return false;
    requested=false;
    // Gate first: in quiet hours or inside the 2h gap nothing else runs at all.
    if(!eligible()){counters.gated++;return false;}
    cognition.reconcile?.();discovery?.reconcile?.();
    if(!claim())return false;
    busy=true;lastFault=null;counters.runs++;cycleCalls=0;
    try{
      const before=cognition.workState(),s=state(),f=features(before,s);
      const value=score(f);
      if(!Number.isFinite(value)||value<0||value>1)throw fault('PREDICTOR','Invalid predictor score');
      const pass=value>=threshold;
      db.prepare('UPDATE dots_proactive_trigger SET decisions=decisions+1,last_score=?,last_reason=? WHERE manager_id=?').run(value,pass?'admitted:'+String(kind).slice(0,40):'below-threshold',managerId);
      store.transaction(()=>{
        db.prepare('INSERT INTO dots_proactive_decisions(manager_id,created_at,features,score,reason) VALUES(?,?,?,?,?)').run(managerId,now(),JSON.stringify(f),value,String(kind).slice(0,40));
        db.prepare('DELETE FROM dots_proactive_decisions WHERE manager_id=? AND id NOT IN (SELECT id FROM dots_proactive_decisions WHERE manager_id=? ORDER BY id DESC LIMIT 512)').run(managerId,managerId);
      });
      if(!pass){counters.belowThreshold++;db.prepare('UPDATE dots_proactive_trigger SET wants_since=0 WHERE manager_id=?').run(managerId);return true;}
      if(!takeSlot()){counters.gated++;db.prepare('UPDATE dots_proactive_trigger SET last_reason=? WHERE manager_id=?').run('waiting-global-slot',managerId);return true;}
      counters.cycles++;
      admitted=true;turnEpoch=String(epoch());
      // At most one model call per cycle: discovery may use it (only when user
      // history changed); otherwise cognition gets it.
      if(discovery&&(f.explorationDue||f.inputChanged)){
        const ok=await discovery.tick();if(lastFault)throw lastFault;
        if(ok===false)throw fault('DISCOVERY','Discovery did not complete');
      }
      if(cycleCalls<callsPerCycle){
        if(closed||!active()||String(epoch())!==turnEpoch)throw fault('STALE_CONTEXT','Context changed during exploration');
        const ok=await cognition.pump({maxSteps:1,reconsider:f.explorationDue});
        if(lastFault)throw lastFault;
        if(ok===false)throw fault('COGNITION','Cognition did not complete');
      }
      const after=cognition.workState();
      const progressed=String(after.progressStamp??'')!==String(before.progressStamp??'');
      db.prepare('UPDATE dots_proactive_trigger SET last_explore_at=CASE WHEN ? THEN ? ELSE last_explore_at END,seen_input=?,seen_context=?,failures=0,next_allowed_at=?,last_reason=? WHERE manager_id=? AND lease_owner=?').run(Number(f.explorationDue),now(),String(after.inputKey??''),String(after.contextKey??''),gate().next_at,progressed?'substantive-progress':'rest',managerId,owner);
      return true;
    }catch(error){
      // The global slot stays consumed: failures, cancellations and stale
      // context never reopen the gate early.
      const s=state();
      db.prepare('UPDATE dots_proactive_trigger SET failures=?,next_allowed_at=?,last_reason=? WHERE manager_id=? AND lease_owner=?').run(s.failures+1,gate().next_at,String((error as any).code||'failure').slice(0,60),managerId,owner);
      logger.warn?.('[proactive-trigger]',(error as any).code||'failure',(error as any).message);
      return false;
    }finally{
      admitted=false;busy=false;cycleCalls=0;release();
      if(!closed&&requested&&eligible()&&gateOpen())schedule();else requested=false;
    }
  }
  return {runOnce,signal,assess,state,gate,metrics:()=>({...counters,predictor:PREDICTOR_INFO,gate:gate(),quiet:quietHours()}),start(){if(closed||interval)return;interval=setIntervalImpl(()=>signal('L1-heartbeat'),intervalMs);interval?.unref?.();signal('startup');},close(){closed=true;requested=false;admitted=false;release();if(interval)clearIntervalImpl(interval);interval=null;cognition.close?.();discovery?.close?.();},get busy(){return busy;}};
}
