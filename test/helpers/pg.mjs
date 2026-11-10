import { PGlite } from "@electric-sql/pglite";
import { setSqlForTests } from "../../lib/sql.mjs";
import { migrateUp } from "../../lib/migrate.mjs";

// A real in-process Postgres (WASM). It proves SQL semantics and constraints, but it is NOT Neon:
// Neon-specific behaviour (HTTP driver, pooling, latency) still needs a check against a Neon branch.
export async function freshDatabase({ migrate = true } = {}) {
  const db = new PGlite();
  setSqlForTests({ query: async (text, params = []) => (await db.query(text, params)).rows });
  if (migrate) await migrateUp();
  return { db, close: () => db.close() };
}

export async function seedAccount(igUserId = "17841000", owner = "owner@example.com") {
  const { query } = await import("../../lib/sql.mjs");
  const [account] = await query(`INSERT INTO ig_accounts (owner_email, ig_user_id) VALUES ($1,$2) RETURNING *`, [owner, igUserId]);
  return account;
}
