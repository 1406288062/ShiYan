import {createHash,randomUUID} from 'node:crypto';

const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const parse=(value,fallback=null)=>{try{return JSON.parse(value);}catch{return fallback;}};
const clean=value=>typeof value==='string'?value.trim():'';
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const str=maxLength=>({type:'string',maxLength});
const secret=/(?:-----BEGIN|\b(?:sk|ghp|github_pat)[-_A-Za-z0-9]{16,}|密码|验证码|私钥|密钥|身份证|银行卡|https?:|@|\/Users\/|\/home\/)/i;
export const INTEREST_SCHEMA=object({interests:{type:'array',maxItems:6,items:object({public_query:str(80),source_message_id:{type:'integer'},quote:str(500),ongoing_interest:{type:'boolean'},public_subject:{type:'boolean'},supporting_quotes:{type:'array',maxItems:4,items:object({source_message_id:{type:'integer'},quote:str(500)})}})}});
export const UPDATE_SCHEMA=object({selected_event_key:str(64),action:{type:'string',enum:['send','discard']},message:str(1200),reason:str(500),interest_quote:str(500),event_quote:str(1000),relevant:{type:'boolean'},novel:{type:'boolean'},appropriate:{type:'boolean'}});

const decode=value=>String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';}).replace(/&(amp|lt|gt|quot|apos);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[key]));
const plain=value=>decode(decode(value).replace(/<[^>]*>/g,'')).replace(/\s+/g,' ').trim();
// Only this fixed, public news endpoint is fetched. Model output cannot select
// a network host, local file, credential or an arbitrary URL to retrieve.
export const newsUrl=query=>'https://news.google.com/rss/search?'+new URLSearchParams({q:query,hl:'zh-CN',gl:'CN',ceid:'CN:zh-Hans'});
export function parseNewsFeed(xml){
  if(typeof xml!=='string'||xml.length>512*1024||/<!DOCTYPE|<!ENTITY/i.test(xml)||!/<rss[\s>]/i.test(xml)||!/<\/rss>/i.test(xml))throw new Error('Invalid news feed');
  const get=(block,name)=>block.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'))?.[1]||'';
  const result=[];
  for(const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)){
    const block=match[1],title=plain(get(block,'title')).slice(0,500),summary=plain(get(block,'description')).slice(0,1800),url=decode(get(block,'link')).trim();
    const published=Date.parse(plain(get(block,'pubDate')))/1000;
    let link;try{link=new URL(url);}catch{continue;}
    if(!title||!Number.isFinite(published)||link.protocol!=='https:'||link.hostname!=='news.google.com'||!link.pathname.startsWith('/rss/articles/')||link.username||link.password)continue;
    const publisher=plain(get(block,'source')).slice(0,200);
    if(!publisher)continue;
    const guid=plain(get(block,'guid'))||url;
    result.push({key:hash(guid),title,summary,url,publisher,published});
    if(result.length>=50)break;
  }
  return result;
}
export async function readPublicNews(query,{fetchImpl=fetch,signal}={}){
  const response=await fetchImpl(newsUrl(query),{signal,redirect:'error',headers:{accept:'application/rss+xml, application/xml, text/xml','user-agent':'ShiYan-Dots/1.0'}});
  if(!response.ok)throw new Error('News source HTTP '+response.status);
  if(Number(response.headers.get('content-length')||0)>512*1024)throw new Error('News source too large');
  const reader=response.body.getReader(),decoder=new TextDecoder();let size=0,xml='';
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>512*1024)throw new Error('News source too large');xml+=decoder.decode(value,{stream:true});}xml+=decoder.decode();}
  finally{await reader.cancel().catch(()=>{});}
  return parseNewsFeed(xml);
}

// A source monitor, not a scheduled chat. Network checks run independently of
// user messages/tasks. Only a newly published, unseen external item can create
// a candidate; elapsed chat silence never creates one.
export interface PublicDiscoveryOptions {
  store: any;
  assess: (data: any, schema: any, control?: any) => Promise<any>;
  memory: any;
  readNews?: any;
  now?: () => number;
  pollSeconds?: number;
  onObservation?: ((observation: any) => boolean) | null;
  propagateErrors?: boolean;
  logger?: Console;
}
export function createPublicDiscovery({store,assess,memory,readNews=readPublicNews,now=()=>Math.floor(Date.now()/1000),pollSeconds=900,onObservation=null,propagateErrors=false,logger=console}: PublicDiscoveryOptions){
  const {db,managerId}=store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS dots_discovery_state(manager_id TEXT PRIMARY KEY,source_key TEXT NOT NULL DEFAULT '',memory_key TEXT NOT NULL DEFAULT '',source_floor INTEGER NOT NULL DEFAULT 0,next_extract_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS dots_discovery_interests(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,query TEXT NOT NULL,source_id INTEGER NOT NULL,quote TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,initialized INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,next_poll_at INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,UNIQUE(manager_id,query));
    CREATE TABLE IF NOT EXISTS dots_discovery_seen(manager_id TEXT NOT NULL,event_key TEXT NOT NULL,content_key TEXT NOT NULL,first_seen INTEGER NOT NULL,PRIMARY KEY(manager_id,event_key),UNIQUE(manager_id,content_key));
    CREATE TABLE IF NOT EXISTS dots_discovery_updates(id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,interest_id TEXT NOT NULL,event_key TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL DEFAULT '',message_id INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(manager_id,event_key));
  `);
  if(!db.prepare('PRAGMA table_info(dots_discovery_interests)').all().some(row=>row.name==='evidence_json'))db.exec("ALTER TABLE dots_discovery_interests ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'");
  db.prepare('INSERT OR IGNORE INTO dots_discovery_state(manager_id) VALUES(?)').run(managerId);
  // A crash must not cause a private draft to be delivered or regenerated.
  db.prepare("UPDATE dots_discovery_updates SET state='abandoned',reason='评估进程已中断',updated_at=? WHERE manager_id=? AND state='assessing'").run(now(),managerId);
  let busy=false,closed=false,abort=null;
  const state=()=>db.prepare('SELECT * FROM dots_discovery_state WHERE manager_id=?').get(managerId);
  const memoryState=()=>memory?.settings?memory.settings(store.ownerId):{enabled:true,generation:0};
  const memoryKey=value=>JSON.stringify([value.enabled,value.generation??0]);
  const forgotten=id=>Boolean(db.prepare('SELECT 1 FROM dots_relationship_forgotten_sources WHERE manager_id=? AND message_id=?').get(managerId,id));
  const authentic=interest=>{
    const source=db.prepare("SELECT content FROM manager_messages WHERE manager_id=? AND id=? AND role='user'").get(managerId,interest.source_id);
    if(!source||forgotten(interest.source_id)||!source.content.includes(interest.quote))return false;
    return parse(interest.evidence_json,[]).every(ref=>{const original=db.prepare("SELECT content FROM manager_messages WHERE manager_id=? AND id=? AND role='user'").get(managerId,ref.source_id);return original&&!forgotten(ref.source_id)&&original.content.includes(ref.quote);});
  };
  const watermark=()=>db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM manager_messages WHERE manager_id=? AND role='user'").get(managerId).id;
  const current=()=>{
    if(db.prepare('SELECT status FROM managers WHERE id=?').get(managerId)?.status!=='active')return false;
    if(db.prepare('SELECT 1 FROM manager_inbox WHERE manager_id=? AND consumed_at IS NULL').get(managerId))return false;
    if(db.prepare("SELECT 1 FROM manager_runs WHERE manager_id=? AND state='running'").get(managerId))return false;
    if(db.prepare("SELECT 1 FROM manager_messages WHERE manager_id=? AND delivery_state='streaming'").get(managerId))return false;
    if(db.prepare('SELECT awaiting_user_input FROM dots_relationship_conversation WHERE manager_id=?').get(managerId)?.awaiting_user_input)return false;
    if(db.prepare("SELECT 1 FROM goals WHERE manager_id=? AND legacy_imported=0 AND status='active' AND next_wake_at<=?").get(managerId,now()))return false;
    return true;
  };
  const invalidate=()=>store.transaction(()=>{
    db.prepare('UPDATE dots_discovery_interests SET active=0,quote=\'\',evidence_json=\'[]\' WHERE manager_id=?').run(managerId);
    db.prepare("UPDATE dots_discovery_updates SET state='withdrawn',payload='{}',reason='' WHERE manager_id=? AND state IN ('pending','assessing')").run(managerId);
  });
  const history=()=>db.prepare("SELECT id,content FROM manager_messages WHERE manager_id=? AND role='user' AND id>? ORDER BY id DESC LIMIT 32").all(managerId,state().source_floor).filter(row=>!forgotten(row.id)&&!secret.test(row.content)).reverse().map(row=>({id:row.id,content:row.content.slice(0,500)}));
  async function refreshInterests(settings){
    const sources=history(),sourceKey=hash('public-interest-v2:'+JSON.stringify(sources)),s=state();
    if(s.source_key===sourceKey||s.next_extract_at>now())return;
    const result=await assess(JSON.stringify({operation:'identify_public_interests',user_evidence:sources}),INTEREST_SCHEMA,{signal:abort.signal});
    if(closed||abort.signal.aborted||memoryKey(memoryState())!==memoryKey(settings)||hash('public-interest-v2:'+JSON.stringify(history()))!==sourceKey)return;
    if(!Array.isArray(result?.interests)||result.interests.length>6)throw new Error('Invalid interest assessment');
    const selected=[];
    for(const item of result.interests){
      const query=clean(item.public_query).replace(/\s+/g,' '),quote=clean(item.quote),source=sources.find(row=>row.id===item.source_message_id);
      if(item.ongoing_interest!==true||item.public_subject!==true||!source||quote.length<6||quote.length>500||!source.content.includes(quote)||query.length<2||query.length>80||secret.test(query)||!/^[\p{L}\p{N} .+#&·’'-]+$/u.test(query))continue;
      const support=(Array.isArray(item.supporting_quotes)?item.supporting_quotes:[]).filter(ref=>typeof ref?.quote==='string'&&ref.quote.trim().length>=6&&sources.some(row=>row.id===ref.source_message_id&&row.content.includes(ref.quote)));
      const explicit=/(?:我|本人).{0,12}(?:一直|长期|特别|很|比较|最)?(?:喜欢|喜爱|热爱|关注|感兴趣)|对.{1,40}(?:感兴趣|很有兴趣)|(?:I|my)\b.{0,25}\b(?:like|love|interest|follow)|(?:新动态|新消息|新进展).{0,15}(?:告诉我|跟我说|分享给我)/iu.test(quote);
      if(!explicit&&new Set([source.id,...support.map(ref=>ref.source_message_id)]).size<2)continue;
      selected.push({query,quote,sourceId:source.id,evidence:[{source_id:source.id,quote},...support.map(ref=>({source_id:ref.source_message_id,quote:ref.quote}))]});
    }
    store.transaction(()=>{
      const selectedQueries=new Set(selected.map(item=>item.query));
      for(const old of db.prepare('SELECT id,query FROM dots_discovery_interests WHERE manager_id=? AND active=1').all(managerId))if(!selectedQueries.has(old.query))db.prepare('UPDATE dots_discovery_interests SET active=0 WHERE id=?').run(old.id);
      for(const interest of selected)db.prepare('INSERT INTO dots_discovery_interests(id,manager_id,query,source_id,quote,created_at,evidence_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(manager_id,query) DO UPDATE SET next_poll_at=CASE WHEN dots_discovery_interests.active=0 THEN 0 ELSE dots_discovery_interests.next_poll_at END,initialized=CASE WHEN dots_discovery_interests.active=0 THEN 0 ELSE dots_discovery_interests.initialized END,created_at=CASE WHEN dots_discovery_interests.active=0 THEN excluded.created_at ELSE dots_discovery_interests.created_at END,active=1,source_id=excluded.source_id,quote=excluded.quote,evidence_json=excluded.evidence_json').run(randomUUID(),managerId,interest.query,interest.sourceId,interest.quote,now(),JSON.stringify(interest.evidence));
      db.prepare('UPDATE dots_discovery_state SET source_key=?,memory_key=?,next_extract_at=0 WHERE manager_id=?').run(sourceKey,memoryKey(settings),managerId);
    });
  }
  async function poll(interest){
    const items=await readNews(interest.query,{signal:abort.signal});
    if(closed||abort.signal.aborted||!authentic(interest))return;
    // All items in the first successful read form a baseline, not a backlog of
    // old news to message. A failed first fetch never establishes a baseline.
    store.transaction(()=>{
      for(const event of items){
        if(!event||!clean(event.title)||!clean(event.publisher)||!Number.isFinite(event.published)||event.published>now()+300)continue;
        let url;try{url=new URL(event.url);}catch{continue;}
        if(url.protocol!=='https:'||url.hostname!=='news.google.com'||!url.pathname.startsWith('/rss/articles/')||url.username||url.password)continue;
        const contentKey=hash(event.title.normalize('NFKC').replace(/\s+/g,'').toLowerCase());
        const inserted=db.prepare('INSERT OR IGNORE INTO dots_discovery_seen(manager_id,event_key,content_key,first_seen) VALUES(?,?,?,?)').run(managerId,event.key,contentKey,now());
        if(inserted.changes&&interest.initialized&&event.published>interest.created_at&&event.published>=now()-172800){
          db.prepare('INSERT OR IGNORE INTO dots_discovery_updates(id,manager_id,interest_id,event_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),managerId,interest.id,event.key,JSON.stringify(event),now(),now());
        }
      }
      db.prepare('UPDATE dots_discovery_interests SET initialized=1,failures=0,next_poll_at=? WHERE id=?').run(now()+pollSeconds,interest.id);
    });
  }
  function reconcile(){
    const settings=memoryState(),s=state(),key=memoryKey(settings);
    if((!settings.enabled||s.memory_key&&s.memory_key!==key)&&s.memory_key!==key){
      invalidate();
      db.prepare("UPDATE dots_discovery_updates SET state='withdrawn',payload='{}',reason='' WHERE manager_id=?").run(managerId);
      db.prepare("UPDATE dots_discovery_state SET source_key='',memory_key=?,source_floor=? WHERE manager_id=?").run(key,watermark(),managerId);
    }
    for(const interest of db.prepare("SELECT * FROM dots_discovery_interests WHERE manager_id=? AND quote<>''").all(managerId))if(!authentic(interest)){
      db.prepare("UPDATE dots_discovery_interests SET active=0,quote='',evidence_json='[]' WHERE id=?").run(interest.id);
      db.prepare("UPDATE dots_discovery_updates SET state='withdrawn',payload='{}',reason='' WHERE manager_id=? AND interest_id=?").run(managerId,interest.id);
    }
    return Boolean(settings.enabled);
  }
  async function tick(){
    if(busy||closed)return false;busy=true;abort=new AbortController();
    const deadline=setTimeout(()=>abort.abort(new Error('Discovery deadline')),60000);deadline.unref?.();
    try{
      const settings=memoryState(),s=state(),epoch=memoryKey(settings);
      if(!settings.enabled||s.memory_key&&s.memory_key!==epoch){invalidate();db.prepare("UPDATE dots_discovery_state SET source_key='',memory_key=?,source_floor=? WHERE manager_id=?").run(epoch,watermark(),managerId);if(!settings.enabled)return false;}
      await refreshInterests(settings);
      if(closed||abort.signal.aborted||memoryKey(memoryState())!==epoch)return false;
      const interests=db.prepare('SELECT * FROM dots_discovery_interests WHERE manager_id=? AND active=1 AND next_poll_at<=? ORDER BY next_poll_at,id LIMIT 2').all(managerId,now());
      for(const interest of interests){
        if(!authentic(interest)){db.prepare("UPDATE dots_discovery_interests SET active=0,quote='',evidence_json='[]' WHERE id=?").run(interest.id);continue;}
        try{await poll(interest);}catch(error){const failures=interest.failures+1;db.prepare('UPDATE dots_discovery_interests SET failures=?,next_poll_at=? WHERE id=?').run(failures,now()+Math.min(21600,pollSeconds*2**Math.min(failures,4)),interest.id);logger.warn?.('[public-discovery-source]',error?.message||error);}
      }
      if(memoryKey(memoryState())===epoch&&onObservation){
        for(const update of db.prepare("SELECT u.*,i.quote,i.source_id,i.evidence_json,i.active FROM dots_discovery_updates u JOIN dots_discovery_interests i ON i.id=u.interest_id WHERE u.manager_id=? AND u.state='pending' ORDER BY u.created_at,u.id LIMIT 40").all(managerId)){
          if(!update.active||!authentic(update)){db.prepare("UPDATE dots_discovery_updates SET state='withdrawn',payload='{}' WHERE id=?").run(update.id);continue;}
          const refs=parse(update.evidence_json,[]).map(ref=>({kind:'user',id:String(ref.source_id),quote:ref.quote}));
          if(onObservation({id:update.event_key,event:parse(update.payload),userReferences:refs}))db.prepare("UPDATE dots_discovery_updates SET state='observed',reason='已成为认知过程的观察材料',updated_at=? WHERE id=? AND state='pending'").run(now(),update.id);
        }
      }
      return true;
    }catch(error){db.prepare('UPDATE dots_discovery_state SET next_extract_at=? WHERE manager_id=? AND source_key=?').run(now()+600,managerId,state().source_key);logger.warn?.('[public-discovery]',error?.message||error);if(propagateErrors)throw error;return false;}
    finally{clearTimeout(deadline);abort=null;busy=false;}
  }
  return {tick,reconcile,close(){closed=true;abort?.abort(new Error('Discovery closed'));},get busy(){return busy;}};
}
