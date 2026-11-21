import { createHash } from 'node:crypto';
import { nextScheduleRun } from './dots-schedules.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => { const s = hash(value).slice(0, 32); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; };
export const memberExecution = auth => auth?.role === 'user' || auth?.serverAccess === false;
export function nextMemberRun(schedule, after = Date.now()) {
  if (!schedule.enabled) return null;
  if (schedule.repeat !== 'hourly') { const value = nextScheduleRun(schedule, after); return value === null ? null : new Date(value).toISOString(); }
  const minute = Number(schedule.time.split(':')[1]);
  let at = new Date(Math.max(after, Date.parse(schedule.startDate + 'T00:00:00Z') - 86400000)); at.setUTCSeconds(0, 0);
  for (let i = 0; i < 3 * 24 * 60; i++, at = new Date(at.getTime() + 60000)) {
    if (at.getTime() <= after) continue;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit', minute: '2-digit' }).formatToParts(at).map(p => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (date < schedule.startDate) continue;
    if (schedule.endDate && date > schedule.endDate) return null;
    if (Number(parts.minute) === minute) return at.toISOString();
  }
  return null;
}
export function prepareMemberSchedule(current, data, auth, now = Date.now()) {
  const result = { ...data, runLocally: false, executionMode: 'isolated', executorDeviceId: 'isolated', source: 'server',
    createdAt: current.createdAt || new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
  // Clients configure schedules, but cannot forge execution results or claim another host.
  for (const key of ['lastRunAt', 'lastRunState', 'lastError', 'conversationId']) {
    if (Object.hasOwn(current, key)) result[key] = current[key]; else delete result[key];
  }
  const timingChanged = !current.id || current.executionMode !== 'isolated' || ['enabled', 'repeat', 'time', 'timezone', 'startDate', 'endDate'].some(k => result[k] !== current[k]);
  result.nextRunAt = timingChanged ? nextMemberRun(result, now) : current.nextRunAt;
  result.status = !result.enabled ? 'paused' : result.nextRunAt ? 'enabled' : 'completed';
  if (result.repeat === 'once' && result.enabled && !result.nextRunAt && timingChanged) throw Object.assign(new Error('执行时间已过去，请选择未来时间'), { status: 400 });
  return result;
}

interface MemberScheduleWorkerOptions { submit?: any; access?: any; jobStatus?: (owner: any, id: any) => any; now?: () => number; pollMs?: number; }
export class MemberScheduleWorker {
  constructor(store, { submit, access, jobStatus = () => null, now = Date.now, pollMs = 15000 }: MemberScheduleWorkerOptions = {}) {
    this.store = store; this.submit = submit; this.access = access; this.jobStatus = jobStatus; this.now = now; this.running = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS member_schedule_runs(owner TEXT NOT NULL,task_id TEXT NOT NULL,due_at TEXT NOT NULL,request_id TEXT NOT NULL,job_id TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,task_id,due_at));`);
    this.timer = pollMs > 0 ? setInterval(() => void this.tick().catch(() => {}), pollMs) : null; this.timer?.unref();
  }
  close() { clearInterval(this.timer); }
  async submitTask(owner, task, requestId, prompt = task.instruction, due = 'manual:' + requestId) {
    const conversationId = task.newChatEachRun ? uuid(owner + ':' + requestId) : task.conversationId || uuid(owner + ':' + task.id);
    const job = await this.submit({ requestId, conversationId, syncConversationId: conversationId, projectId: task.projectId,
      userMessageId: uuid(owner + ':' + requestId + ':user'), assistantMessageId: uuid(owner + ':' + requestId + ':assistant'),
      prompt, model: task.model, reasoning: task.reasoning }, owner);
    this.store.db.prepare("INSERT INTO member_schedule_runs VALUES(?,?,?,?,?,'running',?) ON CONFLICT(owner,task_id,due_at) DO UPDATE SET job_id=excluded.job_id,state='running'").run(owner, task.id, due, requestId, job.id, this.now());
    return { job, conversationId };
  }
  async handle(req, res, auth, readBody) {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/(?:shiyan\/)?v1\/workspace\/schedules\/([A-Za-z0-9_-]{8,120})\/(control|messages|conversation)$/);
    if (!match) return false;
    const row = this.store.get(auth.owner, 'scheduledTasks', match[1]);
    if (!row || row.deleted || row.data.executionMode !== 'isolated') throw Object.assign(new Error('定时任务不存在'), { status: 404 });
    const reply = value => { const bytes = Buffer.from(JSON.stringify({ ok: true, ...value })); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); res.end(bytes); return true; };
    if (req.method === 'GET' && match[2] === 'conversation') {
      const conversationId = row.data.conversationId;
      const messages = conversationId ? this.store.db.prepare("SELECT data FROM sync_entities WHERE owner=? AND kind='messages' AND deleted=0 AND json_extract(data,'$.conversationId')=? ORDER BY json_extract(data,'$.createdAt')").all(auth.owner, conversationId).map(r => JSON.parse(r.data)) : [];
      return reply({ conversationId: conversationId || null, conversation: conversationId ? this.store.get(auth.owner, 'conversations', conversationId)?.data || { id: conversationId, title: row.data.title } : null, messages });
    }
    if (req.method !== 'POST' || !['control', 'messages'].includes(match[2])) throw Object.assign(new Error('定时任务操作无效'), { status: 405 });
    const input = await readBody(req, 256 * 1024);
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) throw Object.assign(new Error('缺少请求标识'), { status: 400 });
    if (match[2] === 'control' && input.action !== 'run') throw Object.assign(new Error('请通过任务配置暂停或恢复任务'), { status: 400 });
    const prompt = match[2] === 'messages' ? input.message : row.data.instruction;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw Object.assign(new Error('请输入有效指令'), { status: 400 });
    const result = await this.submitTask(auth.owner, row.data, input.requestId, prompt);
    this.store.putAuthoritative(auth.owner, 'scheduledTasks', row.id, { ...row.data, conversationId: result.conversationId, lastRunAt: new Date(this.now()).toISOString(), lastRunState: 'running', lastError: '' });
    return reply({ task: { ...this.store.get(auth.owner, 'scheduledTasks', row.id).data, revision: this.store.get(auth.owner, 'scheduledTasks', row.id).revision }, conversationId: result.conversationId, requestId: input.requestId, jobId: result.job.id, status: result.job.status });
  }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      // Materialize completion only from the job tied to this owner's durable claim.
      for (const run of this.store.db.prepare("SELECT * FROM member_schedule_runs WHERE state='running'").all()) {
        const job = this.jobStatus(run.owner, run.job_id);
        if (!job || !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) continue;
        this.store.db.prepare('UPDATE member_schedule_runs SET state=? WHERE owner=? AND task_id=? AND due_at=?').run(job.status, run.owner, run.task_id, run.due_at);
        const row = this.store.get(run.owner, 'scheduledTasks', run.task_id);
        if (row && !row.deleted) this.store.putAuthoritative(run.owner, 'scheduledTasks', run.task_id, { ...row.data, lastRunState: job.status, lastError: job.error || '', updatedAt: new Date(this.now()).toISOString() });
      }
      const rows = this.store.db.prepare("SELECT owner,id,data FROM sync_entities WHERE kind='scheduledTasks' AND deleted=0 AND json_extract(data,'$.executionMode')='isolated' AND json_extract(data,'$.enabled')=1").all();
      for (const row of rows) {
        const task = JSON.parse(row.data), currentAccess = this.access(row.owner);
        if (currentAccess.status !== 'active' || !task.nextRunAt || Date.parse(task.nextRunAt) > this.now()) continue;
        const due = task.nextRunAt, requestId = 'schedule_' + hash(row.owner + ':' + row.id + ':' + due).slice(0, 48);
        this.store.db.prepare("INSERT OR IGNORE INTO member_schedule_runs VALUES(?,?,?,?,NULL,'pending',?)").run(row.owner, row.id, due, requestId, this.now());
        const claim = this.store.db.prepare('SELECT * FROM member_schedule_runs WHERE owner=? AND task_id=? AND due_at=?').get(row.owner, row.id, due);
        if (claim.state !== 'pending') continue;
        try {
          const { job, conversationId } = await this.submitTask(row.owner, { ...task, id: row.id }, requestId, task.instruction, due);
          const fresh = this.store.get(row.owner, 'scheduledTasks', row.id);
          if (!fresh || fresh.deleted || fresh.data.nextRunAt !== due) continue;
          const next = nextMemberRun(fresh.data, this.now());
          this.store.putAuthoritative(row.owner, 'scheduledTasks', row.id, { ...fresh.data, nextRunAt: next, enabled: next !== null && fresh.data.enabled, status: next ? 'enabled' : 'completed', lastRunAt: new Date(this.now()).toISOString(), lastRunState: 'running', lastError: '', conversationId, updatedAt: new Date(this.now()).toISOString() });
        } catch {
          // Leave the same durable request pending; retry is idempotent and cannot start another owner's task.
        }
      }
    } finally { this.running = false; }
  }
}
