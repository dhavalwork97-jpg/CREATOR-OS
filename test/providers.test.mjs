import test from "node:test";
import assert from "node:assert/strict";
import { reserveText, recordTextFailure, recordTextSuccess, textUsageToday } from "../lib/usage.mjs";
import { providerSummary, textProvider, imageProvider } from "../lib/providers/registry.mjs";

const now = new Date("2026-11-08T10:00:00Z");

test("text provider is opt-in and needs a key", () => {
  assert.equal(textProvider({}, {}).configured, false);
  assert.equal(textProvider({}, { GEMINI_API_KEY: "k" }).configured, false, "key alone is not enough");
  assert.equal(textProvider({}, { GEMINI_TEXT_ENABLED: "true" }).configured, false);
  assert.equal(textProvider({}, { GEMINI_TEXT_ENABLED: "true", GEMINI_API_KEY: "k" }).configured, true);
});

test("model comes from dashboard choice, then environment, then the default alias", () => {
  assert.equal(textProvider({ settings: { textModel: "m-dash" } }, { GEMINI_TEXT_MODEL: "m-env" }).model, "m-dash");
  assert.equal(textProvider({}, { GEMINI_TEXT_MODEL: "models/m-env" }).model, "m-env");
  assert.equal(textProvider({}, {}).model, "gemini-flash-lite-latest");
});

test("image provider is treated as paid with visible, never-assumed costs", () => {
  const image = imageProvider({}, {});
  assert.equal(image.costClass, "paid");
  assert.equal(image.estimatedCostUsdPerImage, null);
  assert.equal(imageProvider({}, { GEMINI_IMAGE_COST_USD_PER_IMAGE: "0.04" }).estimatedCostUsdPerImage, 0.04);
  assert.equal(imageProvider({}, { GEMINI_IMAGE_FREE_TIER: "true" }).costClass, "free_tier");
  assert.equal(imageProvider({}, { GEMINI_IMAGE_GENERATION_ENABLED: "true", GEMINI_API_KEY: "k" }).configured, true);
});

test("daily limit is enforced before the provider is called", () => {
  const state = {};
  assert.equal(reserveText(state, 2, now).allowed, true);
  assert.equal(reserveText(state, 2, now).allowed, true);
  const third = reserveText(state, 2, now);
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "daily_limit");
  assert.equal(textUsageToday(state, now).requests, 2);
  assert.equal(reserveText(state, 2, new Date("2026-11-09T10:00:00Z")).allowed, true, "a new day starts fresh");
});

test("a 429 pauses text calls until Retry-After (default 15 minutes) and success clears it", () => {
  const state = {};
  reserveText(state, 10, now);
  recordTextFailure(state, Object.assign(new Error("limit"), { status: 429 }), now);
  const blocked = reserveText(state, 10, new Date(now.getTime() + 60000));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "rate_limited");
  assert.equal(textUsageToday(state, now).rateLimited, 1);
  assert.equal(reserveText(state, 10, new Date(now.getTime() + 16 * 60000)).allowed, true);
  recordTextSuccess(state, { inputTokens: 3, outputTokens: 4 }, new Date(now.getTime() + 16 * 60000));
  assert.equal(state.providerStatus.text.blockedUntil, undefined);
});

test("summary shows usage, estimated image spend and never includes secrets", () => {
  const state = { mediaUsage: { "2026-11-08": { attempts: 2 } }, textUsage: { "2026-11-08": { requests: 3, errors: 1, rateLimited: 0, inputTokens: 10, outputTokens: 20 } } };
  const summary = providerSummary(state, { GEMINI_API_KEY: "AIza-SECRET", GEMINI_IMAGE_COST_USD_PER_IMAGE: "0.05" }, now);
  assert.equal(summary.text.usageToday.requests, 3);
  assert.equal(summary.image.usageToday.attempts, 2);
  assert.equal(summary.image.estimatedCostTodayUsd, 0.1);
  assert.equal(JSON.stringify(summary).includes("AIza-SECRET"), false);
});
