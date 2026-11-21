// 「做过的事」：把 Dots 以你的名义实际做过的事汇总成一条时间线（只读视图）。
// 来源：执行过的动作回执（manager_actions）、自动放行与授权（timeline）、主动消息（manager_activity），
// 以及没有其它记录的变更（微信绑定、订阅、设置、授权撤销等）写入 dots_audit。时间单位为秒。

const ACTION_LABELS = {
  host_command: '执行命令', inspect_host: '查看主机', mac_codex: '在 Mac 上执行任务', write_file: '写入文件', append_file: '追加文件',
  device_read: '读取设备文件', send_message: '发送消息', memory: '更新记忆', web_fetch: '读取网页', schedule: '安排任务',
};

const clip = (value, max = 240) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max - 1) + '…' : text; };
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };

export function createAuditLog(db, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS dots_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, manager_id TEXT NOT NULL, kind TEXT NOT NULL,
    summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS dots_audit_manager ON dots_audit(manager_id, created_at)');

  function record(managerId, kind, summary, { detail = '', ok = true } = {}) {
    if (!managerId) return;
    db.prepare('INSERT INTO dots_audit(manager_id,kind,summary,detail,ok,created_at) VALUES(?,?,?,?,?,?)').run(managerId, String(kind), clip(summary, 500), clip(detail, 2000), ok ? 1 : 0, now());
  }

  function list(managerId, { before = null, limit = 50, category = null } = {}) {
    limit = Math.max(1, Math.min(200, Number(limit) || 50));
    const cutoff = Number.isFinite(Number(before)) && Number(before) > 0 ? Number(before) : now() + 1;
    const out = [];
    if (!category || category === 'action') for (const row of db.prepare(`SELECT a.id,a.payload,a.state,a.result,a.started_at,a.finished_at,r.goal_id,g.title FROM manager_actions a
        JOIN manager_runs r ON r.id=a.run_id LEFT JOIN goals g ON g.id=r.goal_id
        WHERE r.manager_id=? AND COALESCE(a.finished_at,a.started_at)<? ORDER BY COALESCE(a.finished_at,a.started_at) DESC LIMIT ?`).all(managerId, cutoff, limit)) {
      const payload = parse(row.payload), result = parse(row.result);
      const target = payload.command || payload.path || '';
      out.push({ id: 'action:' + row.id, category: 'action', kind: payload.type || 'action', title: ACTION_LABELS[payload.type] || payload.type || '动作',
        summary: clip(payload.reason || payload.content || ''), detail: clip(target, 400), ok: row.state === 'succeeded', state: row.state,
        goalId: row.goal_id, goalTitle: row.title || null, approvalId: payload.approvalId || null, error: row.state === 'failed' ? clip(result.detail || result.note || '', 300) : null,
        at: row.finished_at || row.started_at });
    }
    if (!category || category === 'action') for (const row of db.prepare(`SELECT t.id,t.kind,t.message,t.data,t.created_at,t.goal_id,g.title FROM timeline t JOIN goals g ON g.id=t.goal_id
        WHERE g.manager_id=? AND t.kind IN ('approval_auto','approval_grant_created','approval_rejected','approval_auto_failed') AND t.created_at<? ORDER BY t.created_at DESC LIMIT ?`).all(managerId, cutoff, limit)) {
      const data = parse(row.data);
      const title = { approval_auto: data.mode === 'grant' ? '按你的授权自动批准' : '按审批方式自动批准', approval_grant_created: '你设置了授权', approval_rejected: '你拒绝了一项操作', approval_auto_failed: '自动批准失败' }[row.kind];
      out.push({ id: 'timeline:' + row.id, category: 'action', kind: row.kind, title, summary: clip(row.message), detail: data.signatures ? data.signatures.join('、') : '', ok: row.kind !== 'approval_auto_failed', goalId: row.goal_id, goalTitle: row.title, at: row.created_at });
    }
    if (!category || category === 'message') for (const row of db.prepare(`SELECT id,message,created_at FROM manager_activity WHERE manager_id=? AND kind='proactive_message' AND created_at<? ORDER BY created_at DESC LIMIT ?`).all(managerId, cutoff, limit)) {
      out.push({ id: 'activity:' + row.id, category: 'message', kind: 'proactive_message', title: '主动给你发了消息', summary: clip(row.message), detail: '', ok: true, at: row.created_at });
    }
    for (const row of db.prepare(`SELECT * FROM dots_audit WHERE manager_id=? AND created_at<? ORDER BY created_at DESC LIMIT ?`).all(managerId, cutoff, limit)) {
      const cat = row.kind.startsWith('weixin') || row.kind.startsWith('message') ? 'message' : row.kind.startsWith('grant') ? 'action' : 'change';
      if (category && category !== cat) continue;
      out.push({ id: 'audit:' + row.id, category: cat, kind: row.kind, title: row.summary, summary: row.detail, detail: '', ok: row.ok === 1, at: row.created_at });
    }
    out.sort((a, b) => b.at - a.at || String(b.id).localeCompare(String(a.id)));
    const items = out.slice(0, limit);
    return { ok: true, items, nextBefore: items.length === limit ? items[items.length - 1].at : null };
  }
  return { record, list };
}
