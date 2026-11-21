import {createHash, randomUUID} from 'node:crypto';
import {matchContentOpportunity,connectionAlreadyCovered,contentTerms,normalizedText} from './natural-opportunities.ts';
import {createAutonomousReflection} from './autonomous-reflection.ts';

const parse=(text,fallback={})=>{try{return JSON.parse(text);}catch{return fallback;}};
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const clean=value=>String(value??'').trim();
const digest=value=>createHash('sha256').update(String(value)).digest('hex');
const normalized=value=>clean(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu,'');
const only=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))throw fail('共同话题包含不支持的字段');};
const bounded=(value,max)=>typeof value==='string'&&value.trim().length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const unsafe=/(?:-----BEGIN .*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)[-_A-Za-z0-9]{16,}|(?:密码|验证码|私钥|密钥|身份证号|银行卡号)\s*[:：是为]\s*\S+)/i;

// Shared experiences are not instructions or task records. Content review and
// publication are driven by actual content and finite unfinished thought, never clock ticks.
export interface DotsRelationshipOptions {
  db: any;
  managerId: string;
  now: () => number;
  transaction: (fn: () => any) => any;
  retireLegacyOpportunities: () => void;
  activityEvent: (...args: any[]) => any;
}
export function createDotsRelationship({db,managerId,now,transaction,retireLegacyOpportunities,activityEvent}: DotsRelationshipOptions) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dots_relationship_state(manager_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,memory_revision TEXT NOT NULL DEFAULT '',migration_user_watermark INTEGER);
    CREATE TABLE IF NOT EXISTS dots_relationship_topics(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,topic_key TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,open_question TEXT NOT NULL,source_message_ids TEXT NOT NULL,evidence TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,review_after INTEGER NOT NULL,fingerprint TEXT NOT NULL,memory_blocked INTEGER NOT NULL DEFAULT 0,UNIQUE(manager_id,topic_key));
    CREATE TABLE IF NOT EXISTS dots_relationship_tombstones(manager_id TEXT NOT NULL,topic_key TEXT NOT NULL,source_watermark INTEGER NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(manager_id,topic_key));
    CREATE TABLE IF NOT EXISTS dots_relationship_forgotten_sources(manager_id TEXT NOT NULL,message_id INTEGER NOT NULL,PRIMARY KEY(manager_id,message_id));
    CREATE TABLE IF NOT EXISTS dots_relationship_candidates(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,topic_id TEXT NOT NULL,topic_revision INTEGER NOT NULL,settings_revision INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',review_after INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,cycle INTEGER NOT NULL DEFAULT 1,declines INTEGER NOT NULL DEFAULT 0,message_id INTEGER,reason TEXT NOT NULL DEFAULT '',content_hash TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(manager_id,topic_id,topic_revision));
    CREATE TABLE IF NOT EXISTS dots_relationship_deliveries(message_id INTEGER PRIMARY KEY,manager_id TEXT NOT NULL,topic_id TEXT NOT NULL,content_hash TEXT NOT NULL,new_value TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dots_relationship_signals(manager_id TEXT NOT NULL,event_key TEXT NOT NULL,kind TEXT NOT NULL,message_id INTEGER,created_at INTEGER NOT NULL,PRIMARY KEY(manager_id,event_key));
    CREATE TABLE IF NOT EXISTS dots_relationship_content_events(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,source_run_id TEXT NOT NULL,event_key TEXT NOT NULL,source_ids TEXT NOT NULL,reply_message_id INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(manager_id,source_run_id),UNIQUE(manager_id,event_key));
    CREATE TABLE IF NOT EXISTS dots_relationship_event_candidates(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,event_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'pending',match_json TEXT NOT NULL,input_watermark INTEGER NOT NULL,relationship_revision INTEGER NOT NULL,memory_revision TEXT NOT NULL,reply_message_id INTEGER NOT NULL,content_key TEXT NOT NULL,run_id TEXT,reason TEXT NOT NULL DEFAULT '',message_id INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(manager_id,content_key));
    CREATE INDEX IF NOT EXISTS dots_relationship_event_queue ON dots_relationship_event_candidates(manager_id,state,created_at);
    CREATE INDEX IF NOT EXISTS dots_relationship_candidates_due ON dots_relationship_candidates(manager_id,state,review_after);
  `);
  if(!db.prepare('PRAGMA table_info(dots_relationship_state)').all().some(column=>column.name==='timed_review_retired'))db.exec('ALTER TABLE dots_relationship_state ADD COLUMN timed_review_retired INTEGER NOT NULL DEFAULT 0');
  // Retain legacy settings only as an inert archive. No initiative or feedback
  // value participates in the new runtime. Shared topics and source evidence stay.
  transaction(()=>{
    if(db.prepare('SELECT 1 FROM dots_relationship_state WHERE manager_id=?').get(managerId))return;
    const legacyTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dots_relationship_settings'").get();
    const legacy=legacyTable&&db.prepare('SELECT revision,created_at,memory_revision FROM dots_relationship_settings WHERE manager_id=?').get(managerId);
    db.prepare('INSERT INTO dots_relationship_state(manager_id,revision,created_at,memory_revision,migration_user_watermark) VALUES(?,?,?,?,NULL)').run(managerId,legacy?legacy.revision+1:1,legacy?.created_at??now(),legacy?.memory_revision??'');
  });
  // Retire the old clock-driven queue once, including a run already reviewing
  // it. User messages, worker reports and source memories remain untouched.
  transaction(()=>{
    if(db.prepare('SELECT timed_review_retired FROM dots_relationship_state WHERE manager_id=?').get(managerId).timed_review_retired)return;
    db.prepare("UPDATE dots_relationship_candidates SET state='invalidated',reason='基于时间的主动复审已移除',updated_at=? WHERE manager_id=? AND state IN ('pending','queued','deferred')").run(now(),managerId);
    retireLegacyOpportunities();
    db.prepare('UPDATE dots_relationship_state SET timed_review_retired=1,revision=revision+1 WHERE manager_id=?').run(managerId);
  });
  let reflection;
  const stateRow=()=>db.prepare('SELECT * FROM dots_relationship_state WHERE manager_id=?').get(managerId);
  const latestUserId=()=>Number(db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM manager_messages WHERE manager_id=? AND role='user'").get(managerId).id);
  const topicRow=id=>db.prepare('SELECT * FROM dots_relationship_topics WHERE manager_id=? AND id=?').get(managerId,id);
  const publicTopic=row=>({id:row.id,title:row.title,summary:row.summary,openQuestion:row.open_question,sourceMessageIds:parse(row.source_message_ids,[]),revision:row.revision,updatedAt:row.updated_at*1000,needsReview:Boolean(row.memory_blocked)});
  const invalidate=(reason,topicId=null)=>{
    reflection?.invalidate(reason);
    db.prepare("UPDATE dots_relationship_event_candidates SET state='invalidated',reason=?,updated_at=? WHERE manager_id=? AND state IN ('pending','claimed')").run(reason,now(),managerId);
    db.prepare("UPDATE dots_relationship_candidates SET state='invalidated',reason=?,updated_at=? WHERE manager_id=? AND state IN ('pending','queued','deferred') AND (? IS NULL OR topic_id=?)").run(reason,now(),managerId,topicId,topicId);
  };
  const withdrawEvidence=(topicId=null)=>{
    const sourceIds=new Set(topicId===null?[]:parse(topicRow(topicId)?.source_message_ids,[]));
    reflection?.withdraw(topicId,sourceIds);
    for(const row of db.prepare('SELECT id,match_json,message_id FROM dots_relationship_event_candidates WHERE manager_id=?').all(managerId)){
      const match=parse(row.match_json);
      if(topicId===null||[match.prior,match.fresh].some(fact=>fact&&(fact.topicId===topicId||sourceIds.has(fact.messageId)))){
        db.prepare("UPDATE dots_relationship_event_candidates SET match_json='{}',reason='',state=CASE WHEN state IN ('pending','claimed') THEN 'invalidated' ELSE state END,updated_at=? WHERE id=?").run(now(),row.id);
        if(row.message_id)db.prepare("UPDATE dots_relationship_deliveries SET new_value='' WHERE manager_id=? AND message_id=?").run(managerId,row.message_id);
      }
    }
    db.prepare("UPDATE dots_relationship_deliveries SET new_value='' WHERE manager_id=? AND (? IS NULL OR topic_id=?)").run(managerId,topicId,topicId);
  };
  const snapshot=()=>{
    const s=stateRow();
    return {revision:s.revision,topics:db.prepare('SELECT * FROM dots_relationship_topics WHERE manager_id=? ORDER BY updated_at DESC,id LIMIT 100').all(managerId).map(publicTopic)};
  };
  const changed=()=>activityEvent('relationship_updated','共同话题已更新',{revision:stateRow().revision});
  const deleteTopic=id=>transaction(()=>{
    const row=topicRow(id);if(!row)return snapshot();
    db.prepare('INSERT INTO dots_relationship_tombstones(manager_id,topic_key,source_watermark,deleted_at) VALUES(?,?,?,?) ON CONFLICT(manager_id,topic_key) DO UPDATE SET source_watermark=MAX(source_watermark,excluded.source_watermark),deleted_at=excluded.deleted_at').run(managerId,row.topic_key,latestUserId(),now());
    for(const messageId of parse(row.source_message_ids,[]))db.prepare('INSERT OR IGNORE INTO dots_relationship_forgotten_sources(manager_id,message_id) VALUES(?,?)').run(managerId,messageId);
    db.prepare("UPDATE dots_relationship_deliveries SET new_value='' WHERE manager_id=? AND topic_id=?").run(managerId,id);
    db.prepare("UPDATE dots_relationship_candidates SET reason='' WHERE manager_id=? AND topic_id=?").run(managerId,id);
    invalidate('用户删除了这个话题',id);withdrawEvidence(id);db.prepare('UPDATE dots_relationship_state SET revision=revision+1 WHERE manager_id=?').run(managerId);db.prepare('DELETE FROM dots_relationship_topics WHERE manager_id=? AND id=?').run(managerId,id);changed();return snapshot();
  });
  const updateTopic=(id,input)=>transaction(()=>{
    only(input,['title','summary','openQuestion','revision']);
    const row=topicRow(id);if(!row)throw fail('共同话题不存在',404);
    if(input.revision!==undefined&&input.revision!==row.revision)throw fail('共同话题已更新，请刷新后重试',409);
    const title=input.title??row.title,summary=input.summary??row.summary,question=input.openQuestion??row.open_question;
    if(!bounded(title,200)||!title.trim()||!bounded(summary,4000)||!summary.trim()||!bounded(question,2000)||unsafe.test(title+summary+question))throw fail('请填写有效的共同话题');
    const fingerprint=digest(normalized(title+summary+question));if(title.trim()===row.title&&summary.trim()===row.summary&&question.trim()===row.open_question&&!row.memory_blocked)return snapshot();
    invalidate('用户纠正了这个话题',id);withdrawEvidence(id);db.prepare('UPDATE dots_relationship_state SET revision=revision+1 WHERE manager_id=?').run(managerId);
    db.prepare('UPDATE dots_relationship_topics SET title=?,summary=?,open_question=?,fingerprint=?,evidence=?,revision=revision+1,memory_blocked=0,updated_at=?,review_after=? WHERE id=?').run(title.trim(),summary.trim(),question.trim(),fingerprint,'[]',now(),0,id);
    changed();return snapshot();
  });
  const observeUser=message=>{
    reflection?.invalidate('用户已开始新的交流');
    db.prepare("UPDATE dots_relationship_event_candidates SET state='invalidated',reason='用户已开始新的交流',updated_at=? WHERE manager_id=? AND state IN ('pending','claimed')").run(now(),managerId);
    // Incoming authenticated input always invalidates the prior spontaneous turn.
    db.prepare("UPDATE dots_relationship_candidates SET state='invalidated',reason='用户已开始新的交流',updated_at=? WHERE manager_id=? AND state='queued'").run(now(),managerId);
  };
  const learn=(value,sourceIds,expectedRevision)=>{
    const changes: any[]=[];
    if(!value||!sourceIds.length||expectedRevision!==undefined&&expectedRevision!==stateRow().revision)return changes;
    const allowed=new Set(sourceIds),source=id=>allowed.has(id)?db.prepare("SELECT id,content FROM manager_messages WHERE manager_id=? AND id=? AND role='user'").get(managerId,id):null;
    if(parse(stateRow().memory_revision,{enabled:true}).enabled===false)return changes;
    for(const item of (Array.isArray(value.topics)?value.topics:[]).slice(0,3)){
      if(!item||typeof item!=='object'||!Array.isArray(item.source_message_ids))continue;
      const ids: any[]=[...new Set(item.source_message_ids||[])].filter(id=>source(id));
      if(!ids.length||ids.length!==(item.source_message_ids||[]).length||!Array.isArray(item.evidence)||!item.evidence.length||item.evidence.some(text=>typeof text!=='string'||text.length<2||!ids.some(id=>source(id).content.includes(text))))continue;
      if(!/^[a-z0-9][a-z0-9._:-]{1,99}$/.test(item.key||'')||!bounded(item.title,200)||!item.title.trim()||!bounded(item.summary,4000)||!item.summary.trim()||!bounded(item.open_question,2000)||unsafe.test(item.title+item.summary+item.evidence.join(' ')))continue;
      if(ids.some(id=>db.prepare('SELECT 1 FROM dots_relationship_forgotten_sources WHERE manager_id=? AND message_id=?').get(managerId,id)))continue;
      const tombstone=db.prepare('SELECT source_watermark FROM dots_relationship_tombstones WHERE manager_id=? AND topic_key=?').get(managerId,item.key);
      if(tombstone&&ids.some(id=>id<=tombstone.source_watermark))continue;
      const existing=db.prepare('SELECT * FROM dots_relationship_topics WHERE manager_id=? AND topic_key=?').get(managerId,item.key);
      // An extraction must include new evidence, never rewrite a topic from only old inputs.
      if(existing&&ids.every(id=>parse(existing.source_message_ids,[]).includes(id)))continue;
      const fingerprint=digest(normalized(item.title+item.summary+item.open_question));
      if(existing&&fingerprint===existing.fingerprint&&!existing.memory_blocked)continue;
      if(!existing&&Number(db.prepare('SELECT COUNT(*) AS n FROM dots_relationship_topics WHERE manager_id=?').get(managerId).n)>=100)continue;
      const id=existing?.id||randomUUID();if(existing)invalidate('共同话题有新的内容',id);
      db.prepare('INSERT INTO dots_relationship_topics(id,manager_id,topic_key,title,summary,open_question,source_message_ids,evidence,created_at,updated_at,review_after,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(manager_id,topic_key) DO UPDATE SET title=excluded.title,summary=excluded.summary,open_question=excluded.open_question,source_message_ids=excluded.source_message_ids,evidence=excluded.evidence,revision=revision+1,memory_blocked=0,updated_at=excluded.updated_at,review_after=excluded.review_after,fingerprint=excluded.fingerprint').run(id,managerId,item.key,item.title.trim(),item.summary.trim(),item.open_question.trim(),JSON.stringify(ids),JSON.stringify(item.evidence),now(),now(),0,fingerprint);
      changes.push({before:existing||null,after:topicRow(id)});
    }
    return changes;
  };
  const blocked=()=>parse(stateRow().memory_revision,{enabled:true}).enabled===false||db.prepare('SELECT status FROM managers WHERE id=?').get(managerId)?.status!=='active';
  const evidenceFor=topic=>{
    if(!topic||topic.memory_blocked)return [];
    const out: any[]=[];
    for(const id of parse(topic.source_message_ids,[])){
      if(db.prepare('SELECT 1 FROM dots_relationship_forgotten_sources WHERE manager_id=? AND message_id=?').get(managerId,id))continue;
      const original=db.prepare("SELECT content FROM manager_messages WHERE manager_id=? AND id=? AND role='user'").get(managerId,id);
      if(!original)continue;
      for(const quote of parse(topic.evidence,[]))if(typeof quote==='string'&&original.content.includes(quote))out.push({messageId:id,quote,topicId:topic.id,topicRevision:topic.revision});
    }
    return out;
  };
  reflection=createAutonomousReflection({db,managerId,now,stateRow,latestUserId,topicRow,evidenceFor,blocked,unsafe});
  const initializeReflection=()=>stateRow().cognition_enabled?null:reflection.initialize();
  const recordReflection=options=>stateRow().cognition_enabled?null:reflection.record(options);
  const noteConversation=options=>reflection.noteConversation(options);
  const recordContentEvent=({runId,sourceIds,replyMessageId,changes=[],eligible}: any={})=>{
    if(stateRow().cognition_enabled||!eligible||!sourceIds?.length||blocked())return null;
    const accepted=new Set(sourceIds),fresh: any[]=[];
    // Short-lived observations need not be promoted to permanent memory. Only
    // real user text is fresh material; an assistant message never seeds itself.
    for(const messageId of sourceIds){
      const original=db.prepare("SELECT content FROM manager_messages WHERE manager_id=? AND id=? AND role='user'").get(managerId,messageId);
      if(!original||db.prepare('SELECT 1 FROM dots_relationship_forgotten_sources WHERE manager_id=? AND message_id=?').get(managerId,messageId))continue;
      for(const quote of (original.content.match(/[^。！？!?\n]+[。！？!?]?/gu)||[]).slice(0,30)){
        const text=quote.trim().slice(0,1000);if(text&&!unsafe.test(quote))fresh.push({messageId,quote:text});
      }
    }
    if(!fresh.length)return null;
    const reply=db.prepare("SELECT content FROM manager_messages WHERE manager_id=? AND id=? AND role='assistant' AND origin='reply' AND delivery_state='completed'").get(managerId,replyMessageId);if(!reply)return null;
    const beforeById=new Map(changes.map(change=>[change.after.id,change.before]));
    const prior=db.prepare('SELECT * FROM dots_relationship_topics WHERE manager_id=? AND memory_blocked=0 ORDER BY updated_at DESC,id LIMIT 100').all(managerId).flatMap(row=>{
      // Updated facts may correct the earlier statement. Do not present the
      // superseded version as a still-confirmed second side of a connection.
      const before=beforeById.has(row.id)?null:row;
      return evidenceFor(before).map(item=>({...item,topicRevision:row.revision}));
    }).filter(item=>!accepted.has(item.messageId));
    const unique=(rows: any[])=>[...new Map(rows.map(row=>[row.messageId+':'+normalizedText(row.quote),row])).values()];
    const match=matchContentOpportunity({fresh:unique(fresh).slice(-12),prior:unique(prior).slice(0,300),reply:reply.content});if(!match)return null;
    const eventId=randomUUID(),eventKey=digest(JSON.stringify(fresh.map(row=>[row.messageId,normalizedText(row.quote)]).sort()));
    const inserted=db.prepare('INSERT OR IGNORE INTO dots_relationship_content_events(id,manager_id,source_run_id,event_key,source_ids,reply_message_id,created_at) VALUES(?,?,?,?,?,?,?)').run(eventId,managerId,runId,eventKey,JSON.stringify(sourceIds),replyMessageId,now());
    if(!inserted.changes)return null;
    const contentKey=digest(JSON.stringify([normalizedText(match.fresh.quote),normalizedText(match.prior.quote)]));
    const id=randomUUID(),state=stateRow();
    const created=db.prepare("INSERT OR IGNORE INTO dots_relationship_event_candidates(id,manager_id,event_id,state,match_json,input_watermark,relationship_revision,memory_revision,reply_message_id,content_key,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?,?,?,?,?,?)").run(id,managerId,eventId,JSON.stringify(match),latestUserId(),state.revision,state.memory_revision,replyMessageId,contentKey,now(),now());
    return created.changes?id:null;
  };
  const candidateRow=id=>db.prepare('SELECT c.* FROM dots_relationship_event_candidates c JOIN dots_relationship_content_events e ON e.id=c.event_id AND e.manager_id=c.manager_id WHERE c.manager_id=? AND c.id=?').get(managerId,id);
  const validCandidate=row=>{
    if(!row||!['pending','claimed'].includes(row.state)||blocked()||latestUserId()!==row.input_watermark||stateRow().revision!==row.relationship_revision||stateRow().memory_revision!==row.memory_revision)return false;
    const match=parse(row.match_json),facts=[match.fresh,match.prior];
    if(facts.some(fact=>!fact||fact.topicId&&(topicRow(fact.topicId)?.revision!==fact.topicRevision||topicRow(fact.topicId)?.memory_blocked)))return false;
    for(const fact of facts){
      if(db.prepare('SELECT 1 FROM dots_relationship_forgotten_sources WHERE manager_id=? AND message_id=?').get(managerId,fact.messageId))return false;
      const original=db.prepare("SELECT content FROM manager_messages WHERE manager_id=? AND id=? AND role='user'").get(managerId,fact.messageId);
      if(!original?.content.includes(fact.quote))return false;
    }
    return true;
  };
  const nextCandidate=()=>{
    if(stateRow().cognition_enabled)return null;
    for(const row of db.prepare("SELECT * FROM dots_relationship_event_candidates WHERE manager_id=? AND state='pending' ORDER BY created_at,id").all(managerId)){
      if(validCandidate(row))return row;
      db.prepare("UPDATE dots_relationship_event_candidates SET state='invalidated',reason='来源或当前对话已变化',updated_at=? WHERE id=?").run(now(),row.id);
    }
    return reflection.next();
  };
  const hasPending=()=>!stateRow().cognition_enabled&&(Boolean(db.prepare("SELECT 1 FROM dots_relationship_event_candidates WHERE manager_id=? AND state='pending' LIMIT 1").get(managerId))||reflection.hasPending());
  const bindRun=(candidate,run)=>candidate.kind==='reflection'?reflection.bind(candidate,run):db.prepare("UPDATE dots_relationship_event_candidates SET state='claimed',run_id=?,updated_at=? WHERE id=? AND manager_id=? AND state='pending'").run(run.id,now(),candidate.id,managerId).changes===1;
  const forRun=run=>{
    const durable=run&&db.prepare('SELECT * FROM manager_runs WHERE manager_id=? AND id=? AND fence=?').get(managerId,run.id,run.fence);
    if(durable?.purpose!=='content_review')return null;
    if(durable.reflection_id)return reflection.forRun(durable);
    if(!durable.content_candidate_id)return null;
    const candidate=candidateRow(durable.content_candidate_id);
    // Purpose is durable even if the candidate was invalidated while the model
    // was working. Never fall through to the ordinary task/streaming path.
    return {candidate:candidate?.run_id===run.id?candidate:null,match:candidate?.run_id===run.id?parse(candidate.match_json):null,reply:candidate?db.prepare('SELECT content FROM manager_messages WHERE manager_id=? AND id=?').get(managerId,candidate.reply_message_id)?.content||'':''};
  };
  const cancelRun=(run,reason='本次内容评估已结束')=>{
    const durable=run&&db.prepare('SELECT * FROM manager_runs WHERE manager_id=? AND id=? AND fence=?').get(managerId,run.id,run.fence);
    if(durable?.purpose==='content_review'&&durable.reflection_id)return reflection.cancel(durable,reason);
    if(durable?.purpose==='content_review')db.prepare("UPDATE dots_relationship_event_candidates SET state='cancelled',reason=?,updated_at=? WHERE manager_id=? AND id=? AND run_id=? AND state IN ('pending','claimed')").run(reason,now(),managerId,durable.content_candidate_id,durable.id);
  };
  const finish=(context,decision,publish)=>{
    if(context?.kind==='reflection')return reflection.finish(context,decision,publish);
    const candidate=context?.candidate,live=candidate&&candidateRow(candidate.id),match=live&&parse(live.match_json);
    const noInput=!db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL LIMIT 1').get(managerId);
    const noStream=!db.prepare("SELECT 1 FROM manager_messages WHERE manager_id=? AND delivery_state='streaming' LIMIT 1").get(managerId);
    const valid=live?.state==='claimed'&&live.run_id===candidate.run_id&&validCandidate(live)&&noInput&&noStream;
    let state=valid?'discarded':'invalidated',reason=clean(decision?.reason).slice(0,500),message: any=null;
    if(valid&&decision?.action==='send'){
      const content=clean(decision.message),connection=clean(decision.new_connection),quotes=Array.isArray(decision.source_quotes)?decision.source_quotes:[];
      const exactFacts=[match.fresh,match.prior].every(fact=>quotes.some(ref=>ref?.message_id===fact.messageId&&typeof ref.quote==='string'&&normalizedText(ref.quote).length>=8&&fact.quote.includes(ref.quote)));
      const allQuotes=quotes.length>=2&&quotes.length<=8&&quotes.every(ref=>[match.fresh,match.prior].some(fact=>ref?.message_id===fact.messageId&&typeof ref.quote==='string'&&fact.quote.includes(ref.quote)));
      const both=value=>{const terms=contentTerms(value);return match.freshTerms.some(term=>terms.has(term))&&match.priorTerms.some(term=>terms.has(term));},usesBoth=both(content);
      const hash=digest(normalized(content));
      const duplicate=db.prepare('SELECT 1 FROM dots_relationship_deliveries WHERE manager_id=? AND content_hash=?').get(managerId,hash);
      const priorValues=db.prepare('SELECT new_value FROM dots_relationship_deliveries WHERE manager_id=?').all(managerId);
      const repeated=priorValues.some(row=>connectionAlreadyCovered(connection,row.new_value));
      const pressure=/(?:怎么|为什么|为何).{0,10}(?:不回|没回|不理)|(?:还没|还没有).{0,6}(?:回复|回答)|我一直在等|不理我|再问你一次/.test(content);
      const generic=/^(?:你好[呀啊！!。 ]*|早上好[！!。 ]*|最近(?:怎么样|还好吗)[？?。 ]*)$/.test(content);
      const exactPrior=db.prepare('SELECT content FROM manager_messages WHERE manager_id=? ORDER BY id DESC LIMIT 100').all(managerId).some(row=>normalized(row.content)===normalized(content));
      if(content&&content.length<=1200&&reason&&connection.length>=12&&clean(decision.not_covered_by_reply).length>=8&&decision.conversation_appropriate===true&&exactFacts&&allQuotes&&usesBoth&&!unsafe.test(content+connection)&&!duplicate&&!repeated&&!exactPrior&&!pressure&&!generic&&!connectionAlreadyCovered(connection,context.reply)&&!connectionAlreadyCovered(content,context.reply)){
        message=publish(content,{origin:'proactive',topicId:match.prior.topicId,proactiveReason:reason});state='sent';
        db.prepare('INSERT INTO dots_relationship_deliveries(message_id,manager_id,topic_id,content_hash,new_value,created_at) VALUES(?,?,?,?,?,?)').run(message.id,managerId,match.prior.topicId,hash,connection,now());
      }else reason='来源、新联系或当前回复未覆盖条件不足';
    }
    if(live)db.prepare('UPDATE dots_relationship_event_candidates SET state=?,reason=?,message_id=?,updated_at=? WHERE id=?').run(state,valid?reason:'当前输入或来源已变化',message?.id??null,now(),live.id);
    return {message,state};
  };
  const memoryChanged=value=>transaction(()=>{
    const marker=JSON.stringify({generation:Number(value?.generation||0),enabled:value?.enabled!==false}),before=stateRow();if(marker===before.memory_revision)return;
    db.prepare('UPDATE dots_relationship_state SET memory_revision=?,revision=revision+1 WHERE manager_id=?').run(marker,managerId);
    if(before.memory_revision){
      // A user correction/deletion withdraws old personalization. Preserve the
      // visible topic for user correction, but never send from it until a new
      // authenticated conversation or an explicit topic edit confirms it again.
      for(const topic of db.prepare('SELECT source_message_ids FROM dots_relationship_topics WHERE manager_id=?').all(managerId))for(const messageId of parse(topic.source_message_ids,[]))db.prepare('INSERT OR IGNORE INTO dots_relationship_forgotten_sources(manager_id,message_id) VALUES(?,?)').run(managerId,messageId);
      db.prepare('UPDATE dots_relationship_topics SET memory_blocked=1 WHERE manager_id=?').run(managerId);
      invalidate('长期记忆已变化，需要新的用户来源');withdrawEvidence();
    }
  });
  const safeHistory=messages=>{const forgotten=new Set(db.prepare('SELECT message_id FROM dots_relationship_forgotten_sources WHERE manager_id=?').all(managerId).map(row=>row.message_id));return messages.filter(message=>message.createdAt>=stateRow().created_at&&!forgotten.has(message.id)&&!(message.respondsToMessageIds||[]).some(id=>forgotten.has(id))&&(message.role==='user'||message.origin==='proactive'||(message.respondsToMessageIds||[]).length)&&!(message.origin==='proactive'&&(!db.prepare("SELECT 1 FROM dots_relationship_deliveries WHERE manager_id=? AND message_id=? AND new_value<>''").get(managerId,message.id)||!topicRow(message.topicId)||topicRow(message.topicId).memory_blocked||message.createdAt<=topicRow(message.topicId).updated_at)));};
  const context=(text='')=>{
    const s=snapshot();if(parse(stateRow().memory_revision,{enabled:true}).enabled===false)return {...s,topics:[]};
    const query=normalized(text),tokens=value=>new Set(Array.from({length:Math.max(0,value.length-1)},(_,i)=>value.slice(i,i+2))),queryTokens=tokens(query);
    const ranked=s.topics.filter(topic=>!topic.needsReview).map(topic=>({topic,score:[...tokens(normalized(topic.title+' '+topic.summary))].filter(token=>queryTokens.has(token)).length})).sort((a,b)=>b.score-a.score||b.topic.updatedAt-a.topic.updatedAt);
    const topics: any[]=[];let used=0;for(const {topic} of ranked){const item={...topic,key:topicRow(topic.id).topic_key,summary:topic.summary.slice(0,1600),openQuestion:topic.openQuestion.slice(0,600)};const size=JSON.stringify(item).length;if(used+size>12000)continue;topics.push(item);used+=size;if(topics.length>=12)break;}
    return {revision:s.revision,topics};
  };
  return {snapshot,context,safeHistory,updateTopic,deleteTopic,observeUser,learn,recordContentEvent,initializeReflection,recordReflection,noteConversation,nextCandidate,hasPending,bindRun,forRun,cancelRun,finish,memoryChanged,invalidate};
}
