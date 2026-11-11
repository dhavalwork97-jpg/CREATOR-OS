import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/harness.mjs";
import { freshDatabase } from "../helpers/pg.mjs";
import { query } from "../../lib/sql.mjs";

const app = await startApp({ env: { IG_GRAPH_API_VERSION: "v21.0", IG_USER_ID: "17841", IG_ACCESS_TOKEN: "tok-never-leak" } });
test.after(() => app.close());
const bearer = { authorization: "Bearer " + "c".repeat(40) };

test("analytics routes are protected and explain missing migrations", async () => {
  assert.equal((await app.call("/api/analytics/report", undefined, { auth: false })).status, 401);
  assert.equal((await app.call("/api/analytics/report")).status, 503);
});

test("report starts empty, manual run is idempotent, and the tick schedules the analytics task", async () => {
  const { close } = await freshDatabase();
  try {
    const tick = await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
    assert.equal(tick.status, 200);
    assert.ok((await query(`SELECT 1 FROM agent_tasks WHERE agent = 'analytics'`)).length >= 1);
    const report = await app.call("/api/analytics/report");
    assert.equal(report.status, 200);
    assert.deepEqual(report.body.strategistFeedback, []);
    const a = await app.call("/api/analytics/run", {}), b = await app.call("/api/analytics/run", {});
    assert.equal(a.status, 202);
    assert.equal(b.body.created, false);
    // The next tick actually computes it (no network is needed for analytics).
    await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
    const after = await app.call("/api/analytics/report");
    assert.ok(after.body.insights.length > 0);
    assert.ok(after.body.insights.every(i => i.status === "insufficient_data"), "no data, so no claims");
    assert.equal(JSON.stringify(after.body).includes("tok-never-leak"), false);
  } finally { await close(); }
});
