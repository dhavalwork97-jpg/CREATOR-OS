import test from "node:test";
import assert from "node:assert/strict";
import { pickSlot, scheduleConfig, offsetLabel } from "../lib/scheduler.mjs";

const config = { hours: [12, 19], offsetMinutes: 330, maxPerDay: 2, minGapMinutes: 180 };

test("defaults to UTC+05:30 and builds its label from the offset", () => {
  const c = scheduleConfig({});
  assert.equal(c.offsetMinutes, 330);
  assert.equal(c.label, "UTC+05:30");
  assert.equal(offsetLabel(-300), "UTC-05:00");
  assert.equal(scheduleConfig({ POSTING_UTC_OFFSET_MINUTES: "0" }).label, "UTC+00:00");
  assert.equal(scheduleConfig({ POSTING_UTC_OFFSET_MINUTES: "banana" }).offsetMinutes, 330);
});

test("reads posting hours from the environment with safe defaults", () => {
  assert.deepEqual(scheduleConfig({ POSTING_HOURS: "20, 9, x" }).hours, [9, 20]);
  assert.deepEqual(scheduleConfig({}).hours, [12, 19]);
});

test("picks the next posting hour in the configured local time", () => {
  assert.equal(pickSlot({ posts: [], now: new Date("2026-11-07T05:00:00Z"), config }), "2026-11-07T06:30:00.000Z");
});

test("skips taken slots, honours the daily cap and the card's suggested day", () => {
  const first = { status: "scheduled", scheduledAt: "2026-11-07T06:30:00.000Z" };
  const second = { status: "scheduled", scheduledAt: "2026-11-07T13:30:00.000Z" };
  const now = new Date("2026-11-07T05:00:00Z");
  assert.equal(pickSlot({ posts: [first], now, config }), "2026-11-07T13:30:00.000Z");
  assert.equal(pickSlot({ posts: [first, second], now, config }), "2026-11-08T06:30:00.000Z");
  assert.equal(pickSlot({ posts: [], now, earliestDay: "2026-11-10", config }), "2026-11-10T06:30:00.000Z");
});

test("ignores cancelled and failed posts", () => {
  const posts = [{ status: "cancelled", scheduledAt: "2026-11-07T06:30:00.000Z" }, { status: "failed", scheduledAt: "2026-11-07T13:30:00.000Z" }];
  assert.equal(pickSlot({ posts, now: new Date("2026-11-07T05:00:00Z"), config }), "2026-11-07T06:30:00.000Z");
});
