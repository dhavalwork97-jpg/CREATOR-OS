import test from "node:test";
import assert from "node:assert/strict";
import { median, ratesFor, compareGroups, confidenceFor, timeBucket, followerGrowth, MIN_GROUP } from "../lib/analytics/calc.mjs";

const rows = (group, values) => values.map((value, i) => ({ group, value, id: group + i }));

test("median ignores non-numbers and handles even/odd", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([null, undefined, NaN]), null);
});

test("rates: missing or zero reach gives null, never 0 or Infinity", () => {
  assert.equal(ratesFor({ reach: 0, saved: 5 }).savesPerReach, null);
  assert.equal(ratesFor({ saved: 5 }).savesPerReach, null);
  assert.equal(ratesFor({ reach: 100 }).savesPerReach, null, "a metric Meta did not return is not 0");
  assert.equal(ratesFor({ reach: 100, saved: 0 }).savesPerReach, 0, "a real zero stays zero");
  assert.equal(ratesFor({ reach: 200, saved: 10, shares: 4 }).sharesPerReach, 0.02);
});

test("too few posts per group is reported as insufficient data, not a conclusion", () => {
  const result = compareGroups([...rows("Reels", [9, 9, 9, 9]), ...rows("feed posts", [1, 1, 1, 1])]);
  assert.equal(result.status, "insufficient_data");
  assert.match(result.reason, /at least 5/);
  assert.equal(compareGroups([]).status, "insufficient_data");
  assert.equal(compareGroups(rows("Reels", [1, 2, 3, 4, 5, 6])).status, "insufficient_data", "one group cannot be compared");
});

test("a clear, stable difference is reported with sample size and confidence", () => {
  const result = compareGroups([...rows("Reels", [10, 11, 12, 13, 14, 15]), ...rows("feed posts", [5, 6, 6, 7, 7, 8])]);
  assert.equal(result.status, "clear_difference");
  assert.equal(result.leader, "Reels");
  assert.equal(result.sampleSize, 12);
  assert.ok(result.relativeDiff > 0.25);
  assert.equal(result.confidence, "low");
});

test("one viral post cannot create a trend: medians plus removing the best post", () => {
  // Reels median is 5 (same as feed) but one post is 500. A mean would call Reels 20x better.
  const viral = compareGroups([...rows("Reels", [5, 5, 5, 5, 5, 500]), ...rows("feed posts", [5, 5, 5, 5, 5, 5])]);
  assert.notEqual(viral.status, "clear_difference");
  // A lead that exists only because of the single best post is rejected.
  const fragile = compareGroups([...rows("Reels", [6, 6, 6, 6, 6.2, 40]), ...rows("feed posts", [5, 5, 5, 5, 5, 5])]);
  assert.equal(fragile.status, "no_clear_difference");
  assert.match(fragile.reason, /best post|within/);
});

test("small differences are not reported as winners", () => {
  const result = compareGroups([...rows("a", [10, 10, 10, 10, 10]), ...rows("b", [11, 11, 11, 11, 11])]);
  assert.equal(result.status, "no_clear_difference");
});

test("rows with missing values or groups are excluded rather than counted as zero", () => {
  const input = [...rows("Reels", [10, 11, 12, 13, 14]), ...rows("feed posts", [5, 6, 6, 7, 7]), { group: "Reels", value: null }, { group: null, value: 99 }, { group: "Reels", value: NaN }];
  const result = compareGroups(input);
  assert.equal(result.groups.find(g => g.group === "Reels").n, 5);
});

test("confidence rises only with group size and effect size", () => {
  assert.equal(confidenceFor(4, 5), "none");
  assert.equal(confidenceFor(5, 0.3), "low");
  assert.equal(confidenceFor(8, 0.3), "medium");
  assert.equal(confidenceFor(15, 0.2), "medium");
  assert.equal(confidenceFor(15, 0.5), "high");
  assert.equal(MIN_GROUP, 5);
});

test("time buckets use the posting timezone, not UTC", () => {
  assert.equal(timeBucket("2026-11-10T06:30:00Z", 330), "afternoon (12-18)"); // 12:00 IST
  assert.equal(timeBucket("2026-11-10T06:30:00Z", 0), "morning (06-12)");
  assert.equal(timeBucket("2026-11-10T20:00:00Z", 330), "night (00-06)"); // 01:30 IST next day
});

test("follower growth needs two snapshots at least a day apart and reports counts only", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const snap = (d, followers) => ({ collected_at: new Date(now.getTime() - d * 86400000).toISOString(), followers });
  assert.equal(followerGrowth([snap(1, 10)], { days: 7, now }).status, "insufficient_data");
  assert.equal(followerGrowth([{ ...snap(0.5, 10) }, snap(0.4, 12)], { days: 7, now }).status, "insufficient_data");
  assert.equal(followerGrowth([snap(5, null), snap(3, 100)], { days: 7, now }).status, "insufficient_data");
  const ok = followerGrowth([snap(6, 100), snap(3, 104), snap(0.1, 110), snap(20, 1)], { days: 7, now });
  assert.deepEqual([ok.status, ok.change, ok.from, ok.to], ["ok", 10, 100, 110]);
});
