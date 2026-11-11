import { query } from "../sql.mjs";

const json = value => JSON.stringify(value ?? {});

export async function getAccount(accountId) {
  const [row] = await query(`SELECT * FROM ig_accounts WHERE account_id = $1`, [accountId]);
  return row || null;
}

export async function updateAccountHealth(accountId, patch, now = new Date()) {
  await query(
    `UPDATE ig_accounts SET username = COALESCE($2, username), connection_status = COALESCE($3, connection_status),
       token_status = COALESCE($4, token_status), token_checked_at = $5::timestamptz, last_error = $6, updated_at = $5::timestamptz
     WHERE account_id = $1`,
    [accountId, patch.username ?? null, patch.connectionStatus ?? null, patch.tokenStatus ?? null, now.toISOString(), patch.lastError ?? null]);
}

export async function latestProfileSnapshot(accountId) {
  const [row] = await query(`SELECT * FROM account_snapshots WHERE account_id = $1 AND kind = 'profile' ORDER BY collected_at DESC LIMIT 1`, [accountId]);
  return row || null;
}

export async function insertProfileSnapshot(accountId, { followers, following, mediaCount, unavailable = {} }, now = new Date()) {
  await query(
    `INSERT INTO account_snapshots (account_id, kind, collected_at, followers, following, media_count, unavailable, source)
     VALUES ($1,'profile',$2::timestamptz,$3,$4,$5,$6::jsonb,'graph:/{ig-user}?fields')`,
    [accountId, now.toISOString(), followers ?? null, following ?? null, mediaCount ?? null, json(unavailable)]);
}

// One insights row per account per window; a re-run for the same window is a no-op (history is never rewritten).
export async function insertAccountInsights(accountId, { windowStart, windowEnd, metrics, unavailable }, now = new Date()) {
  const rows = await query(
    `INSERT INTO account_snapshots (account_id, kind, collected_at, window_start, window_end, metrics, unavailable, source)
     VALUES ($1,'insights',$2::timestamptz,$3::timestamptz,$4::timestamptz,$5::jsonb,$6::jsonb,'graph:/{ig-user}/insights period=day metric_type=total_value')
     ON CONFLICT (account_id, window_end) WHERE kind = 'insights' DO NOTHING RETURNING snapshot_id`,
    [accountId, now.toISOString(), windowStart.toISOString(), windowEnd.toISOString(), json(metrics), json(unavailable)]);
  return rows.length > 0;
}

// Descriptive fields refresh on every successful sync; identity and first_seen_at never change.
export async function upsertMedia(accountId, item, now = new Date()) {
  const [row] = await query(
    `INSERT INTO media_items (account_id, ig_media_id, caption, media_type, product_type, permalink, posted_at, like_count, comments_count, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10::timestamptz,$10::timestamptz)
     ON CONFLICT (account_id, ig_media_id) DO UPDATE SET caption = EXCLUDED.caption, media_type = EXCLUDED.media_type,
       product_type = EXCLUDED.product_type, permalink = EXCLUDED.permalink, like_count = EXCLUDED.like_count,
       comments_count = EXCLUDED.comments_count, last_seen_at = EXCLUDED.last_seen_at
     RETURNING media_id, (xmax = 0) AS inserted`,
    [accountId, item.id, item.caption ?? null, item.media_type ?? null, item.media_product_type ?? null, item.permalink ?? null,
      item.timestamp ?? null, Number.isInteger(item.like_count) ? item.like_count : null,
      Number.isInteger(item.comments_count) ? item.comments_count : null, now.toISOString()]);
  return row;
}

export async function mediaForInsights(accountId, { sinceDays = 35, limit = 40 } = {}, now = new Date()) {
  return query(
    `SELECT m.media_id, m.ig_media_id, m.product_type, m.posted_at,
       COALESCE((SELECT array_agg(i.checkpoint) FROM media_insights i WHERE i.media_id = m.media_id), '{}') AS checkpoints
     FROM media_items m WHERE m.account_id = $1 AND m.posted_at IS NOT NULL AND m.posted_at > $2::timestamptz - make_interval(days => $3)
     ORDER BY m.posted_at DESC LIMIT $4`, [accountId, now.toISOString(), sinceDays, limit]);
}

export async function insertMediaInsights(mediaId, { checkpoint, ageHours, metrics, unavailable, source }, now = new Date()) {
  const rows = await query(
    `INSERT INTO media_insights (media_id, checkpoint, collected_at, age_hours, metrics, unavailable, source)
     VALUES ($1,$2,$3::timestamptz,$4,$5::jsonb,$6::jsonb,$7) ON CONFLICT (media_id, checkpoint) DO NOTHING RETURNING insight_id`,
    [mediaId, checkpoint, now.toISOString(), ageHours, json(metrics), json(unavailable), source]);
  return rows.length > 0;
}

export async function overview(accountId) {
  const [account] = await query(`SELECT account_id, ig_user_id, username, connection_status, token_status, token_checked_at, last_error FROM ig_accounts WHERE account_id = $1`, [accountId]);
  const profile = await query(`SELECT collected_at, followers, following, media_count FROM account_snapshots WHERE account_id = $1 AND kind = 'profile' ORDER BY collected_at DESC LIMIT 60`, [accountId]);
  const [insights] = await query(`SELECT collected_at, window_start, window_end, metrics, unavailable FROM account_snapshots WHERE account_id = $1 AND kind = 'insights' ORDER BY window_end DESC LIMIT 1`, [accountId]);
  const media = await query(
    `SELECT m.ig_media_id, m.caption, m.media_type, m.product_type, m.permalink, m.posted_at, m.like_count, m.comments_count,
       i.checkpoint, i.collected_at AS insights_collected_at, i.age_hours, i.metrics, i.unavailable
     FROM media_items m LEFT JOIN LATERAL (SELECT * FROM media_insights x WHERE x.media_id = m.media_id ORDER BY x.collected_at DESC LIMIT 1) i ON true
     WHERE m.account_id = $1 ORDER BY m.posted_at DESC NULLS LAST LIMIT 20`, [accountId]);
  const tasks = await query(
    `SELECT DISTINCT ON (task_type) task_type, status, error, completed_at, run_after FROM agent_tasks
     WHERE account_id = $1 AND agent = 'monitor' ORDER BY task_type, created_at DESC`, [accountId]);
  return { account, profile: profile.reverse(), insights: insights || null, media, tasks };
}
