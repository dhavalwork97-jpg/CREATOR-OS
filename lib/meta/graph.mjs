// Read-only Graph API client for monitoring. It reuses the existing IG_* credentials (no second auth system),
// follows the existing convention (graph.facebook.com + access_token), and never lets the token reach errors or logs.

export class GraphError extends Error {
  constructor(message, { kind, status, code, subcode } = {}) {
    super(message);
    this.name = "GraphError";
    this.kind = kind; // token | permission | rate_limit | transient | request
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}

export function graphConfig(env = process.env) {
  const version = env.IG_GRAPH_API_VERSION, userId = env.IG_USER_ID, token = env.IG_ACCESS_TOKEN;
  if (!version || !userId || !token) return null;
  return { version, userId, token };
}

const RATE = new Set([4, 17, 32, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

export function classify(status, error = {}) {
  const code = Number(error.code);
  if (code === 190 || error.type === "OAuthException" && [102, 190].includes(code)) return "token";
  if (RATE.has(code)) return "rate_limit";
  if (code === 10 || code === 3 || (code >= 200 && code <= 299)) return "permission";
  if (status >= 500 || code === 1 || code === 2) return "transient";
  return "request";
}

export const scrub = (text, token) => {
  let out = String(text ?? "");
  if (token) out = out.split(token).join("[redacted]");
  return out.replace(/access_token=[^&\s"]+/gi, "access_token=[redacted]").slice(0, 400);
};

export async function graphGet(path, params = {}, { env = process.env, fetchImpl = globalThis.fetch, signal } = {}) {
  const config = graphConfig(env);
  if (!config) throw new GraphError("Instagram credentials are not configured", { kind: "request" });
  const url = new URL("https://graph.facebook.com/" + config.version + "/" + path.replace(/^\//, ""));
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  url.searchParams.set("access_token", config.token);
  let response;
  try { response = await fetchImpl(url, { signal }); }
  catch (error) { throw new GraphError("Network error contacting Meta: " + scrub(error?.message, config.token), { kind: "transient" }); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const error = body.error || {};
    throw new GraphError(scrub(error.message || "Meta returned HTTP " + response.status, config.token), {
      kind: classify(response.status, error), status: response.status, code: error.code, subcode: error.error_subcode
    });
  }
  return body;
}
