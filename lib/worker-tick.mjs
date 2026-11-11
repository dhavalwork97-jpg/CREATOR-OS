import crypto from "node:crypto";
import { readState } from "./db.mjs";
import { schemaIsCurrent } from "./migrate.mjs";
import { ensureAccountFromEnv } from "./accounts.mjs";
import { tick, ensureRecurring } from "./supervisor.mjs";
import { handlers, recurringDefinitions } from "./agents/index.mjs";

// One short-lived execution unit, called by the scheduled worker. Existing /api/worker/run (publishing) is unchanged.
export async function runWorkerTick() {
  if (!(await schemaIsCurrent())) {
    return { status: 503, body: { error: "Database migrations have not been applied. Run: node --env-file-if-exists=.env scripts/migrate.mjs up" } };
  }
  const account = await ensureAccountFromEnv();
  if (!account) return { status: 200, body: { skipped: true, reason: "No Instagram account is configured (IG_USER_ID / OWNER_EMAIL)." } };
  // The existing JSON-state kill switch stays the single source of truth; it defaults to ON.
  const killSwitch = (await readState()).settings?.killSwitch !== false;
  const created = await ensureRecurring({ accountId: account.account_id, definitions: await recurringDefinitions(account.account_id), now: new Date() });
  const summary = await tick({ handlers, workerId: "tick-" + crypto.randomUUID().slice(0, 8), killSwitch });
  return { status: 200, body: { ...summary, scheduled: created.length } };
}
