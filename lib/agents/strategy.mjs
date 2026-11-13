import crypto from "node:crypto";
import { TaskError } from "../tasks/queue.mjs";
import { strategistFeedback } from "./analytics.mjs";
import * as store from "../strategy/store.mjs";
import { buildItems, tokens } from "../strategy/calc.mjs";
import { scheduleConfig } from "../scheduler.mjs";

// Researcher: records opportunities with their evidence class, confidence and research date.
// Strategist: turns opportunities + analytics feedback into a proposed 7-day plan.
// Neither agent publishes, approves, edits settings or touches the kill switch; plan items are proposals the owner edits,
// rejects or converts into Content Board cards (which still need media, safety review and approval).
//
// Evidence classes are never blended: account_analytics (your own stored metrics), ai_hypothesis (model-generated idea,
// NOT a verified trend, no sources), external_research / verified_fact (reserved for a configured research adapter that
// supplies source URLs; none is built in, so nothing is labelled as such today).

const FORMAT_OF = { Reels: "reel", "feed posts": "image" };
const GAP_DAYS = 30;

async function defaultDeps() {
  const { readState } = await import("../db.mjs");
  const { generateJsonText } = await import("./text-dep.mjs");
  return {
    generateIdeas: (prompt, system) => generateJsonText(prompt, system, { temperature: 0.7, maxOutputTokens: 1200 }),
    async existingBoardTexts() { return ((await readState()).boardCards || []).map(c => String(c.idea || "") + " " + String(c.caption || "")); }
  };
}

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const dedupe = text => crypto.createHash("sha256").update(String(text).toLowerCase().replace(/[^a-z0-9]/g, "")).digest("hex").slice(0, 24);

export function parseIdeas(text) {
  let data;
  try { data = JSON.parse(String(text).replace(/^```(?:json)?|```$/gim, "").trim()); } catch { return []; }
  const list = Array.isArray(data) ? data : Array.isArray(data?.ideas) ? data.ideas : [];
  return list.slice(0, 5).map(i => ({ title: clip(i?.title, 120), summary: clip(i?.summary || i?.why, 400), pillar: clip(i?.pillar, 80),
    format: i?.format === "image" ? "image" : i?.format === "reel" ? "reel" : null })).filter(i => i.title.length >= 8 && i.summary.length >= 10);
}

export function makeResearcher(getDeps = defaultDeps) {
  return async function discover({ task, now }) {
    const at = now();
    const accountId = task.account_id;
    const settings = await store.getStrategySettings(accountId);
    const out = { analytics: 0, gaps: 0, aiHypotheses: 0, aiSkipped: null, externalResearch: "not_configured" };
    if (!settings.researchEnabled) return { output: { ...out, skipped: "research_disabled" }, decision: { action: "research disabled by owner" } };

    // (a) the account's own measured performance (already confidence-filtered by the Analytics agent)
    for (const f of await strategistFeedback(accountId)) {
      const format = FORMAT_OF[f.suggestedAction?.match?.(/more (Reels|feed posts)/)?.[1]] || null;
      await store.upsertOpportunity(accountId, {
        dedupeKey: "analytics:" + f.kind + ":" + f.computedOn, sourceClass: "account_analytics",
        title: "Lean into what is working: " + f.kind.replace(/[:_]/g, " "),
        summary: f.observation + " " + (f.suggestedAction || ""), suggestedFormat: format, confidence: f.confidence,
        evidence: { window: f.window, sampleSize: f.sampleSize, metrics: f.supportingMetrics, computedOn: f.computedOn, note: "Association within your own account, not proven cause." }
      }, at);
      out.analytics += 1;
    }

    // (b) pillar gaps: keyword heuristic over stored captions, labelled as such
    const captions = (await store.recentCaptions(accountId, GAP_DAYS)).map(r => r.caption);
    if (captions.length >= 3) {
      for (const pillar of settings.pillars) {
        const pt = tokens(pillar);
        const hits = captions.filter(c => { const ct = tokens(c); return [...pt].some(w => ct.has(w)); }).length;
        if (hits === 0) {
          await store.upsertOpportunity(accountId, {
            dedupeKey: "gap:" + dedupe(pillar) + ":" + at.toISOString().slice(0, 7), sourceClass: "account_analytics",
            title: "Pillar not covered recently: " + pillar, pillar, confidence: "low",
            summary: "None of your " + captions.length + " posts from the last " + GAP_DAYS + " days mention \"" + pillar + "\" (keyword match on captions, so image-only themes may be missed).",
            evidence: { pillar, postsChecked: captions.length, method: "caption keyword match" }
          }, at);
          out.gaps += 1;
        }
      }
    }

    // (c) AI hypotheses: only when the existing Gemini text provider is configured and within its caps
    if (settings.pillars.length && settings.niche) {
      const deps = await getDeps();
      const prompt = "Niche: " + settings.niche + ". Audience: " + settings.audience + ". Objective: " + settings.objective + ". Pillars: " + settings.pillars.join(", ") +
        ". Suggest up to 5 original Instagram post ideas. Reply as JSON: {\"ideas\":[{\"title\":\"\",\"summary\":\"why it could work\",\"pillar\":\"\",\"format\":\"reel|image\"}]}. Do not claim trends, statistics or sources.";
      const res = await deps.generateIdeas(prompt, "You propose content ideas for a small creator. You have no web access; never cite sources or assert that something is trending.");
      if (res.skipped) out.aiSkipped = res.skipped;
      else for (const idea of parseIdeas(res.text)) {
        await store.upsertOpportunity(accountId, {
          dedupeKey: "ai:" + dedupe(idea.title), sourceClass: "ai_hypothesis", title: idea.title, pillar: settings.pillars.includes(idea.pillar) ? idea.pillar : null,
          suggestedFormat: idea.format, confidence: "low",
          summary: idea.summary + " (AI-generated idea. Not a verified trend; no external source.)",
          evidence: { model: res.model, note: "Hypothesis only. Test it and let analytics judge it." }
        }, at);
        out.aiHypotheses += 1;
      }
    } else out.aiSkipped = "niche_or_pillars_not_set";
    return { output: out, decision: { action: "recorded opportunities", ...out } };
  };
}

export function makeStrategist(getDeps = defaultDeps) {
  return async function planWeek({ task, now }) {
    const at = now();
    const accountId = task.account_id;
    const settings = await store.getStrategySettings(accountId);
    if (!settings.pillars.length) throw new TaskError("not_configured", "Add at least one content pillar in Strategy settings before generating a plan.");
    const offset = scheduleConfig().offsetMinutes;
    const today = new Date(at.getTime() + offset * 60000).toISOString().slice(0, 10);
    const start = new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);

    const feedback = await strategistFeedback(accountId);
    const formatRec = feedback.find(f => f.kind.startsWith("format:") && f.confidence !== "none");
    const preferred = formatRec ? FORMAT_OF[formatRec.suggestedAction?.match?.(/more (Reels|feed posts)/)?.[1]] || null : null;

    const deps = await getDeps();
    const existing = [
      ...(await store.recentCaptions(accountId, 60)).map(r => r.caption),
      ...(await store.planTexts(accountId)).map(r => r.topic),
      ...(await deps.existingBoardTexts())
    ];
    const opportunities = await store.activeOpportunities(accountId);
    const items = buildItems({ opportunities, slots: settings.postsPerWeek, startDate: start, pillars: settings.pillars, preferredFormat: preferred, existingTexts: existing });

    const generationId = crypto.randomUUID();
    await store.clearProposed(accountId, start);
    const basis = feedback.slice(0, 3).map(f => ({ kind: f.kind, confidence: f.confidence, computedOn: f.computedOn }));
    const saved = [];
    for (const item of items) saved.push(await store.insertPlanItem(accountId, generationId, { ...item, performance_basis: basis }));
    const skippedReason = items.length < settings.postsPerWeek
      ? "Only " + items.length + " of " + settings.postsPerWeek + " slots were filled: not enough distinct, evidence-backed opportunities. No filler was invented."
      : null;
    return { output: { generationId, planned: saved.length, requested: settings.postsPerWeek, startDate: start, note: skippedReason, performanceInputs: basis.length },
      decision: { action: "proposed 7-day plan", planned: saved.length, note: skippedReason } };
  };
}

export const strategyHandlers = { "researcher.discover": makeResearcher(), "strategist.plan_week": makeStrategist() };
// Research runs weekly; planning is on demand (owner request) so it never changes the plan unprompted.
export const strategyDefinitions = () => [{ agent: "researcher", type: "discover", intervalMinutes: 10080, priority: 1, timeoutSeconds: 60 }];
