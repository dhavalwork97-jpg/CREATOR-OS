import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, seedAccount } from "./helpers/pg.mjs";
import { query } from "../lib/sql.mjs";
import { validatePackage, templatePackage, normalizeHashtags } from "../lib/creative/validate.mjs";
import { makeCreative, parsePackage } from "../lib/agents/creative.mjs";
import * as store from "../lib/strategy/store.mjs";

const item = { topic: "One bag for two weeks", pillar: "packing", format: "reel", rationale: "Shows a repeatable system (AI-generated idea. Not a verified trend; no external source.)", hook: null };

test("normalizeHashtags cleans, dedupes and caps", () => {
  assert.deepEqual(normalizeHashtags(["#Travel", "travel", "bad tag!", "a", "#ok_1"]), ["#Travel", "#badtag", "#ok_1"]);
  assert.equal(normalizeHashtags(Array.from({ length: 50 }, (_, i) => "tag" + i)).length, 30);
});

test("validator enforces limits and warns on unverifiable claims", () => {
  const good = templatePackage(item, { niche: "travel", audience: "backpackers" });
  assert.equal(validatePackage(good, "reel").ok, true);
  assert.equal(validatePackage({ ...good, caption: "x".repeat(2300) }, "reel").ok, false);
  assert.equal(validatePackage({ ...good, alt_text: "y".repeat(101) }, "reel").ok, false);
  assert.equal(validatePackage({ ...good, script: Array.from({ length: 9 }, () => ({ shot: "s", seconds: 1 })) }, "reel").ok, false);
  const claims = validatePackage({ ...good, caption: "This is trending and guaranteed to work for everyone" }, "image");
  assert.equal(claims.ok, true);
  assert.equal(claims.warnings.filter(w => /trending|absolute/.test(w)).length, 2);
});

test("template never carries the AI disclaimer text into the caption", () => {
  assert.doesNotMatch(templatePackage(item, {}).caption, /AI-generated/);
});

test("parsePackage tolerates fences and rejects garbage", () => {
  assert.equal(parsePackage("nope", "reel"), null);
  const p = parsePackage("```json\n{\"caption\":\"A caption long enough\",\"hashtags\":[\"a1b\",\"#c2d\"],\"media_prompt\":\"An original scene of a packed bag on a bed\",\"script\":[{\"shot\":\"bag\",\"seconds\":3}]}\n```", "image");
  assert.deepEqual(p.hashtags, ["#a1b", "#c2d"]);
  assert.deepEqual(p.script, [], "no shot list for images");
});

async function setup() {
  const account = await seedAccount();
  await store.saveStrategySettings(account.account_id, { niche: "travel", audience: "backpackers", pillars: ["packing"] });
  const [row] = await query(`INSERT INTO content_plan_items (account_id, generation_id, plan_date, format, pillar, topic, rationale, evidence_class, confidence)
    VALUES ($1,'g','2026-11-12','reel','packing','One bag for two weeks','why','ai_hypothesis','low') RETURNING *`, [account.account_id]);
  return { account, row };
}
const run = (fn, account, row) => makeCreative(fn)({ task: { account_id: account.account_id, input: { planItemId: row.item_id } } });

test("falls back to a labelled template when the text provider is unavailable", async () => {
  const { close } = await freshDatabase();
  try {
    const { account, row } = await setup();
    const out = await run(async () => ({ skipped: "daily_limit" }), account, row);
    assert.equal(out.output.source, "template");
    assert.equal(out.output.fallbackReason, "daily_limit");
    const [pkg] = await query(`SELECT * FROM creative_packages`);
    assert.equal(pkg.source, "template");
    assert.equal(pkg.status, "draft");
    assert.equal(pkg.model, null);
  } finally { await close(); }
});

test("valid model output is stored as gemini; invalid output falls back; new versions supersede unedited drafts", async () => {
  const { close } = await freshDatabase();
  try {
    const { account, row } = await setup();
    const ok = JSON.stringify({ caption: "A clear caption for the post", hashtags: ["travel", "packing"], hook: "Two weeks, one bag", cta: "Show me yours", media_prompt: "An original scene of a neatly packed backpack on a bed", alt_text: "Packed backpack", script: [{ shot: "bag", seconds: 3 }] });
    const a = await run(async () => ({ text: ok, model: "m" }), account, row);
    assert.equal(a.output.source, "gemini");
    const bad = await run(async () => ({ text: JSON.stringify({ caption: "x".repeat(2300), media_prompt: "An original scene of a backpack" }), model: "m" }), account, row);
    assert.equal(bad.output.source, "template", "a failed validation is never stored as the model's package");
    const rows = await query(`SELECT version, status FROM creative_packages ORDER BY version`);
    assert.deepEqual(rows.map(r => r.status), ["superseded", "draft"]);
  } finally { await close(); }
});

test("unknown or rejected plan items fail permanently", async () => {
  const { close } = await freshDatabase();
  try {
    const { account, row } = await setup();
    await assert.rejects(makeCreative(async () => ({ skipped: "x" }))({ task: { account_id: account.account_id, input: { planItemId: "00000000-0000-0000-0000-000000000000" } } }), e => e.code === "not_found" && !e.retryable);
    await query(`UPDATE content_plan_items SET status = 'rejected'`);
    await assert.rejects(run(async () => ({ skipped: "x" }), account, row), e => e.code === "rejected_item");
  } finally { await close(); }
});
