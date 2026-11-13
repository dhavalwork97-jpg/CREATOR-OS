import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/harness.mjs";
import { freshDatabase } from "../helpers/pg.mjs";
import { query } from "../../lib/sql.mjs";

const app = await startApp({ env: { IG_GRAPH_API_VERSION: "v21.0", IG_USER_ID: "17841", IG_ACCESS_TOKEN: "tok-never-leak" } });
test.after(() => app.close());
const bearer = { authorization: "Bearer " + "c".repeat(40) };
const tick = () => app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });

test("creative routes require auth and migrations", async () => {
  assert.equal((await app.call("/api/creative/packages", undefined, { auth: false })).status, 401);
  assert.equal((await app.call("/api/creative/packages")).status, 503);
});

test("draft, edit with revalidation, reject, and apply guards", async () => {
  const { close } = await freshDatabase();
  try {
    await tick();
    const account = (await query(`SELECT account_id FROM ig_accounts`))[0];
    const [item] = await query(`INSERT INTO content_plan_items (account_id, generation_id, plan_date, format, pillar, topic, rationale, evidence_class, confidence)
      VALUES ($1,'g','2026-11-12','image','packing','One bag for two weeks','why','ai_hypothesis','low') RETURNING item_id`, [account.account_id]);
    assert.equal((await app.call("/api/creative/plan/" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12) + "/draft", {})).status, 404);
    const a = await app.call("/api/creative/plan/" + item.item_id + "/draft", {}), b = await app.call("/api/creative/plan/" + item.item_id + "/draft", {});
    assert.equal(a.status, 202);
    assert.equal(b.body.created, false);
    await tick();
    const list = await app.call("/api/creative/packages?planItemId=" + item.item_id);
    assert.equal(list.body.packages.length, 1);
    assert.equal(list.body.imageGeneration, "owner_triggered_only");
    const pkg = list.body.packages[0];
    assert.equal(pkg.source, "template", "no Gemini configured in tests");

    const bad = await app.call("/api/creative/packages/" + pkg.package_id, { caption: "x".repeat(2200), hashtags: ["a1", "b2"] });
    assert.equal(bad.body.package.status, "needs_fixes");
    assert.equal((await app.call("/api/creative/packages/" + pkg.package_id + "/apply", {})).status, 409, "invalid drafts cannot be applied");
    const fixed = await app.call("/api/creative/packages/" + pkg.package_id, { caption: "A fixed caption that is fine" });
    assert.equal(fixed.body.package.status, "draft");
    assert.equal(fixed.body.package.edited_by_owner, true);
    assert.equal((await app.call("/api/creative/packages/" + pkg.package_id, { hashtags: "no" })).status, 400);
    const apply = await app.call("/api/creative/packages/" + pkg.package_id + "/apply", {});
    assert.equal(apply.status, 409, "item was never sent to the board");
    assert.match(apply.body.error, /Content Board/);
    assert.equal((await app.call("/api/creative/packages/" + pkg.package_id + "/reject", {})).body.package.status, "rejected");
    assert.equal(JSON.stringify(list.body).includes("tok-never-leak"), false);
    const audits = (await query(`SELECT action FROM audit_events`)).map(r => r.action);
    for (const want of ["creative_draft_requested", "creative_package_edited", "creative_package_rejected"]) assert.ok(audits.includes(want), want);
  } finally { await close(); }
});
