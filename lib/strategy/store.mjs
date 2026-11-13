import { query } from "../sql.mjs";

export const DEFAULT_STRATEGY = { niche: "", audience: "", objective: "", pillars: [], postsPerWeek: 3, researchEnabled: true };

export async function getStrategySettings(accountId) {
  const [row] = await query(`SELECT strategy FROM agent_settings WHERE account_id = $1`, [accountId]);
  return { ...DEFAULT_STRATEGY, ...(row?.strategy || {}) };
}

export async function saveStrategySettings(accountId, patch) {
  await query(`INSERT INTO agent_settings (account_id, strategy) VALUES ($1,$2::jsonb)
    ON CONFLICT (account_id) DO UPDATE SET strategy = agent_settings.strategy || EXCLUDED.strategy, updated_at = now()`, [accountId, JSON.stringify(patch)]);
  return getStrategySettings(accountId);
}

// Re-running research refreshes evidence but never resurrects a rejected opportunity or overwrites the owner's decision.
export async function upsertOpportunity(accountId, o, now = new Date()) {
  const [row] = await query(
    `INSERT INTO content_opportunities (account_id, dedupe_key, source_class, title, summary, pillar, suggested_format, confidence, evidence, source_urls, researched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::timestamptz)
     ON CONFLICT (account_id, dedupe_key) DO UPDATE SET summary = EXCLUDED.summary, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence,
       source_urls = EXCLUDED.source_urls, researched_at = EXCLUDED.researched_at, updated_at = now()
     RETURNING opportunity_id, status, (xmax = 0) AS inserted`,
    [accountId, o.dedupeKey, o.sourceClass, o.title, o.summary, o.pillar || null, o.suggestedFormat || null, o.confidence,
      JSON.stringify(o.evidence || {}), JSON.stringify(o.sourceUrls || []), now.toISOString()]);
  return row;
}

export const listOpportunities = (accountId, limit = 100) => query(
  `SELECT * FROM content_opportunities WHERE account_id = $1 ORDER BY researched_at DESC, created_at DESC LIMIT $2`, [accountId, limit]);

export const activeOpportunities = accountId => query(
  `SELECT * FROM content_opportunities WHERE account_id = $1 AND status IN ('new','accepted')`, [accountId]);

export async function setOpportunityStatus(accountId, id, status) {
  const [row] = await query(`UPDATE content_opportunities SET status = $3, updated_at = now() WHERE opportunity_id = $2 AND account_id = $1 RETURNING *`, [accountId, id, status]);
  return row || null;
}

export const listPlan = (accountId, fromDate) => query(
  `SELECT * FROM content_plan_items WHERE account_id = $1 AND plan_date >= $2::date ORDER BY plan_date, created_at`, [accountId, fromDate]);

export const getPlanItem = (accountId, id) => query(`SELECT * FROM content_plan_items WHERE item_id = $2 AND account_id = $1`, [accountId, id]).then(r => r[0] || null);

export async function insertPlanItem(accountId, generationId, item) {
  const [row] = await query(
    `INSERT INTO content_plan_items (account_id, generation_id, plan_date, format, pillar, topic, hook, rationale, opportunity_id, evidence_class, confidence, performance_basis)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
    [accountId, generationId, item.plan_date, item.format, item.pillar, item.topic, item.hook, item.rationale, item.opportunity_id,
      item.evidence_class, item.confidence, JSON.stringify(item.performance_basis || [])]);
  return row;
}

// A new generation replaces earlier PROPOSED items for the future only; edited, rejected and converted items stay.
export const clearProposed = (accountId, fromDate) => query(
  `DELETE FROM content_plan_items WHERE account_id = $1 AND status = 'proposed' AND plan_date >= $2::date RETURNING item_id`, [accountId, fromDate]);

export async function updatePlanItem(accountId, id, patch) {
  const [row] = await query(
    `UPDATE content_plan_items SET topic = COALESCE($3, topic), hook = COALESCE($4, hook), format = COALESCE($5, format),
       pillar = COALESCE($6, pillar), plan_date = COALESCE($7::date, plan_date), status = COALESCE($8, status),
       edited_by_owner = edited_by_owner OR $9::boolean, board_card_id = COALESCE($10, board_card_id), updated_at = now()
     WHERE item_id = $2 AND account_id = $1 RETURNING *`,
    [accountId, id, patch.topic ?? null, patch.hook ?? null, patch.format ?? null, patch.pillar ?? null, patch.plan_date ?? null,
      patch.status ?? null, Boolean(patch.edited), patch.board_card_id ?? null]);
  return row || null;
}

export const recentCaptions = (accountId, days = 90) => query(
  `SELECT caption, posted_at FROM media_items WHERE account_id = $1 AND caption IS NOT NULL AND posted_at >= now() - make_interval(days => $2)`, [accountId, days]);

export const planTexts = accountId => query(
  `SELECT topic FROM content_plan_items WHERE account_id = $1 AND status IN ('proposed','edited','converted') AND plan_date >= CURRENT_DATE - 14`, [accountId]);
