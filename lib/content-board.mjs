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
      "Create an original vertical 9:16 Instagram " + (item.format === "reel" ? "Reel cover / scene" : "feed image"),
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
