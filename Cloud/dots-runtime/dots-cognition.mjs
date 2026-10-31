import {createHash,randomUUID} from 'node:crypto';
import {normalizedText,connectionAlreadyCovered} from './natural-opportunities.mjs';
import {buildCognitivePrompt} from './cognition-prompt.mjs';

const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const parse=(value,fallback=null)=>{try{return JSON.parse(value);}catch{return fallback;}};
const text=value=>typeof value==='string'?value.trim():'';
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const str=maxLength=>({type:'string',maxLength});
const reference=object({kind:{type:'string',enum:['user','observation']},id:str(100),quote:str(1000)});
const references={type:'array',minItems:1,maxItems:12,items:reference};
const shareKinds=new Set(['insight','suggestion','question']);
const expressionKind={type:'string',enum:[...shareKinds,'internal_acknowledgment','restatement','no_update']};
const unsafe=/(?:-----BEGIN .*PRIVATE KEY|\b(?:sk|ghp|github_pat)[-_A-Za-z0-9]{16,}|(?:密码|验证码|私钥|密钥|身份证号|银行卡号)\s*[:：是为]\s*\S+)/i;
export function encodeCognitiveInput(value,maxBytes=96*1024){
  const copy=structuredClone(value),size=()=>Buffer.byteLength(JSON.stringify(copy),'utf8');
  for(const key of ['exchange','trace','evidence'])while(Array.isArray(copy[key])&&copy[key].length>2&&size()>maxBytes)copy[key].shift();
  if(size()>maxBytes){
    const clip=value=>{
      if(typeof value==='string'){let n=0,result='';for(const char of value){const bytes=Buffer.byteLength(char,'utf8');if(n+bytes>2048)break;n+=bytes;result+=char;}return result;}
      if(Array.isArray(value))return value.slice(-12).map(clip);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clip(item)]));
      return value;
    };
    const bounded=JSON.stringify(clip(copy));if(Buffer.byteLength(bounded,'utf8')>maxBytes)throw new Error('Cognitive input exceeds bounded data size');return bounded;
  }
  return JSON.stringify(copy);
}
export const UNDERSTANDING_SCHEMA=object({understanding:str(4000),understanding_references:references,retire_focuses:{type:'array',maxItems:8,items:object({key:str(100),reason:str(1000),references})},focuses:{type:'array',maxItems:4,items:object({key:str(100),question:str(700),personal_meaning:str(1000),references})}});
export const THINK_SCHEMA=object({action:{type:'string',enum:['continue','ready','rest']},contribution_kind:expressionKind,view:str(2000),new_contribution:str(1200),understanding:str(3000),next_question:str(700),why_share:str(1000),references});
export const MOMENT_SCHEMA=object({action:{type:'string',enum:['send','hold','drop']},expression_kind:expressionKind,message:str(1600),new_value:str(1200),context_clear:{type:'boolean'},claims_supported:{type:'boolean'},reason:str(1000),wait_for:str(1000),worth_sharing:{type:'boolean'},not_already_expressed:{type:'boolean'},appropriate_now:{type:'boolean'},references});

// Cognitive work, communication intent and expression are separate durable
// states. There is no send_at, silence counter, relationship tier, task gate or
// periodic greeting. The compute allowance controls spend, not social timing.
export function createDotsCognition({store,assess,memory,now=()=>Math.floor(Date.now()/1000),callsPerHour=24,propagateErrors=false,logger=console}={}){
  const {db,managerId}=store,owner=randomUUID();
  db.exec(`
    CREATE TABLE IF NOT EXISTS dots_cognition_state(manager_id TEXT PRIMARY KEY,knowledge_key TEXT NOT NULL DEFAULT '',understanding TEXT NOT NULL DEFAULT '',understanding_refs TEXT NOT NULL DEFAULT '[]',memory_key TEXT NOT NULL DEFAULT '',source_floor INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,compute_start INTEGER NOT NULL DEFAULT 0,compute_calls INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS dots_cognition_focuses(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,focus_key TEXT NOT NULL,question TEXT NOT NULL,personal_meaning TEXT NOT NULL,refs TEXT NOT NULL,view TEXT NOT NULL DEFAULT '',frontier TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',revision INTEGER NOT NULL DEFAULT 0,parent_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(manager_id,focus_key));
    CREATE TABLE IF NOT EXISTS dots_cognition_steps(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,focus_id TEXT NOT NULL,revision INTEGER NOT NULL,previous_view TEXT NOT NULL,next_view TEXT NOT NULL,new_contribution TEXT NOT NULL,next_question TEXT NOT NULL,refs TEXT NOT NULL,action TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(focus_id,revision));
    CREATE TABLE IF NOT EXISTS dots_cognition_intents(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,focus_id TEXT NOT NULL,focus_revision INTEGER NOT NULL,view TEXT NOT NULL,why_share TEXT NOT NULL,refs TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',context_key TEXT NOT NULL DEFAULT '',wait_for TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',message_id INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(focus_id,focus_revision));
    CREATE TABLE IF NOT EXISTS dots_cognition_observations(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,payload TEXT NOT NULL,user_refs TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(manager_id,id));
  `);
  db.prepare('INSERT OR IGNORE INTO dots_cognition_state(manager_id) VALUES(?)').run(managerId);
  // Retire both reply-followup and one-shot material-review publication paths.
  store.transaction(()=>{
    if(!db.prepare('PRAGMA table_info(dots_relationship_state)').all().some(row=>row.name==='cognition_enabled'))db.exec('ALTER TABLE dots_relationship_state ADD COLUMN cognition_enabled INTEGER NOT NULL DEFAULT 0');
    db.prepare('UPDATE dots_relationship_state SET cognition_enabled=1 WHERE manager_id=?').run(managerId);
    db.prepare("UPDATE dots_relationship_event_candidates SET state='invalidated',reason='已转为独立认知过程' WHERE manager_id=? AND state IN ('pending','claimed')").run(managerId);
    db.prepare("UPDATE dots_relationship_reflections SET state='invalidated',reason='已转为独立认知过程' WHERE manager_id=? AND state IN ('pending','claimed')").run(managerId);
  });
  db.exec("CREATE INDEX IF NOT EXISTS idx_cognition_focus_state ON dots_cognition_focuses(manager_id,state); CREATE INDEX IF NOT EXISTS idx_cognition_intent_state ON dots_cognition_intents(manager_id,state); CREATE INDEX IF NOT EXISTS idx_cognition_step_action ON dots_cognition_steps(manager_id,action); CREATE INDEX IF NOT EXISTS idx_cognition_observation_recent ON dots_cognition_observations(manager_id,created_at DESC,id)");
  if(!db.prepare('PRAGMA table_info(dots_cognition_state)').all().some(row=>row.name==='contribution_revision'))db.exec('ALTER TABLE dots_cognition_state ADD COLUMN contribution_revision INTEGER NOT NULL DEFAULT 0');
  let busy=false,closed=false,abort=null;
  const state=()=>db.prepare('SELECT * FROM dots_cognition_state WHERE manager_id=?').get(managerId);
  const settings=()=>memory?.settings?memory.settings(store.ownerId):{enabled:true,generation:0};
  const epoch=s=>JSON.stringify([s.enabled,s.generation??0]);
  const forgotten=id=>Boolean(db.prepare('SELECT 1 FROM dots_relationship_forgotten_sources WHERE manager_id=? AND message_id=?').get(managerId,id));
  const refValid=ref=>{
    if(!ref||!['user','observation'].includes(ref.kind)||!text(ref.quote)||ref.quote.length<6||unsafe.test(ref.quote))return false;
    if(ref.kind==='user'){
      const row=db.prepare("SELECT id,content FROM manager_messages WHERE manager_id=? AND id=? AND role='user'").get(managerId,Number(ref.id));
      return row&&row.id>state().source_floor&&!forgotten(row.id)&&row.content.includes(ref.quote);
    }
    const row=db.prepare('SELECT * FROM dots_cognition_observations WHERE manager_id=? AND id=?').get(managerId,ref.id);
    return row&&[parse(row.payload)?.title,parse(row.payload)?.summary].some(value=>typeof value==='string'&&value.includes(ref.quote))&&parse(row.user_refs,[]).length>0&&parse(row.user_refs,[]).every(user=>user.kind==='user'&&refValid(user));
  };
  const refsValid=refs=>Array.isArray(refs)&&refs.length>0&&refs.length<=64&&refs.some(ref=>ref.kind==='user')&&refs.every(refValid);
  const unique=refs=>[...new Map(refs.map(ref=>[JSON.stringify(ref),ref])).values()];
  const sourceContext=refs=>refs.filter(refValid).map(ref=>{
    const table=ref.kind==='user'?'manager_messages':'dots_cognition_observations';
    const source=db.prepare('SELECT created_at FROM '+table+' WHERE manager_id=? AND id=?').get(managerId,ref.id);
    return {...ref,date:new Date(source.created_at*1000).toISOString().slice(0,10)};
  });
  const snapshot=()=>{
    const floor=state().source_floor;
    const rows=store.snapshot().messages.filter(row=>row.role==='user'?row.id>floor&&!forgotten(row.id):!(row.respondsToMessageIds||[]).some(forgotten));
    return rows.filter(row=>{
      if(row.origin!=='proactive')return true;
      const intent=db.prepare('SELECT refs,state FROM dots_cognition_intents WHERE manager_id=? AND message_id=?').get(managerId,row.id);
      return intent?intent.state==='sent'&&refsValid(parse(intent.refs,[])):(Boolean(db.prepare("SELECT 1 FROM dots_relationship_deliveries WHERE manager_id=? AND message_id=? AND new_value<>''").get(managerId,row.id))||Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dots_discovery_updates'").get()&&db.prepare("SELECT i.source_id,i.quote,i.evidence_json,i.active FROM dots_discovery_updates u JOIN dots_discovery_interests i ON i.id=u.interest_id WHERE u.manager_id=? AND u.message_id=? AND u.state='sent'").all(managerId,row.id).some(interest=>interest.active&&[{kind:'user',id:String(interest.source_id),quote:interest.quote},...parse(interest.evidence_json,[]).map(ref=>({kind:'user',id:String(ref.source_id),quote:ref.quote}))].every(refValid))));
    }).filter(row=>row.deliveryState==='completed'&&!unsafe.test(row.content)).slice(-12).map(row=>({id:row.id,role:row.role,content:row.content.slice(0,1500),origin:row.origin,date:new Date(row.createdAt*1000).toISOString().slice(0,10)}));
  };
  const knowledge=()=>{
    const users=db.prepare("SELECT id,content,created_at FROM manager_messages WHERE manager_id=? AND role='user' AND id>? ORDER BY id DESC LIMIT 32").all(managerId,state().source_floor).filter(row=>!forgotten(row.id)&&!unsafe.test(row.content)).map(row=>({kind:'user',id:String(row.id),text:row.content.slice(0,1000),date:new Date(row.created_at*1000).toISOString().slice(0,10)}));
    const observations=db.prepare('SELECT * FROM dots_cognition_observations WHERE manager_id=? ORDER BY created_at DESC,id LIMIT 8').all(managerId).filter(row=>parse(row.user_refs,[]).every(refValid)).map(row=>({kind:'observation',id:row.id,text:row.payload}));
    return [...users.reverse(),...observations];
  };
  const withdraw=()=>store.transaction(()=>{
    for(const [table,fields] of [['dots_cognition_focuses',"state='withdrawn',refs='[]',question='',personal_meaning='',view='',frontier=''"],['dots_cognition_intents',"state='withdrawn',refs='[]',view='',why_share='',reason='',wait_for=''"],['dots_cognition_steps',"previous_view='',next_view='',new_contribution='',next_question='',refs='[]'"],['dots_cognition_observations',"payload='{}',user_refs='[]'"]])db.prepare('UPDATE '+table+' SET '+fields+' WHERE manager_id=?').run(managerId);
    db.prepare("UPDATE dots_cognition_state SET understanding='',understanding_refs='[]',knowledge_key='',source_floor=? WHERE manager_id=?").run(db.prepare("SELECT COALESCE(MAX(id),0) n FROM manager_messages WHERE manager_id=? AND role='user'").get(managerId).n,managerId);
  });
  const sanitize=()=>{
    for(const observation of db.prepare("SELECT id,user_refs FROM dots_cognition_observations WHERE manager_id=? AND user_refs<>'[]'").all(managerId))if(!parse(observation.user_refs,[]).every(refValid))db.prepare("UPDATE dots_cognition_observations SET payload='{}',user_refs='[]' WHERE id=? AND manager_id=?").run(observation.id,managerId);
    for(const focus of db.prepare("SELECT id,refs FROM dots_cognition_focuses WHERE manager_id=? AND state<>'withdrawn'").all(managerId))if(!refsValid(parse(focus.refs,[]))){
      db.prepare("UPDATE dots_cognition_focuses SET state='withdrawn',refs='[]',question='',personal_meaning='',view='',frontier='' WHERE id=?").run(focus.id);
      db.prepare("UPDATE dots_cognition_steps SET previous_view='',next_view='',new_contribution='',next_question='',refs='[]' WHERE focus_id=?").run(focus.id);
      db.prepare("UPDATE dots_cognition_intents SET state='withdrawn',refs='[]',view='',why_share='',reason='',wait_for='' WHERE focus_id=?").run(focus.id);
    }
    if(state().understanding&&!refsValid(parse(state().understanding_refs,[])))db.prepare("UPDATE dots_cognition_state SET understanding='',understanding_refs='[]' WHERE manager_id=?").run(managerId);
  };
  const reserve=()=>store.transaction(()=>{
    const s=state();if(s.lease_owner!==owner||s.lease_until<=now())return false;
    const reset=now()-s.compute_start>=3600;
    if(!reset&&s.compute_calls>=callsPerHour)return false;
    db.prepare('UPDATE dots_cognition_state SET compute_start=?,compute_calls=?,lease_until=? WHERE manager_id=?').run(reset?now():s.compute_start,reset?1:s.compute_calls+1,now()+180,managerId);return true;
  });
  const ask=async(prompt,schema)=>{
    if(!reserve())return null;
    let input=prompt;
    // 用户对近期主动消息的“有用 / 没用”反馈，只在决定是否发送时提供。
    try{const data=JSON.parse(prompt);if(data.operation==='evaluate_expression'&&store.recentFeedback){const feedback=store.recentFeedback(15);if(feedback.length){data.user_feedback=feedback;input=JSON.stringify(data);}}}catch{}
    return assess(buildCognitivePrompt(input),schema,{signal:abort.signal});
  };
  const stillCurrent=key=>!closed&&!abort.signal.aborted&&epoch(settings())===key&&state().lease_owner===owner&&state().lease_until>now();
  const technicalDeliveryAvailable=()=>db.prepare('SELECT status FROM managers WHERE id=?').get(managerId)?.status==='active'&&!db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL').get(managerId)&&!db.prepare("SELECT 1 FROM manager_runs WHERE manager_id=? AND kind='manager' AND state='running'").get(managerId)&&!db.prepare("SELECT 1 FROM manager_messages WHERE manager_id=? AND delivery_state='streaming'").get(managerId);
  async function understand(key,{reconsider=false}={}){
    const facts=knowledge(),digest=hash(JSON.stringify(facts));if(!facts.length||!reconsider&&state().knowledge_key===digest)return;
    const existing=db.prepare("SELECT focus_key,question,view,frontier,state FROM dots_cognition_focuses WHERE manager_id=? AND state<>'withdrawn' ORDER BY updated_at DESC LIMIT 24").all(managerId);
    const result=await ask(encodeCognitiveInput({operation:'update_understanding',evaluatedAt:new Date(now()*1000).toISOString(),understanding:state().understanding,focuses:existing,evidence:facts,exchange:snapshot()}),UNDERSTANDING_SCHEMA);
    if(!result||!stillCurrent(key)||digest!==hash(JSON.stringify(knowledge())))return;
    if(!Array.isArray(result.focuses)||result.focuses.length>4)throw new Error('Invalid cognitive orientation');
    const accepted=[];
    store.transaction(()=>{
      for(const item of result.focuses){
        const refs=item.references,q=text(item.question),meaning=text(item.personal_meaning),focusKey=text(item.key);
        if(!focusKey||focusKey.length>100||q.length<8||q.length>700||meaning.length<8||!refsValid(refs)||unsafe.test(q+meaning))continue;
        accepted.push(...refs);
        const old=db.prepare('SELECT * FROM dots_cognition_focuses WHERE manager_id=? AND focus_key=?').get(managerId,focusKey);
        if(!old&&existing.some(previous=>normalizedText(previous.question)===normalizedText(q)||connectionAlreadyCovered(q,previous.question)))continue;
        if(!old)db.prepare("INSERT INTO dots_cognition_focuses(id,manager_id,focus_key,question,personal_meaning,refs,frontier,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(),managerId,focusKey,q,meaning,JSON.stringify(refs),q,now(),now());
        else{
          const before=parse(old.refs,[]),added=refs.some(ref=>!before.some(previous=>JSON.stringify(previous)===JSON.stringify(ref)));
          if(added){const retained=unique([...before.filter(refValid),...refs]);db.prepare("UPDATE dots_cognition_focuses SET question=?,personal_meaning=?,refs=?,frontier=?,state='active',updated_at=? WHERE id=?").run(q,meaning,JSON.stringify(retained),q,now(),old.id);}
        }
      }
      for(const item of result.retire_focuses||[]){
        if(!text(item.key)||text(item.reason).length<6||!refsValid(item.references))continue;
        const old=db.prepare('SELECT id FROM dots_cognition_focuses WHERE manager_id=? AND focus_key=?').get(managerId,item.key);if(!old)continue;
        const family=[old.id];
        for(let cursor=0;cursor<family.length;cursor++)for(const child of db.prepare('SELECT id FROM dots_cognition_focuses WHERE manager_id=? AND parent_id=?').all(managerId,family[cursor]))if(!family.includes(child.id))family.push(child.id);
        for(const id of family){
          db.prepare("UPDATE dots_cognition_focuses SET state='retired',frontier='',updated_at=? WHERE id=?").run(now(),id);
          db.prepare("UPDATE dots_cognition_intents SET state='dropped',reason=?,wait_for='',updated_at=? WHERE focus_id=? AND state IN ('pending','held')").run(text(item.reason).slice(0,1000),now(),id);
        }
      }
      const understanding=text(result.understanding),understandingRefs=result.understanding_references||unique(accepted);
      if(understanding&&refsValid(understandingRefs)&&!unsafe.test(understanding))db.prepare('UPDATE dots_cognition_state SET understanding=?,understanding_refs=? WHERE manager_id=?').run(understanding,JSON.stringify(understandingRefs),managerId);
      db.prepare('UPDATE dots_cognition_state SET knowledge_key=? WHERE manager_id=?').run(digest,managerId);
    });
  }
  async function think(focus,key){
    const refs=parse(focus.refs,[]);if(!refsValid(refs))return;
    const history=db.prepare('SELECT revision,next_view,new_contribution,next_question,action FROM dots_cognition_steps WHERE focus_id=? ORDER BY revision DESC LIMIT 8').all(focus.id).reverse();
    const discussed=snapshot();
    const result=await ask(encodeCognitiveInput({operation:'advance_thought',evaluatedAt:new Date(now()*1000).toISOString(),understanding:state().understanding,focus:{question:focus.question,personalMeaning:focus.personal_meaning,view:focus.view,frontier:focus.frontier},sourceContext:sourceContext(refs),trace:history,evidence:knowledge(),exchange:discussed}),THINK_SCHEMA);
    if(!result||!stillCurrent(key)||!refsValid(refs))return false;
    const view=text(result.view),contribution=text(result.new_contribution),frontier=text(result.next_question),action=result.action;
    const cited=result.references,effective=unique([...refs,...(Array.isArray(cited)?cited:[])]);
    const novel=shareKinds.has(result.contribution_kind)&&view.length>=12&&contribution.length>=10&&!unsafe.test(view+contribution+frontier)&&refsValid(cited)&&refsValid(effective)&&normalizedText(view)!==normalizedText(focus.view)&&!history.some(row=>row.next_view&&connectionAlreadyCovered(view,row.next_view))&&!discussed.some(row=>row.role==='assistant'&&connectionAlreadyCovered(view,row.content));
    const nextAction=['continue','ready','rest'].includes(action)&&novel?action:'rest';
    store.transaction(()=>{
      if(db.prepare('SELECT revision FROM dots_cognition_focuses WHERE id=?').get(focus.id)?.revision!==focus.revision)return;
      const revision=focus.revision+1;
      db.prepare('INSERT INTO dots_cognition_steps(id,manager_id,focus_id,revision,previous_view,next_view,new_contribution,next_question,refs,action,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),managerId,focus.id,revision,focus.view,novel?view:'',novel?contribution:'',novel?frontier:'',JSON.stringify(novel?effective:refs),nextAction,now());
      if(novel&&nextAction!=='rest')db.prepare('UPDATE dots_cognition_state SET contribution_revision=contribution_revision+1 WHERE manager_id=?').run(managerId);
      const canContinue=nextAction==='continue'&&frontier.length>=8&&normalizedText(frontier)!==normalizedText(focus.frontier)&&!history.some(row=>normalizedText(row.next_question)===normalizedText(frontier));
      db.prepare('UPDATE dots_cognition_focuses SET view=?,frontier=?,state=?,revision=?,refs=?,updated_at=? WHERE id=?').run(novel?view:focus.view,canContinue?frontier:'',canContinue?'active':'resting',revision,JSON.stringify(novel?effective:refs),now(),focus.id);
      if(novel&&text(result.understanding)&&!unsafe.test(result.understanding))db.prepare('UPDATE dots_cognition_state SET understanding=?,understanding_refs=? WHERE manager_id=?').run(text(result.understanding).slice(0,3000),JSON.stringify(effective),managerId);
      if(nextAction==='ready'&&text(result.why_share).length>=10){
        const previous=db.prepare("SELECT view FROM dots_cognition_intents WHERE manager_id=? AND state<>'withdrawn'").all(managerId);
        if(!previous.some(row=>connectionAlreadyCovered(view,row.view)))db.prepare('INSERT OR IGNORE INTO dots_cognition_intents(id,manager_id,focus_id,focus_revision,view,why_share,refs,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),managerId,focus.id,revision,view,text(result.why_share).slice(0,1000),JSON.stringify(effective),now(),now());
        // A genuinely new frontier is a child line of thought, not another
        // attempt to resend this intent. Its evidence and ancestry are durable.
        if(frontier.length>=8&&normalizedText(frontier)!==normalizedText(focus.question)&&!history.some(row=>normalizedText(row.next_question)===normalizedText(frontier)))db.prepare('INSERT OR IGNORE INTO dots_cognition_focuses(id,manager_id,focus_key,question,personal_meaning,refs,frontier,parent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),managerId,'frontier:'+hash(normalizedText(frontier)),frontier,focus.personal_meaning,JSON.stringify(effective),frontier,focus.id,now(),now());
      }
    });
    return true;
  }
  async function express(key){
    if(!technicalDeliveryAvailable())return;
    const recent=snapshot(),contextKey=hash(JSON.stringify([recent,state().understanding,knowledge()]));
    const intent=db.prepare("SELECT * FROM dots_cognition_intents WHERE manager_id=? AND (state='pending' OR state='held' AND context_key<>?) ORDER BY created_at,id LIMIT 1").get(managerId,contextKey);
    if(!intent||!refsValid(parse(intent.refs,[])))return;
    const focus=db.prepare('SELECT question,personal_meaning FROM dots_cognition_focuses WHERE manager_id=? AND id=?').get(managerId,intent.focus_id);
    const step=db.prepare('SELECT new_contribution FROM dots_cognition_steps WHERE manager_id=? AND focus_id=? AND revision=?').get(managerId,intent.focus_id,intent.focus_revision);
    const result=await ask(encodeCognitiveInput({operation:'evaluate_expression',evaluatedAt:new Date(now()*1000).toISOString(),understanding:state().understanding,intent:{view:intent.view,newContribution:step?.new_contribution||'',whyShare:intent.why_share,question:focus?.question,personalMeaning:focus?.personal_meaning,formedAt:new Date(intent.created_at*1000).toISOString()},sourceContext:sourceContext(parse(intent.refs,[])),evidence:knowledge(),exchange:recent}),MOMENT_SCHEMA);
    if(!result||!stillCurrent(key)||!refsValid(parse(intent.refs,[])))return;
    const content=text(result.message),reason=text(result.reason),refs=unique([...parse(intent.refs,[]),...(Array.isArray(result.references)?result.references:[])]);
    const grounded=refsValid(result.references)&&refsValid(refs);
    const duplicate=recent.some(row=>row.role==='assistant'&&connectionAlreadyCovered(content,row.content));
    const expressionReady=shareKinds.has(result.expression_kind)&&result.context_clear===true&&result.claims_supported===true&&text(result.new_value).length>=10;
    const validSend=expressionReady&&result.action==='send'&&result.worth_sharing===true&&result.not_already_expressed===true&&result.appropriate_now===true&&content.length>=8&&content.length<=1600&&reason.length>=6&&grounded&&!unsafe.test(content)&&!duplicate&&!/(?:怎么|为什么|为何).{0,10}(?:不回|没回|不理)|我一直在等|不理我|再问你一次/.test(content);
    store.transaction(()=>{
      if(db.prepare('SELECT state FROM dots_cognition_intents WHERE id=?').get(intent.id)?.state==='sent')return;
      const changed=contextKey!==hash(JSON.stringify([snapshot(),state().understanding,knowledge()]));
      if(changed||!technicalDeliveryAvailable()){
        db.prepare("UPDATE dots_cognition_intents SET state='held',context_key=?,wait_for='对话已变化，需要重新判断',updated_at=? WHERE id=?").run(contextKey,now(),intent.id);return;
      }
      if(validSend){
        const links=[];
        for(const ref of refs.filter(ref=>ref.kind==='observation')){
          const payload=parse(db.prepare('SELECT payload FROM dots_cognition_observations WHERE manager_id=? AND id=?').get(managerId,ref.id)?.payload);
          if(payload?.url&&payload?.publisher&&!links.some(link=>link.url===payload.url))links.push(payload);
        }
        const suffix=links.length?'\n\n'+links.slice(0,3).map(link=>'来源：['+text(link.publisher).replace(/[\[\]()]/g,'')+']('+link.url+')').join('\n'):'';
        const message=store.publishCognition({intentId:intent.id,content:content+suffix,reason});
        db.prepare("UPDATE dots_cognition_intents SET state='sent',message_id=?,reason=?,context_key=?,refs=?,updated_at=? WHERE id=?").run(message.id,reason.slice(0,1000),contextKey,JSON.stringify(refs),now(),intent.id);
      }else{
        const hold=result.action==='hold'&&text(result.wait_for).length>=6;
        const qualityReason=!shareKinds.has(result.expression_kind)?'仅为内部确认或重复表述，没有可分享的新内容':result.context_clear!==true?'表达缺少可理解的上下文':result.claims_supported!==true?'表达包含未获证据支持的要求、授权或执行断言':'表达未说明具体的新价值';
        const dropReason=result.action==='send'&&!expressionReady?qualityReason:reason;
        db.prepare('UPDATE dots_cognition_intents SET state=?,reason=?,wait_for=?,context_key=?,updated_at=? WHERE id=?').run(hold?'held':'dropped',dropReason.slice(0,1000),hold?text(result.wait_for).slice(0,1000):'',contextKey,now(),intent.id);
      }
    });
  }
  function reconcile(){
    const settingsNow=settings(),key=epoch(settingsNow),before=state();
    if(before.memory_key!==key){
      if(!settingsNow.enabled||before.memory_key)withdraw();
      db.prepare('UPDATE dots_cognition_state SET memory_key=? WHERE manager_id=?').run(key,managerId);
    }
    if(!settingsNow.enabled)return false;
    sanitize();return true;
  }
  async function pump({maxSteps=2,reconsider=false}={}){
    if(busy||closed||db.prepare('SELECT status FROM managers WHERE id=?').get(managerId)?.status!=='active')return false;
    const claimed=store.transaction(()=>db.prepare('UPDATE dots_cognition_state SET lease_owner=?,lease_until=? WHERE manager_id=? AND (lease_until<=? OR lease_owner=?)').run(owner,now()+180,managerId,now(),owner).changes);
    if(!claimed)return false;busy=true;abort=new AbortController();
    const deadline=setTimeout(()=>abort.abort(new Error('Cognition compute deadline')),120000);deadline.unref?.();
    try{
      const key=epoch(settings());if(!reconcile())return false;await understand(key,{reconsider});
      // Continue the private frontier even when no input or observation changed.
      for(let step=0;step<Math.min(4,maxSteps)&&stillCurrent(key);step++){
        const focus=db.prepare("SELECT * FROM dots_cognition_focuses WHERE manager_id=? AND state='active' ORDER BY revision,updated_at,id LIMIT 1").get(managerId);
        if(!focus||!await think(focus,key))break;
      }
      if(stillCurrent(key))await express(key);
      return true;
    }catch(error){logger.warn?.('[dots-cognition]',error?.message||error);if(propagateErrors)throw error;return false;}
    finally{clearTimeout(deadline);abort=null;busy=false;db.prepare('UPDATE dots_cognition_state SET lease_until=0,lease_owner=NULL WHERE manager_id=? AND lease_owner=?').run(managerId,owner);}
  }
  function observe({id,event,userReferences}){
    const s=settings();if(closed||!s.enabled||!Array.isArray(userReferences)||!userReferences.length||!userReferences.every(ref=>ref.kind==='user'&&refValid(ref)))return false;
    let url;try{url=new URL(event?.url);}catch{return false;}
    if(url.protocol!=='https:'||url.hostname!=='news.google.com'||!url.pathname.startsWith('/rss/articles/'))return false;
    const inserted=db.prepare('INSERT OR IGNORE INTO dots_cognition_observations(id,manager_id,payload,user_refs,created_at) VALUES(?,?,?,?,?)').run(String(id),managerId,JSON.stringify(event),JSON.stringify(userReferences),now()).changes;
    return Boolean(inserted||db.prepare('SELECT 1 FROM dots_cognition_observations WHERE manager_id=? AND id=? AND payload=? AND user_refs=?').get(managerId,String(id),JSON.stringify(event),JSON.stringify(userReferences)));
  }
  function workState(){
    const s=state();
    const active=db.prepare("SELECT COUNT(*) n FROM dots_cognition_focuses WHERE manager_id=? AND state='active'").get(managerId).n;
    const pending=db.prepare("SELECT COUNT(*) n FROM dots_cognition_intents WHERE manager_id=? AND state='pending'").get(managerId).n;
    const progress=s.contribution_revision;
    const contributions=s.contribution_revision;
    const observations=db.prepare("SELECT id FROM dots_cognition_observations WHERE manager_id=? AND user_refs<>'[]' ORDER BY created_at DESC,id LIMIT 8").all(managerId);
    const users=db.prepare("SELECT id,revision FROM manager_messages WHERE manager_id=? AND role='user' AND id>? ORDER BY id DESC LIMIT 32").all(managerId,s.source_floor).filter(row=>!forgotten(row.id));
    const context=db.prepare("SELECT id,revision,delivery_state FROM manager_messages WHERE manager_id=? AND (request_id IS NULL OR request_id NOT LIKE 'registration:%') ORDER BY id DESC LIMIT 12").all(managerId);
    const held=db.prepare("SELECT COUNT(*) n FROM dots_cognition_intents WHERE manager_id=? AND state='held'").get(managerId).n;
    return {active,pending,held,evidence:settings().enabled&&users.length>0?1:0,inputKey:hash(JSON.stringify([users,observations])),contextKey:hash(JSON.stringify(context)),progressStamp:hash(JSON.stringify([contributions,observations,pending])),stamp:hash(JSON.stringify([s.knowledge_key,s.compute_calls,progress,s.understanding,pending]))};
  }
  return {pump,observe,workState,reconcile,close(){closed=true;abort?.abort(new Error('Cognition closed'));db.prepare('UPDATE dots_cognition_state SET lease_until=0,lease_owner=NULL WHERE manager_id=? AND lease_owner=?').run(managerId,owner);},get busy(){return busy;}};
}
