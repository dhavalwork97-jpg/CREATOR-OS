import { query } from "./sql.mjs";

// The deployment is single-owner. The connected Instagram account comes from the existing IG_USER_ID
// credentials; this registers it relationally so tasks and metrics can be scoped by account_id.
// Tokens are never read, stored or returned here.
export async function ensureAccountFromEnv(env = process.env) {
  const igUserId = String(env.IG_USER_ID || "").trim();
  const owner = String(env.OWNER_EMAIL || "").trim().toLowerCase();
  if (!igUserId || !owner) return null;
  const [account] = await query(
    `INSERT INTO ig_accounts (owner_email, ig_user_id) VALUES ($1,$2)
     ON CONFLICT (ig_user_id) DO UPDATE SET updated_at = ig_accounts.updated_at RETURNING *`, [owner, igUserId]);
  await query(`INSERT INTO agent_settings (account_id) VALUES ($1) ON CONFLICT DO NOTHING`, [account.account_id]);
  return account;
}

export async function getAccountForOwner(ownerEmail, env = process.env) {
  const igUserId = String(env.IG_USER_ID || "").trim();
  const [account] = await query(`SELECT * FROM ig_accounts WHERE ig_user_id = $1 AND owner_email = $2`,
    [igUserId, String(ownerEmail || "").toLowerCase()]);
  return account || null;
}

export const publicAccount = account => account && ({
  accountId: account.account_id, igUserId: account.ig_user_id, username: account.username,
  connectionStatus: account.connection_status, tokenStatus: account.token_status,
  tokenCheckedAt: account.token_checked_at, tokenExpiresAt: account.token_expires_at, lastError: account.last_error
});
