// In-memory stand-in for @neondatabase/serverless, used only by integration tests.
// It understands the handful of statements lib/db.mjs issues against the single state row.
let row = null;

export function neon() {
  return async (strings, ...values) => {
    const text = strings.join("?");
    if (text.includes("CREATE TABLE")) return [];
    if (text.includes("INSERT INTO creator_os_state")) {
      if (!row) row = { version: 0, data: { settings: { killSwitch: true }, posts: [], audit: [] } };
      return [];
    }
    if (text.includes("SELECT version, data")) return row ? [{ version: row.version, data: structuredClone(row.data) }] : [];
    if (text.includes("UPDATE creator_os_state")) {
      if (!row || row.version !== values[1]) return [];
      row.data = JSON.parse(values[0]);
      row.version += 1;
      return [{ version: row.version }];
    }
    throw new Error("neon-stub: unsupported statement: " + text.slice(0, 80));
  };
}
