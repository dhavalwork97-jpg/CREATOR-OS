// Metric registry, checked against Meta's Instagram Platform docs on 2026-11-10:
//  - media insights: reach, views, likes, comments, shares, saved, total_interactions (+ ig_reels_avg_watch_time for Reels);
//    `impressions` is deprecated for media created after 2024-07-02 and `plays` is not listed, so neither is requested.
//  - account insights: period=day, metric_type=total_value. `impressions` is deprecated (2025-04-21) and not requested.
//  - Meta says unavailable metrics return an empty data set (not 0), and some account metrics are not returned under 100 followers.
// Anything Meta does not return is stored as absent with a reason. Nothing is estimated or defaulted to zero.

export const ACCOUNT_METRICS = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "saves", "shares", "replies", "reposts", "follows_and_unfollows"];

const FEED = ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions"];
export function mediaMetricsFor(productType) {
  const type = String(productType || "").toUpperCase();
  if (type === "REELS") return [...FEED, "ig_reels_avg_watch_time"];
  if (type === "FEED") return FEED;
  return null; // STORY, AD and unknown types are not collected
}

export const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count";

// First numeric value from either Graph insight shape (values[] for media, total_value for accounts).
export function readInsightValue(entry) {
  if (!entry) return null;
  const candidate = entry.total_value?.value ?? entry.values?.[0]?.value;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

// Collection checkpoints (hours after posting). A row is only recorded when the observation lands inside the window,
// so the stored checkpoint label is honest. Anything first seen later is stored once as "baseline".
export const CHECKPOINTS = [
  { label: "h1", from: 1, to: 6 },
  { label: "h24", from: 24, to: 36 },
  { label: "h72", from: 72, to: 90 },
  { label: "d7", from: 168, to: 192 }
];
export function checkpointFor(ageHours, existing = new Set()) {
  for (const cp of CHECKPOINTS) if (ageHours >= cp.from && ageHours < cp.to && !existing.has(cp.label)) return cp.label;
  return existing.has("baseline") || existing.size > 0 ? null : "baseline";
}
