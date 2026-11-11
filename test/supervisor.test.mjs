import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, seedAccount } from "./helpers/pg.mjs";
import { query } from "../lib/sql.mjs";
import { tick, ensureRecurring } from "../lib/supervisor.mjs";
import { enqueue, TaskError, claim } from "../lib/tasks/queue.mjs";

const clock = start => { let t = start.getTime(); return { now: () => new Date(t), advance: s => { t += s * 1000; } }; };
const base = () => new Date(Date.now() + 60000);
const job = (account, type, extra = {}) => enqueue({ accountId: account.account_id, agent: "t", type, idempotencyKey: type + Math.random(), ...extra });
const statusOf = async type => (await query(`SELECT status, error FROM agent_tasks WHERE task_type = $1`, [type]))[0];

test("runs a handler, stores its output and records the run", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await job(account, "ok");
    const c = clock(base());
    const summary = await tick({ handlers: { "t.ok": async () => ({ output: { n: 1 }, decision: { why: "test" } }) }, now: c.now, killSwitch: false });
    assert.equal(summary.completed, 1);
    const [task] = await query(`SELECT status, output FROM agent_tasks`);
    assert.deepEqual([task.status, task.output], ["completed", { n: 1 }]);
    const [run] = await query(`SELECT outcome, decision FROM agent_runs`);
    assert.deepEqual([run.outcome, run.decision], ["completed", { why: "test" }]);
  } finally { await close(); }
});

test("a task with no handler fails visibly instead of silently succeeding", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await job(account, "mystery");
    await tick({ handlers: {}, now: clock(base()).now, killSwitch: false });
    const row = await statusOf("mystery");
    assert.equal(row.status, "failed");
    assert.equal(row.error.code, "no_handler");
  } finally { await close(); }
});

test("retryable errors back off and succeed later; non-retryable errors fail at once", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await job(account, "flaky");
    await job(account, "broken");
    let calls = 0;
    const handlers = {
      "t.flaky": async () => { calls += 1; if (calls === 1) throw new TaskError("rate_limited", "later", { retryable: true }); return { output: { calls } }; },
      "t.broken": async () => { throw new TaskError("bad_input", "never works"); }
    };
    const c = clock(base());
    let summary = await tick({ handlers, now: c.now, killSwitch: false });
    assert.equal(summary.retried, 1);
    assert.equal(summary.failed, 1);
    assert.equal((await tick({ handlers, now: c.now, killSwitch: false })).claimed, 0, "retry waits for its backoff");
    c.advance(31);
    summary = await tick({ handlers, now: c.now, killSwitch: false });
    assert.equal(summary.completed, 1);
    assert.equal((await statusOf("flaky")).status, "completed");
    assert.equal((await statusOf("broken")).status, "failed");
  } finally { await close(); }
});

test("a handler that exceeds its time limit is aborted and retried", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await job(account, "slow", { timeoutSeconds: 1 });
    let aborted = false;
    const handlers = { "t.slow": ({ signal }) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }) };
    const summary = await tick({ handlers, now: clock(base()).now, killSwitch: false, budgetMs: 10000 });
    assert.equal(aborted, true);
    assert.equal(summary.retried, 1);
    assert.equal((await statusOf("slow")).status, "retrying");
  } finally { await close(); }
});

test("server restart: work claimed by a dead worker is recovered and then completed by the next tick", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await job(account, "survivor", { timeoutSeconds: 60 });
    const c = clock(base());
    await claim({ workerId: "crashed-instance", now: c.now() }); // worker dies here: never completes
    c.advance(61);
    const first = await tick({ handlers: { "t.survivor": async () => ({ output: { ok: true } }) }, now: c.now, killSwitch: false });
    assert.equal(first.recovered, 1);
    c.advance(31);
    const second = await tick({ handlers: { "t.survivor": async () => ({ output: { ok: true } }) }, now: c.now, killSwitch: false });
    assert.equal(second.completed, 1);
    assert.equal((await statusOf("survivor")).status, "completed");
  } finally { await close(); }
});

test("kill switch ON: external-effect tasks never run and stay queued; read-only agents continue", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await job(account, "publish", { externalEffect: true, retrySafe: false });
    await job(account, "monitor");
    let published = 0;
    const handlers = { "t.publish": async () => { published += 1; return {}; }, "t.monitor": async () => ({ output: {} }) };
    const summary = await tick({ handlers, now: clock(base()).now, killSwitch: true });
    assert.equal(published, 0);
    assert.equal(summary.completed, 1);
    assert.equal((await statusOf("publish")).status, "queued");
  } finally { await close(); }
});

test("a task cancelled while running has its result discarded", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await job(account, "racy");
    const handlers = { "t.racy": async ({ task }) => {
      await query(`UPDATE agent_tasks SET status = 'cancelled' WHERE task_id = $1`, [task.task_id]);
      return { output: { shouldNotLand: true } };
    } };
    const summary = await tick({ handlers, now: clock(base()).now, killSwitch: false });
    assert.equal(summary.completed, 0);
    const [row] = await query(`SELECT status, output FROM agent_tasks WHERE task_type = 'racy'`);
    assert.deepEqual([row.status, row.output], ["cancelled", null]);
  } finally { await close(); }
});

test("recurring tasks are created once per interval bucket, however many ticks run", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    const defs = [{ agent: "monitor", type: "account_health", intervalMinutes: 360 }];
    const noon = new Date("2026-11-10T12:00:00Z");
    assert.equal((await ensureRecurring({ accountId: account.account_id, definitions: defs, now: noon })).length, 1);
    assert.equal((await ensureRecurring({ accountId: account.account_id, definitions: defs, now: new Date(noon.getTime() + 60000) })).length, 0);
    assert.equal((await ensureRecurring({ accountId: account.account_id, definitions: defs, now: new Date(noon.getTime() + 7 * 3600000) })).length, 1);
    assert.equal((await query(`SELECT count(*)::int AS n FROM agent_tasks`))[0].n, 2);
  } finally { await close(); }
});
