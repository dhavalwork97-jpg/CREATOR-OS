import { query } from "../sql.mjs";
import { monitorHandlers, monitorDefinitions } from "./monitor.mjs";
import { analyticsHandlers, analyticsDefinitions } from "./analytics.mjs";
import { strategyHandlers, strategyDefinitions } from "./strategy.mjs";
import { creativeHandlers } from "./creative.mjs";
import { safetyHandlers } from "./safety.mjs";

// Handler registry keyed by "<agent>.<task_type>". Each phase registers its agents here.
export const handlers = { ...monitorHandlers, ...analyticsHandlers, ...strategyHandlers, ...creativeHandlers, ...safetyHandlers };

// Recurring task definitions the worker tick makes sure exist (idempotent per interval bucket).
// Intervals come from the account's saved monitoring settings; defaults follow the Creator OS 2.0 brief.
export async function recurringDefinitions(accountId) {
  const [row] = await query(`SELECT monitoring FROM agent_settings WHERE account_id = $1`, [accountId]);
  return [...monitorDefinitions(row?.monitoring || {}), ...analyticsDefinitions(), ...strategyDefinitions()];
}
