import { neon } from "@neondatabase/serverless";

let sql;
function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

export async function ensureSchema() {
  const q = database();
  await q`CREATE TABLE IF NOT EXISTS creator_os_state (
    id text PRIMARY KEY CHECK (id = 'owner'),
    version bigint NOT NULL DEFAULT 0,
    data jsonb NOT NULL
  )`;
  await q`INSERT INTO creator_os_state (id, version, data)
    VALUES ('owner', 0, '{"settings":{"killSwitch":true},"posts":[],"audit":[]}'::jsonb)
    ON CONFLICT (id) DO NOTHING`;
}

export async function readState() {
  await ensureSchema();
  const rows = await database()`SELECT version, data FROM creator_os_state WHERE id = 'owner'`;
  if (!rows.length) throw new Error("Creator OS database state is unavailable");
  return rows[0].data;
}

export async function mutateState(mutator) {
  await ensureSchema();
  const q = database();
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await q`SELECT version, data FROM creator_os_state WHERE id = 'owner'`;
    const current = rows[0];
    if (!current) throw new Error("Creator OS database state is unavailable");
    const next = structuredClone(current.data);
    const result = await mutator(next);
    const updated = await q`UPDATE creator_os_state
      SET data = ${JSON.stringify(next)}::jsonb, version = version + 1
      WHERE id = 'owner' AND version = ${current.version}
      RETURNING version`;
    if (updated.length) return result;
  }
  throw new Error("Database is busy; please retry the request");
}
