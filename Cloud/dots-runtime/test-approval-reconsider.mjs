import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createManagerStore } from './manager-store.mjs';

// An isolated database only. This test never imports the live server, opens the
// production database, starts a worker process or executes a host command.
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dots-approval-reconsider-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE goals(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',thread_id TEXT,mac_thread_id TEXT,mac_last_route TEXT,workspace TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_wake_at INTEGER,last_run_at INTEGER,last_summary TEXT NOT NULL DEFAULT '',run_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);
    CREATE TABLE approvals(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,reason TEXT,command TEXT,status TEXT,created_at INTEGER,decided_at INTEGER,output TEXT);
    CREATE TABLE agent_outputs(id INTEGER PRIMARY KEY AUTOINCREMENT,goal_id INTEGER,run_number INTEGER,thread_id TEXT,status TEXT,raw_result TEXT,summary TEXT,notification TEXT,created_at INTEGER);
  `);
  const store = createManagerStore({ db, workspaceRoot: path.join(root, 'workspaces'), now: () => 100 });
  const [task, other] = store.createTasks([
    { key: 'network', title: '查看本机网络接口', instruction: 'Read the authorized host network interfaces', dependencies: [], resourceKey: 'ubuntu:current-host' },
    { key: 'other', title: '保留其他待审批事项', instruction: 'Unrelated work', dependencies: [] }
  ]);
  db.prepare("UPDATE goals SET status='waiting_approval',next_wake_at=NULL,thread_id='retained-thread' WHERE id=?").run(task.id);
  const approvalId = store.bindApproval(task.id, '旧远程目标未确定', "ssh <placeholder-host> 'ifconfig || ip addr show'");
  const oldApproval = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId);
  db.prepare("UPDATE goals SET status='waiting_approval',next_wake_at=NULL WHERE id=?").run(other.id);
  const otherApprovalId = store.bindApproval(other.id, 'Unrelated approval', 'example-dangerous-operation');
  const originalEvent = Number(db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(?,'user_instruction','目标是当前 Ubuntu 主机，进行只读检查',99)").run(task.id).lastInsertRowid);
  const user = store.message({ message: '目标是当前 Ubuntu 主机，不要使用占位 SSH；重新评估并继续原事项', requestId: 'clarify-host', host: 'shiyan_desktop' }).message;
  const run = store.claimManager();
  const directive = { task_id: task.id, source_message_ids: [user.id], message: user.content, reason: '新目标澄清使旧远程主机提案失效', resource_key: 'ubuntu:current-host' };
  const result = overrides => ({ reply: '按新要求重新评估原事项。', summary: '已处理目标澄清', tasks: [], reviews: [], controls: [], instructions: [], continuations: [directive], ...overrides });
  const goal = () => db.prepare('SELECT * FROM goals WHERE id=?').get(task.id);
  const approval = () => db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId);
  const commit = overrides => store.completeManager(run, result(overrides));
  const assertOtherUntouched = () => {
    assert.equal(db.prepare('SELECT status FROM goals WHERE id=?').get(other.id).status, 'waiting_approval');
    assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(otherApprovalId).status, 'pending');
  };
  return { db, store, task, other, approvalId, otherApprovalId, oldApproval, originalEvent, user, run, directive, result, goal, approval, commit, assertOtherUntouched, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('authenticated concrete continuation supersedes only an unexecuted proposal and retains the original worker thread', () => {
  const f = fixture(); try {
    const before = f.goal();
    assert.equal(f.commit().committed, true);
    assert.equal(f.approval().status, 'superseded');
    assert.equal(f.goal().status, 'active');
    assert.equal(f.goal().control_revision, before.control_revision + 1);
    assert.equal(f.goal().thread_id, before.thread_id);
    assert.equal(f.goal().workspace, before.workspace);
    assert.equal(f.goal().next_wake_at, 100);
    assert.equal(f.db.prepare('SELECT consumed_at FROM events WHERE id=?').get(f.originalEvent).consumed_at, null);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_actions').get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_runs WHERE kind='approval'").get().n, 0);
    const worker = f.store.claimGoal(f.task.id);
    assert.ok(worker);
    assert.equal(worker.thread_id, 'retained-thread');
    f.assertOtherUntouched();
  } finally { f.close(); }
});

test('replaying the completed manager run does not increment revision or repeat supersession', () => {
  const f = fixture(); try {
    f.commit();
    const revision = f.goal().control_revision;
    const activityCount = f.db.prepare('SELECT COUNT(*) AS n FROM manager_activity').get().n;
    assert.equal(f.commit().committed, false);
    assert.equal(f.goal().control_revision, revision);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_activity').get().n, activityCount);
  } finally { f.close(); }
});

test('all unexecuted proposals for this task are withdrawn together and no unrelated approval changes', () => {
  const f = fixture(); try {
    const extra = Number(f.db.prepare("INSERT INTO approvals(goal_id,reason,command,status,created_at,control_revision,payload_hash) VALUES(?,'second old proposal','different-old-command','pending',98,0,'old-fingerprint')").run(f.task.id).lastInsertRowid);
    assert.equal(f.commit().committed, true);
    assert.equal(f.approval().status, 'superseded');
    assert.equal(f.db.prepare('SELECT status FROM approvals WHERE id=?').get(extra).status, 'superseded');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE goal_id=? AND status IN ('pending','executing','unknown')").get(f.task.id).n, 0);
    assert.equal(f.goal().status, 'active');
    f.assertOtherUntouched();
  } finally { f.close(); }
});

test('an active task with a pending proposal also re-evaluates it only after authenticated continuation', () => {
  const f = fixture(); try {
    f.db.prepare("UPDATE goals SET status='active' WHERE id=?").run(f.task.id);
    assert.equal(f.commit().committed, true);
    assert.equal(f.approval().status, 'superseded');
    assert.equal(f.goal().status, 'active');
    assert.equal(f.goal().control_revision, 1);
    assert.equal(f.goal().next_wake_at, 100);
    f.assertOtherUntouched();
  } finally { f.close(); }
});

test('a paused task keeps its original pending proposal and only queues the clarification', () => {
  const f = fixture(); try {
    f.db.prepare("UPDATE goals SET status='paused' WHERE id=?").run(f.task.id);
    assert.equal(f.commit().committed, true);
    assert.equal(f.goal().status, 'paused');
    assert.equal(f.goal().control_revision, 0);
    assert.equal(f.goal().next_wake_at, null);
    assert.equal(f.approval().status, 'pending');
    assert.equal(f.store.claimGoal(f.task.id), null);
  } finally { f.close(); }
});

for (const status of ['executing', 'unknown']) {
  test(`a ${status} approval prevents supersession and activation even when another pending proposal exists`, () => {
    const f = fixture(); try {
      f.db.prepare("INSERT INTO approvals(goal_id,reason,command,status,created_at) VALUES(?,'already started','host-side-effect',?,99)").run(f.task.id, status);
      assert.equal(f.commit().committed, true);
      assert.equal(f.approval().status, 'pending');
      assert.equal(f.goal().status, 'waiting_approval');
      assert.equal(f.goal().control_revision, 0);
      assert.equal(f.goal().next_wake_at, null);
      assert.equal(f.store.claimGoal(f.task.id), null);
    } finally { f.close(); }
  });
}

test('an uncertain action prevents clearing pending approval or restarting work', () => {
  const f = fixture(); try {
    f.db.prepare("INSERT INTO manager_runs(id,manager_id,goal_id,kind,state,worker_id,fence,control_revision,lease_expires_at,heartbeat_at,started_at) VALUES('old-uncertain',?,?,'worker','uncertain','fixture',1,0,99,99,99)").run(f.store.managerId, f.task.id);
    f.db.prepare("INSERT INTO manager_actions(id,run_id,ordinal,payload,payload_hash,state,started_at) VALUES('uncertain-action','old-uncertain',0,'{}','fixture','unknown',99)").run();
    assert.equal(f.commit().committed, true);
    assert.equal(f.approval().status, 'pending');
    assert.equal(f.goal().status, 'waiting_approval');
    assert.equal(f.goal().control_revision, 0);
    assert.equal(f.store.claimGoal(f.task.id), null);
  } finally { f.close(); }
});

test('cancelled tasks cannot be revived by a continuation', () => {
  const f = fixture(); try {
    f.db.prepare("UPDATE goals SET status='cancelled' WHERE id=?").run(f.task.id);
    assert.throws(() => f.commit(), /cancelled/i);
    assert.equal(f.goal().status, 'cancelled');
    assert.equal(f.approval().status, 'pending');
    f.assertOtherUntouched();
  } finally { f.close(); }
});

for (const kind of ['foreign-user', 'assistant', 'non-current-user']) {
  test(`a ${kind} source cannot supersede a pending approval`, () => {
    const f = fixture(); try {
      let id;
      if (kind === 'non-current-user') {
        id = Number(f.db.prepare("INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES(?,'user','old context',1)").run(f.store.managerId).lastInsertRowid);
      } else {
        id = Number(f.db.prepare('INSERT INTO manager_messages(manager_id,role,content,created_at) VALUES(?,?,?,1)').run(kind === 'foreign-user' ? 'manager:foreign' : f.store.managerId, kind === 'assistant' ? 'assistant' : 'user', 'not an authenticated current user source').lastInsertRowid);
      }
      assert.throws(() => f.commit({ continuations: [{ ...f.directive, source_message_ids: [id] }] }), /current user message sources/);
      assert.equal(f.approval().status, 'pending');
      assert.equal(f.goal().status, 'waiting_approval');
      assert.equal(f.goal().control_revision, 0);
    } finally { f.close(); }
  });
}

test('a continuation for another project cannot clear the proposal', () => {
  const f = fixture(); try {
    assert.throws(() => f.commit({ continuations: [{ ...f.directive, resource_key: 'mac:/different-project' }] }), /project does not match/);
    assert.equal(f.approval().status, 'pending');
    assert.equal(f.goal().status, 'waiting_approval');
  } finally { f.close(); }
});

test('manager fencing preserves the pending proposal when a newer message arrives', () => {
  const f = fixture(); try {
    f.store.message({ message: '新的要求稍后处理', requestId: 'newer-source' });
    assert.equal(f.commit().committed, false);
    assert.equal(f.approval().status, 'pending');
    assert.equal(f.goal().status, 'waiting_approval');
    assert.equal(f.goal().control_revision, 0);
  } finally { f.close(); }
});

test('reconsideration does not approve the old command and a later dangerous proposal still requires fresh approval', () => {
  const f = fixture(); try {
    f.commit();
    assert.throws(() => f.store.validateApproval(f.oldApproval), /stale|not awaiting/i);
    f.db.prepare("UPDATE goals SET status='waiting_approval',next_wake_at=NULL WHERE id=?").run(f.task.id);
    const newId = f.store.bindApproval(f.task.id, 'A distinct dangerous action requires approval', 'example-dangerous-operation');
    assert.notEqual(newId, f.approvalId);
    const next = f.db.prepare('SELECT * FROM approvals WHERE id=?').get(newId);
    assert.equal(next.status, 'pending');
    assert.equal(next.control_revision, f.goal().control_revision);
    assert.doesNotThrow(() => f.store.validateApproval(next));
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM manager_runs WHERE kind='approval'").get().n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM manager_actions').get().n, 0);
    f.assertOtherUntouched();
  } finally { f.close(); }
});

test('status-only replies and raw wake controls do not clear an approval without authenticated continuation', () => {
  const f = fixture(); try {
    assert.throws(() => f.store.controlTask(f.task.id, 'wake'), /pending approval/i);
    assert.equal(f.commit({ continuations: [], reply: '等待审批。' }).committed, true);
    assert.equal(f.approval().status, 'pending');
    assert.equal(f.goal().status, 'waiting_approval');
    assert.equal(f.goal().control_revision, 0);
  } finally { f.close(); }
});
