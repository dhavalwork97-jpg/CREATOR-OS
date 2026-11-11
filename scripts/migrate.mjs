// Usage: node --env-file-if-exists=.env scripts/migrate.mjs [up|down|status]
// `down` rolls back exactly one migration. Run against a Neon branch first.
import { migrateUp, migrateDown, appliedMigrations, MIGRATIONS } from "../lib/migrate.mjs";

const command = process.argv[2] || "status";
if (command === "up") console.log("Applied:", await migrateUp());
else if (command === "down") console.log("Rolled back:", await migrateDown());
else if (command === "status") {
  const done = await appliedMigrations();
  for (const migration of MIGRATIONS) console.log((done.includes(migration.id) ? "applied  " : "pending  ") + migration.id);
} else { console.error("Unknown command: " + command); process.exit(2); }
