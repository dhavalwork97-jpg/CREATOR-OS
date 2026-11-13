import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, seedAccount } from "./helpers/pg.mjs";
import { query } from "../lib/sql.mjs";
import { similarity, isDuplicate, buildItems, weekDates } from "../lib/strategy/calc.mjs";
import { makeResearcher, makeStrategist, parseIdeas } from "../lib/agents/strategy.mjs";
import * as store from "../lib/strategy/store.mjs";
import { addCardFromPlanItem } from "../lib/content-board.mjs";

const NOW = new Date("2026-11-10T12:00:00Z");
const ctx = account => ({ task: { account_id: account.account_id }, now: () => NOW });
const noAi = async () => ({ generateIdeas: async () => ({ skipped: "text_provider_not_configured" }), existingBoardTexts: async () => [] });

test("similarity and duplicate detection", () => {
  assert.ok(similarity("5 mistakes beginners make with budgeting", "Mistakes beginners make with budgeting") > 0.6);
  assert.ok(similarity("sourdough starter tips", "quarterly tax filing") < 0.1);
  assert.equal(isDuplicate("a b", []), false);
});

test("weekDates spreads slots across seven days", () => {
  assert.deepEqual(weekDates("2026-11-11", 3), ["2026-11-11", "2026-11-13", "2026-11-15"]);
  assert.equal(weekDates("2026-11-11", 99).length, 7);
});

test("buildItems skips rejected, planned and duplicate opportunities and never pads", () => {
  const opp = (id, title, o = {}) => ({ opportunity_id: id, title, summary: "why " + title, status: "new", confidence: "low", source_class: "ai_hypothesis", ...o });
  const items = buildItems({
    opportunities: [opp("1", "Morning routine mistakes", { status: "rejected" }), opp("2", "Packing checklist for weekend trips", { confidence: "medium", source_class: "account_analytics" }),
      opp("3", "Weekend trips packing checklist"), opp("4", "Budget camera lenses", { status: "accepted" })],
    slots: 5, startDate: "2026-11-11", pillars: ["travel"], preferredFormat: "reel", existingTexts: []
  });
  assert.deepEqual(items.map(i => i.opportunity_id), ["4", "2"], "accepted first, duplicate of #2 dropped, rejected dropped, no filler");
  assert.equal(items[0].format, "reel");
});

test("researcher with nothing configured records nothing and says why", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    const out = (await makeResearcher(noAi)(ctx(account))).output;
    assert.equal(out.aiHypotheses, 0);
    assert.equal(out.aiSkipped, "niche_or_pillars_not_set");
    assert.equal(out.externalResearch, "not_configured");
    assert.equal((await query(`SELECT 1 FROM content_opportunities`)).length, 0);
  } finally { await close(); }
});

test("AI ideas are stored only as low-confidence hypotheses with no sources", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await store.saveStrategySettings(account.account_id, { niche: "travel", audience: "backpackers", objective: "grow", pillars: ["packing"] });
    const deps = async () => ({ generateIdeas: async () => ({ model: "m", text: JSON.stringify({ ideas: [{ title: "One bag for two weeks", summary: "Shows a repeatable packing system", pillar: "packing", format: "reel" }, { title: "x", summary: "bad" }] }) }), existingBoardTexts: async () => [] });
    const out = (await makeResearcher(deps)(ctx(account))).output;
    assert.equal(out.aiHypotheses, 1);
    const [row] = await query(`SELECT * FROM content_opportunities`);
    assert.equal(row.source_class, "ai_hypothesis");
    assert.equal(row.confidence, "low");
    assert.deepEqual(row.source_urls, []);
    assert.match(row.summary, /Not a verified trend/);
    await makeResearcher(deps)(ctx(account));
    assert.equal((await query(`SELECT 1 FROM content_opportunities`)).length, 1, "re-running refreshes, never duplicates");
  } finally { await close(); }
});

test("parseIdeas tolerates fences and garbage", () => {
  assert.equal(parseIdeas("not json").length, 0);
  assert.equal(parseIdeas("```json\n[{\"title\":\"A long enough title\",\"summary\":\"long enough summary\"}]\n```").length, 1);
});

test("a rejected opportunity stays rejected after re-research", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    const o = { dedupeKey: "k", sourceClass: "ai_hypothesis", title: "Idea title here", summary: "s", confidence: "low" };
    const { opportunity_id } = await store.upsertOpportunity(account.account_id, o);
    await store.setOpportunityStatus(account.account_id, opportunity_id, "rejected");
    await store.upsertOpportunity(account.account_id, { ...o, summary: "fresher" });
    const [row] = await query(`SELECT status, summary FROM content_opportunities`);
    assert.equal(row.status, "rejected");
    assert.equal(row.summary, "fresher");
  } finally { await close(); }
});

test("strategist needs pillars, plans fewer items when evidence is thin, avoids existing posts, keeps owner edits", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await assert.rejects(makeStrategist(noAi)(ctx(account)), e => e.code === "not_configured" && e.retryable === false);
    await store.saveStrategySettings(account.account_id, { pillars: ["travel"], postsPerWeek: 4 });
    await query(`INSERT INTO media_items (account_id, ig_media_id, product_type, posted_at, caption) VALUES ($1,'m1','FEED',$2,'Packing checklist for weekend trips')`, [account.account_id, new Date(NOW.getTime() - 5 * 86400000).toISOString()]);
    for (const [k, t] of [["a", "Packing checklist for weekend trips"], ["b", "Budget camera lenses for travel"]]) {
      await store.upsertOpportunity(account.account_id, { dedupeKey: k, sourceClass: "ai_hypothesis", title: t, summary: "why", confidence: "low" });
    }
    const first = await makeStrategist(noAi)(ctx(account));
    assert.equal(first.output.planned, 1, "duplicate of an already-posted caption is skipped");
    assert.match(first.output.note, /No filler/);
    const [item] = await store.listPlan(account.account_id, "2026-11-01");
    assert.equal(item.topic, "Budget camera lenses for travel");
    assert.equal(item.evidence_class, "ai_hypothesis");
    await store.updatePlanItem(account.account_id, item.item_id, { topic: "My own wording", edited: true, status: "edited" });
    await makeStrategist(noAi)(ctx(account));
    const plan = await store.listPlan(account.account_id, "2026-11-01");
    assert.ok(plan.some(p => p.topic === "My own wording" && p.edited_by_owner), "edited items survive regeneration");
  } finally { await close(); }
});

test("addCardFromPlanItem creates a needs_media card, never an approved or scheduled one", () => {
  const state = { boardCards: [], posts: [], audit: [] };
  const card = addCardFromPlanItem(state, { item_id: "i", generation_id: "g", plan_date: "2026-11-12", format: "reel", pillar: "travel", topic: "One bag trip", hook: null }, { niche: "travel", audience: "backpackers" }, NOW);
  assert.equal(card.status, "needs_media");
  assert.equal(state.boardCards.length, 1);
  assert.equal(card.mediaUrl, undefined);
});
