import { query } from "../sql.mjs";

export async function getSafetySettings(accountId) {
  const [row] = await query(`SELECT safety FROM agent_settings WHERE account_id = $1`, [accountId]);
  return { blockedTerms: [], reviewTerms: [], ...(row?.safety || {}) };
}

// Owner-only (called from an authenticated owner route). No agent code imports this function.
export async function saveSafetySettings(accountId, patch) {
  await query(`INSERT INTO agent_settings (account_id, safety) VALUES ($1,$2::jsonb)
    ON CONFLICT (account_id) DO UPDATE SET safety = agent_settings.safety || EXCLUDED.safety, updated_at = now()`, [accountId, JSON.stringify(patch)]);
  return getSafetySettings(accountId);
}

export async function insertReview(accountId, cardId, review) {
  const [row] = await query(
    `INSERT INTO safety_reviews (account_id, subject_type, subject_id, content_hash, status, findings, rules_version)
     VALUES ($1,'board_card',$2,$3,$4,$5::jsonb,$6) RETURNING *`,
    [accountId, cardId, review.contentHash, review.status, JSON.stringify(review.findings), review.rulesVersion]);
  return row;
}

export const latestReview = (accountId, cardId) => query(
  `SELECT * FROM safety_reviews WHERE account_id = $1 AND subject_type = 'board_card' AND subject_id = $2 ORDER BY created_at DESC, review_id DESC LIMIT 1`, [accountId, cardId]).then(r => r[0] || null);

export const listReviews = (accountId, cardId, limit = 50) => cardId
  ? query(`SELECT * FROM safety_reviews WHERE account_id = $1 AND subject_id = $2 ORDER BY created_at DESC LIMIT $3`, [accountId, cardId, limit])
  : query(`SELECT * FROM safety_reviews WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`, [accountId, limit]);

export const recentCaptions = accountId => query(
  `SELECT caption FROM media_items WHERE account_id = $1 AND caption IS NOT NULL ORDER BY posted_at DESC NULLS LAST LIMIT 30`, [accountId]).then(rows => rows.map(r => r.caption));
