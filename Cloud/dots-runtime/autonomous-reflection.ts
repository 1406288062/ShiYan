import {createHash,randomUUID} from 'node:crypto';
import {normalizedText,contentTerms,connectionAlreadyCovered} from './natural-opportunities.ts';

const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const parse=(value,fallback={})=>{try{return JSON.parse(value);}catch{return fallback;}};
const text=value=>typeof value==='string'?value.trim():'';
const words=new Intl.Segmenter('zh',{granularity:'word'});
const contentAnchors=value=>{
  const terms=contentTerms(value);
  // Source grounding must also recognize meaningful single-character words.
  // This is a lightweight anchor, not a demand to repeat the original wording
  // or a substitute for the private semantic assessment of an interpretation.
  for(const part of words.segment(String(value)))if(part.isWordLike&&/^[\p{Script=Han}]$/u.test(part.segment)&&!/[我你他她它的了是在和与也又就都很不有可把被着过想会能将所之从向让给为到得地吗呢啊吧呀于及或而则但才先后再更最这那哪其此每各另多些等一二三四五六七八九十百千万上下中时]/u.test(part.segment))terms.add(part.segment);
  return terms;
};

// A finite unit of unfinished thought over authenticated shared material. Time,
// silence, client presence and the assistant's own output never create work.
export function createAutonomousReflection({db,managerId,now,stateRow,latestUserId,topicRow,evidenceFor,blocked,unsafe}){
  db.exec(`
    CREATE TABLE IF NOT EXISTS dots_relationship_reflections(
      id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,corpus_key TEXT NOT NULL,
      materials_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
      input_watermark INTEGER NOT NULL,relationship_revision INTEGER NOT NULL,memory_revision TEXT NOT NULL,
      run_id TEXT,covered_candidate_id TEXT,thought_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT NOT NULL DEFAULT '',message_id INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(manager_id,corpus_key));
    CREATE INDEX IF NOT EXISTS dots_reflection_queue ON dots_relationship_reflections(manager_id,state,created_at);
    CREATE TABLE IF NOT EXISTS dots_relationship_conversation(
      manager_id TEXT PRIMARY KEY,reply_message_id INTEGER,awaiting_user_input INTEGER,
      ordinary_work INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
  `);
  if(!db.prepare('PRAGMA table_info(dots_relationship_state)').all().some(row=>row.name==='reflection_initialized'))db.exec('ALTER TABLE dots_relationship_state ADD COLUMN reflection_initialized INTEGER NOT NULL DEFAULT 0');
  const row=id=>db.prepare('SELECT * FROM dots_relationship_reflections WHERE manager_id=? AND id=?').get(managerId,id);
  const conversation=()=>{
    const state=db.prepare('SELECT * FROM dots_relationship_conversation WHERE manager_id=?').get(managerId);
    const running=Boolean(db.prepare("SELECT 1 FROM manager_runs WHERE manager_id=? AND kind IN ('worker','approval') AND state='running' LIMIT 1").get(managerId));
    const unfinished=Boolean(db.prepare("SELECT 1 FROM goals WHERE manager_id=? AND legacy_imported=0 AND status='active' AND next_wake_at IS NOT NULL AND next_wake_at<=? LIMIT 1").get(managerId,now()));
    return {latestReplyId:state?.reply_message_id??null,awaitingUserInput:state?.awaiting_user_input==null?null:Boolean(state.awaiting_user_input),ordinaryWork:running||unfinished,observedAt:state?.updated_at??null,evaluationAt:now()};
  };
  const noteConversation=({replyMessageId,awaitingUserInput,ordinaryWork,hasUserInput=true})=>{
    const awaiting=conversation().awaitingUserInput===true&&!hasUserInput?true:awaitingUserInput;
    db.prepare('INSERT INTO dots_relationship_conversation(manager_id,reply_message_id,awaiting_user_input,ordinary_work,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(manager_id) DO UPDATE SET reply_message_id=excluded.reply_message_id,awaiting_user_input=excluded.awaiting_user_input,ordinary_work=excluded.ordinary_work,updated_at=excluded.updated_at').run(managerId,replyMessageId,typeof awaiting==='boolean'?Number(awaiting):null,Number(Boolean(ordinaryWork)),now());
  };
  const evidence=()=>{
    const topics=db.prepare('SELECT * FROM dots_relationship_topics WHERE manager_id=? AND memory_blocked=0 ORDER BY updated_at DESC,id').all(managerId);
    const seen=new Set(),all=[];
    for(const topic of topics){
      let count=0;
      for(const source of evidenceFor(topic)){
        const normalized=normalizedText(source.quote);
        if(normalized.length<8||contentTerms(source.quote).size<3||unsafe.test(source.quote)||seen.has(normalized))continue;
        seen.add(normalized);all.push({...source,source:'confirmed_topic',title:topic.title,selected:count++<2});
      }
    }
    // Fingerprint ALL eligible original content, not its title, timestamp,
    // database ID, alias topic or only the bounded prompt selection.
    const corpusKey=all.length?hash(JSON.stringify([...seen].sort())):null;
    const topicIds=new Set(),materials=[];
    for(const fact of all){
      if(!fact.selected)continue;
      if(!topicIds.has(fact.topicId)&&topicIds.size>=6)continue;
      topicIds.add(fact.topicId);const {selected,...material}=fact;materials.push(material);
    }
    return {corpusKey,materials};
  };
  const invalidate=reason=>db.prepare("UPDATE dots_relationship_reflections SET state='invalidated',reason=?,updated_at=? WHERE manager_id=? AND state IN ('pending','claimed')").run(reason,now(),managerId);
  const record=({coveredCandidateId=null}={})=>{
    if(!stateRow().reflection_initialized||blocked())return null;
    const {corpusKey,materials}=evidence();if(!corpusKey||!materials.length)return null;
    if(db.prepare('SELECT 1 FROM dots_relationship_reflections WHERE manager_id=? AND corpus_key=?').get(managerId,corpusKey))return null;
    invalidate('共同材料已形成新的版本');
    const id=randomUUID(),state=stateRow();
    db.prepare('INSERT INTO dots_relationship_reflections(id,manager_id,corpus_key,materials_json,state,input_watermark,relationship_revision,memory_revision,covered_candidate_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,managerId,corpusKey,JSON.stringify(materials),coveredCandidateId?'covered':'pending',latestUserId(),state.revision,state.memory_revision,coveredCandidateId,now(),now());
    return coveredCandidateId?null:id;
  };
  const initialize=()=>{
    if(stateRow().reflection_initialized)return null;
    db.prepare('UPDATE dots_relationship_state SET reflection_initialized=1 WHERE manager_id=?').run(managerId);
    // Existing knowledge is an actual backlog, not a fresh startup greeting.
    // Subsequent startup does nothing, including after deleting a topic.
    const active=db.prepare("SELECT id FROM dots_relationship_event_candidates WHERE manager_id=? AND input_watermark=? AND state IN ('pending','claimed') ORDER BY created_at DESC LIMIT 1").get(managerId,latestUserId());
    return record({coveredCandidateId:active?.id??null});
  };
  const valid=work=>{
    if(!work||!['pending','claimed'].includes(work.state)||blocked()||latestUserId()!==work.input_watermark||stateRow().revision!==work.relationship_revision||stateRow().memory_revision!==work.memory_revision)return false;
    const materials=parse(work.materials_json,[]);if(!materials.length)return false;
    return materials.every(fact=>{
      const topic=topicRow(fact.topicId);
      return topic&&!topic.memory_blocked&&topic.revision===fact.topicRevision&&evidenceFor(topic).some(ref=>ref.messageId===fact.messageId&&ref.quote===fact.quote);
    });
  };
  const next=()=>{
    const current=conversation();if(current.awaitingUserInput===true||current.ordinaryWork)return null;
    for(const work of db.prepare("SELECT * FROM dots_relationship_reflections WHERE manager_id=? AND state='pending' ORDER BY created_at,id").all(managerId)){
      if(valid(work))return {...work,kind:'reflection'};
      db.prepare("UPDATE dots_relationship_reflections SET state='invalidated',reason='来源或当前对话已变化',updated_at=? WHERE id=?").run(now(),work.id);
    }
    return null;
  };
  const hasPending=()=>Boolean(db.prepare("SELECT 1 FROM dots_relationship_reflections WHERE manager_id=? AND state='pending' LIMIT 1").get(managerId));
  const bind=(work,run)=>db.prepare("UPDATE dots_relationship_reflections SET state='claimed',run_id=?,updated_at=? WHERE id=? AND manager_id=? AND state='pending'").run(run.id,now(),work.id,managerId).changes===1;
  const coveredReplies=materials=>{
    const sourceIds=new Set(materials.map(ref=>ref.messageId));
    const topicIds=new Set(materials.map(ref=>ref.topicId)),originals=new Set(materials.map(ref=>normalizedText(ref.quote)));
    const forgotten=new Set(db.prepare('SELECT message_id FROM dots_relationship_forgotten_sources WHERE manager_id=?').all(managerId).map(ref=>ref.message_id));
    // Fetch the original associated replies even if they predate module setup
    // or the last twenty messages. Disconnected personal context is excluded.
    const ordinary=db.prepare("SELECT id,content,responds_to_message_ids FROM manager_messages WHERE manager_id=? AND role='assistant' AND delivery_state='completed' ORDER BY id").all(managerId)
      .filter(message=>{const ids=parse(message.responds_to_message_ids,[]);return ids.some(id=>sourceIds.has(id))&&!ids.some(id=>forgotten.has(id));})
      .map(message=>({id:message.id,content:message.content}));
    const proactive=[];
    for(const delivery of db.prepare("SELECT d.message_id,d.topic_id,d.new_value,m.content FROM dots_relationship_deliveries d JOIN manager_messages m ON m.id=d.message_id AND m.manager_id=d.manager_id WHERE d.manager_id=? AND d.new_value<>'' AND m.delivery_state='completed' ORDER BY d.message_id").all(managerId)){
      if(!topicRow(delivery.topic_id)||topicRow(delivery.topic_id).memory_blocked)continue;
      const priorThought=db.prepare('SELECT materials_json FROM dots_relationship_reflections WHERE manager_id=? AND message_id=?').get(managerId,delivery.message_id);
      const priorCandidate=db.prepare('SELECT match_json FROM dots_relationship_event_candidates WHERE manager_id=? AND message_id=?').get(managerId,delivery.message_id);
      const match=parse(priorCandidate?.match_json),refs=priorThought?parse(priorThought.materials_json,[]):[match.fresh,match.prior].filter(Boolean);
      if(!topicIds.has(delivery.topic_id)&&!refs.some(ref=>originals.has(normalizedText(ref.quote))))continue;
      proactive.push({id:delivery.message_id,content:delivery.content,insight:delivery.new_value});
    }
    return [...ordinary,...proactive].sort((a,b)=>a.id-b.id);
  };
  const forRun=run=>{
    const work=row(run.reflection_id),bound=work?.run_id===run.id;
    const materials=bound?parse(work.materials_json,[]):[];
    return {kind:'reflection',reflection:bound?work:null,materials,coveredReplies:coveredReplies(materials),conversation:conversation()};
  };
  const cancel=(run,reason)=>db.prepare("UPDATE dots_relationship_reflections SET state='cancelled',reason=?,updated_at=? WHERE manager_id=? AND id=? AND run_id=? AND state IN ('pending','claimed')").run(reason,now(),managerId,run.reflection_id,run.id);
  const withdraw=(topicId=null,sourceIds=new Set())=>{
    for(const work of db.prepare('SELECT id,materials_json,message_id FROM dots_relationship_reflections WHERE manager_id=?').all(managerId)){
      const materials=parse(work.materials_json,[]);
      if(topicId!==null&&!materials.some(fact=>fact.topicId===topicId||sourceIds.has(fact.messageId)))continue;
      db.prepare("UPDATE dots_relationship_reflections SET materials_json='[]',thought_json='{}',reason='',state=CASE WHEN state IN ('pending','claimed') THEN 'invalidated' ELSE state END,updated_at=? WHERE id=?").run(now(),work.id);
      if(work.message_id)db.prepare("UPDATE dots_relationship_deliveries SET new_value='' WHERE manager_id=? AND message_id=?").run(managerId,work.message_id);
    }
  };
  const finish=(context,decision,publish)=>{
    const work=context?.reflection&&row(context.reflection.id),materials=work?parse(work.materials_json,[]):[];
    const current=conversation();
    const noInput=!db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL LIMIT 1').get(managerId);
    const noStream=!db.prepare("SELECT 1 FROM manager_messages WHERE manager_id=? AND delivery_state='streaming' LIMIT 1").get(managerId);
    const currentWork=work?.state==='claimed'&&work.run_id===context.reflection.run_id&&valid(work)&&noInput&&noStream&&current.awaitingUserInput!==true&&!current.ordinaryWork;
    let state=currentWork?'discarded':'invalidated',reason=text(decision?.reason).slice(0,500),message=null;
    const content=text(decision?.message),insight=text(decision?.insight),quotes=Array.isArray(decision?.source_quotes)?decision.source_quotes:[];
    const citations=quotes.map(ref=>materials.find(fact=>ref?.message_id===fact.messageId&&typeof ref.quote==='string'&&normalizedText(ref.quote).length>=8&&fact.quote.includes(ref.quote)));
    const grounded=quotes.length>=1&&quotes.length<=8&&citations.every(Boolean);
    const uniqueSources=new Set(citations.filter(Boolean).map(ref=>normalizedText(ref.quote)));
    const enoughSources=decision?.idea_kind==='perspective'&&uniqueSources.size>=1||decision?.idea_kind==='connection'&&uniqueSources.size>=2;
    // The thought is private and durable before its separate publication checks.
    // Never reintroduce withdrawn quotes when a late model result arrives.
    if(currentWork&&grounded&&!unsafe.test(content+insight))db.prepare('UPDATE dots_relationship_reflections SET thought_json=?,updated_at=? WHERE id=?').run(JSON.stringify({idea_kind:decision.idea_kind,insight,source_quotes:quotes}),now(),work.id);
    if(currentWork&&decision?.action==='send'){
      const replies=coveredReplies(materials),previous=db.prepare('SELECT new_value FROM dots_relationship_deliveries WHERE manager_id=?').all(managerId);
      const previousMessages=db.prepare("SELECT content FROM manager_messages WHERE manager_id=? AND role='assistant' AND delivery_state='completed'").all(managerId);
      const repeated=replies.some(reply=>connectionAlreadyCovered(insight,reply.content)||connectionAlreadyCovered(content,reply.content))||previous.some(reply=>connectionAlreadyCovered(insight,reply.new_value))||previousMessages.some(reply=>normalizedText(reply.content)===normalizedText(content));
      const copied=materials.some(fact=>connectionAlreadyCovered(insight,fact.quote)||normalizedText(fact.quote)===normalizedText(content));
      const rendered=normalizedText(content);
      const usesSources=citations.filter(Boolean).every(fact=>[...contentAnchors(fact.quote)].some(term=>rendered.includes(term)));
      const pressure=/(?:怎么|为什么|为何).{0,10}(?:不回|没回|不理)|(?:还没|还没有).{0,6}(?:回复|回答)|我一直在等|不理我|再问你一次/.test(content);
      if(content&&content.length<=1200&&insight.length>=12&&insight.length<=1400&&reason&&text(decision.not_covered_by_history).length>=8&&decision.conversation_appropriate===true&&grounded&&enoughSources&&usesSources&&!unsafe.test(content+insight)&&!repeated&&!copied&&!pressure){
        const topicId=citations[0].topicId;
        message=publish(content,{origin:'proactive',topicId,proactiveReason:reason});state='sent';
        db.prepare('INSERT INTO dots_relationship_deliveries(message_id,manager_id,topic_id,content_hash,new_value,created_at) VALUES(?,?,?,?,?,?)').run(message.id,managerId,topicId,hash(normalizedText(content)),insight,now());
      }else reason='来源、新见解或既有表达未覆盖条件不足';
    }
    if(work)db.prepare('UPDATE dots_relationship_reflections SET state=?,reason=?,message_id=?,updated_at=? WHERE id=?').run(state,currentWork?reason:'当前输入或来源已变化',message?.id??null,now(),work.id);
    return {message,state};
  };
  return {initialize,record,noteConversation,conversation,next,hasPending,bind,forRun,cancel,finish,invalidate,withdraw};
}
