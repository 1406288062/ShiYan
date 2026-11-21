// Content matching only. These weights describe text overlap, never the user,
// a relationship level, elapsed time, or a desired conversation frequency.
const stop = new Set(('我 我们 你 你们 他 她 它 自己 大家 这个 那个 这些 那些 一个 一些 什么 怎么 为什么 可以 可能 还是 就是 但是 因为 所以 而且 然后 觉得 喜欢 最近 今天 昨天 现在 之前 以后 有点 很多 特别 其实 已经 还有 有趣 知道 想到 发现 观察 变化 准备 尝试 试试 我在 上有 聊聊 聊过 事情 东西 时候 一起 一直 the a an this that these those i we you it is are was were to of and or but in on at for with have has had just really like love about').split(' '));
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const normalizedText = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
export function primaryTerms(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const terms = new Set();
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike || stop.has(part.segment)) continue;
    const word = part.segment;
    if (/^[a-z][a-z0-9-]{2,}$/i.test(word) || /^[\p{Script=Han}]{2,}$/u.test(word)) terms.add(word);
  }
  return terms;
}
export function contentTerms(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase(), terms = primaryTerms(text);
  // Add within-word grams and runs of meaningful single-character segments,
  // not arbitrary pairs spanning whole sentences (which would inflate novelty
  // with grammatical fragments such as “仍想” or “种着”).
  let singles='';
  const grams=run=>{for(let i=0;i<run.length-1;i++){const term=run.slice(i,i+2);if(!stop.has(term))terms.add(term);}};
  const flush=()=>{grams(singles);singles='';};
  for(const part of segmenter.segment(text)){
    const word=part.segment;
    if(part.isWordLike&&/^[\p{Script=Han}]$/u.test(word)&&!/[我你他她它的了是在和与也又就都很不有可把被着过想随]/u.test(word)){singles+=word;continue;}
    flush();if(!stop.has(word)&&/^[\p{Script=Han}]{3,}$/u.test(word))grams(word);
  }
  flush();
  return terms;
}
const intersection = (a, b) => [...a].filter(term => b.has(term));
const difference = (a, b) => [...a].filter(term => !b.has(term));
const covered = (terms, reply, main) => {
  // A reply can cover a connection without repeating every adjective or camera
  // detail in its source. Require two independent distinctive spans on each
  // side, including a segmented word; overlapping grams count only once.
  const ranges: any[]=[];let hasWord=false;
  for(const term of [...terms].sort((a,b)=>Number(main.has(b))-Number(main.has(a))||b.length-a.length)){
    let at=reply.indexOf(term);
    while(at>=0){
      const end=at+term.length;
      if(!ranges.some(([start,stop])=>at<stop&&end>start)){ranges.push([at,end]);hasWord ||= main.has(term);break;}
      at=reply.indexOf(term,at+1);
    }
  }
  return ranges.length>=2&&hasWord;
};
// Evidence records are authenticated original user quotations, not summaries
// invented by the extractor. A distinct prior fact must be recoverable too.
export interface MatchContentOpportunityOptions {
  fresh?: any[];
  prior?: any[];
  reply?: string;
  latestUserText?: string;
}
export function matchContentOpportunity({ fresh = [], prior = [], reply = '', latestUserText = '' }: MatchContentOpportunityOptions = {}) {
  const eligible = row => row && Number.isSafeInteger(row.messageId) && normalizedText(row.quote).length >= 8 && contentTerms(row.quote).size >= 3;
  fresh = fresh.filter(eligible); prior = prior.filter(eligible);
  if (!fresh.length || !prior.length) return null;
  const cached=new Map([...fresh,...prior].map(row=>[row,contentTerms(row.quote)]));
  const lexicalCache=new Map([...fresh,...prior].map(row=>[row,primaryTerms(row.quote)]));
  const documents = [...cached.values()];
  const df = new Map(); for (const terms of documents) for (const term of terms) df.set(term, (df.get(term) || 0) + 1);
  const lexical = new Set([...fresh, ...prior].flatMap(row => [...primaryTerms(row.quote)]));
  const weight = term => (lexical.has(term) ? 2 : .35) * (1 + Math.log(1 + documents.length / (1 + (df.get(term) || 0))));
  const total = terms => [...terms].reduce((sum, term) => sum + weight(term), 0);
  const replyText = normalizedText(reply);
  let best: any = null;
  for (const incoming of fresh) {
    const current = cached.get(incoming);
    // Repeating an old fact under a new message or topic ID is not a new event.
    if (prior.some(old => { const previous = cached.get(old), main=lexicalCache.get(incoming), oldMain=lexicalCache.get(old); return normalizedText(old.quote) === normalizedText(incoming.quote) || total(intersection(current, previous)) / total(current) >= .82 || main!.size>=3&&difference(main,oldMain).length<=1&&intersection(main,oldMain).length/main!.size>=.75; })) continue;
    for (const previous of prior) {
      if (previous.messageId >= incoming.messageId || previous.messageId === incoming.messageId) continue;
      const old = cached.get(previous), shared = intersection(current, old);
      if (!shared.some(term => lexical.has(term)) && shared.length < 2) continue;
      const newTerms = difference(current, old), oldTerms = difference(old, current);
      if (newTerms.length < 2 || oldTerms.length < 2) continue;
      const relevance = total(shared) / Math.min(total(current), total(old));
      const novelty = total(newTerms) / total(current);
      if (relevance < .06 || novelty < .22) continue;
      // An ordinary answer that already uses both sets of distinctive facts
      // covers the connection; changing its wording must not produce a follow-up.
      if (covered(newTerms, replyText, lexicalCache.get(incoming)) && covered(oldTerms, replyText, lexicalCache.get(previous))) continue;
      const score = relevance * Math.min(1, novelty + .25);
      if (!best || score > best.score) best = { fresh: incoming, prior: previous, sharedTerms: shared, freshTerms: newTerms, priorTerms: oldTerms, score };
    }
  }
  return best;
}

export function connectionAlreadyCovered(connection, reply) {
  const value = normalizedText(connection), previous = normalizedText(reply);
  if (!value || previous.includes(value)) return true;
  const terms = contentTerms(connection), before = contentTerms(reply);
  return terms.size < 3 || intersection(terms, before).length / terms.size >= .82;
}
