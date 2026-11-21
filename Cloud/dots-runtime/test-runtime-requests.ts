import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeRequestStore } from "./runtime-requests.ts";

function fixture(filename = ":memory:") {
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_goals(id INTEGER PRIMARY KEY,title TEXT);
    CREATE TABLE IF NOT EXISTS test_events(id INTEGER PRIMARY KEY,goal_id INTEGER,message TEXT);
  `);
  const store = createRuntimeRequestStore(db);
  const create = (payload) => store.run({ requestId: "create:stable-key", operation: "goal:create", payload }, () => {
    const result = db.prepare("INSERT INTO test_goals(title) VALUES(?)").run(payload.title);
    const goalId = Number(result.lastInsertRowid);
    return { goalId, response: { ok: true, goal: { id: goalId, title: payload.title } } };
  });
  return { db, store, create };
}

test("create retries return the same goal without duplicate mutation", () => {
  const f = fixture();
  try {
    const first = f.create({ title: "test", clientContext: { conversation_id: "one", client: "desktop" } });
    const second = f.create({ clientContext: { client: "desktop", conversation_id: "one" }, title: "test" });
    assert.deepEqual(second.response, first.response);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM test_goals").get().n, 1);
  } finally { f.db.close(); }
});

test("same request ID cannot be rebound to a different conversation or payload", () => {
  const f = fixture();
  try {
    f.create({ title: "test", clientContext: { conversation_id: "one" } });
    for (const payload of [
      { title: "changed", clientContext: { conversation_id: "one" } },
      { title: "test", clientContext: { conversation_id: "two" } }
    ]) assert.throws(() => f.create(payload), (error) => error.statusCode === 409);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM test_goals").get().n, 1);
  } finally { f.db.close(); }
});

test("instruction retries produce one event and target reuse is rejected", () => {
  const f = fixture();
  try {
    const send = (goalId, message) => f.store.run({ requestId: "instruct:stable-key", operation: "goal:instruct:" + goalId, payload: { message } }, () => {
      f.db.prepare("INSERT INTO test_events(goal_id,message) VALUES(?,?)").run(goalId, message);
      return { goalId, response: { ok: true, goalId } };
    });
    send(1, "continue");
    assert.equal(send(1, "continue").replayed, true);
    assert.throws(() => send(2, "continue"), (error) => error.statusCode === 409);
    assert.throws(() => send(1, "changed instruction"), (error) => error.statusCode === 409);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM test_events").get().n, 1);
  } finally { f.db.close(); }
});

test("mutation failure rolls back both data and request receipt", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.run({ requestId: "failed-key", operation: "goal:create", payload: { title: "test" } }, () => {
      f.db.prepare("INSERT INTO test_goals(title) VALUES('partial')").run();
      throw new Error("stub failure");
    }), /stub failure/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM test_goals").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM runtime_requests").get().n, 0);
    f.create({ title: "test" });
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM test_goals").get().n, 1);
  } finally { f.db.close(); }
});

test("invalid IDs do not mutate and absent IDs preserve old behavior", () => {
  const f = fixture();
  try {
    let calls = 0;
    const mutate = () => { calls++; return { response: { ok: true } }; };
    for (const requestId of [null, "", "a b", "x".repeat(129), 1]) {
      assert.throws(() => f.store.run({ requestId, operation: "test", payload: {} }, mutate), (error) => error.statusCode === 400);
    }
    assert.equal(calls, 0);
    f.store.run({ operation: "test", payload: {} }, mutate);
    f.store.run({ operation: "test", payload: {} }, mutate);
    assert.equal(calls, 2);
  } finally { f.db.close(); }
});

test("request receipts survive closing and reopening the database", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dots-request-test-"));
  const filename = path.join(dir, "test.sqlite3");
  let f;
  try {
    f = fixture(filename);
    const first = f.create({ title: "persistent receipt" });
    f.db.close();
    f = fixture(filename);
    const retry = f.create({ title: "persistent receipt" });
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.response, first.response);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM test_goals").get().n, 1);
  } finally {
    try { f?.db.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
