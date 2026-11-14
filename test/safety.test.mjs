import test from "node:test";
import assert from "node:assert/strict";
import { reviewContent, contentHash, STATUSES } from "../lib/safety/rules.mjs";
import { freshDatabase, seedAccount } from "./helpers/pg.mjs";
import { query } from "../lib/sql.mjs";
import { reviewCard, validReviewFor } from "../lib/safety/review.mjs";
import { saveSafetySettings } from "../lib/safety/store.mjs";

const clean = (o = {}) => ({ id: "c1", format: "image", caption: "A calm morning walk along the coast. What would you add?\n\n#travel #coast", mediaUrl: "https://cdn.example.com/a.jpg", mediaSource: "upload", ...o });
const verdict = (card, ctx) => reviewContent(card, ctx).status;

test("only the four required statuses exist", () => assert.deepEqual(STATUSES, ["approved", "needs_revision", "human_review", "blocked"]));

test("clean owned content is approved with no findings", () => {
  const r = reviewContent(clean());
  assert.equal(r.status, "approved");
  assert.deepEqual(r.findings, []);
});

test("hard failures block", () => {
  assert.equal(verdict(clean({ mediaUrl: null })), "blocked");
  assert.equal(verdict(clean({ mediaUrl: "http://x.example.com/a.jpg" })), "blocked");
  assert.equal(verdict(clean({ caption: "Great view! AKIAABCDEFGHIJKLMNOP " + "x".repeat(10) })), "blocked");
  assert.equal(verdict(clean({ format: "story" })), "blocked");
  assert.equal(verdict(clean({ caption: "Visit my casino today!!" }), { settings: { blockedTerms: ["Casino"] } }), "blocked");
});

test("fixable problems need revision", () => {
  assert.equal(verdict(clean({ caption: "Guaranteed results for everyone, try it today" })), "needs_revision");
  assert.equal(verdict(clean({ caption: "x".repeat(2300) })), "needs_revision");
  assert.equal(verdict(clean({ caption: "Hello there friends #a1 #a1" })), "needs_revision");
  assert.equal(verdict(clean({ caption: "Email me at me@example.com for details" })), "needs_revision");
  assert.equal(verdict(clean(), { recentCaptions: [clean().caption] }), "needs_revision");
});

test("judgement calls go to a human", () => {
  assert.equal(verdict(clean({ caption: "Use code SAVE10 for a discount code at checkout" })), "human_review");
  assert.equal(verdict(clean({ caption: "Giveaway time, enter below please" })), "human_review");
  assert.equal(verdict(clean({ mediaSource: "url" })), "human_review");
  assert.equal(verdict(clean({ caption: "Thinking about investing this year?" })), "human_review");
});

test("precedence: blocked > needs_revision > human_review", () => {
  assert.equal(verdict(clean({ mediaUrl: null, caption: "guaranteed giveaway" })), "blocked");
  assert.equal(verdict(clean({ caption: "guaranteed giveaway for everyone here" })), "needs_revision");
});

test("content hash changes with any reviewed field", () => {
  const base = contentHash(clean());
  for (const change of [{ caption: "other caption text" }, { mediaUrl: "https://cdn.example.com/b.jpg" }, { format: "reel" }, { altText: "alt" }]) assert.notEqual(contentHash(clean(change)), base);
  assert.equal(contentHash(clean({ id: "other", status: "ready" })), base, "non-content fields do not matter");
});

test("reviews are stored, bound to content, and go stale on edit; owner settings apply", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    const card = clean();
    assert.equal((await validReviewFor(account.account_id, card)).state, "unreviewed");
    const row = await reviewCard(account.account_id, card);
    assert.equal(row.status, "approved");
    assert.equal((await validReviewFor(account.account_id, card)).state, "current");
    assert.equal((await validReviewFor(account.account_id, { ...card, caption: "Edited after review, now different" })).state, "stale");
    await saveSafetySettings(account.account_id, { blockedTerms: ["coast"] });
    assert.equal((await reviewCard(account.account_id, card)).status, "blocked");
    assert.equal((await query(`SELECT 1 FROM safety_reviews`)).length, 2, "append-only history");
    await assert.rejects(query(`INSERT INTO safety_reviews (account_id, subject_type, subject_id, content_hash, status, rules_version) VALUES ($1,'board_card','x','h','maybe','v')`, [account.account_id]));
  } finally { await close(); }
});
