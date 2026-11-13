import { TaskError } from "../tasks/queue.mjs";
import { getStrategySettings } from "../strategy/store.mjs";
import * as store from "../creative/store.mjs";
import { validatePackage, templatePackage, normalizeHashtags, LIMITS } from "../creative/validate.mjs";

// Creative agent: drafts TEXT for one plan item (caption, hashtags, hook, CTA, media prompt, alt text, reel shot list).
// It never generates images (paid by default; stays owner-triggered), never approves, schedules or publishes, and never
// fabricates facts: the prompt forbids statistics, trends and sources. If the text provider is unavailable it falls back to a
// plain template and labels the package source "template" so the owner knows no AI wrote it.

async function defaultGenerate(prompt, system) {
  const { generateJsonText } = await import("./text-dep.mjs");
  return generateJsonText(prompt, system, { temperature: 0.8, maxOutputTokens: 1400 });
}

const clip = (v, n) => String(v ?? "").trim().slice(0, n);

export function parsePackage(text, format) {
  let data;
  try { data = JSON.parse(String(text).replace(/^```(?:json)?|```$/gim, "").trim()); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const script = Array.isArray(data.script) ? data.script.slice(0, LIMITS.shots).map(s => ({ shot: clip(s?.shot, 200), seconds: Math.max(0, Math.min(30, Number(s?.seconds) || 0)) })).filter(s => s.shot) : [];
  return { caption: clip(data.caption, 5000), hashtags: normalizeHashtags(data.hashtags), hook: clip(data.hook, 200) || null, cta: clip(data.cta, 200) || null,
    media_prompt: clip(data.media_prompt, 5000), alt_text: clip(data.alt_text, LIMITS.altText) || null, script: format === "reel" ? script : [] };
}

export function makeCreative(generate = defaultGenerate) {
  return async function draftPackage({ task }) {
    const accountId = task.account_id;
    const item = await store.getItem(accountId, task.input?.planItemId);
    if (!item) throw new TaskError("not_found", "Plan item not found for this account.");
    if (item.status === "rejected") throw new TaskError("rejected_item", "Rejected plan items are not drafted.");
    const settings = await getStrategySettings(accountId);
    const aspect = item.format === "reel" ? "vertical 9:16 Instagram Reel (6 to 8 seconds)" : "vertical 4:5 Instagram feed image";
    const prompt = "Draft an Instagram " + item.format + " post. Niche: " + (settings.niche || "n/a") + ". Audience: " + (settings.audience || "n/a") + ". Pillar: " + item.pillar +
      ". Topic: " + item.topic + (item.hook ? ". Owner's hook: " + item.hook : "") + ". Media will be a " + aspect + ". Reply as JSON with keys caption (under 600 chars, no hashtags), hashtags (5 to 10 words without #), hook, cta, media_prompt (describe an original image/scene; no real people, brands or logos), alt_text (under 100 chars), script (list of {shot, seconds}; reels only).";
    const res = await generate(prompt, "You write captions for a small creator. Never invent statistics, studies, sources or claims that something is trending. Do not promise results.");
    let pkg = null, source = "template", model = null;
    if (!res.skipped) { pkg = parsePackage(res.text, item.format); if (pkg) { source = "gemini"; model = res.model; } }
    const fallbackReason = source === "template" ? (res.skipped || "unparseable_model_output") : null;
    if (!pkg) pkg = templatePackage(item, settings);
    let validation = validatePackage(pkg, item.format);
    if (!validation.ok && source === "gemini") { pkg = templatePackage(item, settings); source = "template"; model = null; validation = { ...validatePackage(pkg, item.format), note: "Model output failed validation; template used." }; }
    const row = await store.insertPackage(accountId, item.item_id, { ...pkg, source, model, validation, status: validation.ok ? "draft" : "needs_fixes" });
    return { output: { packageId: row.package_id, version: row.version, source, fallbackReason, valid: validation.ok, warnings: validation.warnings },
      decision: { action: "drafted creative package", source, fallbackReason, valid: validation.ok } };
  };
}

export const creativeHandlers = { "creative.draft_package": makeCreative() };
