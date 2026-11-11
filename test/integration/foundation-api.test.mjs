import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/harness.mjs";
import { freshDatabase } from "../helpers/pg.mjs";
import { enqueue } from "../../lib/tasks/queue.mjs";
import { query } from "../../lib/sql.mjs";

const app = await startApp({ env: { IG_GRAPH_API_VERSION: "v21.0", IG_USER_ID: "17841", IG_ACCESS_TOKEN: "tok-should-never-leak" } });
test.after(() => app.close());
const bearer = { authorization: "Bearer " + "c".repeat(40) };

test("worker tick and task routes are protected", async () => {
  assert.equal((await app.call("/api/worker/tick", undefined, { auth: false })).status, 401);
  assert.equal((await app.call("/api/worker/tick", undefined, { auth: false, headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await app.call("/api/tasks", undefined, { auth: false })).status, 401);
});

test("before migrations the new routes explain what to do instead of failing, and existing routes still work", async () => {
  const tick = await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
  assert.equal(tick.status, 503);
  assert.match(tick.body.error, /migrations/i);
  assert.equal((await app.call("/api/tasks")).status, 503);
  assert.equal((await app.call("/api/state")).status, 200, "legacy dashboard state is unaffected");
});

test("after migrations: tick registers the account, lists tasks, cancels with ownership checks, and never leaks the token", async () => {
  const { close } = await freshDatabase();
  try {
    const tick = await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.claimed, 0);
    assert.equal(tick.body.killSwitch, true, "kill switch defaults ON");

    const list = await app.call("/api/tasks");
    assert.equal(list.status, 200);
    const accountId = list.body.account.accountId;
    const { task } = await enqueue({ accountId, agent: "t", type: "x", idempotencyKey: "api-1" });
    const cancelled = await app.call("/api/tasks/" + task.task_id + "/cancel", {});
    assert.equal(cancelled.body.task.status, "cancelled");
    assert.equal((await app.call("/api/tasks/" + task.task_id + "/cancel", {})).status, 409);
    assert.equal((await app.call("/api/tasks/00000000-0000-0000-0000-000000000000/cancel", {})).status, 404);
    const events = await app.call("/api/activity");
    assert.ok(events.body.events.some(e => e.action === "task_cancelled"));

    // Another owner's account row is invisible to this owner.
    await query(`INSERT INTO ig_accounts (owner_email, ig_user_id) VALUES ('other@example.com','999')`);
    assert.equal(JSON.stringify([list.body, events.body, tick.body]).includes("tok-should-never-leak"), false);
  } finally { await close(); }
});
