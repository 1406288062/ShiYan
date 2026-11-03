import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { canApplyGoalActions, resolveGoalRunState, resolveGoalRunFailure, classifyGoalRunFailure, assertGoalActionAllowed, mayActivateGoalForEvent } from "./goal-run-state.mjs";
import { createRuntimeRequestStore } from "./runtime-requests.mjs";

// Exercise the actual runtime functions with an isolated in-memory database and
// a stub planner. These tests never start a live runtime, Codex, Mac or a goal.
const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
const runSource = source.slice(source.indexOf("async function runGoal("), source.indexOf("function scheduleGoalNow("));
const actionSource = source.slice(source.indexOf("async function executeSafeActions("), source.indexOf("async function runGoal("));
const scheduleSource = source.slice(source.indexOf("function scheduleGoalNow("), source.indexOf("function catastrophicCommand("));
const handleSource = source.slice(source.indexOf("async function handle("), source.indexOf("let closeLocalMcpSocket"));

function fixture({ onPlan = () => {}, onActions, plannerError, status = "done", actions = [] } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE goals(id INTEGER PRIMARY KEY,title TEXT,instruction TEXT,status TEXT,thread_id TEXT,
      workspace TEXT,updated_at INTEGER,last_run_at INTEGER,next_wake_at INTEGER,last_summary TEXT,run_count INTEGER,failure_count INTEGER DEFAULT 0);
    CREATE TABLE events(id INTEGER PRIMARY KEY,goal_id INTEGER,type TEXT,payload TEXT,created_at INTEGER,consumed_at INTEGER);
    CREATE TABLE agent_outputs(id INTEGER PRIMARY KEY,goal_id INTEGER,run_number INTEGER,thread_id TEXT,
      status TEXT,raw_result TEXT,summary TEXT,notification TEXT,created_at INTEGER);
    INSERT INTO goals VALUES(1,'test','test','active',NULL,'/isolated-test',100,NULL,100,'',0,0);
  `);
  const notifications = [];
  const timeline = [];
  let actionCalls = 0;
  let approvals = 0;
  const getGoal = (id) => db.prepare("SELECT * FROM goals WHERE id=?").get(id);
  const addEvent = () => db.prepare("INSERT INTO events(goal_id,type,payload,created_at) VALUES(1,'user_instruction','new instruction',100)").run();
  const ctx = vm.createContext({
    db, canApplyGoalActions, resolveGoalRunState, resolveGoalRunFailure,
    now: () => 100, runningGoalId: null, getGoal,
    listGoalMemories: () => [], listGoalTimeline: () => [], storeMemories: () => {},
    listPendingEvents: (id, limit) => db.prepare("SELECT * FROM events WHERE goal_id=? AND consumed_at IS NULL ORDER BY id LIMIT ?").all(id, limit),
    getThread: () => ({ id: "stub-thread", run: async () => {
      await onPlan({ db, addEvent });
      if (plannerError) throw new Error(plannerError);
      return { finalResponse: JSON.stringify({ status, summary: "planned result", notify: true,
        notification: "planned notification", memories: [], actions, wake_after_seconds: 900 }) };
    } }),
    AGENT_SCHEMA: {}, buildAgentPrompt: () => "stub prompt", parseJson: JSON.parse, json: JSON.stringify,
    clampInt: (v, min, max, fallback) => Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback,
    executeSafeActions: async () => { actionCalls++; return onActions ? await onActions({ db, addEvent }) : []; },
    addTimeline: (...args) => timeline.push(args),
    createApproval: () => { approvals++; return 1; },
    addNotification: async (...args) => notifications.push(args)
  });
  vm.runInContext(runSource, ctx);
  return { db, ctx, notifications, timeline, getGoal, addEvent,
    run: () => ctx.runGoal(1), actionCalls: () => actionCalls, approvals: () => approvals };
}

for (const control of ["paused", "cancelled"]) {
  test(`${control} during planning survives completion without starting actions`, async () => {
    const f = fixture({ actions: [{ type: "write_file" }], onPlan: ({ db }) =>
      db.prepare("UPDATE goals SET status=?,next_wake_at=NULL WHERE id=1").run(control) });
    try {
      await f.run();
      assert.equal(f.getGoal(1).status, control);
      assert.equal(f.getGoal(1).next_wake_at, null);
      assert.equal(f.getGoal(1).thread_id, "stub-thread");
      assert.equal(f.actionCalls(), 0);
      assert.equal(f.notifications.length, 0);
      assert.equal(f.db.prepare("SELECT status FROM agent_outputs").get().status, control);
    } finally { f.db.close(); }
  });

  test(`${control} during an active action survives result writeback`, async () => {
    const f = fixture({ status: "needs_approval", onActions: ({ db }) => {
      db.prepare("UPDATE goals SET status=?,next_wake_at=NULL WHERE id=1").run(control);
      return [{ type: "run_command", ok: true }];
    } });
    try {
      await f.run();
      assert.equal(f.getGoal(1).status, control);
      assert.equal(f.getGoal(1).next_wake_at, null);
      assert.equal(f.notifications.length, 0);
      assert.equal(f.approvals(), 0);
    } finally { f.db.close(); }
  });

  test(`${control} during a failed run does not schedule retry`, async () => {
    const f = fixture({ plannerError: "stub error", onPlan: ({ db }) =>
      db.prepare("UPDATE goals SET status=?,next_wake_at=NULL WHERE id=1").run(control) });
    try {
      await f.run();
      assert.equal(f.getGoal(1).status, control);
      assert.equal(f.getGoal(1).next_wake_at, null);
      assert.equal(f.notifications.length, 0);
    } finally { f.db.close(); }
  });
}

for (const status of ["done", "blocked", "needs_approval"]) {
  test(`new instruction overrides stale ${status} with immediate next wake`, async () => {
    const f = fixture({ status, onPlan: ({ addEvent }) => addEvent() });
    try {
      await f.run();
      assert.equal(f.getGoal(1).status, "active");
      assert.equal(f.getGoal(1).next_wake_at, 100);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE consumed_at IS NULL").get().n, 1);
      assert.equal(f.approvals(), 0);
      assert.equal(f.notifications.length, 0);
    } finally { f.db.close(); }
  });
}

test("generic usage-limit errors use the common transient retry policy", () => {
  const state = resolveGoalRunFailure({ status: "active" }, { nowSec: 100, hasPendingEvents: true, errorMessage: "You have hit your usage limit" });
  assert.equal(state.cooldown, 0);
  assert.equal(state.retryKind, "transient");
  assert.equal(state.retrySeconds, 60 * 60);
  assert.equal(state.nextWakeAt, 100 + 60 * 60);
});

test("network failures use an hourly exponential backoff capped at 24 hours", () => {
  const expectedHours = [1, 2, 4, 8, 24, 24, 24];
  for (let failure_count = 0; failure_count < expectedHours.length; failure_count++) {
    const state = resolveGoalRunFailure({ status: "active", failure_count }, { nowSec: 100, errorMessage: "network error" });
    assert.equal(state.nextWakeAt, 100 + expectedHours[failure_count] * 3600);
    assert.equal(state.retrySeconds, expectedHours[failure_count] * 3600);
    assert.equal(state.nextFailureCount, failure_count + 1);
  }
  assert.equal(classifyGoalRunFailure("ECONNRESET"), "network");
  assert.equal(classifyGoalRunFailure("network access disabled"), "non_retryable");
});

test("new input after planner failure keeps immediate wake", async () => {
  const f = fixture({ plannerError: "stub error", onPlan: ({ addEvent }) => addEvent() });
  try {
    await f.run();
    assert.equal(f.getGoal(1).status, "active");
    assert.equal(f.getGoal(1).next_wake_at, 100);
    assert.match(f.notifications[0][3], /immediate retry/);
  } finally { f.db.close(); }
});

test("non-retryable planner errors do not schedule blind automatic retries", async () => {
  const f = fixture({ plannerError: "stub error" });
  try {
    f.addEvent();
    await f.run();
    assert.equal(f.getGoal(1).next_wake_at, null);
  } finally { f.db.close(); }
});

test("new instruction during planning defers the old requested actions", async () => {
  const f = fixture({ actions: [{ type: "write_file" }], onPlan: ({ addEvent }) => addEvent() });
  try {
    await f.run();
    assert.equal(f.actionCalls(), 0);
    assert.equal(f.getGoal(1).next_wake_at, 100);
  } finally { f.db.close(); }
});

test("the run's own tool result retains a short verification wake", async () => {
  const f = fixture({ onActions: () => [{ type: "run_command", ok: true }] });
  try {
    await f.run();
    assert.equal(f.getGoal(1).status, "active");
    assert.equal(f.getGoal(1).next_wake_at, 102);
  } finally { f.db.close(); }
});

test("ordinary completion remains unchanged and non-retryable errors stop retrying", async () => {
  for (const fail of [false, true]) {
    const f = fixture({ plannerError: fail ? "stub error" : undefined });
    try {
      await f.run();
      assert.equal(f.getGoal(1).status, fail ? "active" : "done");
      assert.equal(f.getGoal(1).next_wake_at, null);
      assert.equal(f.notifications.length, 1);
    } finally { f.db.close(); }
  }
});

test("safe action loop stops after pause instead of starting the next action", async () => {
  let goalStatus = "active";
  let writes = 0;
  const ctx = vm.createContext({
    canApplyGoalActions, getGoal: () => ({ status: goalStatus }),
    addTimeline: () => {}, resolveWorkspacePath: (_workspace, relative) => "/isolated-test/" + relative,
    path: { dirname: () => "/isolated-test", relative: (_workspace, value) => value },
    fs: { mkdir: async () => {}, writeFile: async () => { writes++; goalStatus = "paused"; } }, Buffer,
    json: JSON.stringify
  });
  vm.runInContext(actionSource, ctx);
  const result = await ctx.executeSafeActions({ id: 1, workspace: "/isolated-test" }, [
    { type: "write_file", path: "first", content: "first" },
    { type: "write_file", path: "second", content: "second" }
  ]);
  assert.equal(writes, 1);
  assert.equal(result.length, 1);
});

function httpFixture(status = "active", onReadJson = () => {}) {
  const f = fixture();
  f.db.exec("CREATE TABLE approvals(id INTEGER PRIMARY KEY,goal_id INTEGER,status TEXT)");
  f.db.prepare("UPDATE goals SET status=?,next_wake_at=? WHERE id=1").run(status, status === "active" ? 100 : null);
  Object.assign(f.ctx, {
    HOST: "127.0.0.1", PORT: 4330, TOKEN: "isolated-test-token", URL,
    mcpBridge: { matches: () => false }, assertGoalActionAllowed, mayActivateGoalForEvent,
    runtimeRequests: createRuntimeRequestStore(f.db), detailedGoal: (goal) => goal,
    readJson: async (req) => { await onReadJson(f); return req.payload || {}; },
    send: (res, status, response) => { res.status = status; res.response = response; }
  });
  vm.runInContext(scheduleSource + handleSource, f.ctx);
  f.request = async (action, payload = {}, event = false) => {
    const res = {};
    const req = { method: "POST", url: event ? "/v1/events" : "/v1/goals/1/" + action,
      headers: { authorization: "Bearer isolated-test-token" }, payload };
    try { await f.ctx.handle(req, res); }
    catch (error) { res.status = error.statusCode || 500; res.response = { error: error.message }; }
    return res;
  };
  return f;
}

test("backend lifecycle guards reject terminal and inactive execution requests", async () => {
  for (const status of ["done", "cancelled", "paused", "waiting_approval"]) {
    const rejected = status === "done" ? ["wake", "pause", "resume", "cancel", "instruct"]
      : status === "cancelled" ? ["wake", "pause", "resume", "instruct"]
      : status === "paused" ? ["wake", "instruct"] : ["wake", "resume", "instruct"];
    for (const action of rejected) {
      const f = httpFixture(status);
      try {
        const response = await f.request(action, { message: "new instruction" });
        assert.equal(response.status, 409, `${status} ${action}`);
        assert.equal(f.getGoal(1).status, status);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
      } finally { f.db.close(); }
    }
  }
});

test("status changes while reading a control request are checked again", async () => {
  const f = httpFixture("active", ({ db }) => db.prepare("UPDATE goals SET status='paused',next_wake_at=NULL WHERE id=1").run());
  try {
    assert.equal((await f.request("wake")).status, 409);
    assert.equal(f.getGoal(1).status, "paused");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  } finally { f.db.close(); }
});

test("duplicate pause and cancel do not produce duplicate timeline entries", async () => {
  for (const action of ["pause", "cancel"]) {
    const f = httpFixture();
    try {
      assert.equal((await f.request(action)).status, 200);
      assert.equal((await f.request(action)).status, 200);
      assert.equal(f.timeline.length, 1);
    } finally { f.db.close(); }
  }
});

test("resume is limited to paused or blocked with no pending approval", async () => {
  for (const status of ["active", "paused", "blocked", "waiting_approval"]) {
    for (const approval of [false, true]) {
      const f = httpFixture(status);
      try {
        if (approval) f.db.exec("INSERT INTO approvals VALUES(1,1,'pending')");
        const response = await f.request("resume");
        const allowed = ["paused", "blocked"].includes(status) && !approval;
        assert.equal(response.status, allowed ? 200 : 409);
        assert.equal(f.getGoal(1).status, allowed ? "active" : status);
      } finally { f.db.close(); }
    }
  }
});

test("instruct receipt replays before later cancellation guards", async () => {
  const f = httpFixture();
  try {
    const body = { requestId: "instruction:one", message: "continue" };
    assert.equal((await f.request("instruct", body)).status, 200);
    f.db.exec("UPDATE goals SET status='cancelled',next_wake_at=NULL WHERE id=1");
    assert.equal((await f.request("instruct", body)).status, 200);
    assert.equal(f.getGoal(1).status, "cancelled");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
    assert.equal((await f.request("instruct", { ...body, message: "changed" })).status, 409);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  } finally { f.db.close(); }
});

test("external events queue paused and approval-waiting goals without activating them", async () => {
  for (const status of ["paused", "waiting_approval", "done", "cancelled"]) {
    const f = httpFixture(status);
    try {
      const response = await f.request(null, { goalId: 1, type: "approval_executed", payload: "untrusted event" }, true);
      assert.equal(response.status, ["done", "cancelled"].includes(status) ? 409 : 202);
      assert.equal(f.getGoal(1).status, status);
      assert.equal(f.getGoal(1).next_wake_at, null);
      if (response.status === 202) {
        assert.equal(response.response.queued, true);
        assert.equal(response.response.scheduled, false);
      }
    } finally { f.db.close(); }
  }
});

test("approval results preserve stopped goals and explicitly resume approval-waiting goals", () => {
  for (const status of ["active", "blocked", "paused", "waiting_approval", "done", "cancelled"]) {
    const f = httpFixture(status);
    try {
      f.ctx.scheduleGoalNow(1, "approval_executed", { output: "stub" }, { resumeAfterApproval: true });
      const activates = ["active", "blocked", "waiting_approval"].includes(status);
      assert.equal(f.getGoal(1).status, activates ? "active" : status);
      assert.equal(f.getGoal(1).next_wake_at, activates ? 100 : null);
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
    } finally { f.db.close(); }
  }
});
