import { query } from "./sql.mjs";

// Append-only audit trail for 2.0 features. Details must never contain tokens or API keys;
// callers pass only identifiers, counts and short reasons.
const FORBIDDEN = /(token|secret|api[_-]?key|password|authorization)/i;

function scrub(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => scrub(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = FORBIDDEN.test(key) ? "[redacted]" : scrub(item, depth + 1);
  return out;
}

export async function recordAudit({ accountId = null, actor = "system", action, subjectType = null, subjectId = null, detail = {} }) {
  if (!action) throw new Error("audit action is required");
  await query(
    `INSERT INTO audit_events (account_id, actor, action, subject_type, subject_id, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [accountId, actor, action, subjectType, subjectId ? String(subjectId) : null, JSON.stringify(scrub(detail))]);
}

export async function recentAudit(accountId, limit = 50) {
  return query(`SELECT event_id, actor, action, subject_type, subject_id, detail, created_at
    FROM audit_events WHERE account_id = $1 ORDER BY event_id DESC LIMIT $2`, [accountId, Math.min(200, Math.max(1, Number(limit) || 50))]);
}
