import crypto from "node:crypto";
import { similarity } from "../strategy/calc.mjs";

// Deterministic Safety Reviewer. No AI model decides safety: a model could be talked out of a rule, rules cannot.
// Verdict precedence: blocked > needs_revision > human_review > approved. "approved" requires ZERO findings.
// A review is bound to the exact content (hash of caption, media URL, format, alt text); any edit invalidates it.
export const RULES_VERSION = "2026-11-v1";
export const STATUSES = ["approved", "needs_revision", "human_review", "blocked"];

const SECRET = /(AKIA[0-9A-Z]{16}|\bBearer\s+[A-Za-z0-9._-]{20,}|EAA[A-Za-z0-9]{40,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const ABSOLUTE = /\b(guaranteed?|proven to|cures?|get rich|100% (safe|effective|results)|no risk|miracle)\b/i;
const ENGAGEMENT_BAIT = /\b(follow for follow|f4f|l4l|like (and|&) share to win|tag \d+ friends to win|giveaway)\b/i;
const COMMERCIAL = /\b(discount code|use code|affiliate|sponsored|paid partnership|#ad\b|#sponsored|promo code|link in bio to buy)\b/i;
const HEALTH_FINANCE = /\b(diagnos|treatment|medication|weight loss|lose \d+ ?(kg|lbs|pounds)|invest(ing|ment)?|returns?|crypto|trading signals?)\b/i;
const PII = /(\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b\+?\d[\d\s().-]{8,}\d\b)/;

export const contentHash = card => crypto.createHash("sha256")
  .update(JSON.stringify([card.caption || "", card.mediaUrl || "", card.format || "", card.altText || ""])).digest("hex");

const finding = (rule, severity, message, evidence) => ({ rule, severity, message, ...(evidence ? { evidence } : {}) });

export function reviewContent(card, { settings = {}, recentCaptions = [] } = {}) {
  const f = [];
  const caption = String(card.caption || "");
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu) || [];
  const lowered = caption.toLowerCase();

  if (SECRET.test(caption)) f.push(finding("credential_in_caption", "block", "The caption looks like it contains a credential or private key."));
  for (const term of settings.blockedTerms || []) if (term && lowered.includes(String(term).toLowerCase())) f.push(finding("owner_blocked_term", "block", "The caption contains a term you blocked.", { term }));
  if (!card.mediaUrl) f.push(finding("media_missing", "block", "No media is attached."));
  else { try { if (new URL(card.mediaUrl).protocol !== "https:") throw 0; } catch { f.push(finding("media_not_https", "block", "Media must be a public HTTPS URL.")); } }
  if (!["reel", "image"].includes(card.format)) f.push(finding("format_unknown", "block", "Format must be reel or image."));

  if (caption.trim().length < 10) f.push(finding("caption_too_short", "revise", "The caption is too short."));
  if (caption.length > 2200) f.push(finding("caption_too_long", "revise", "The caption is over 2,200 characters."));
  if (tags.length > 30) f.push(finding("too_many_hashtags", "revise", "More than 30 hashtags; Instagram rejects this."));
  if (new Set(tags.map(t => t.toLowerCase())).size !== tags.length) f.push(finding("duplicate_hashtags", "revise", "Duplicate hashtags."));
  const letters = caption.replace(/[^A-Za-z]/g, "");
  if (letters.length > 30 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6) f.push(finding("shouting", "revise", "Most of the caption is capital letters."));
  if ((caption.match(/@\w+/g) || []).length > 5) f.push(finding("many_mentions", "revise", "More than 5 @mentions can look spammy."));
  if (ABSOLUTE.test(caption)) f.push(finding("absolute_claim", "revise", "Absolute or unverifiable claim wording; soften or substantiate it.", { match: caption.match(ABSOLUTE)[0] }));
  if (/\btrending\b/i.test(caption)) f.push(finding("trend_claim", "revise", "Claims something is trending; no trend data supports this."));
  if (PII.test(caption)) f.push(finding("possible_personal_data", "revise", "The caption seems to contain an email address or phone number."));
  const dup = recentCaptions.find(c => similarity(caption, c) >= 0.8);
  if (dup) f.push(finding("near_duplicate", "revise", "Very similar to a recent post caption.", { similarTo: String(dup).slice(0, 80) }));

  if (ENGAGEMENT_BAIT.test(caption)) f.push(finding("engagement_bait", "review", "Engagement-bait or giveaway wording; a person should confirm it follows Instagram's rules."));
  if (COMMERCIAL.test(caption)) f.push(finding("commercial_content", "review", "Looks promotional; confirm the required partnership disclosure."));
  if (HEALTH_FINANCE.test(caption)) f.push(finding("health_or_finance", "review", "Health or financial wording; a person should check the claims."));
  for (const term of settings.reviewTerms || []) if (term && lowered.includes(String(term).toLowerCase())) f.push(finding("owner_review_term", "review", "The caption contains a term you flagged for review.", { term }));
  if (card.mediaSource === "url") f.push(finding("media_rights_unverified", "review", "The media comes from an external URL; ownership or licence cannot be verified automatically."));

  const has = s => f.some(x => x.severity === s);
  const status = has("block") ? "blocked" : has("revise") ? "needs_revision" : has("review") ? "human_review" : "approved";
  return { status, findings: f, contentHash: contentHash(card), rulesVersion: RULES_VERSION };
}
