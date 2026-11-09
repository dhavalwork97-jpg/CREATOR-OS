import { DEFAULT_TEXT_MODEL, normalizeModel } from "./gemini-text.mjs";
import { DEFAULT_MODEL as DEFAULT_IMAGE_MODEL } from "../media-providers/gemini-image.mjs";
import { clean, dayKey } from "../util.mjs";
import { textUsageToday } from "../usage.mjs";
import { storageSummary } from "../storage/media.mjs";

// Describes every provider and what it can cost. Nothing here switches providers automatically:
// each capability has exactly one provider, and fallbacks (when added) may only be built-in free rules.
const int = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.parseInt(value, 10) || fallback));

export function textProvider(state, env = process.env) {
  const enabled = env.GEMINI_TEXT_ENABLED === "true";
  const hasKey = Boolean(env.GEMINI_API_KEY);
  const model = normalizeModel(state?.settings?.textModel || env.GEMINI_TEXT_MODEL || DEFAULT_TEXT_MODEL);
  return {
    id: "gemini-text", kind: "text", label: "Gemini text",
    enabled, configured: enabled && hasKey, keyPresent: hasKey, model,
    modelSource: state?.settings?.textModel ? "dashboard" : env.GEMINI_TEXT_MODEL ? "environment" : "default",
    dailyLimit: int(env.MAX_TEXT_GENERATIONS_PER_DAY, 20, 1, 500),
    costClass: "free_tier",
    costNote: "Free only while the API key's Google project has no billing enabled. Free-tier prompts may be used by Google to improve its products. Creator OS cannot verify billing status; if the project has billing, usage is charged.",
    capability: "text_only"
  };
}

export function imageProvider(state, env = process.env) {
  const enabled = env.GEMINI_IMAGE_GENERATION_ENABLED === "true";
  const cost = Number.parseFloat(env.GEMINI_IMAGE_COST_USD_PER_IMAGE);
  const freeOverride = env.GEMINI_IMAGE_FREE_TIER === "true";
  return {
    id: "gemini-image", kind: "image", label: "Gemini image",
    enabled, configured: enabled && Boolean(env.GEMINI_API_KEY), keyPresent: Boolean(env.GEMINI_API_KEY),
    model: clean(env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL, 100),
    dailyLimit: int(env.MAX_IMAGE_GENERATIONS_PER_DAY, 2, 1, 5),
    costClass: freeOverride ? "free_tier" : "paid",
    costNote: freeOverride
      ? "Marked free-tier by GEMINI_IMAGE_FREE_TIER. Verify on Google's pricing page."
      : "Treated as PAID. Free Gemini text models do not generate images. Verify current pricing on Google's pricing page.",
    estimatedCostUsdPerImage: Number.isFinite(cost) && cost >= 0 ? cost : null,
    capability: "image"
  };
}

export function providerSummary(state, env = process.env, now = new Date()) {
  const text = textProvider(state, env);
  const image = imageProvider(state, env);
  const textToday = textUsageToday(state, now);
  const imageToday = state.mediaUsage?.[dayKey(now)]?.attempts || 0;
  const blockedUntil = state.providerStatus?.text?.blockedUntil;
  return {
    text: { ...text, usageToday: { requests: textToday.requests, errors: textToday.errors, rateLimited: textToday.rateLimited, inputTokens: textToday.inputTokens, outputTokens: textToday.outputTokens },
      rateLimitedUntil: blockedUntil && Date.parse(blockedUntil) > now.getTime() ? blockedUntil : null },
    image: { ...image, usageToday: { attempts: imageToday },
      estimatedCostTodayUsd: image.estimatedCostUsdPerImage === null ? null : Number((image.estimatedCostUsdPerImage * imageToday).toFixed(4)) },
    storage: storageSummary(state, env, now),
    policy: "Creator OS never switches providers automatically and never calls a paid provider without explicit confirmation."
  };
}
