// 分级审批授权：用户批准一条命令时可以选择「仅这次 / 这个任务 / 1 小时 / 24 小时 / 一直允许」。
// 授权绑定的是命令的「动作类型」（如 git push、systemctl restart、npm），不是整条命令文本；
// bash / python 等万能解释器只按完整命令精确匹配，避免一次授权放开一切。
// 提权和灾难性命令永远不走授权，由调用方在 covers 之前拦截。

export const GRANT_SCOPES = ['task', 'hour', 'day', 'always'];
// 时间统一用秒，和 Dots 其余表一致。
const DURATION = { hour: 3600, day: 86_400, task: 7 * 86_400 };
const MULTI = new Set(['git', 'systemctl', 'docker', 'npm', 'pnpm', 'yarn', 'brew', 'apt', 'apt-get', 'kubectl', 'pip', 'pip3', 'cargo', 'go', 'launchctl', 'journalctl', 'gh', 'make']);
const BROAD = new Set(['bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'eval', 'exec', 'xargs', 'ssh', 'env', 'osascript', 'sudo', 'su', 'doas', 'find']);
const WRAPPERS = new Set(['nohup', 'time', 'nice', 'command', 'builtin', 'timeout']);

export function commandSegments(command) {
  return String(command || '').split(/&&|\|\||[;|\n]/).map(part => part.trim()).filter(Boolean);
}

export function segmentSignature(segment) {
  const tokens = String(segment || '').trim().split(/\s+/).filter(Boolean);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  while (tokens.length && WRAPPERS.has(tokens[0])) { tokens.shift(); if (/^\d+[smhd]?$/.test(tokens[0] || '')) tokens.shift(); }
  if (!tokens.length) return null;
  const base = tokens[0].replace(/^.*\//, '').replace(/^\(+/, '');
  if (!base) return null;
  if (BROAD.has(base)) return 'exact:' + tokens.join(' ');
  if (MULTI.has(base)) {
    const sub = tokens.slice(1).find(token => !token.startsWith('-'));
    return sub ? `${base} ${sub}` : base;
  }
  return base;
}

export function commandSignatures(command) {
  return [...new Set(commandSegments(command).map(segmentSignature).filter(Boolean))];
}

export function signatureLabel(signature) {
  return signature.startsWith('exact:') ? `这条命令（${signature.slice(6).slice(0, 80)}）` : signature;
}

export function createGrantStore(db, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS dots_approval_grants(
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, signatures TEXT NOT NULL, scope TEXT NOT NULL,
    goal_id INTEGER, expires_at INTEGER, sample_command TEXT, created_at INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, revoked_at INTEGER)`);
  db.exec('CREATE INDEX IF NOT EXISTS dots_approval_grants_owner ON dots_approval_grants(owner_id, revoked_at)');
  const present = row => ({ id: row.id, signatures: JSON.parse(row.signatures), labels: JSON.parse(row.signatures).map(signatureLabel), scope: row.scope, goalId: row.goal_id, expiresAt: row.expires_at, sampleCommand: row.sample_command, createdAt: row.created_at, uses: row.uses, lastUsedAt: row.last_used_at });
  const active = owner => db.prepare('SELECT * FROM dots_approval_grants WHERE owner_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY id DESC').all(owner, now());

  function create({ owner, goalId = null, command, scope }: {owner?: string; goalId?: any; command?: string; scope: string}) {
    if (!GRANT_SCOPES.includes(scope)) throw Object.assign(new Error('授权范围无效'), { statusCode: 400 });
    const signatures = commandSignatures(command);
    if (!signatures.length) throw Object.assign(new Error('这条命令无法生成授权'), { statusCode: 400 });
    const at = now();
    const expires = scope === 'always' ? null : at + DURATION[scope];
    const info = db.prepare('INSERT INTO dots_approval_grants(owner_id,signatures,scope,goal_id,expires_at,sample_command,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(owner, JSON.stringify(signatures), scope, scope === 'task' ? goalId : null, expires, String(command).slice(0, 500), at);
    return present(db.prepare('SELECT * FROM dots_approval_grants WHERE id=?').get(Number(info.lastInsertRowid)));
  }

  // 每个命令片段要么被授权覆盖，要么本身在当前审批方式下可以自动放行；至少要有一个片段用到授权。
  function covers({ owner, goalId, command, autoOk = () => false }: {owner?: string; goalId?: any; command?: string; autoOk?: (segment: string) => boolean}) {
    const segments = commandSegments(command);
    if (!segments.length) return null;
    const grants = active(owner).filter(row => row.scope !== 'task' || row.goal_id === goalId);
    if (!grants.length) return null;
    const used = new Set();
    for (const segment of segments) {
      const signature = segmentSignature(segment);
      const grant = signature && grants.find(row => JSON.parse(row.signatures).includes(signature));
      if (grant) { used.add(grant.id); continue; }
      if (!autoOk(segment)) return null;
    }
    return used.size ? [...used] : null;
  }

  function markUsed(ids) {
    const stmt = db.prepare('UPDATE dots_approval_grants SET uses=uses+1,last_used_at=? WHERE id=?');
    for (const id of ids || []) stmt.run(now(), id);
  }
  const list = owner => active(owner).map(present);
  function revoke(owner, id) {
    const info = db.prepare('UPDATE dots_approval_grants SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL').run(now(), Number(id), owner);
    if (!info.changes) throw Object.assign(new Error('授权不存在或已撤销'), { statusCode: 404 });
    return { ok: true };
  }
  return { create, covers, markUsed, list, revoke };
}
