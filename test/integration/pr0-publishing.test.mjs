import test from "node:test";
import assert from "node:assert/strict";
import { startApp, graphRoutes } from "../helpers/harness.mjs";

const graphCalls = [];
const app = await startApp({
  env: {
    IG_GRAPH_API_VERSION: "v21.0", IG_USER_ID: "17841", IG_ACCESS_TOKEN: "token",
    // A leftover Zapier variable must never reroute publishing.
    ZAPIER_PUBLISH_WEBHOOK_URL: "https://hooks.zapier.test/abc", ZAPIER_CALLBACK_SECRET: "s".repeat(32)
  },
  routes: graphRoutes(graphCalls)
});
test.after(() => app.close());

const brief = { niche: "coastal travel", audience: "quiet travel fans", objective: "grow", pillars: ["escapes"], postsPerWeek: 3 };

test("requires the owner session", async () => {
  assert.equal((await app.call("/api/state", undefined, { auth: false })).status, 401);
});

test("the Zapier callback route no longer exists", async () => {
  assert.equal((await app.call("/api/publishing/callback", { postId: "x", status: "published" })).status, 404);
});

test("state reports the configured timezone and no Zapier fields", async () => {
  const { body } = await app.call("/api/state");
  assert.equal(body.schedule.label, "UTC+05:30");
  assert.equal("zapierConfigured" in body.connection, false);
  assert.equal(body.settings.killSwitch, true);
});

test("board card -> media URL -> approve schedules one post at a configured local hour", async () => {
  const generated = await app.call("/api/board/generate", brief);
  assert.equal(generated.status, 201);
  const card = generated.body.cards[0];
  assert.equal((await app.call("/api/board/" + card.id + "/approve", {})).status, 409);
  assert.equal((await app.call("/api/board/" + card.id + "/update", { mediaUrl: "https://media.example.com/a.jpg" })).status, 200);
  const approved = await app.call("/api/board/" + card.id + "/approve", {});
  assert.equal(approved.status, 200);
  const local = new Date(Date.parse(approved.body.post.scheduledAt) + 330 * 60000);
  assert.ok([12, 19].includes(local.getUTCHours()), "scheduled at a configured local hour");
  assert.equal(approved.body.post.status, "scheduled");
});

test("legacy awaiting_confirmation posts can still be cancelled", async () => {
  await app.db.mutateState(state => { state.posts.unshift({ id: "11111111-1111-1111-1111-111111111111", type: "image", caption: "old", mediaUrl: "https://m.example.com/x.jpg", scheduledAt: new Date().toISOString(), status: "awaiting_confirmation" }); });
  const cancelled = await app.call("/api/posts/11111111-1111-1111-1111-111111111111/cancel", {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.post.status, "cancelled");
});

test("worker rejects missing or wrong secrets", async () => {
  assert.equal((await app.call("/api/worker/run", undefined, { auth: false })).status, 401);
  assert.equal((await app.call("/api/worker/run", undefined, { auth: false, headers: { authorization: "Bearer wrong" } })).status, 401);
});

test("worker publishes through Meta only, and never contacts Zapier", async () => {
  const bearer = { authorization: "Bearer " + "c".repeat(40) };
  // Kill switch is ON by default: nothing may publish.
  process.env.ENABLE_AUTOPUBLISH = "true";
  const blocked = await app.call("/api/worker/run", undefined, { auth: false, headers: bearer });
  assert.equal(blocked.body.processed, false);
  assert.equal(graphCalls.length, 0);

  await app.call("/api/kill-switch", { enabled: false });
  await app.db.mutateState(state => { state.posts.find(p => p.status === "scheduled").scheduledAt = new Date(Date.now() - 1000).toISOString(); });
  const run = await app.call("/api/worker/run", undefined, { auth: false, headers: bearer });
  assert.equal(run.body.processed, true);
  const { body } = await app.call("/api/state");
  const published = body.posts.find(p => p.status === "published");
  assert.ok(published, "the due post is published");
  assert.equal(published.instagramMediaId, "ig-media-1");
  assert.deepEqual(graphCalls, ["POST 17841/media", "GET container-1", "POST 17841/media_publish"]);
  assert.equal(app.outbound.some(call => call.url.includes("zapier")), false);
});
