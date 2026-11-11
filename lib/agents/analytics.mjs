import { compareGroups, ratesFor, timeBucket, followerGrowth, median, METRIC_LABELS, MIN_GROUP } from "../analytics/calc.mjs";
import * as store from "../analytics/store.mjs";
import { scheduleConfig } from "../scheduler.mjs";

// The Analytics & Learning agent only READS stored Meta metrics and WRITES performance_insights.
// It has no import of, and no query against, agent_settings, publishing, the kill switch or safety rules.
// Its output is advice for the Content Strategist; it cannot change what may be published.

const CHECKPOINT_PREFERENCE = ["d7", "h72", "h24"]; // longer observation windows are more stable
const FORMAT_LABEL = { REELS: "Reels", FEED: "feed posts" };
const METRICS = ["reach", "savesPerReach", "sharesPerReach", "interactionsPerReach"];
const pct = value => Math.round(value * 100) + "%";
const fmt = value => (value === null || value === undefined ? "n/a" : value >= 1 ? String(Math.round(value * 10) / 10) : String(Math.round(value * 10000) / 10000));

function describe(kindLabel, metric, comparison, checkpoint) {
  const [lead, next] = [comparison.groups.find(g => g.group === comparison.leader), comparison.groups.find(g => g.group === comparison.runnerUp)];
  const base = "Across " + comparison.sampleSize + " comparable posts measured at " + checkpoint + ", " + comparison.leader + " have a median " + METRIC_LABELS[metric] +
    " " + pct(comparison.relativeDiff) + " higher than " + comparison.runnerUp + " (median " + fmt(lead.median) + " vs " + fmt(next.median) + "; " + lead.n + " vs " + next.n + " posts).";
  return base + " This is an association within your own account. Topic, timing and audience were not controlled, so it does not show that " + kindLabel + " caused the difference.";
}

export async function compute({ task, now }) {
  const at = now();
  const accountId = task.account_id;
  const offset = scheduleConfig().offsetMinutes;
  const offsetLabel = scheduleConfig().label;
  const day = at.toISOString().slice(0, 10);

  const rows = await store.comparableRows(accountId, CHECKPOINT_PREFERENCE);
  const byCheckpoint = new Map();
  for (const row of rows) {
    if (!byCheckpoint.has(row.checkpoint)) byCheckpoint.set(row.checkpoint, []);
    byCheckpoint.get(row.checkpoint).push({ ...row, rates: ratesFor(row.metrics) });
  }
  // Use the most mature checkpoint that has enough posts to compare; never mix checkpoints.
  const checkpoint = CHECKPOINT_PREFERENCE.find(cp => (byCheckpoint.get(cp) || []).length >= MIN_GROUP * 2) ||
    CHECKPOINT_PREFERENCE.find(cp => (byCheckpoint.get(cp) || []).length > 0) || null;
  const posts = checkpoint ? byCheckpoint.get(checkpoint) : [];
  const window = checkpoint ? checkpoint + " observation window" : "no comparable posts";
  const written = { recommendation: 0, observation: 0, insufficient_data: 0 };
  const save = async insight => { await store.saveInsight(accountId, insight, day); written[insight.status] += 1; };

  if (!checkpoint) {
    await save({ kind: "data_coverage", status: "insufficient_data", confidence: "none", window, sampleSize: 0,
      observation: "No posts have stored insights at a comparable checkpoint yet. Insights are collected after each post reaches 24 hours, 72 hours and 7 days.",
      suggestedAction: "No action yet. Keep monitoring enabled and check again after more posts have been measured." });
  } else {
    const dimensions = [
      { kind: "format", label: "the format", pick: p => FORMAT_LABEL[String(p.product_type).toUpperCase()] || null },
      { kind: "time_of_day", label: "the posting time", pick: p => timeBucket(p.posted_at, offset) }
    ];
    for (const dim of dimensions) {
      for (const metric of METRICS) {
        const input = posts.map(p => ({ group: dim.pick(p), value: p.rates[metric], id: p.ig_media_id }));
        const usable = input.filter(r => r.group && Number.isFinite(r.value)).length;
        const comparison = compareGroups(input);
        const base = { kind: dim.kind + ":" + metric, groupKey: checkpoint, window: window + (dim.kind === "time_of_day" ? ", times in " + offsetLabel : ""), sampleSize: usable,
          metrics: { checkpoint, groups: comparison.groups, metric } };
        if (comparison.status === "clear_difference") {
          await save({ ...base, status: "recommendation", confidence: comparison.confidence, sampleSize: comparison.sampleSize,
            observation: describe(dim.label, metric, comparison, checkpoint),
            suggestedAction: "Try more " + comparison.leader + " over the next week, then re-check this comparison. A recommendation here changes planning only, never publishing permissions.",
            evidence: { leader: comparison.leader, runnerUp: comparison.runnerUp, relativeDiff: comparison.relativeDiff } });
        } else if (comparison.status === "no_clear_difference") {
          await save({ ...base, status: "observation", confidence: "low", observation: "No reliable " + dim.kind.replace("_", " ") + " difference in " + METRIC_LABELS[metric] + ". " + comparison.reason, evidence: { reason: comparison.reason } });
        } else {
          await save({ ...base, status: "insufficient_data", confidence: "none", observation: "Not enough data to compare " + dim.kind.replace("_", " ") + " on " + METRIC_LABELS[metric] + ". " + comparison.reason,
            suggestedAction: "No action. A comparison needs at least " + MIN_GROUP + " posts in each of two groups.", evidence: { reason: comparison.reason } });
        }
      }
    }
    // Strongest and weakest posts by interactions per reach, shown only with enough posts and without causal claims.
    const ranked = posts.filter(p => Number.isFinite(p.rates.interactionsPerReach)).sort((a, b) => b.rates.interactionsPerReach - a.rates.interactionsPerReach);
    if (ranked.length >= MIN_GROUP) {
      const pick = list => list.map(p => ({ permalink: p.permalink, format: p.product_type, interactionsPerReach: Math.round(p.rates.interactionsPerReach * 10000) / 10000, reach: p.rates.reach }));
      await save({ kind: "top_and_bottom_posts", groupKey: checkpoint, status: "observation", confidence: "low", window, sampleSize: ranked.length,
        observation: "Of " + ranked.length + " posts measured at " + checkpoint + ", the median is " + fmt(median(ranked.map(p => p.rates.interactionsPerReach))) +
          " interactions per reach. The lists show which posts sit at either end; they do not explain why.",
        evidence: { top: pick(ranked.slice(0, 3)), bottom: pick(ranked.slice(-3).reverse()) } });
    }
  }

  const snapshots = await store.profileSnapshots(accountId, 30, at);
  for (const days of [7, 30]) {
    const growth = followerGrowth(snapshots, { days, now: at });
    if (growth.status === "ok") {
      await save({ kind: "follower_growth", groupKey: days + "d", status: "observation", confidence: growth.snapshots >= 5 ? "medium" : "low", window: "last " + days + " days",
        sampleSize: growth.snapshots, metrics: growth,
        observation: "Followers moved from " + growth.from + " to " + growth.to + " (" + (growth.change >= 0 ? "+" : "") + growth.change + ") over " + growth.spanDays + " days of stored snapshots. This is a count, not an explanation." });
    } else {
      await save({ kind: "follower_growth", groupKey: days + "d", status: "insufficient_data", confidence: "none", window: "last " + days + " days", sampleSize: growth.snapshots,
        metrics: growth, observation: "Not enough stored follower snapshots to report " + days + "-day growth. At least two snapshots at least a day apart are needed." });
    }
  }
  return { output: { checkpoint, postsConsidered: posts.length, ...written }, decision: { action: "recomputed performance insights", checkpointUsed: checkpoint } };
}

export const analyticsHandlers = { "analytics.compute": compute };
export const analyticsDefinitions = () => [{ agent: "analytics", type: "compute", intervalMinutes: 1440, priority: 2, timeoutSeconds: 45 }];

// Structured feedback for the Content Strategist (consumed in Phase 3). Only reliable recommendations are passed on.
export async function strategistFeedback(accountId) {
  const rows = await store.latestInsights(accountId);
  return rows.filter(r => r.status === "recommendation" && ["low", "medium", "high"].includes(r.confidence)).map(r => ({
    kind: r.kind, observation: r.observation, supportingMetrics: r.metrics, sampleSize: r.sample_size,
    confidence: r.confidence, suggestedAction: r.suggested_action, window: r.window_label, computedOn: r.computed_on
  }));
}
