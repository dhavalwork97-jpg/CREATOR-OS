import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDatabase, seedAccount } from "./helpers/pg.mjs";
import { query } from "../lib/sql.mjs";
import { compute, strategistFeedback } from "../lib/agents/analytics.mjs";

const NOW = new Date("2026-11-10T12:00:00Z");
const run = account => compute({ task: { account_id: account.account_id }, now: () => NOW });

async function post(account, id, { type = "REELS", hoursAgo = 200, checkpoint = "d7", metrics }) {
  const [m] = await query(`INSERT INTO media_items (account_id, ig_media_id, product_type, posted_at, permalink) VALUES ($1,$2,$3,$4,$5) RETURNING media_id`,
    [account.account_id, id, type, new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(), "https://instagram.com/p/" + id]);
  await query(`INSERT INTO media_insights (media_id, checkpoint, collected_at, metrics, source) VALUES ($1,$2,$3,$4::jsonb,'test')`,
    [m.media_id, checkpoint, NOW.toISOString(), JSON.stringify(metrics)]);
}
const m = (reach, saved, shares = 1, total = 10) => ({ reach, saved, shares, total_interactions: total });
const insight = async kind => (await query(`SELECT * FROM performance_insights WHERE kind = $1`, [kind]))[0];

test("with no data every insight says so; nothing is invented", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    const result = await run(account);
    assert.equal(result.output.checkpoint, null);
    const rows = await query(`SELECT status, sample_size FROM performance_insights`);
    assert.ok(rows.length >= 3);
    assert.ok(rows.every(r => r.status === "insufficient_data" && r.sample_size === 0));
    assert.deepEqual(await strategistFeedback(account.account_id), [], "nothing is passed to the strategist");
  } finally { await close(); }
});

test("clear Reels advantage becomes a recommendation with sample size, confidence and non-causal wording", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    for (let i = 0; i < 6; i += 1) await post(account, "r" + i, { type: "REELS", metrics: m(1000, 80 + i) });
    for (let i = 0; i < 6; i += 1) await post(account, "f" + i, { type: "FEED", metrics: m(1000, 20 + i) });
    await run(account);
    const row = await insight("format:savesPerReach");
    assert.equal(row.status, "recommendation");
    assert.equal(row.sample_size, 12);
    assert.ok(["low", "medium"].includes(row.confidence));
    assert.match(row.observation, /Reels have a median saves per reach/);
    assert.match(row.observation, /12 comparable posts/);
    assert.match(row.observation, /does not show that .* caused/);
    assert.doesNotMatch(row.observation, /\bbecause\b|\bproves?\b/i);
    assert.equal(row.metrics.groups.find(g => g.group === "Reels").n, 6);
    const feedback = await strategistFeedback(account.account_id);
    assert.ok(feedback.some(f => f.kind === "format:savesPerReach" && f.sampleSize === 12 && f.confidence));
  } finally { await close(); }
});

test("different observation windows are never mixed", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    // Reels measured only at h24, feed only at d7: no single checkpoint has two comparable groups.
    for (let i = 0; i < 6; i += 1) await post(account, "r" + i, { type: "REELS", checkpoint: "h24", hoursAgo: 30, metrics: m(1000, 90) });
    for (let i = 0; i < 6; i += 1) await post(account, "f" + i, { type: "FEED", checkpoint: "d7", metrics: m(1000, 10) });
    await run(account);
    const row = await insight("format:savesPerReach");
    assert.notEqual(row.status, "recommendation");
    assert.equal(row.status, "insufficient_data");
  } finally { await close(); }
});

test("a missing metric lowers the sample instead of counting as zero", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    for (let i = 0; i < 6; i += 1) await post(account, "r" + i, { type: "REELS", metrics: { reach: 1000, total_interactions: 50 } }); // no "saved" returned
    for (let i = 0; i < 6; i += 1) await post(account, "f" + i, { type: "FEED", metrics: m(1000, 20) });
    await run(account);
    const row = await insight("format:savesPerReach");
    assert.equal(row.status, "insufficient_data", "Reels have no saves data, so no saves comparison is made");
    assert.equal(row.sample_size, 6);
  } finally { await close(); }
});

test("a single viral post does not produce a recommendation", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    for (let i = 0; i < 5; i += 1) await post(account, "r" + i, { type: "REELS", metrics: m(1000, 20) });
    await post(account, "viral", { type: "REELS", metrics: m(1000, 900) });
    for (let i = 0; i < 6; i += 1) await post(account, "f" + i, { type: "FEED", metrics: m(1000, 20) });
    await run(account);
    assert.notEqual((await insight("format:savesPerReach")).status, "recommendation");
  } finally { await close(); }
});

test("rerunning on the same day refreshes rows instead of duplicating them", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await run(account);
    const first = (await query(`SELECT count(*)::int n FROM performance_insights`))[0].n;
    await run(account);
    assert.equal((await query(`SELECT count(*)::int n FROM performance_insights`))[0].n, first);
  } finally { await close(); }
});

test("follower growth uses stored snapshots only", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await run(account);
    assert.equal((await insight("follower_growth")).status, "insufficient_data");
    for (const [d, f] of [[6, 100], [3, 103], [0.2, 108]]) {
      await query(`INSERT INTO account_snapshots (account_id, kind, collected_at, followers, source) VALUES ($1,'profile',$2,$3,'test')`,
        [account.account_id, new Date(NOW.getTime() - d * 86400000).toISOString(), f]);
    }
    await run(account);
    const rows = await query(`SELECT group_key, status, observation FROM performance_insights WHERE kind='follower_growth' ORDER BY group_key`);
    assert.equal(rows.find(r => r.group_key === "7d").status, "observation");
    assert.match(rows.find(r => r.group_key === "7d").observation, /100 to 108 \(\+8\)/);
  } finally { await close(); }
});

test("learning cannot change permissions: settings untouched and the module has no path to them", async () => {
  const { close } = await freshDatabase();
  try {
    const account = await seedAccount();
    await query(`INSERT INTO agent_settings (account_id, autonomy_mode, limits) VALUES ($1,'copilot','{"maxPerDay":1}'::jsonb)`, [account.account_id]);
    for (let i = 0; i < 6; i += 1) await post(account, "r" + i, { type: "REELS", metrics: m(1000, 90) });
    for (let i = 0; i < 6; i += 1) await post(account, "f" + i, { type: "FEED", metrics: m(1000, 10) });
    await run(account);
    const [settings] = await query(`SELECT autonomy_mode, limits FROM agent_settings`);
    assert.deepEqual([settings.autonomy_mode, settings.limits], ["copilot", { maxPerDay: 1 }]);
    for (const file of ["lib/agents/analytics.mjs", "lib/analytics/store.mjs", "lib/analytics/calc.mjs"]) {
      const source = readFileSync(new URL("../" + file, import.meta.url), "utf8").split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
      assert.doesNotMatch(source, /agent_settings|killSwitch|autonomy_mode|publishDirect|ENABLE_AUTOPUBLISH|safety/i, file + " must not reach permissions or publishing");
    }
  } finally { await close(); }
});
