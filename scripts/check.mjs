import { spawnSync } from "node:child_process";

const files = [
  "server.mjs",
  "lib/db.mjs",
  "lib/agent-planner.mjs",
  "lib/content-board.mjs",
  "lib/api-handler.mjs",
  "api/[...path].mjs",
  "lib/media-providers/gemini-image.mjs",
  "lib/scheduler.mjs",
  "lib/util.mjs",
  "lib/usage.mjs",
  "lib/providers/gemini-text.mjs",
  "lib/providers/registry.mjs",
  "public/providers.js",
  "lib/storage/cloudinary.mjs",
  "lib/storage/media.mjs",
  "public/content-board.js",
  "lib/sql.mjs",
  "lib/migrate.mjs",
  "lib/accounts.mjs",
  "lib/audit-log.mjs",
  "lib/supervisor.mjs",
  "lib/worker-tick.mjs",
  "lib/tasks/queue.mjs",
  "lib/agents/index.mjs",
  "migrations/0001_foundation.mjs",
  "scripts/migrate.mjs",
  "api/worker/tick.mjs"
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });

  if (result.error) {
    console.error(`Could not check ${file}:`, result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`Syntax check failed: ${file}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`Syntax check passed for all ${files.length} files.`);
