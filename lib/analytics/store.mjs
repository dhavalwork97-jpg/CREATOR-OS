import { query } from "../sql.mjs";

// Read-only over monitor history; the only table this module writes is performance_insights.
export async function comparableRows(accountId, checkpoints) {
  return query(
    `SELECT m.ig_media_id, m.product_type, m.posted_at, m.permalink, m.caption, i.checkpoint, i.metrics
     FROM media_items m JOIN media_insights i ON i.media_id = m.media_id
     WHERE m.account_id = $1 AND i.checkpoint = ANY($2::text[]) AND m.posted_at IS NOT NULL`, [accountId, checkpoints]);
}

export async function profileSnapshots(accountId, days, now) {
  return query(
    `SELECT collected_at, followers FROM account_snapshots
     WHERE account_id = $1 AND kind = 'profile' AND collected_at >= $2::timestamptz - make_interval(days => $3) ORDER BY collected_at`,
    [accountId, now.toISOString(), days]);
}

export async function checkpointCoverage(accountId) {
  return query(
    `SELECT i.checkpoint, count(*)::int AS posts FROM media_insights i JOIN media_items m ON m.media_id = i.media_id
     WHERE m.account_id = $1 GROUP BY i.checkpoint ORDER BY i.checkpoint`, [accountId]);
}

export async function saveInsight(accountId, insight, day) {
  await query(
    `INSERT INTO performance_insights (account_id, kind, group_key, computed_on, status, observation, metrics, sample_size, confidence, suggested_action, window_label, evidence)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (account_id, kind, group_key, computed_on) DO UPDATE SET status = EXCLUDED.status, observation = EXCLUDED.observation,
       metrics = EXCLUDED.metrics, sample_size = EXCLUDED.sample_size, confidence = EXCLUDED.confidence,
       suggested_action = EXCLUDED.suggested_action, window_label = EXCLUDED.window_label, evidence = EXCLUDED.evidence`,
    [accountId, insight.kind, insight.groupKey || "", day, insight.status, insight.observation, JSON.stringify(insight.metrics || {}),
      insight.sampleSize || 0, insight.confidence, insight.suggestedAction ?? null, insight.window, JSON.stringify(insight.evidence || {})]);
}

export async function latestInsights(accountId) {
  return query(
    `SELECT kind, group_key, computed_on, status, observation, metrics, sample_size, confidence, suggested_action, window_label, evidence
     FROM performance_insights WHERE account_id = $1
       AND computed_on = (SELECT max(computed_on) FROM performance_insights WHERE account_id = $1)
     ORDER BY CASE status WHEN 'recommendation' THEN 0 WHEN 'observation' THEN 1 ELSE 2 END, kind, group_key`, [accountId]);
}
