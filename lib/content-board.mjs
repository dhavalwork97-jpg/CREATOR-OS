import crypto from "node:crypto";
import { buildContentPlan } from "./agent-planner.mjs";
import { pickSlot, scheduleConfig } from "./scheduler.mjs";

const clean = (value, limit = 2200) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const audit = (state, action, detail = {}) => {
  state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail });
  state.audit = state.audit.slice(0, 300);
};
const safeMediaUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
};

export function generateBoard(state, input, now = new Date(), config = scheduleConfig()) {
  const plan = buildContentPlan(input, now);
  state.boardCards ||= [];
  const cards = plan.items.map((item, index) => {
    const prompt = [
      item.format === "reel"
        ? "Create an original vertical 9:16 Instagram Reel scene (6 to 8 seconds, smooth camera movement)."
        : "Create an original vertical 4:5 Instagram feed image (Instagram feed images must be between 4:5 and 1.91:1).",
      "Niche: " + plan.niche + ". Audience: " + plan.audience + ".",
      "Content pillar: " + item.pillar + ". Concept: " + item.idea,
      "Use a clear focal subject, polished composition, natural detail and no watermarks or logos.",
      "Do not add text unless it is essential to the concept."
    ].join(" ");
    const tags = [...new Set([plan.niche, item.pillar, "creatorcommunity"].map(value => "#" + value.toLowerCase().replace(/[^a-z0-9]/g, "")))].filter(tag => tag.length > 1 && tag.length <= 32);
    const caption = item.idea + " What would you add?\n\n" + tags.join(" ");
    const card = {
      id: crypto.randomUUID(), planId: plan.id, day: item.day, format: item.format,
      pillar: item.pillar, idea: item.idea, prompt, caption,
      status: "needs_media", createdAt: now.toISOString()
    };
    card.suggestedAt = pickSlot({ posts: state.posts || [], now, earliestDay: card.day, config });
    card.suggestedSlotLabel = card.suggestedAt
      ? new Date(Date.parse(card.suggestedAt) + config.offsetMinutes * 60000).toISOString().slice(0, 16).replace("T", " ")
      : null;
    return card;
  });
  state.boardCards = [...cards, ...state.boardCards].slice(0, 200);
  audit(state, "content_board_generated", { planId: plan.id, cards: cards.length });
  return cards;
}

export function updateBoardCard(state, id, input) {
  state.boardCards ||= [];
  const card = state.boardCards.find(item => item.id === id);
  if (!card) return { status: 404, body: { error: "Content card not found" } };
  if (card.status === "scheduled") return { status: 409, body: { error: "Cancel the scheduled post before editing this card" } };
  if (typeof input.caption === "string") card.caption = clean(input.caption, 2200);
  if (typeof input.prompt === "string") card.prompt = clean(input.prompt, 2000);
  if (typeof input.mediaUrl === "string") {
    const url = clean(input.mediaUrl, 2048);
    if (url && !safeMediaUrl(url)) return { status: 400, body: { error: "Media must be a publicly accessible HTTPS URL" } };
    if (url !== (card.mediaUrl || "")) {
      // The media changed: forget any file we stored for the previous version (the caller removes it from storage).
      delete card.mediaKey; delete card.mediaBytes; delete card.mediaFormat; delete card.mediaResource;
      card.mediaSource = url ? "url" : null;
    }
    card.mediaUrl = url || null;
    card.status = url ? "ready" : "needs_media";
  }
  audit(state, "content_card_updated", { cardId: id });
  return { status: 200, body: { card } };
}

export function approveBoardCard(state, id, now = new Date(), config = scheduleConfig()) {
  state.boardCards ||= [];
  const card = state.boardCards.find(item => item.id === id);
  if (!card) return { status: 404, body: { error: "Content card not found" } };
  if (card.status !== "ready" || !card.mediaUrl) return { status: 409, body: { error: "Attach a public media URL and save the card before approval" } };
  if (!card.caption.trim()) return { status: 400, body: { error: "Add a caption before approval" } };
  const scheduledAt = pickSlot({ posts: state.posts || [], now, earliestDay: card.day, config });
  if (!scheduledAt) return { status: 409, body: { error: "No available posting slot in the next four weeks" } };
  const post = {
    id: crypto.randomUUID(), type: card.format, caption: card.caption,
    mediaUrl: card.mediaUrl, scheduledAt, status: "scheduled",
    createdAt: now.toISOString(), cardId: card.id
  };
  state.posts.unshift(post);
  card.status = "scheduled";
  card.postId = post.id;
  card.scheduledAt = scheduledAt;
  audit(state, "content_card_approved_and_scheduled", { cardId: card.id, postId: post.id, scheduledAt });
  return { status: 200, body: { card, post } };
}

export function discardBoardCard(state, id) {
  state.boardCards ||= [];
  const card = state.boardCards.find(item => item.id === id);
  if (!card) return { status: 404, body: { error: "Content card not found" } };
  if (card.status === "scheduled") return { status: 409, body: { error: "Cancel the scheduled post before discarding this card" } };
  state.boardCards = state.boardCards.filter(item => item.id !== id);
  audit(state, "content_card_discarded", { cardId: id });
  return { status: 200, body: { ok: true } };
}

export function releaseBoardCard(state, post) {
  const card = (state.boardCards || []).find(item => item.id === post.cardId || item.postId === post.id);
  if (card && card.status === "scheduled") {
    card.status = card.mediaUrl ? "ready" : "needs_media";
    delete card.postId;
    delete card.scheduledAt;
  }
}

// Converts an owner-chosen strategy plan item into a Content Board card. The card starts as needs_media:
// it still needs media, safety review and the owner's approval before anything can be scheduled or published.
export function addCardFromPlanItem(state, item, context = {}, now = new Date(), config = scheduleConfig()) {
  state.boardCards ||= [];
  const niche = clean(context.niche, 120) || "creator content", audience = clean(context.audience, 160) || "your audience";
  const day = String(item.plan_date instanceof Date ? item.plan_date.toISOString() : item.plan_date).slice(0, 10);
  const prompt = [
    item.format === "reel"
      ? "Create an original vertical 9:16 Instagram Reel scene (6 to 8 seconds, smooth camera movement)."
      : "Create an original vertical 4:5 Instagram feed image (Instagram feed images must be between 4:5 and 1.91:1).",
    "Niche: " + niche + ". Audience: " + audience + ".",
    "Content pillar: " + item.pillar + ". Concept: " + item.topic + (item.hook ? ". Hook: " + item.hook : "") + ".",
    "Use a clear focal subject, polished composition, natural detail and no watermarks or logos.",
    "Do not add text unless it is essential to the concept."
  ].join(" ");
  const card = {
    id: crypto.randomUUID(), planId: "strategy:" + item.generation_id, strategyItemId: item.item_id, day, format: item.format,
    pillar: item.pillar, idea: item.topic, prompt, caption: clean(item.topic + (item.hook ? "\n\n" + item.hook : ""), 2200),
    status: "needs_media", createdAt: now.toISOString()
  };
  card.suggestedAt = pickSlot({ posts: state.posts || [], now, earliestDay: day, config });
  card.suggestedSlotLabel = card.suggestedAt ? new Date(Date.parse(card.suggestedAt) + config.offsetMinutes * 60000).toISOString().slice(0, 16).replace("T", " ") : null;
  state.boardCards = [card, ...state.boardCards].slice(0, 200);
  audit(state, "content_card_from_strategy", { cardId: card.id, itemId: item.item_id });
  return card;
}
