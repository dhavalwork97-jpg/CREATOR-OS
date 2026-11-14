import { reviewContent, contentHash } from "./rules.mjs";
import * as store from "./store.mjs";

// Reviews one Content Board card (passed in; the caller reads it from legacy state) and appends the verdict.
export async function reviewCard(accountId, card, extraRecent = []) {
  const [settings, recent] = [await store.getSafetySettings(accountId), await store.recentCaptions(accountId)];
  const verdict = reviewContent(card, { settings, recentCaptions: [...recent, ...extraRecent] });
  return store.insertReview(accountId, card.id, verdict);
}

// A review only counts while the content is unchanged since it was written.
export async function validReviewFor(accountId, card) {
  const review = await store.latestReview(accountId, card.id);
  if (!review) return { state: "unreviewed", review: null };
  if (review.content_hash !== contentHash(card)) return { state: "stale", review };
  return { state: "current", review };
}
