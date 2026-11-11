// Pure analytics. No I/O. Every function works only on numbers Meta actually returned.
// Statistical rules (documented in docs/PHASE2_ANALYTICS.md):
//  - Posts are only compared at the SAME observation checkpoint, so a 7-day post is never compared with a 1-day post.
//  - A comparison needs at least MIN_GROUP posts in each of at least two groups.
//  - Medians, not means, so one viral or flopped post cannot drive a result.
//  - A leading group must lead by >= MIN_RELATIVE_DIFF, and the lead must survive removing its single best post.
//  - Wording is associative ("associated with"), never causal.

export const MIN_GROUP = 5;
export const MIN_RELATIVE_DIFF = 0.25;

export const median = values => {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Rates are per reach. A post with missing or zero reach has no rate (null), not a rate of zero.
export function ratesFor(metrics = {}) {
  const reach = metrics.reach;
  const ok = Number.isFinite(reach) && reach > 0;
  const per = key => (ok && Number.isFinite(metrics[key]) ? metrics[key] / reach : null);
  return { reach: Number.isFinite(reach) ? reach : null, savesPerReach: per("saved"), sharesPerReach: per("shares"), interactionsPerReach: per("total_interactions") };
}

export const METRIC_LABELS = {
  reach: "reach", savesPerReach: "saves per reach", sharesPerReach: "shares per reach", interactionsPerReach: "interactions per reach"
};

export function confidenceFor(minGroupSize, relativeDiff) {
  if (minGroupSize < MIN_GROUP) return "none";
  if (minGroupSize >= 15 && relativeDiff >= 0.4) return "high";
  if (minGroupSize >= 8) return "medium";
  return "low";
}

// rows: [{ group, value, id }]. Returns a comparison result or an insufficient-data explanation.
export function compareGroups(rows, { minGroup = MIN_GROUP, minRelativeDiff = MIN_RELATIVE_DIFF } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.value) || row.group === null || row.group === undefined) continue;
    if (!groups.has(row.group)) groups.set(row.group, []);
    groups.get(row.group).push(row);
  }
  const summary = [...groups.entries()].map(([group, items]) => ({ group, n: items.length, median: median(items.map(i => i.value)), items }));
  const eligible = summary.filter(g => g.n >= minGroup).sort((a, b) => b.median - a.median);
  const description = summary.map(({ group, n, median: m }) => ({ group, n, median: m }));
  if (eligible.length < 2) {
    return { status: "insufficient_data", groups: description, reason: "Need at least " + minGroup + " posts in each of two groups; have " +
      (summary.map(g => g.group + ": " + g.n).join(", ") || "no usable posts") + "." };
  }
  const [lead, next] = eligible;
  const diff = next.median > 0 ? (lead.median - next.median) / next.median : (lead.median > 0 ? Infinity : 0);
  // Robustness: drop the lead group's best post and require the lead to hold.
  const trimmed = median(lead.items.map(i => i.value).sort((a, b) => b - a).slice(1));
  const survives = trimmed !== null && trimmed > next.median && (next.median > 0 ? (trimmed - next.median) / next.median >= minRelativeDiff / 2 : true);
  if (!(diff >= minRelativeDiff) || !survives) {
    return { status: "no_clear_difference", groups: description, leader: lead.group, relativeDiff: Number.isFinite(diff) ? diff : null,
      reason: diff >= minRelativeDiff ? "The lead disappears when the single best post is removed, so it is not reliable." : "Groups are within " + Math.round(minRelativeDiff * 100) + "% of each other." };
  }
  return { status: "clear_difference", groups: description, leader: lead.group, runnerUp: next.group, relativeDiff: Number.isFinite(diff) ? diff : null,
    confidence: confidenceFor(Math.min(lead.n, next.n), diff), sampleSize: lead.n + next.n };
}

// Time-of-day buckets in the account's posting timezone.
export function timeBucket(postedAt, offsetMinutes) {
  const local = new Date(new Date(postedAt).getTime() + offsetMinutes * 60000);
  const hour = local.getUTCHours();
  return hour < 6 ? "night (00-06)" : hour < 12 ? "morning (06-12)" : hour < 18 ? "afternoon (12-18)" : "evening (18-24)";
}

// Follower change between the oldest and newest snapshot inside the window. Needs two snapshots at least a day apart.
export function followerGrowth(snapshots, { days, now }) {
  const cutoff = now.getTime() - days * 86400000;
  const usable = snapshots.filter(s => Number.isFinite(s.followers) && new Date(s.collected_at).getTime() >= cutoff)
    .sort((a, b) => new Date(a.collected_at) - new Date(b.collected_at));
  if (usable.length < 2) return { status: "insufficient_data", snapshots: usable.length };
  const first = usable[0], last = usable[usable.length - 1];
  const spanDays = (new Date(last.collected_at) - new Date(first.collected_at)) / 86400000;
  if (spanDays < 1) return { status: "insufficient_data", snapshots: usable.length, spanDays };
  return { status: "ok", change: last.followers - first.followers, from: first.followers, to: last.followers, spanDays: Math.round(spanDays * 10) / 10, snapshots: usable.length };
}
