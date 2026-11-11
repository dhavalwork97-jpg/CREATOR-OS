import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, seedAccount } from "./helpers/pg.mjs";
import { query } from "../lib/sql.mjs";
import { migrateUp, migrateDown, appliedMigrations, schemaIsCurrent, MIGRATIONS } from "../lib/migrate.mjs";
import * as q from "../lib/tasks/queue.mjs";
import { recordAudit, recentAudit } from "../lib/audit-log.mjs";

// Tasks are stamped with the real clock when enqueued, so the simulated clock starts just after now.
const T0 = new Date(Date.now() + 60000);
const at = seconds => new Date(T0.getTime() + seconds * 1000);
const newTask = (account, extra = {}) => q.enqueue({ accountId: account.account_id, agent: "monitor", type: "sync", idempotencyKey: "k-" + Math.random(), ...extra });

test("state transitions: terminal states are final and running can finish or retry", () => {
  assert.equal(q.canTransition("queued", "running"), true);
  assert.equal(q.canTransition("running", "retrying"), true);
  assert.equal(q.canTransition("completed", "running"), false);
  assert.equal(q.canTransition("failed", "queued"), false);
  assert.equal(q.canTransition("cancelled", "queued"), false);
  assert.equal(q.canTransition("pending", "running"), false);
});

test("backoff is exponential and capped at one hour", () => {
  assert.deepEqual([0, 1, 2, 3].map(q.backoffSeconds), [30, 60, 120, 240]);
  assert.equal(q.backoffSeconds(20), 3600);
});

test("migrations apply once, report status, and roll back one step at a time without touching legacy state", async () => {
  const { close } = await freshDatabase({ migrate: false });
  try {
    const ids = MIGRATIONS.map(m => m.id);
    assert.equal(await schemaIsCurrent(), false);
    assert.deepEqual(await migrateUp(), ids);
    assert.deepEqual(await migrateUp(), []);
    assert.equal(await schemaIsCurrent(), true);
    await query(`CREATE TABLE creator_os_state (id text PRIMARY KEY, version bigint, data jsonb)`);
    assert.equal(await migrateDown(), ids[ids.length - 1], "only the latest migration is rolled back");
    assert.equal(await schemaIsCurrent(), false);
    assert.ok((await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_tasks'`)).length === 1, "earlier migrations stay applied");
    while (await migrateDown()) { /* roll everything back */ }
    assert.deepEqual(await appliedMigrations(), []);
    const left = (await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).map(r => r.table_name);
    assert.ok(left.includes("creator_os_state"), "legacy table survives a full rollback");
    assert.ok(!left.includes("agent_tasks") && !left.includes("media_items"));
    assert.deepEqual(await migrateUp(), ids, "rollback is repeatable");
  } finally { await close(); }
});

test("enqueue is idempotent by key and records an audit event without secrets", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    const first = await q.enqueue({ accountId: account.account_id, agent: "monitor", type: "sync", idempotencyKey: "same" });
    const second = await q.enqueue({ accountId: account.account_id, agent: "monitor", type: "sync", idempotencyKey: "same" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.task.task_id, second.task.task_id);
    await recordAudit({ accountId: account.account_id, action: "x", detail: { access_token: "SECRET", count: 2 } });
    const [event] = await recentAudit(account.account_id);
    assert.equal(event.detail.access_token, "[redacted]");
    assert.equal(event.detail.count, 2);
  } finally { await close(); }
});

test("claim hands each task to exactly one worker and respects run_after and priority", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await newTask(account, { priority: 1, input: { n: "low" } });
    await newTask(account, { priority: 9, input: { n: "high" } });
    await newTask(account, { runAfter: at(3600), input: { n: "later" } });
    const [a, b] = await Promise.all([q.claim({ workerId: "a", limit: 5, now: T0 }), q.claim({ workerId: "b", limit: 5, now: T0 })]);
    const all = [...a, ...b];
    assert.equal(all.length, 2, "the future task is not claimed and nothing is claimed twice");
    assert.equal(new Set(all.map(t => t.task_id)).size, 2);
    assert.equal(all.find(t => t.input.n === "high").status, "running");
  } finally { await close(); }
});

test("kill switch pauses external-effect tasks but lets read-only tasks run", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await newTask(account, { externalEffect: true, input: { n: "publish" } });
    await newTask(account, { input: { n: "read" } });
    const claimed = await q.claim({ workerId: "w", now: T0, allowExternal: false });
    assert.deepEqual(claimed.map(t => t.input.n), ["read"]);
    const [paused] = await query(`SELECT status FROM agent_tasks WHERE external_effect`);
    assert.equal(paused.status, "queued", "paused work is preserved, not erased");
    const released = await q.claim({ workerId: "w", now: T0, allowExternal: true });
    assert.deepEqual(released.map(t => t.input.n), ["publish"]);
  } finally { await close(); }
});

test("only the lock owner can complete; retries back off; limits and retry-unsafe tasks end in failed", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await newTask(account, { maxRetries: 1 });
    let [task] = await q.claim({ workerId: "w1", now: T0 });
    assert.equal(await q.complete({ ...task, locked_by: "intruder" }, {}, at(1)), null);
    const retry = await q.fail(task, new q.TaskError("rate_limited", "slow down"), { retryable: true, now: at(1) });
    assert.equal(retry.retried, true);
    assert.equal(retry.task.status, "retrying");
    assert.equal(new Date(retry.task.run_after).getTime(), at(1).getTime() + 30000);
    assert.equal((await q.claim({ workerId: "w1", now: at(10) })).length, 0, "not due yet");
    [task] = await q.claim({ workerId: "w1", now: at(40) });
    const final = await q.fail(task, new Error("again"), { retryable: true, now: at(41) });
    assert.equal(final.task.status, "failed", "retry limit reached");

    await newTask(account, { retrySafe: false, externalEffect: true });
    [task] = await q.claim({ workerId: "w1", now: at(100) });
    const unsafe = await q.fail(task, new Error("uncertain"), { retryable: true, now: at(101) });
    assert.equal(unsafe.task.status, "failed", "retry-unsafe tasks are never blindly retried");
  } finally { await close(); }
});

test("timed-out tasks are recovered after a worker dies: retried when safe, failed when not", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await newTask(account, { timeoutSeconds: 60, input: { n: "safe" } });
    await newTask(account, { timeoutSeconds: 60, retrySafe: false, input: { n: "unsafe" } });
    await q.claim({ workerId: "dead", now: T0 });
    assert.equal((await q.recoverTimedOut(at(30))).length, 0);
    const recovered = await q.recoverTimedOut(at(61));
    assert.equal(recovered.length, 2);
    const rows = await query(`SELECT input->>'n' AS n, status FROM agent_tasks ORDER BY n`);
    assert.deepEqual(rows, [{ n: "safe", status: "retrying" }, { n: "unsafe", status: "failed" }]);
  } finally { await close(); }
});

test("dependencies gate execution; a failed parent cancels its dependents", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    const parent = (await newTask(account, { input: { n: "parent" } })).task;
    const child = (await newTask(account, { dependsOn: [parent.task_id], input: { n: "child" } })).task;
    assert.equal(child.status, "pending");
    let [p] = await q.claim({ workerId: "w", now: T0 });
    assert.equal(p.input.n, "parent");
    await q.complete(p, { ok: true }, at(1));
    const [c] = await q.claim({ workerId: "w", now: at(2) });
    assert.equal(c.input.n, "child");

    const p2 = (await newTask(account, { maxRetries: 0, input: { n: "p2" } })).task;
    const c2 = (await newTask(account, { dependsOn: [p2.task_id] })).task;
    const [claimed] = await q.claim({ workerId: "w", now: at(3) });
    await q.fail(claimed, new Error("boom"), { retryable: false, now: at(4) });
    const [after] = await query(`SELECT status, error FROM agent_tasks WHERE task_id = $1`, [c2.task_id]);
    assert.equal(after.status, "cancelled");
    assert.equal(after.error.code, "dependency_failed");
  } finally { await close(); }
});

test("cancel is account-scoped and a cancelled running task's result is discarded", async () => {
  const { close } = await freshDatabase();
  try {
    const mine = await seedAccount("111");
    const other = await seedAccount("222");
    await newTask(mine);
    const [task] = await q.claim({ workerId: "w", now: T0 });
    assert.equal(await q.cancel(task.task_id, other.account_id, at(1)), null, "another account cannot cancel it");
    assert.equal((await q.cancel(task.task_id, mine.account_id, at(1))).status, "cancelled");
    assert.equal(await q.complete(task, { late: true }, at(2)), null);
    assert.equal(await q.getTask(task.task_id, other.account_id), null);
  } finally { await close(); }
});
