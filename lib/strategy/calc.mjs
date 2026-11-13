// Pure planning logic: duplicate detection and slot filling. No I/O, no randomness.
const STOP = new Set(["the","a","an","and","or","of","for","to","in","on","with","your","you","is","are","how","what","why","this","that","it","at","by","from","about","my","our","their","be","can","do","does"]);

export const tokens = text => new Set(String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));

export function similarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared);
}

export const DUPLICATE_THRESHOLD = 0.5;
export const isDuplicate = (text, existing, threshold = DUPLICATE_THRESHOLD) => existing.some(other => similarity(text, other) >= threshold);

const RANK = { high: 3, medium: 2, low: 1, none: 0 };
const CLASS_RANK = { verified_fact: 3, external_research: 3, account_analytics: 2, ai_hypothesis: 1 };

// Accepted opportunities first (the owner chose them), then by confidence, then by evidence class.
export function rankOpportunities(list) {
  return [...list].sort((a, b) =>
    (b.status === "accepted") - (a.status === "accepted") ||
    RANK[b.confidence] - RANK[a.confidence] ||
    CLASS_RANK[b.source_class] - CLASS_RANK[a.source_class] ||
    String(a.title).localeCompare(String(b.title)));
}

export function weekDates(startIso, count) {
  const start = new Date(startIso + "T00:00:00Z");
  const n = Math.min(7, Math.max(1, count));
  return Array.from({ length: n }, (_, i) => new Date(start.getTime() + Math.floor(i * 7 / n) * 86400000).toISOString().slice(0, 10));
}

// Returns at most `slots` items. Fewer items are returned when evidence is thin: no filler is invented.
export function buildItems({ opportunities, slots, startDate, pillars, preferredFormat, existingTexts }) {
  const dates = weekDates(startDate, slots);
  const taken = [...existingTexts];
  const items = [];
  const used = new Set();
  for (const opp of rankOpportunities(opportunities)) {
    if (items.length >= dates.length) break;
    if (opp.status === "rejected" || opp.status === "planned" || used.has(opp.opportunity_id)) continue;
    const text = opp.title + " " + opp.summary;
    if (isDuplicate(text, taken)) continue;
    const pillar = opp.pillar && pillars.includes(opp.pillar) ? opp.pillar : pillars[items.length % pillars.length];
    const format = opp.suggested_format || preferredFormat || (items.length % 2 === 0 ? "reel" : "image");
    used.add(opp.opportunity_id);
    taken.push(text);
    items.push({
      plan_date: dates[items.length], format, pillar, topic: opp.title, hook: null,
      opportunity_id: opp.opportunity_id, evidence_class: opp.source_class, confidence: opp.confidence,
      rationale: opp.summary
    });
  }
  return items;
}
