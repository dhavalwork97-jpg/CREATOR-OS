import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/harness.mjs";
import { freshDatabase } from "../helpers/pg.mjs";

const app = await startApp({ env: { IG_GRAPH_API_VERSION: "v21.0", IG_USER_ID: "17841", IG_ACCESS_TOKEN: "tok-never-leak" } });
test.after(() => app.close());
const bearer = { authorization: "Bearer " + "c".repeat(40) };
const brief = { niche: "coastal travel", audience: "quiet travel fans", objective: "grow", pillars: ["escapes"], postsPerWeek: 3 };

test("safety routes require auth and migrations", async () => {
  assert.equal((await app.call("/api/safety/reviews", undefined, { auth: false })).status, 401);
  assert.equal((await app.call("/api/safety/reviews")).status, 503);
});

test("legacy approval still works unreviewed; a current block stops it; an edit makes the block stale", async () => {
  const unmigrated = await app.call("/api/board/generate", brief);
  const c0 = unmigrated.body.cards[0];
  await app.call("/api/board/" + c0.id + "/update", { mediaUrl: "https://media.example.com/z.jpg" });
  const legacy = await app.call("/api/board/" + c0.id + "/approve", {});
  assert.equal(legacy.status, 200, "no migrations applied: legacy approval unaffected");
  assert.equal(legacy.body.safety.state, "unavailable");

  const { close } = await freshDatabase();
  try {
    await app.call("/api/worker/tick", undefined, { auth: false, headers: bearer });
    const card = (await app.call("/api/board/generate", brief)).body.cards[0];
    await app.call("/api/board/" + card.id + "/update", { mediaUrl: "https://media.example.com/a.jpg" });
    assert.equal((await app.call("/api/safety/settings", { blockedTerms: "x" })).status, 400);
    assert.equal((await app.call("/api/safety/settings", {})).status, 400);
    await app.call("/api/safety/settings", { blockedTerms: [card.caption.split(" ")[0]] });
    const review = await app.call("/api/safety/cards/" + card.id + "/review", {});
    assert.equal(review.status, 200);
    assert.equal(review.body.review.status, "blocked");
    const refused = await app.call("/api/board/" + card.id + "/approve", {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Safety review blocked/);
    assert.ok(refused.body.findings.length);

    await app.call("/api/safety/settings", { blockedTerms: [] });
    await app.call("/api/board/" + card.id + "/update", { caption: "A fresh caption that has changed since the review" });
    const approved = await app.call("/api/board/" + card.id + "/approve", {});
    assert.equal(approved.status, 200, "the stale block no longer applies");
    assert.equal(approved.body.safety.state, "stale");
    assert.equal((await app.call("/api/safety/cards/00000000-0000-0000-0000-000000000000/review", {})).status, 404);
    const list = await app.call("/api/safety/reviews?cardId=" + card.id);
    assert.equal(list.body.reviews.length, 1);
    assert.equal(JSON.stringify(list.body).includes("tok-never-leak"), false);
  } finally { await close(); }
});
