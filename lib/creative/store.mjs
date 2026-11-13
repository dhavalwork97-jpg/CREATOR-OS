import { query } from "../sql.mjs";

export const getItem = (accountId, id) => query(`SELECT * FROM content_plan_items WHERE item_id = $2 AND account_id = $1`, [accountId, id]).then(r => r[0] || null);

export async function insertPackage(accountId, itemId, pkg) {
  const [v] = await query(`SELECT COALESCE(max(version),0) + 1 AS next FROM creative_packages WHERE plan_item_id = $1`, [itemId]);
  await query(`UPDATE creative_packages SET status = 'superseded', updated_at = now() WHERE plan_item_id = $1 AND status IN ('draft','needs_fixes') AND NOT edited_by_owner`, [itemId]);
  const [row] = await query(
    `INSERT INTO creative_packages (account_id, plan_item_id, version, status, source, model, caption, hashtags, hook, cta, media_prompt, alt_text, script, validation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14::jsonb) RETURNING *`,
    [accountId, itemId, v.next, pkg.status, pkg.source, pkg.model || null, pkg.caption, JSON.stringify(pkg.hashtags), pkg.hook, pkg.cta, pkg.media_prompt, pkg.alt_text, JSON.stringify(pkg.script), JSON.stringify(pkg.validation)]);
  return row;
}

export const listPackages = (accountId, itemId) => itemId
  ? query(`SELECT * FROM creative_packages WHERE account_id = $1 AND plan_item_id = $2 ORDER BY version DESC`, [accountId, itemId])
  : query(`SELECT * FROM creative_packages WHERE account_id = $1 AND status <> 'superseded' ORDER BY created_at DESC LIMIT 100`, [accountId]);

export const getPackage = (accountId, id) => query(`SELECT * FROM creative_packages WHERE package_id = $2 AND account_id = $1`, [accountId, id]).then(r => r[0] || null);

export async function savePackage(accountId, id, pkg, status) {
  const [row] = await query(
    `UPDATE creative_packages SET caption = $3, hashtags = $4::jsonb, hook = $5, cta = $6, media_prompt = $7, alt_text = $8, script = $9::jsonb,
       validation = $10::jsonb, status = $11, edited_by_owner = true, updated_at = now() WHERE package_id = $2 AND account_id = $1 RETURNING *`,
    [accountId, id, pkg.caption, JSON.stringify(pkg.hashtags), pkg.hook, pkg.cta, pkg.media_prompt, pkg.alt_text, JSON.stringify(pkg.script), JSON.stringify(pkg.validation), status]);
  return row || null;
}

export const setStatus = (accountId, id, status) => query(`UPDATE creative_packages SET status = $3, updated_at = now() WHERE package_id = $2 AND account_id = $1 RETURNING *`, [accountId, id, status]).then(r => r[0] || null);
