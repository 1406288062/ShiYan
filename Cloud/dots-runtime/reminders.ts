// 定时提醒：Dots 在回复里排好提醒（时间 + 要说的话 + 是否重复），到点由服务器直接把这句话推给用户。
// 到点时不调用模型，所以不额外消耗额度。需要“到点去查一下再告诉我”的定期检查仍然走后台任务。
// 时间一律按北京时间（UTC+8），数据库里存秒。
const ZONE_MS = 8 * 3600_000;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export const REPEATS = ['none', 'daily', 'weekdays', 'weekly'];
const REPEAT_LABEL = { none: '一次', daily: '每天', weekdays: '工作日', weekly: '每周' };
const MAX_ACTIVE = 50, MISSED_GRACE = 3 * 3600;

// "2026-11-12 08:00" (北京时间) -> 秒
export function parseLocal(text: any) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - ZONE_MS;
  const check = new Date(ms + ZONE_MS);
  if (check.getUTCMonth() !== +m[2] - 1 || check.getUTCDate() !== +m[3]) return null;
  return Math.floor(ms / 1000);
}
export function formatLocal(sec: any, { weekday = true } = {}) {
  const d = new Date(sec * 1000 + ZONE_MS), p = (n: any) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` + (weekday ? ` 星期${WEEK[d.getUTCDay()]}` : '');
}
export function nextOccurrence(sec: any, repeat: any) {
  if (repeat === 'daily') return sec + 86400;
  if (repeat === 'weekly') return sec + 7 * 86400;
  if (repeat === 'weekdays') { let next = sec + 86400; while ([0, 6].includes(new Date(next * 1000 + ZONE_MS).getUTCDay())) next += 86400; return next; }
  return null;
}

export function createReminders({ store, now = () => Date.now(), intervalMs = 30_000, logger = console }: any) {
  const { db, managerId } = store;
  db.exec("CREATE TABLE IF NOT EXISTS dots_reminders(id INTEGER PRIMARY KEY AUTOINCREMENT,manager_id TEXT NOT NULL,text TEXT NOT NULL,next_at INTEGER NOT NULL,repeat TEXT NOT NULL DEFAULT 'none',state TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,fired_count INTEGER NOT NULL DEFAULT 0)");
  db.exec('CREATE INDEX IF NOT EXISTS idx_dots_reminders_due ON dots_reminders(state,next_at)');
  let timer: ReturnType<typeof setInterval> | null = null, stopped = false;
  const nowSec = () => Math.floor(now() / 1000);

  function add({ at, text, repeat = 'none' }: any) {
    const when = parseLocal(at), body = String(text || '').trim().slice(0, 500);
    if (!when || !body) return { ok: false, error: '时间或内容无效' };
    if (when < nowSec() - 120) return { ok: false, error: '时间已经过去' };
    const active = db.prepare("SELECT COUNT(*) n FROM dots_reminders WHERE manager_id=? AND state='active'").get(managerId).n;
    if (active >= MAX_ACTIVE) return { ok: false, error: '提醒太多了' };
    const kind = REPEATS.includes(repeat) ? repeat : 'none';
    const same = db.prepare("SELECT id FROM dots_reminders WHERE manager_id=? AND state='active' AND next_at=? AND text=?").get(managerId, when, body);
    if (same) return { ok: true, id: same.id, duplicate: true };
    const id = Number(db.prepare('INSERT INTO dots_reminders(manager_id,text,next_at,repeat,created_at) VALUES(?,?,?,?,?)').run(managerId, body, when, kind, nowSec()).lastInsertRowid);
    return { ok: true, id };
  }
  function cancel(ids: any) {
    let n = 0;
    for (const id of ids || []) n += Number(db.prepare("UPDATE dots_reminders SET state='cancelled' WHERE manager_id=? AND id=? AND state='active'").run(managerId, Number(id)).changes);
    return n;
  }
  function list() {
    return db.prepare("SELECT id,text,next_at,repeat FROM dots_reminders WHERE manager_id=? AND state='active' ORDER BY next_at LIMIT 30").all(managerId)
      .map((r: any) => ({ id: r.id, at: formatLocal(r.next_at), repeat: (REPEAT_LABEL as any)[r.repeat] || '一次', text: r.text }));
  }
  // Dots 回复里的 reminders / cancel_reminders 在提交后执行。
  function apply(result: any) {
    const out: {added: any[]; failed: any[]; cancelled: number} = { added: [], failed: [], cancelled: 0 };
    for (const r of Array.isArray(result?.reminders) ? result.reminders.slice(0, 10) : []) { const v = add(r); (v.ok ? out.added : out.failed).push(v.ok ? v.id : v.error); }
    if (Array.isArray(result?.cancel_reminders)) out.cancelled = cancel(result.cancel_reminders.slice(0, 30));
    return out;
  }
  function tick() {
    if (stopped) return;
    const t = nowSec();
    for (const r of db.prepare("SELECT * FROM dots_reminders WHERE manager_id=? AND state='active' AND next_at<=? ORDER BY next_at LIMIT 20").all(managerId, t)) {
      // 服务停机错过太久的不再补发；重复提醒跳到下一次。
      const late = t - r.next_at > MISSED_GRACE;
      let next = nextOccurrence(r.next_at, r.repeat);
      while (next !== null && next <= t) next = nextOccurrence(next, r.repeat);
      // 先改状态再推送：推送失败也不会反复推同一条。
      db.prepare('UPDATE dots_reminders SET next_at=?,state=?,fired_count=fired_count+? WHERE id=?').run(next ?? r.next_at, next === null ? 'done' : 'active', late ? 0 : 1, r.id);
      if (late) continue;
      try { store.publishProactive({ content: '⏰ 提醒：' + r.text, reason: '提醒' }); }
      catch (error) { logger.warn?.('[reminders] ' + String((error as any)?.message || error).slice(0, 200)); }
    }
  }
  return {
    add, cancel, list, apply, tick,
    start() { if (timer || stopped) return; timer = setInterval(tick, intervalMs); timer.unref?.(); tick(); },
    close() { stopped = true; clearInterval(timer!); timer = null; },
  };
}

// 主动推送偏好：用户说过的“哪些想听、哪些别发、什么时候、怎么说”，用自然语言存一份。
// Dots 回复时整份更新（保留与这次无关的偏好）；早报、主动推送、反思在决定发不发时读它。
export function createProactivePreferences({ store, now = () => Date.now() }: any) {
  const { db, managerId } = store;
  db.exec("CREATE TABLE IF NOT EXISTS dots_proactive_preferences(manager_id TEXT PRIMARY KEY,content TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL)");
  return {
    get() { return db.prepare('SELECT content FROM dots_proactive_preferences WHERE manager_id=?').get(managerId)?.content || ''; },
    set(content: any) {
      const text = String(content ?? '').trim().slice(0, 2000);
      db.prepare('INSERT INTO dots_proactive_preferences(manager_id,content,updated_at) VALUES(?,?,?) ON CONFLICT(manager_id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at').run(managerId, text, Math.floor(now() / 1000));
      return text;
    },
  };
}
