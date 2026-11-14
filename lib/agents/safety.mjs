import { TaskError } from "../tasks/queue.mjs";
import { reviewCard } from "../safety/review.mjs";

// The Safety Reviewer only INSERTS reviews. It has no import of, and no query against, agent_settings, autonomy,
// the kill switch or the board's approval functions, so it cannot loosen a rule or approve content for publishing.
export async function reviewCardTask({ task }) {
  const { readState } = await import("../db.mjs");
  const card = ((await readState()).boardCards || []).find(c => c.id === task.input?.cardId);
  if (!card) throw new TaskError("not_found", "Content Board card not found.");
  const row = await reviewCard(task.account_id, card, ((await readState()).posts || []).map(p => p.caption));
  return { output: { reviewId: row.review_id, status: row.status, findings: row.findings.length }, decision: { action: "safety review", status: row.status } };
}
export const safetyHandlers = { "safety.review_card": reviewCardTask };
