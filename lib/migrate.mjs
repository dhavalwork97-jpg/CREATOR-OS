import { query } from "./sql.mjs";
import * as m0001 from "../migrations/0001_foundation.mjs";
import * as m0002 from "../migrations/0002_monitor.mjs";
import * as m0003 from "../migrations/0003_analytics.mjs";
import * as m0004 from "../migrations/0004_strategy.mjs";

// Ordered list. Add new migrations at the end; never edit one that has been applied.
export const MIGRATIONS = [m0001, m0002, m0003, m0004];

async function ensureLedger() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
}

export async function appliedMigrations() {
  await ensureLedger();
  return (await query(`SELECT id FROM schema_migrations ORDER BY id`)).map(row => row.id);
}

export async function migrateUp(list = MIGRATIONS) {
  const done = new Set(await appliedMigrations());
  const applied = [];
  for (const migration of list) {
    if (done.has(migration.id)) continue;
    for (const statement of migration.up) await query(statement);
    await query(`INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING`, [migration.id]);
    applied.push(migration.id);
  }
  return applied;
}

// Rolls back the most recent migration only, so a rollback is always one deliberate step.
export async function migrateDown(list = MIGRATIONS) {
  const done = new Set(await appliedMigrations());
  const last = [...list].reverse().find(migration => done.has(migration.id));
  if (!last) return null;
  for (const statement of last.down) await query(statement);
  await query(`DELETE FROM schema_migrations WHERE id = $1`, [last.id]);
  return last.id;
}

// Read-only check used by the worker so it fails with a clear message instead of a SQL error.
export async function schemaIsCurrent(list = MIGRATIONS) {
  try {
    const done = new Set(await appliedMigrations());
    return list.every(migration => done.has(migration.id));
  } catch { return false; }
}
