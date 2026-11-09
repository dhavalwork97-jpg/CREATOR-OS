import http from "node:http";

// Boots the real request handler against the in-memory database.
// Every outbound fetch must match a declared route; anything else fails loudly so a test can
// prove that (for example) no request ever reached a service that should be unused.
export async function startApp({ env = {}, routes = [] } = {}) {
  Object.assign(process.env, {
    DATABASE_URL: "stub", OWNER_EMAIL: "owner@example.com", NEON_AUTH_BASE_URL: "https://auth.test",
    CRON_SECRET: "c".repeat(40), ENABLE_AUTOPUBLISH: "false"
  }, env);

  const realFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input : input?.url || input);
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return realFetch(input, init);
    outbound.push({ url, method: init.method || "GET", headers: init.headers, body: init.body });
    if (url.startsWith("https://auth.test/get-session")) {
      return Response.json({ user: { id: "u1", email: process.env.OWNER_EMAIL, name: "Owner" } });
    }
    for (const route of routes) {
      if (route.match(url, init)) return await route.respond(url, init);
    }
    throw new Error("Unexpected outbound request in test: " + (init.method || "GET") + " " + url);
  };

  const { default: handler } = await import("../../lib/api-handler.mjs");
  const db = await import("../../lib/db.mjs");
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  async function call(path, body, { method, auth = true, headers = {} } = {}) {
    const response = await realFetch(base + path, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", origin: base, ...(auth ? { cookie: "session=1" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: response.status, body: json };
  }

  return {
    call, db, outbound, base,
    async close() { await new Promise(resolve => server.close(resolve)); globalThis.fetch = realFetch; }
  };
}

export const graphRoutes = (calls = []) => [{
  match: url => url.startsWith("https://graph.facebook.com/"),
  respond: (url, init) => {
    calls.push((init.method || "GET") + " " + url.split("?")[0].replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, ""));
    if (url.includes("/media_publish")) return Response.json({ id: "ig-media-1" });
    if (url.includes("/media")) return Response.json({ id: "container-1" });
    return Response.json({ status_code: "FINISHED" });
  }
}];
