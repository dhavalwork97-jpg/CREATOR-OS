// Cross-version test runner (Node 20 and newer). `node --test` only learned glob patterns after Node 20,
// so we list the files ourselves. Usage: node scripts/run-tests.mjs [unit|integration|all]
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const list = dir => readdirSync(dir).filter(name => name.endsWith(".test.mjs")).sort().map(name => dir + "/" + name);
const suites = {
  unit: { args: [], files: list("test") },
  integration: { args: ["--import", "./test/helpers/register.mjs"], files: list("test/integration") }
};
const requested = process.argv[2] || "all";
const names = requested === "all" ? Object.keys(suites) : [requested];
let failed = false;
for (const name of names) {
  const suite = suites[name];
  if (!suite) { console.error("Unknown suite: " + name); process.exit(2); }
  console.log("\n=== " + name + " tests (" + suite.files.length + " files) ===");
  const result = spawnSync(process.execPath, [...suite.args, "--test", ...suite.files], { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
