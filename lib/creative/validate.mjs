// Deterministic checks on a creative package. These catch format problems only; they are NOT the Phase 5 safety review.
const HASHTAG = /^#[\p{L}\p{N}_]{2,50}$/u;
const RISKY = /\b(guaranteed?|proven|cure[sd]?|get rich|100%|no risk|miracle)\b/i;
export const LIMITS = { caption: 2200, hashtags: 30, altText: 100, prompt: 2000, shots: 8, reelSeconds: 90 };

export function normalizeHashtags(list, max = LIMITS.hashtags) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const tag = "#" + String(raw).trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (HASHTAG.test(tag) && !out.some(t => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out.slice(0, max);
}

export function validatePackage(pkg, format) {
  const problems = [], warnings = [];
  const caption = String(pkg.caption || "");
  const tags = Array.isArray(pkg.hashtags) ? pkg.hashtags : [];
  if (caption.trim().length < 10) problems.push("Caption is too short.");
  if ((caption + (tags.length ? "\n\n" + tags.join(" ") : "")).length > LIMITS.caption) problems.push("Caption plus hashtags exceeds " + LIMITS.caption + " characters.");
  if (tags.length > LIMITS.hashtags) problems.push("More than " + LIMITS.hashtags + " hashtags.");
  if (tags.some(t => !HASHTAG.test(t))) problems.push("A hashtag has invalid characters.");
  if (new Set(tags.map(t => t.toLowerCase())).size !== tags.length) problems.push("Duplicate hashtags.");
  const prompt = String(pkg.media_prompt || "");
  if (prompt.length < 20 || prompt.length > LIMITS.prompt) problems.push("Media prompt must be 20 to " + LIMITS.prompt + " characters.");
  if (pkg.alt_text && String(pkg.alt_text).length > LIMITS.altText) problems.push("Alt text is over " + LIMITS.altText + " characters.");
  if (!pkg.alt_text) warnings.push("No alt text.");
  const script = Array.isArray(pkg.script) ? pkg.script : [];
  if (format === "reel") {
    if (!script.length) warnings.push("Reel has no shot list.");
    if (script.length > LIMITS.shots) problems.push("More than " + LIMITS.shots + " shots.");
    const seconds = script.reduce((n, s) => n + (Number(s.seconds) || 0), 0);
    if (seconds > LIMITS.reelSeconds) problems.push("Script runs over " + LIMITS.reelSeconds + " seconds.");
  } else if (script.length) warnings.push("Shot list ignored for image posts.");
  if (RISKY.test(caption)) warnings.push("Caption contains absolute or unverifiable claim wording; review before approving.");
  if (/\btrending\b/i.test(caption)) warnings.push("Caption claims something is trending; no trend data backs this.");
  return { ok: problems.length === 0, problems, warnings };
}

export function templatePackage(item, settings) {
  const niche = settings.niche || "creator content", audience = settings.audience || "your audience";
  const tags = normalizeHashtags([niche, item.pillar, "creatorcommunity"].map(v => String(v).replace(/\s+/g, "")));
  const hook = item.hook || item.topic;
  const cta = "What would you add?";
  const aspect = item.format === "reel" ? "vertical 9:16 Instagram Reel scene (6 to 8 seconds, smooth camera movement)" : "vertical 4:5 Instagram feed image";
  return {
    caption: hook + "\n\n" + item.rationale.replace(/\s*\(AI-generated.*$/i, "").slice(0, 300) + "\n\n" + cta, hashtags: tags, hook, cta,
    media_prompt: "Create an original " + aspect + ". Niche: " + niche + ". Audience: " + audience + ". Pillar: " + item.pillar + ". Concept: " + item.topic + ". Clear focal subject, polished composition, no watermarks or logos, no text unless essential.",
    alt_text: String(item.topic).slice(0, LIMITS.altText), script: item.format === "reel" ? [{ shot: "Opening visual for: " + item.topic, seconds: 3 }, { shot: "Payoff or key moment", seconds: 4 }] : []
  };
}
