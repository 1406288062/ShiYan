// 记忆摘要由程序确定性生成，不调用任何大模型。
// 记忆本身已经过提取、去重和分类；设置页只负责按类别整理展示。
export const SECTIONS = [
  { id: 'profile', title: '关于你' },
  { id: 'preference', title: '偏好与习惯' },
  { id: 'project', title: '项目与工作' },
  { id: 'context', title: '近期在做' },
];

const clip = (text, max) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
};

export function buildMemorySummary(memories) {
  const sections: any[] = [];
  for (const section of SECTIONS) {
    const seen = new Set();
    const points: any[] = [];
    for (const memory of memories.filter(item => item.category === section.id)) {
      const point = clip(memory.content, 60);
      const key = point.toLocaleLowerCase();
      if (!point || seen.has(key)) continue;
      seen.add(key);
      points.push(point);
      if (points.length >= 8) break;
    }
    if (points.length) sections.push({ ...section, points });
  }
  return sections;
}

export const fallbackSummary = buildMemorySummary;

export function createMemorySummary(store, { now = () => Date.now() } = {}) {
  store.db.exec('CREATE TABLE IF NOT EXISTS memory_summaries(owner TEXT PRIMARY KEY,revision INTEGER NOT NULL,sections TEXT NOT NULL,generated_at INTEGER NOT NULL)');
  return {
    get(owner) {
      const settings = store.settings(owner);
      const revision = Number(settings.revision || 0);
      const memories = store.list(owner).memories || [];
      const counts = Object.fromEntries(SECTIONS.map(section => [
        section.id, memories.filter(memory => memory.category === section.id).length
      ]));
      if (!memories.length) {
        store.db.prepare('DELETE FROM memory_summaries WHERE owner=?').run(owner);
        return { ok: true, state: 'ready', total: 0, counts, sections: [], generatedAt: null };
      }

      const row = store.db.prepare('SELECT * FROM memory_summaries WHERE owner=?').get(owner);
      const fresh = row && Number(row.revision) === revision;
      if (!fresh) {
        const sections = buildMemorySummary(memories);
        const generatedAt = now();
        store.db.prepare('INSERT INTO memory_summaries(owner,revision,sections,generated_at) VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,sections=excluded.sections,generated_at=excluded.generated_at')
          .run(owner, revision, JSON.stringify(sections), generatedAt);
        return { ok: true, state: 'ready', total: memories.length, counts, sections, generatedAt };
      }
      return {
        ok: true, state: 'ready', total: memories.length, counts,
        sections: JSON.parse(row.sections), generatedAt: Number(row.generated_at)
      };
    },
  };
}
