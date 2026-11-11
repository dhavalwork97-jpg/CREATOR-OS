import { graphGet, graphConfig, GraphError } from "../meta/graph.mjs";
import { ACCOUNT_METRICS, MEDIA_FIELDS, mediaMetricsFor, readInsightValue, checkpointFor } from "../meta/metrics.mjs";
import * as store from "../monitor/store.mjs";
import { TaskError } from "../tasks/queue.mjs";
import { recordAudit } from "../audit-log.mjs";

// The Instagram Account Monitor is strictly read-only: it only issues GET requests to the Graph API and writes history rows.
// It has no access to publishing, settings or autonomy.

export const DEFAULT_MONITORING = { enabled: true, accountHealthMinutes: 360, mediaSyncMinutes: 360, insightsMinutes: 1440 };
export const MIN_MONITORING = { accountHealthMinutes: 15, mediaSyncMinutes: 60, insightsMinutes: 360 };

const reasonOf = error => error instanceof GraphError
  ? { code: "graph_error", kind: error.kind, graphCode: error.code ?? null, message: error.message }
  : { code: "unexpected", message: String(error?.message || error).slice(0, 300) };

// Map a Graph failure to a task outcome: transient problems retry with backoff, token/permission problems are
// surfaced immediately and never retried blindly.
function toTaskError(error) {
  if (!(error instanceof GraphError)) return error;
  const retryable = error.kind === "transient" || error.kind === "rate_limit";
  return new TaskError("graph_" + error.kind, error.message, { retryable, detail: { graphCode: error.code ?? null } });
}

async function requireAccount(task) {
  const account = await store.getAccount(task.account_id);
  if (!account) throw new TaskError("account_missing", "The account for this task no longer exists");
  if (!graphConfig()) throw new TaskError("not_configured", "IG_GRAPH_API_VERSION, IG_USER_ID and IG_ACCESS_TOKEN must be set");
  return account;
}

async function markFailure(account, error, now) {
  if (!(error instanceof GraphError)) return;
  const tokenBad = error.kind === "token";
  await store.updateAccountHealth(account.account_id, {
    connectionStatus: tokenBad ? "error" : undefined, tokenStatus: tokenBad ? "invalid" : undefined, lastError: error.message
  }, now);
  if (tokenBad && account.token_status !== "invalid") {
    await recordAudit({ accountId: account.account_id, action: "token_invalid", subjectType: "account", subjectId: account.account_id,
      detail: { graphCode: error.code ?? null, message: error.message } });
  }
}

export async function accountHealth({ task, now, signal }) {
  const account = await requireAccount(task);
  const at = now();
  let profile;
  try { profile = await graphGet(account.ig_user_id, { fields: "username,followers_count,follows_count,media_count" }, { signal }); }
  catch (error) { await markFailure(account, error, at); throw toTaskError(error); }

  const unavailable = {};
  const num = (value, name) => { if (Number.isInteger(value)) return value; unavailable[name] = { code: "not_returned" }; return null; };
  const followers = num(profile.followers_count, "followers"), following = num(profile.follows_count, "following"), mediaCount = num(profile.media_count, "media_count");
  const previous = await store.latestProfileSnapshot(account.account_id);
  await store.insertProfileSnapshot(account.account_id, { followers, following, mediaCount, unavailable }, at);
  await store.updateAccountHealth(account.account_id, { username: profile.username, connectionStatus: "connected", tokenStatus: "valid", lastError: null }, at);
  if (account.token_status === "invalid") {
    await recordAudit({ accountId: account.account_id, action: "token_recovered", subjectType: "account", subjectId: account.account_id });
  }
  const change = previous?.followers != null && followers != null ? followers - previous.followers : null;
  return { output: { followers, following, mediaCount, followerChange: change, unavailable }, decision: { action: "recorded profile snapshot" } };
}

export async function mediaSync({ task, now, signal }) {
  const account = await requireAccount(task);
  const at = now();
  let page;
  try { page = await graphGet(account.ig_user_id + "/media", { fields: MEDIA_FIELDS, limit: 25 }, { signal }); }
  catch (error) { await markFailure(account, error, at); throw toTaskError(error); }
  let created = 0, seen = 0;
  for (const item of page.data || []) {
    if (!item?.id) continue;
    const row = await store.upsertMedia(account.account_id, item, at);
    seen += 1; if (row?.inserted) created += 1;
  }
  return { output: { seen, created }, decision: { action: "synchronised recent media", note: "Only the 25 most recent items are read per run." } };
}

export async function accountInsights({ task, now, signal }) {
  const account = await requireAccount(task);
  const at = now();
  // Previous full UTC day. The requested window is stored as provenance.
  const windowEnd = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const windowStart = new Date(windowEnd.getTime() - 86400000);
  const metrics = {}, unavailable = {};
  let tokenError = null;
  for (const metric of ACCOUNT_METRICS) {
    if (tokenError) { unavailable[metric] = reasonOf(tokenError); continue; }
    try {
      const body = await graphGet(account.ig_user_id + "/insights", {
        metric, period: "day", metric_type: "total_value", since: Math.floor(windowStart.getTime() / 1000), until: Math.floor(windowEnd.getTime() / 1000)
      }, { signal });
      const value = readInsightValue(body.data?.[0]);
      if (value === null) unavailable[metric] = { code: "no_data_returned", note: "Meta returned an empty data set for this metric (for example, accounts under 100 followers)." };
      else metrics[metric] = value;
    } catch (error) {
      if (error instanceof GraphError && (error.kind === "token")) { tokenError = error; await markFailure(account, error, at); }
      // Network/server/rate-limit failures say nothing about the metric itself. Abort and retry rather than storing a
      // snapshot that would be permanently (and wrongly) marked unavailable. Only Meta's definitive answers are recorded.
      if (error instanceof GraphError && ["rate_limit", "transient"].includes(error.kind)) throw toTaskError(error);
      unavailable[metric] = reasonOf(error);
    }
  }
  if (tokenError) throw toTaskError(tokenError);
  const stored = await store.insertAccountInsights(account.account_id, { windowStart, windowEnd, metrics, unavailable }, at);
  return { output: { stored, collected: Object.keys(metrics).length, unavailable: Object.keys(unavailable).length },
    decision: { action: stored ? "stored daily insights" : "window already collected; nothing written" } };
}

// Collects each media item at most once per checkpoint, capped per run to respect API limits.
export async function mediaInsights({ task, now, signal }) {
  const account = await requireAccount(task);
  const at = now();
  const maxRequests = Number(task.input?.maxItems) || 15;
  const candidates = await store.mediaForInsights(account.account_id, {}, at);
  let collected = 0, skipped = 0;
  for (const media of candidates) {
    if (collected >= maxRequests) break;
    const wanted = mediaMetricsFor(media.product_type);
    if (!wanted) { skipped += 1; continue; }
    const ageHours = (at.getTime() - new Date(media.posted_at).getTime()) / 3600000;
    const checkpoint = checkpointFor(ageHours, new Set(media.checkpoints || []));
    if (!checkpoint) { skipped += 1; continue; }

    const metrics = {}, unavailable = {};
    const take = (body, names) => {
      const byName = new Map((body.data || []).map(entry => [entry.name, entry]));
      for (const name of names) {
        const value = readInsightValue(byName.get(name));
        if (value === null) unavailable[name] = { code: "no_data_returned" }; else metrics[name] = value;
      }
    };
    try { take(await graphGet(media.ig_media_id + "/insights", { metric: wanted.join(",") }, { signal }), wanted); }
    catch (error) {
      if (error instanceof GraphError && (error.kind === "token" || error.kind === "rate_limit" || error.kind === "transient")) {
        await markFailure(account, error, at); throw toTaskError(error);
      }
      // A combined request can be rejected as a whole; retry metric by metric so one bad metric does not hide the rest.
      for (const name of wanted) {
        try { take(await graphGet(media.ig_media_id + "/insights", { metric: name }, { signal }), [name]); }
        catch (inner) {
          if (inner instanceof GraphError && ["token", "rate_limit", "transient"].includes(inner.kind)) throw toTaskError(inner);
          unavailable[name] = reasonOf(inner);
        }
      }
    }
    await store.insertMediaInsights(media.media_id, { checkpoint, ageHours: Math.round(ageHours * 100) / 100, metrics, unavailable, source: "graph:/{media}/insights" }, at);
    collected += 1;
  }
  return { output: { collected, skipped, capped: collected >= maxRequests }, decision: { action: "collected media insights at due checkpoints" } };
}

export const monitorHandlers = {
  "monitor.account_health": accountHealth,
  "monitor.media_sync": mediaSync,
  "monitor.account_insights": accountInsights,
  "monitor.media_insights": mediaInsights
};

export function monitorDefinitions(settings = {}) {
  const config = { ...DEFAULT_MONITORING, ...settings };
  if (config.enabled === false) return [];
  return [
    { agent: "monitor", type: "account_health", intervalMinutes: config.accountHealthMinutes, priority: 10, timeoutSeconds: 45 },
    { agent: "monitor", type: "media_sync", intervalMinutes: config.mediaSyncMinutes, priority: 6, timeoutSeconds: 45 },
    { agent: "monitor", type: "account_insights", intervalMinutes: config.insightsMinutes, priority: 4, timeoutSeconds: 55 },
    { agent: "monitor", type: "media_insights", intervalMinutes: config.insightsMinutes, priority: 3, timeoutSeconds: 55 }
  ];
}
