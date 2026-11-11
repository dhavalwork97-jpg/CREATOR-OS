import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, seedAccount } from "./helpers/pg.mjs";
import { query } from "../lib/sql.mjs";
import { accountHealth, mediaSync, accountInsights, mediaInsights, monitorDefinitions } from "../lib/agents/monitor.mjs";
import { classify, scrub, graphGet } from "../lib/meta/graph.mjs";
import { mediaMetricsFor, checkpointFor, readInsightValue } from "../lib/meta/metrics.mjs";
import { tick } from "../lib/supervisor.mjs";
import { enqueue } from "../lib/tasks/queue.mjs";
import { overview } from "../lib/monitor/store.mjs";

// MOCKED Meta Graph API. These tests prove our handling of Meta's documented response shapes and errors.
// They do NOT prove a real Meta call works; that needs a manual check with real credentials.
const TOKEN = "EAAB-super-secret-token";
const NOW = new Date("2026-11-10T12:00:00Z");
const hoursAgo = h => new Date(NOW.getTime() - h * 3600000).toISOString();

function mockMeta(routes) {
  const calls = [];
  globalThis.fetch = async url => {
    const u = new URL(url);
    calls.push(u);
    const path = u.pathname.replace(/^\/v[\d.]+\//, "");
    const handler = routes[path] || routes["*"];
    const out = handler ? await handler(u, path) : { status: 404, body: { error: { message: "unrouted " + path, code: 100 } } };
    return { ok: out.status < 400, status: out.status, json: async () => out.body };
  };
  return calls;
}
const ok = body => ({ status: 200, body });
const fail = (status, error) => ({ status, body: { error } });

const env = () => { Object.assign(process.env, { IG_GRAPH_API_VERSION: "v21.0", IG_USER_ID: "17841", IG_ACCESS_TOKEN: TOKEN }); };
const run = async (fn, account, input = {}) => fn({ task: { account_id: account.account_id, input }, now: () => NOW, signal: undefined });

test("classifies Graph errors and never leaks the token", () => {
  assert.equal(classify(400, { code: 190 }), "token");
  assert.equal(classify(400, { code: 4 }), "rate_limit");
  assert.equal(classify(400, { code: 10 }), "permission");
  assert.equal(classify(500, {}), "transient");
  assert.equal(classify(400, { code: 100 }), "request");
  assert.equal(scrub("bad " + TOKEN + " access_token=" + TOKEN, TOKEN).includes(TOKEN), false);
});

test("graphGet errors never contain the access token, even if Meta echoes it", async () => {
  env();
  mockMeta({ "*": () => fail(400, { message: "Invalid token " + TOKEN, code: 190 }) });
  await assert.rejects(graphGet("17841"), e => e.kind === "token" && !e.message.includes(TOKEN) && !JSON.stringify(e).includes(TOKEN));
});

test("metric registry: deprecated metrics are not requested; carousels/stories are skipped", () => {
  assert.ok(!mediaMetricsFor("REELS").includes("impressions"));
  assert.ok(!mediaMetricsFor("REELS").includes("plays"));
  assert.ok(mediaMetricsFor("REELS").includes("ig_reels_avg_watch_time"));
  assert.ok(!mediaMetricsFor("FEED").includes("ig_reels_avg_watch_time"));
  assert.equal(mediaMetricsFor("STORY"), null);
  assert.equal(readInsightValue({ values: [{ value: 0 }] }), 0, "a real zero is kept");
  assert.equal(readInsightValue({ values: [] }), null, "empty data is null, not 0");
  assert.equal(readInsightValue(undefined), null);
});

test("checkpoints are only labelled when the observation is inside the window", () => {
  assert.equal(checkpointFor(2, new Set()), "h1");
  assert.equal(checkpointFor(30, new Set()), "h24");
  assert.equal(checkpointFor(50, new Set()), "baseline", "first seen between windows is a baseline, not a fake h24");
  assert.equal(checkpointFor(50, new Set(["baseline"])), null);
  assert.equal(checkpointFor(30, new Set(["h24"])), null, "never collected twice");
  assert.equal(checkpointFor(170, new Set(["baseline"])), "d7");
});

test("account health stores a timestamped snapshot and marks the account connected", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    mockMeta({ "17841": () => ok({ username: "demo", followers_count: 120, follows_count: 30, media_count: 9 }) });
    const first = await run(accountHealth, account);
    assert.equal(first.output.followers, 120);
    assert.equal(first.output.followerChange, null, "no previous snapshot, no invented change");
    mockMeta({ "17841": () => ok({ username: "demo", followers_count: 125, follows_count: 30, media_count: 9 }) });
    const second = await run(accountHealth, account);
    assert.equal(second.output.followerChange, 5);
    assert.equal((await query(`SELECT count(*)::int n FROM account_snapshots WHERE kind='profile'`))[0].n, 2);
    const [row] = await query(`SELECT username, connection_status, token_status FROM ig_accounts`);
    assert.deepEqual(row, { username: "demo", connection_status: "connected", token_status: "valid" });
  } finally { await close(); }
});

test("a missing field is stored as null with a reason, not zero", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    mockMeta({ "17841": () => ok({ username: "demo", followers_count: 50, media_count: 3 }) });
    await run(accountHealth, account);
    const [snap] = await query(`SELECT following, unavailable FROM account_snapshots`);
    assert.equal(snap.following, null);
    assert.equal(snap.unavailable.following.code, "not_returned");
  } finally { await close(); }
});

test("invalid token is detected, recorded once, and the task is not retried; later success recovers", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    await query(`INSERT INTO agent_settings (account_id) VALUES ($1)`, [account.account_id]);
    await enqueue({ accountId: account.account_id, agent: "monitor", type: "account_health", idempotencyKey: "h1" });
    mockMeta({ "17841": () => fail(400, { message: "Error validating access token", code: 190, type: "OAuthException" }) });
    const clock = () => new Date(Date.now() + 60000);
    const summary = await tick({ handlers: { "monitor.account_health": accountHealth }, now: clock, killSwitch: false });
    assert.equal(summary.failed, 1);
    assert.equal(summary.retried, 0, "token errors are not retried blindly");
    const [acct] = await query(`SELECT connection_status, token_status, last_error FROM ig_accounts`);
    assert.deepEqual([acct.connection_status, acct.token_status], ["error", "invalid"]);
    assert.equal((await query(`SELECT count(*)::int n FROM audit_events WHERE action='token_invalid'`))[0].n, 1);
    assert.equal((await query(`SELECT count(*)::int n FROM account_snapshots`))[0].n, 0, "no snapshot written on failure");

    mockMeta({ "17841": () => ok({ username: "demo", followers_count: 10, follows_count: 1, media_count: 1 }) });
    await run(accountHealth, account);
    assert.equal((await query(`SELECT token_status FROM ig_accounts`))[0].token_status, "valid");
    assert.equal((await query(`SELECT count(*)::int n FROM audit_events WHERE action='token_recovered'`))[0].n, 1);
  } finally { await close(); }
});

test("transient and rate-limit failures are retryable; history is untouched by a failed run", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    mockMeta({ "17841": () => ok({ username: "d", followers_count: 7, follows_count: 1, media_count: 1 }) });
    await run(accountHealth, account);
    mockMeta({ "17841": () => fail(500, { message: "Service unavailable", code: 2 }) });
    await assert.rejects(run(accountHealth, account), e => e.retryable === true && e.code === "graph_transient");
    mockMeta({ "17841": () => fail(400, { message: "rate", code: 4 }) });
    await assert.rejects(run(accountHealth, account), e => e.retryable === true && e.code === "graph_rate_limit");
    assert.equal((await query(`SELECT count(*)::int n FROM account_snapshots`))[0].n, 1, "earlier history intact");
  } finally { await close(); }
});

test("media sync upserts without duplicating and keeps first_seen_at", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    const page = caption => ok({ data: [{ id: "m1", caption, media_type: "VIDEO", media_product_type: "REELS", permalink: "https://instagram.com/reel/a", timestamp: hoursAgo(3), like_count: 4, comments_count: 1 }] });
    mockMeta({ "17841/media": () => page("one") });
    assert.equal((await run(mediaSync, account)).output.created, 1);
    const [{ first_seen_at }] = await query(`SELECT first_seen_at FROM media_items`);
    mockMeta({ "17841/media": () => page("edited") });
    const again = await run(mediaSync, { ...account });
    assert.equal(again.output.created, 0);
    const rows = await query(`SELECT caption, first_seen_at FROM media_items`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].caption, "edited");
    assert.equal(new Date(rows[0].first_seen_at).getTime(), new Date(first_seen_at).getTime());
  } finally { await close(); }
});

test("account insights: collected metrics stored, empty ones recorded as unavailable, rerun does not overwrite", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    const calls = mockMeta({ "17841/insights": u => {
      const metric = u.searchParams.get("metric");
      assert.equal(u.searchParams.get("metric_type"), "total_value");
      assert.equal(u.searchParams.get("period"), "day");
      if (metric === "reach") return ok({ data: [{ name: "reach", total_value: { value: 321 } }] });
      if (metric === "views") return ok({ data: [{ name: "views", total_value: { value: 0 } }] });
      if (metric === "follows_and_unfollows") return ok({ data: [] });
      if (metric === "replies") return fail(400, { message: "(#100) metric not supported", code: 100 });
      return ok({ data: [{ name: metric, total_value: { value: 1 } }] });
    } });
    const result = await run(accountInsights, account);
    assert.equal(result.output.stored, true);
    const [snap] = await query(`SELECT metrics, unavailable, window_start, window_end FROM account_snapshots WHERE kind='insights'`);
    assert.equal(snap.metrics.reach, 321);
    assert.equal(snap.metrics.views, 0, "a genuine zero is kept");
    assert.equal(snap.unavailable.follows_and_unfollows.code, "no_data_returned");
    assert.equal(snap.unavailable.replies.graphCode, 100);
    assert.ok(!("follows_and_unfollows" in snap.metrics) && !("replies" in snap.metrics));
    assert.ok(!calls.some(u => u.searchParams.get("metric") === "impressions"));
    assert.equal((await run(accountInsights, account)).output.stored, false);
    assert.equal((await query(`SELECT count(*)::int n FROM account_snapshots WHERE kind='insights'`))[0].n, 1);
  } finally { await close(); }
});

test("account insights: a transient failure retries and never stores a falsely-unavailable snapshot", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    mockMeta({ "17841/insights": u => u.searchParams.get("metric") === "reach" ? ok({ data: [{ name: "reach", total_value: { value: 9 } }] }) : fail(503, { message: "Service unavailable", code: 2 }) });
    await assert.rejects(run(accountInsights, account), e => e.retryable === true && e.code === "graph_transient");
    assert.equal((await query(`SELECT count(*)::int n FROM account_snapshots`))[0].n, 0);
    mockMeta({ "17841/insights": u => ok({ data: [{ name: u.searchParams.get("metric"), total_value: { value: 2 } }] }) });
    assert.equal((await run(accountInsights, account)).output.stored, true, "the retry can still record the window");
  } finally { await close(); }
});

test("account insights with an invalid token throws and stores nothing", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    mockMeta({ "17841/insights": () => fail(400, { message: "expired", code: 190 }) });
    await assert.rejects(run(accountInsights, account), e => e.code === "graph_token" && e.retryable === false);
    assert.equal((await query(`SELECT count(*)::int n FROM account_snapshots`))[0].n, 0);
  } finally { await close(); }
});

test("media insights: one record per checkpoint, no requests for stories, per-metric fallback, unavailable reasons kept", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    const insert = (ig, type, age) => query(`INSERT INTO media_items (account_id, ig_media_id, product_type, posted_at) VALUES ($1,$2,$3,$4)`, [account.account_id, ig, type, hoursAgo(age)]);
    await insert("reel1", "REELS", 25);
    await insert("story1", "STORY", 2);
    await insert("feed1", "FEED", 50);
    const calls = mockMeta({ "*": (u, path) => {
      const ig = path.split("/")[0];
      const requested = u.searchParams.get("metric").split(",");
      if (ig === "feed1" && requested.length > 1) return fail(400, { message: "(#100) combination not supported", code: 100 });
      return ok({ data: requested.filter(m => !(ig === "reel1" && m === "shares")).map(name => ({ name, values: [{ value: 5 }] })) });
    } });
    const first = await run(mediaInsights, account);
    assert.equal(first.output.collected, 2);
    assert.ok(!calls.some(u => u.pathname.includes("story1")), "stories are not requested");
    const rows = await query(`SELECT m.ig_media_id, i.checkpoint, i.metrics, i.unavailable FROM media_insights i JOIN media_items m USING (media_id) ORDER BY 1`);
    const reel = rows.find(r => r.ig_media_id === "reel1"), feed = rows.find(r => r.ig_media_id === "feed1");
    assert.equal(reel.checkpoint, "h24");
    assert.equal(reel.unavailable.shares.code, "no_data_returned");
    assert.equal(reel.metrics.reach, 5);
    assert.equal(feed.checkpoint, "baseline");
    assert.equal(feed.metrics.likes, 5, "per-metric fallback recovered the metrics");
    assert.equal((await run(mediaInsights, account)).output.collected, 0, "nothing is re-collected for a checkpoint");
  } finally { await close(); }
});

test("media insights stop at the per-run request cap", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    for (let i = 0; i < 5; i += 1) await query(`INSERT INTO media_items (account_id, ig_media_id, product_type, posted_at) VALUES ($1,$2,'FEED',$3)`, [account.account_id, "p" + i, hoursAgo(30 + i)]);
    mockMeta({ "*": u => ok({ data: u.searchParams.get("metric").split(",").map(name => ({ name, values: [{ value: 1 }] })) }) });
    const result = await run(mediaInsights, account, { maxItems: 2 });
    assert.deepEqual([result.output.collected, result.output.capped], [2, true]);
  } finally { await close(); }
});

test("monitoring definitions follow settings, respect the disabled flag, and match the brief's defaults", () => {
  const defaults = Object.fromEntries(monitorDefinitions().map(d => [d.type, d.intervalMinutes]));
  assert.deepEqual(defaults, { account_health: 360, media_sync: 360, account_insights: 1440, media_insights: 1440 });
  assert.equal(monitorDefinitions({ enabled: false }).length, 0);
  assert.equal(monitorDefinitions({ accountHealthMinutes: 60 })[0].intervalMinutes, 60);
});

test("overview exposes only stored data, with nulls and reasons preserved", async () => {
  env();
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount("17841");
    mockMeta({ "17841": () => ok({ username: "demo", followers_count: 5, media_count: 1 }) });
    await run(accountHealth, account);
    const data = await overview(account.account_id);
    assert.equal(data.profile.length, 1);
    assert.equal(data.profile[0].following, null);
    assert.equal(JSON.stringify(data).includes(TOKEN), false);
    assert.equal(data.insights, null, "no insights are invented before any are collected");
  } finally { await close(); }
});
