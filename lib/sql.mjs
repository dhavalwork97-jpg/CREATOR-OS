import { neon } from "@neondatabase/serverless";

// Relational access for the 2.0 features. The legacy JSON state in db.mjs is untouched.
// All values are passed as bound parameters; callers never build SQL from user input.
let override = null;
let client = null;

// Tests inject a real in-process Postgres (pglite) through this hook.
export function setSqlForTests(impl) { override = impl; }

export function sql() {
  if (override) return override;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  client ||= neon(process.env.DATABASE_URL);
  return client;
}

// Parameterised query returning rows.
export async function query(text, params = []) {
  const db = sql();
  const result = await db.query(text, params);
  return Array.isArray(result) ? result : (result?.rows || []);
}
