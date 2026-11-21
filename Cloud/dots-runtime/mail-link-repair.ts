import {normalizeMailPresentationLinks} from './qq-mail-content.ts';

// A presentation correction is a real message revision. Otherwise native and
// browser caches correctly reject changed content carrying the same revision.
export function repairMailPresentationLinks(store: any){
 const {db,managerId}=store;
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dots_mail_events'").get())return 0;
 return store.transaction(()=>{
  const rows=db.prepare(`SELECT m.id,m.content,e.id AS event_id FROM manager_messages m
    JOIN dots_mail_events e ON e.message_id=m.id AND e.manager_id=m.manager_id
    WHERE m.manager_id=? AND m.role='assistant' AND m.origin='proactive' AND e.state='sent'
    AND m.content LIKE '%邮件中的链接：%' ORDER BY m.id`).all(managerId);
  let count=0;
  for(const row of rows){
   const content=normalizeMailPresentationLinks(row.content);
   if(content===row.content)continue;
   store.refreshMail({eventId:row.event_id,content});count++;
  }
  return count;
 });
}
