import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/harness.mjs";
import { freshDatabase } from "../helpers/pg.mjs";
import { query } from "../../lib/sql.mjs";

const app = await startApp({ env: { IG_GRAPH_API_VERSION: "v21.0", IG_USER_ID: "17841", IG_ACCESS_TOKEN: "tok-never-leak" } });
test.after(() => app.close());
const bearer = { authorization: "Bearer " + "c".repeat(40) };

test("monitor routes require a session and migrations", async () => {
  assert.equal((await app.call("/api/monitor/overview", undefined, { auth: false })).status, 401);
  assert.equal((await app.call("/api/monitor/overview")).status, 503);
});

test("overview, validated settings, manual refresh and no token leakage", async () => {
  const { close } = await freshDatabase();
  try {
    await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer }); // registers the account
    const overview = await app.call("/api/monitor/overview");
    assert.equal(overview.status, 200);
    assert.equal(overview.body.settings.accountHealthMinutes, 360);
    assert.deepEqual(overview.body.profile, [], "no data is invented before collection");

    assert.equal((await app.call("/api/monitor/settings", { accountHealthMinutes: 1 })).status, 400, "below the minimum interval");
    assert.equal((await app.call("/api/monitor/settings", { accountHealthMinutes: "soon" })).status, 400);
    assert.equal((await app.call("/api/monitor/settings", {})).status, 400);
    const saved = await app.call("/api/monitor/settings", { accountHealthMinutes: 60, enabled: true });
    assert.equal(saved.status, 200);
    assert.equal((await app.call("/api/monitor/overview")).body.settings.accountHealthMinutes, 60, "settings persist");

    const first = await app.call("/api/monitor/run", {});
    const second = await app.call("/api/monitor/run", {});
    assert.equal(first.status, 202);
    assert.equal(first.body.queued.every(q => q.created), true);
    assert.equal(second.body.queued.every(q => !q.created), true, "repeated clicks do not stack tasks");
    assert.equal((await query(`SELECT count(*)::int n FROM audit_events WHERE action='monitoring_settings_changed'`))[0].n, 1);
    assert.equal(JSON.stringify([overview.body, saved.body, first.body]).includes("tok-never-leak"), false);
  } finally { await close(); }
});

test("the worker tick registers the monitor schedule and a restart does not duplicate it", async () => {
  const { close } = await freshDatabase();
  try {
    const one = await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
    assert.equal(one.body.scheduled, 6, "four monitor tasks, daily analytics and weekly research");
    const two = await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
    assert.equal(two.body.scheduled, 0);
    const types = (await query(`SELECT DISTINCT task_type FROM agent_tasks WHERE agent = 'monitor' ORDER BY 1`)).map(r => r.task_type);
    assert.deepEqual(types, ["account_health", "account_insights", "media_insights", "media_sync"]);
  } finally { await close(); }
});
