import test from "node:test";
import assert from "node:assert/strict";
import { generateBoard, updateBoardCard, approveBoardCard, releaseBoardCard, discardBoardCard } from "../lib/content-board.mjs";

const config = { hours: [12, 19], offsetMinutes: 330, maxPerDay: 3, minGapMinutes: 180 };
const brief = { niche: "coastal travel", audience: "quiet travel fans", objective: "grow engagement", pillars: ["coastal escapes", "travel tips"], postsPerWeek: 3 };
const state = () => ({ posts: [], audit: [], settings: { killSwitch: true } });

test("generates editable cards with prompts, captions and local posting suggestions", () => {
  const s = state();
  const cards = generateBoard(s, brief, new Date("2026-11-07T00:00:00Z"), config);
  assert.equal(cards.length, 3);
  assert.ok(cards.every(c => c.status === "needs_media" && c.prompt.length > 20 && c.caption));
  assert.ok(cards.every(c => c.suggestedAt));
  assert.equal(s.boardCards.length, 3);
});

test("requires a public HTTPS media URL and human approval before scheduling", () => {
  const s = state();
  const [card] = generateBoard(s, brief, new Date("2026-11-07T00:00:00Z"), config);
  assert.equal(approveBoardCard(s, card.id, new Date("2026-11-07T00:00:00Z"), config).status, 409);
  assert.equal(updateBoardCard(s, card.id, { mediaUrl: "http://example.com/image.jpg" }).status, 400);
  assert.equal(updateBoardCard(s, card.id, { mediaUrl: "https://media.example.com/image.jpg" }).status, 200);
  const result = approveBoardCard(s, card.id, new Date("2026-11-07T00:00:00Z"), config);
  assert.equal(result.status, 200);
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].status, "scheduled");
  assert.equal(s.posts[0].cardId, card.id);
  assert.equal(card.status, "scheduled");
});

test("cancelling a scheduled post releases its card; discard removes unscheduled cards", () => {
  const s = state();
  const [card] = generateBoard(s, brief, new Date("2026-11-07T00:00:00Z"), config);
  updateBoardCard(s, card.id, { mediaUrl: "https://media.example.com/image.jpg" });
  const post = approveBoardCard(s, card.id, new Date("2026-11-07T00:00:00Z"), config).body.post;
  releaseBoardCard(s, post);
  assert.equal(card.status, "ready");
  assert.equal(discardBoardCard(s, card.id).status, 200);
  assert.equal(s.boardCards.length, 2);
});
