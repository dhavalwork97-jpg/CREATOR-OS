import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/harness.mjs";
import { freshDatabase } from "../helpers/pg.mjs";
import { query } from "../../lib/sql.mjs";

const app = await startApp({ env: { IG_GRAPH_API_VERSION: "v21.0", IG_USER_ID: "17841", IG_ACCESS_TOKEN: "tok-never-leak" } });
test.after(() => app.close());
const bearer = { authorization: "Bearer " + "c".repeat(40) };

test("strategy routes require auth and migrations", async () => {
  assert.equal((await app.call("/api/strategy/overview", undefined, { auth: false })).status, 401);
  assert.equal((await app.call("/api/strategy/overview")).status, 503);
});

test("settings are validated, research/plan requests are idempotent, edits and rejections work", async () => {
  const { close } = await freshDatabase();
  try {
    await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
    assert.equal((await app.call("/api/strategy/settings", { postsPerWeek: 20 })).status, 400);
    assert.equal((await app.call("/api/strategy/settings", { pillars: "x" })).status, 400);
    assert.equal((await app.call("/api/strategy/settings", {})).status, 400);
    const saved = await app.call("/api/strategy/settings", { niche: "travel", audience: "backpackers", objective: "grow", pillars: ["packing", "packing", "budget"], postsPerWeek: 2 });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.settings.pillars, ["packing", "budget"]);

    const a = await app.call("/api/strategy/plan", {}), b = await app.call("/api/strategy/plan", {});
    assert.equal(a.status, 202);
    assert.equal(b.body.created, false);

    const account = (await query(`SELECT account_id FROM ig_accounts`))[0];
    const [opp] = await query(`INSERT INTO content_opportunities (account_id, dedupe_key, source_class, title, summary, confidence)
      VALUES ($1,'k','ai_hypothesis','Budget camera lenses','why','low') RETURNING opportunity_id`, [account.account_id]);
    assert.equal((await app.call("/api/strategy/opportunities/" + opp.opportunity_id + "/accept", {})).body.opportunity.status, "accepted");
    assert.equal((await app.call("/api/strategy/opportunities/" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12) + "/reject", {})).status, 404);

    await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
    const overview = await app.call("/api/strategy/overview");
    assert.equal(overview.status, 200);
    assert.equal(overview.body.externalResearch, "not_configured");
    assert.equal(overview.body.plan.length, 1);
    const item = overview.body.plan[0];
    assert.equal(item.evidence_class, "ai_hypothesis");

    assert.equal((await app.call("/api/strategy/plan/" + item.item_id, { format: "video" })).status, 400);
    const edited = await app.call("/api/strategy/plan/" + item.item_id, { topic: "My topic", hook: "Start strong" });
    assert.equal(edited.body.item.status, "edited");
    assert.equal(edited.body.item.edited_by_owner, true);
    assert.equal((await app.call("/api/strategy/plan/" + item.item_id, { reject: true })).body.item.status, "rejected");
    assert.equal((await app.call("/api/strategy/plan/" + item.item_id + "/to-board", {})).status, 409);
    assert.equal(JSON.stringify(overview.body).includes("tok-never-leak"), false);
    const audits = (await query(`SELECT action FROM audit_events`)).map(r => r.action);
    for (const want of ["strategy_settings_changed", "opportunity_accepted", "plan_item_edited", "plan_item_rejected"]) assert.ok(audits.includes(want), want);
  } finally { await close(); }
});
