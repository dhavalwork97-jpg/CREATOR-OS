export const config = { maxDuration: 60 };
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSchema, readState, mutateState } from "./db.mjs";
import { buildContentPlan } from "./agent-planner.mjs";
import { generateGeminiImage, DEFAULT_MODEL as DEFAULT_GEMINI_IMAGE_MODEL } from "./media-providers/gemini-image.mjs";
import { generateGeminiText, listGeminiTextModels, isValidModelId, normalizeModel } from "./providers/gemini-text.mjs";
import { providerSummary, textProvider, imageProvider } from "./providers/registry.mjs";
import { reserveText, recordTextSuccess, recordTextFailure } from "./usage.mjs";
import { storageConfig, presignUpload, storageLimits, resourceFor, normalizeFormat, publicUrlFor } from "./storage/cloudinary.mjs";
import { validateUpload, mediaKeyFor, keyBelongsToCard, reserveUpload, expirePendingUploads, consumeUploadReservation, recordStored, recordRemoved, verifyPublicMedia, deleteStoredObject, storageSummary } from "./storage/media.mjs";
import { generateBoard, addCardFromPlanItem, updateBoardCard, approveBoardCard, discardBoardCard, releaseBoardCard } from "./content-board.mjs";
import { scheduleConfig } from "./scheduler.mjs";
import { runWorkerTick } from "./worker-tick.mjs";
import { schemaIsCurrent } from "./migrate.mjs";
import { getAccountForOwner, publicAccount } from "./accounts.mjs";
import { listTasks, getTask, cancel as cancelTask } from "./tasks/queue.mjs";
import { recordAudit, recentAudit } from "./audit-log.mjs";
import { overview as monitorOverview } from "./monitor/store.mjs";
import { DEFAULT_MONITORING, MIN_MONITORING } from "./agents/monitor.mjs";
import { enqueue } from "./tasks/queue.mjs";
import { latestInsights, checkpointCoverage } from "./analytics/store.mjs";
import { strategistFeedback } from "./agents/analytics.mjs";
import { query as sqlQuery } from "./sql.mjs";
import * as strategy from "./strategy/store.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clean = (value, limit = 2200) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const send = (res, status, value) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(value));
};
async function readBody(req) {
  let raw = "";
  for await (const part of req) {
    raw += part;
    if (raw.length > 1_000_000) throw new Error("Request too large");
  }
  return raw ? JSON.parse(raw) : {};
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}
function audit(state, action, detail = {}) {
  state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail });
  state.audit = state.audit.slice(0, 300);
}
function authBase() {
  const value = process.env.NEON_AUTH_BASE_URL;
  if (!value) throw new Error("Neon Auth is not configured for this deployment");
  return value.replace(/\/$/, "");
}
async function authProxy(req, res, pathname) {
  const owner = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  if (!owner) return send(res, 503, { error: "Owner sign-in is not configured yet" });
  if (pathname.endsWith("/sign-up/email") && !safeEqual(req.headers["x-creator-os-setup-secret"], process.env.OWNER_SETUP_SECRET)) return send(res, 403, { error: "Account setup is locked" });
  let raw = "";
  if (req.method !== "GET" && req.method !== "HEAD") raw = JSON.stringify(await readBody(req));
  if (pathname.endsWith("/sign-up/email") || pathname.endsWith("/sign-in/email")) {
    let input;
    try { input = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "Invalid sign-in request" }); }
    if (clean(input.email, 254).toLowerCase() !== owner) return send(res, 403, { error: "This Creator OS account is owner-only" });
  }
  const target = authBase() + pathname.replace(/^\/api\/auth/, "");
  const headers = { "content-type": req.headers["content-type"] || "application/json" };
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (req.headers.origin) headers.origin = req.headers.origin;
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : raw,
    redirect: "manual"
  });
  res.statusCode = upstream.status;
  for (const key of ["content-type", "cache-control", "location"]) {
    const value = upstream.headers.get(key);
    if (value) res.setHeader(key, value);
  }
  const cookies = upstream.headers.getSetCookie?.() || [];
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}
async function ownerSession(req) {
  const owner = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
  if (!owner || !req.headers.cookie) return null;
  const response = await fetch(authBase() + "/get-session", {
    headers: { cookie: req.headers.cookie, accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) return null;
  const value = await response.json().catch(() => null);
  const user = value?.user || value?.data?.user;
  if (!user?.email || String(user.email).toLowerCase() !== owner) return null;
  return { id: user.id, email: owner, name: user.name || owner };
}
function ready() {
  const meta = Boolean(process.env.IG_GRAPH_API_VERSION && process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN);
  return process.env.ENABLE_AUTOPUBLISH === "true" && meta;
}
async function publishDirect(post) {
  const apiVersion = process.env.IG_GRAPH_API_VERSION;
  const userId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!apiVersion || !/^v\d+\.\d+$/.test(apiVersion) || !userId || !token) throw new Error("Direct Meta publishing is not configured");
  const media = safeUrl(post.mediaUrl);
  if (!media) throw new Error("Media must use a public HTTPS URL");
  async function graphPost(endpoint, values) {
    const response = await fetch("https://graph.facebook.com/" + apiVersion + "/" + endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...values, access_token: token })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error?.message || "Meta API request failed");
    return data;
  }
  const reel = post.type === "reel";
  // Unified Login System User Access Tokens use graph.facebook.com
  // and the configured Instagram professional account ID.
  const container = await graphPost(userId + "/media", reel
    ? { media_type: "REELS", video_url: media, caption: post.caption }
    : { image_url: media, caption: post.caption });
  if (!container.id) throw new Error("Meta did not return a media container ID");
  let status = "IN_PROGRESS";
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const response = await fetch("https://graph.facebook.com/" + apiVersion + "/" + container.id +
      "?fields=status_code&access_token=" + encodeURIComponent(token));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error?.message || "Could not check media processing");
    status = data.status_code;
    if (status === "FINISHED") break;
    if (status === "ERROR" || status === "EXPIRED") throw new Error("Media processing: " + status);
  }
  if (status !== "FINISHED") throw new Error("Media processing still pending");
  const result = await graphPost(userId + "/media_publish", { creation_id: container.id });
  if (!result.id) throw new Error("Meta did not confirm publish");
  return result.id;
}
async function processDuePost() {
  if (!ready()) return { skipped: true, reason: "Autopublishing is disabled or the publisher is not configured" };
  const cap = Math.max(1, Number(process.env.MAX_POSTS_PER_DAY || 3));
  const gap = Math.max(30, Number(process.env.MIN_MINUTES_BETWEEN_POSTS || 180)) * 60000;
  const claimed = await mutateState(state => {
    if (state.settings.killSwitch) return null;
    const now = Date.now();
    for (const stale of state.posts.filter(p => p.status === "publishing" && p.claimedAt && now - Date.parse(p.claimedAt) > 600000)) {
      stale.status = "delivery_unknown";
      stale.lastError = "Worker stopped before confirming the publishing outcome; review before retrying.";
      delete stale.claimedAt;
      audit(state, "publish_delivery_unknown", { postId: stale.id, reason: "stale_worker_claim" });
    }
    const today = new Date().toISOString().slice(0, 10);
    const published = state.posts.filter(p => p.status === "published" && p.publishedAt?.startsWith(today)).length;
    const last = Math.max(0, ...state.posts.filter(p => p.status === "published").map(p => Date.parse(p.publishedAt || 0)));
    if (published >= cap || now - last < gap) return null;
    const post = state.posts.filter(p => p.status === "scheduled" && Date.parse(p.scheduledAt) <= now)
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
    if (!post) return null;
    post.status = "publishing";
    post.claimedAt = new Date(now).toISOString();
    audit(state, "publish_started", { postId: post.id, adapter: "meta" });
    return structuredClone(post);
  });
  if (!claimed) return { processed: false };
  try {
    const externalId = await publishDirect(claimed);
    await mutateState(state => {
      const post = state.posts.find(p => p.id === claimed.id);
      if (!post || post.status !== "publishing") return;
      post.status = "published";
      post.instagramMediaId = externalId;
      post.publishedAt = new Date().toISOString();
      delete post.claimedAt;
      audit(state, "publish_succeeded", { postId: post.id, adapter: "meta" });
    });
    return { processed: true, postId: claimed.id };
  } catch (error) {
    await mutateState(state => {
      const post = state.posts.find(p => p.id === claimed.id);
      if (!post || post.status !== "publishing") return;
      post.lastError = clean(error.message, 500);
      if (error.definitive) {
        post.status = "scheduled";
        post.scheduledAt = new Date(Date.now() + 300000).toISOString();
        audit(state, "publish_rejected_retry_scheduled", { postId: post.id, error: post.lastError });
      } else {
        post.status = "delivery_unknown";
        audit(state, "publish_delivery_unknown", { postId: post.id, error: post.lastError });
      }
      delete post.claimedAt;
    });
    return { processed: true, postId: claimed.id, error: clean(error.message, 500) };
  }
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "https://" + (req.headers.host || "localhost"));
    const pathname = url.pathname;

    if (pathname.startsWith("/api/auth/")) return await authProxy(req, res, pathname);

    if (req.method === "GET" && pathname === "/health") {
      await ensureSchema();
      return send(res, 200, { ok: true, database: "connected", autoPublishEnabled: process.env.ENABLE_AUTOPUBLISH === "true" });
    }

    if (req.method === "GET" && pathname === "/api/session") {
      const session = await ownerSession(req);
      return send(res, 200, { authenticated: Boolean(session), user: session });
    }

    if (req.method === "GET" && pathname === "/api/worker/run") {
      const secret = process.env.CRON_SECRET;
      if (!secret || !safeEqual(req.headers.authorization?.replace(/^Bearer\s+/i, ""), secret)) {
        return send(res, 401, { error: "Unauthorized worker request" });
      }
      return send(res, 200, await processDuePost());
    }

    if (req.method === "GET" && pathname === "/api/worker/tick") {
      const secret = process.env.CRON_SECRET;
      if (!secret || !safeEqual(req.headers.authorization?.replace(/^Bearer\s+/i, ""), secret)) {
        return send(res, 401, { error: "Unauthorized worker request" });
      }
      const result = await runWorkerTick();
      return send(res, result.status, result.body);
    }

    const session = await ownerSession(req);
    if (!session) return send(res, 401, { error: "Sign in with the configured owner account" });
    if (req.method === "POST") {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (!origin || !host || new URL(origin).host !== host) return send(res, 403, { error: "Invalid request origin" });
    }

    // ---- Creator OS 2.0: tasks and activity (owner session + account ownership on every call) ----
    if (pathname === "/api/tasks" || pathname === "/api/activity" || pathname.startsWith("/api/monitor/") || pathname.startsWith("/api/analytics/") || pathname.startsWith("/api/strategy/") || /^\/api\/tasks\/[a-f0-9-]{36}\/cancel$/i.test(pathname)) {
      if (!(await schemaIsCurrent())) return send(res, 503, { error: "Database migrations have not been applied yet." });
      const account = await getAccountForOwner(session.email);
      if (!account) return send(res, 404, { error: "No Instagram account is registered for this owner yet. The worker registers it on its first run." });
      if (req.method === "GET" && pathname === "/api/tasks") {
        const status = url.searchParams.get("status") || undefined;
        const tasks = await listTasks(account.account_id, { limit: url.searchParams.get("limit"), status });
        return send(res, 200, { account: publicAccount(account), tasks });
      }
      if (req.method === "GET" && pathname === "/api/monitor/overview") {
        const data = await monitorOverview(account.account_id);
        const [settings] = await sqlQuery(`SELECT monitoring FROM agent_settings WHERE account_id = $1`, [account.account_id]);
        return send(res, 200, { ...data, settings: { ...DEFAULT_MONITORING, ...(settings?.monitoring || {}) }, minimums: MIN_MONITORING });
      }
      if (req.method === "POST" && pathname === "/api/monitor/settings") {
        const body = await readBody(req);
        const next = {};
        if (body.enabled !== undefined) { if (typeof body.enabled !== "boolean") return send(res, 400, { error: "enabled must be true or false" }); next.enabled = body.enabled; }
        for (const key of Object.keys(MIN_MONITORING)) {
          if (body[key] === undefined) continue;
          const minutes = Number(body[key]);
          if (!Number.isInteger(minutes) || minutes < MIN_MONITORING[key] || minutes > 10080) {
            return send(res, 400, { error: key + " must be a whole number of minutes between " + MIN_MONITORING[key] + " and 10080" });
          }
          next[key] = minutes;
        }
        if (!Object.keys(next).length) return send(res, 400, { error: "No valid monitoring settings supplied" });
        await sqlQuery(`INSERT INTO agent_settings (account_id, monitoring) VALUES ($1,$2::jsonb)
          ON CONFLICT (account_id) DO UPDATE SET monitoring = agent_settings.monitoring || EXCLUDED.monitoring, updated_at = now()`,
          [account.account_id, JSON.stringify(next)]);
        await recordAudit({ accountId: account.account_id, actor: "owner", action: "monitoring_settings_changed", subjectType: "settings", detail: next });
        return send(res, 200, { settings: { ...DEFAULT_MONITORING, ...next } });
      }
      if (req.method === "POST" && pathname === "/api/monitor/run") {
        // On-demand refresh: read-only monitor tasks only, at most one per type per minute (idempotent).
        const minute = Math.floor(Date.now() / 60000);
        const queued = [];
        for (const type of ["account_health", "media_sync"]) {
          const { task, created } = await enqueue({ accountId: account.account_id, agent: "monitor", type, priority: 20, timeoutSeconds: 45,
            idempotencyKey: "monitor." + type + ":manual:" + account.account_id + ":" + minute });
          queued.push({ taskId: task.task_id, type, created });
        }
        await recordAudit({ accountId: account.account_id, actor: "owner", action: "monitor_refresh_requested" });
        return send(res, 202, { queued, note: "The scheduled worker runs these on its next tick (within about 5 minutes)." });
      }
      if (req.method === "GET" && pathname === "/api/analytics/report") {
        const [insights, coverage, feedback] = await Promise.all([latestInsights(account.account_id), checkpointCoverage(account.account_id), strategistFeedback(account.account_id)]);
        return send(res, 200, { insights, coverage, strategistFeedback: feedback });
      }
      if (req.method === "POST" && pathname === "/api/analytics/run") {
        const { task, created } = await enqueue({ accountId: account.account_id, agent: "analytics", type: "compute", priority: 15, timeoutSeconds: 45,
          idempotencyKey: "analytics.compute:manual:" + account.account_id + ":" + Math.floor(Date.now() / 60000) });
        await recordAudit({ accountId: account.account_id, actor: "owner", action: "analytics_refresh_requested" });
        return send(res, 202, { taskId: task.task_id, created, note: "The scheduled worker computes this on its next tick (within about 5 minutes)." });
      }
      if (pathname.startsWith("/api/strategy/")) {
        const uuid = "([a-f0-9-]{36})";
        const text = (v, n) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : null;
        if (req.method === "GET" && pathname === "/api/strategy/overview") {
          const today = new Date(Date.now() + scheduleConfig().offsetMinutes * 60000).toISOString().slice(0, 10);
          const [settings, opportunities, plan] = await Promise.all([strategy.getStrategySettings(account.account_id), strategy.listOpportunities(account.account_id), strategy.listPlan(account.account_id, today)]);
          return send(res, 200, { settings, opportunities, plan, externalResearch: "not_configured" });
        }
        if (req.method === "POST" && pathname === "/api/strategy/settings") {
          const b = await readBody(req), patch = {};
          for (const [key, limit] of [["niche", 120], ["audience", 160], ["objective", 300]]) if (b[key] !== undefined) { const v = text(b[key], limit); if (v === null) return send(res, 400, { error: key + " must be text" }); patch[key] = v; }
          if (b.pillars !== undefined) {
            if (!Array.isArray(b.pillars)) return send(res, 400, { error: "pillars must be a list" });
            patch.pillars = [...new Set(b.pillars.map(v => text(v, 80)).filter(Boolean))].slice(0, 5);
          }
          if (b.postsPerWeek !== undefined) { const n = Number(b.postsPerWeek); if (!Number.isInteger(n) || n < 1 || n > 7) return send(res, 400, { error: "postsPerWeek must be 1 to 7" }); patch.postsPerWeek = n; }
          if (b.researchEnabled !== undefined) { if (typeof b.researchEnabled !== "boolean") return send(res, 400, { error: "researchEnabled must be true or false" }); patch.researchEnabled = b.researchEnabled; }
          if (!Object.keys(patch).length) return send(res, 400, { error: "No valid strategy settings supplied" });
          const saved = await strategy.saveStrategySettings(account.account_id, patch);
          await recordAudit({ accountId: account.account_id, actor: "owner", action: "strategy_settings_changed", subjectType: "settings", detail: { fields: Object.keys(patch) } });
          return send(res, 200, { settings: saved });
        }
        if (req.method === "POST" && (pathname === "/api/strategy/research" || pathname === "/api/strategy/plan")) {
          const [agent, type] = pathname.endsWith("research") ? ["researcher", "discover"] : ["strategist", "plan_week"];
          const { task, created } = await enqueue({ accountId: account.account_id, agent, type, priority: 15, timeoutSeconds: 60,
            idempotencyKey: agent + "." + type + ":manual:" + account.account_id + ":" + Math.floor(Date.now() / 60000) });
          await recordAudit({ accountId: account.account_id, actor: "owner", action: "strategy_" + type + "_requested" });
          return send(res, 202, { taskId: task.task_id, created, note: "The scheduled worker runs this on its next tick (within about 5 minutes)." });
        }
        const opp = pathname.match(new RegExp("^/api/strategy/opportunities/" + uuid + "/(accept|reject)$", "i"));
        if (req.method === "POST" && opp) {
          const row = await strategy.setOpportunityStatus(account.account_id, opp[1], opp[2] === "accept" ? "accepted" : "rejected");
          if (!row) return send(res, 404, { error: "Opportunity not found" });
          await recordAudit({ accountId: account.account_id, actor: "owner", action: "opportunity_" + opp[2] + "ed", subjectType: "opportunity", subjectId: row.opportunity_id });
          return send(res, 200, { opportunity: row });
        }
        const planEdit = pathname.match(new RegExp("^/api/strategy/plan/" + uuid + "$", "i"));
        if (req.method === "POST" && planEdit) {
          const item = await strategy.getPlanItem(account.account_id, planEdit[1]);
          if (!item) return send(res, 404, { error: "Plan item not found" });
          if (item.status === "converted") return send(res, 409, { error: "This item is already a Content Board card. Edit the card instead." });
          const b = await readBody(req), patch = { edited: true };
          if (b.topic !== undefined) { patch.topic = text(b.topic, 300); if (!patch.topic) return send(res, 400, { error: "topic cannot be empty" }); }
          if (b.hook !== undefined) patch.hook = text(b.hook, 300) ?? "";
          if (b.pillar !== undefined) { patch.pillar = text(b.pillar, 80); if (!patch.pillar) return send(res, 400, { error: "pillar cannot be empty" }); }
          if (b.format !== undefined) { if (!["reel", "image"].includes(b.format)) return send(res, 400, { error: "format must be reel or image" }); patch.format = b.format; }
          if (b.plan_date !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.plan_date)) || Number.isNaN(Date.parse(b.plan_date))) return send(res, 400, { error: "plan_date must be YYYY-MM-DD" }); patch.plan_date = b.plan_date; }
          if (b.reject === true) { patch.status = "rejected"; patch.edited = false; } else patch.status = "edited";
          const row = await strategy.updatePlanItem(account.account_id, item.item_id, patch);
          await recordAudit({ accountId: account.account_id, actor: "owner", action: b.reject === true ? "plan_item_rejected" : "plan_item_edited", subjectType: "plan_item", subjectId: item.item_id });
          return send(res, 200, { item: row });
        }
        const toBoard = pathname.match(new RegExp("^/api/strategy/plan/" + uuid + "/to-board$", "i"));
        if (req.method === "POST" && toBoard) {
          const item = await strategy.getPlanItem(account.account_id, toBoard[1]);
          if (!item) return send(res, 404, { error: "Plan item not found" });
          if (item.status === "converted") return send(res, 409, { error: "Already converted", cardId: item.board_card_id });
          if (item.status === "rejected") return send(res, 409, { error: "Rejected items cannot be converted" });
          const settings = await strategy.getStrategySettings(account.account_id);
          const card = await mutateState(state => addCardFromPlanItem(state, item, settings));
          await strategy.updatePlanItem(account.account_id, item.item_id, { status: "converted", board_card_id: card.id });
          if (item.opportunity_id) await strategy.setOpportunityStatus(account.account_id, item.opportunity_id, "planned");
          await recordAudit({ accountId: account.account_id, actor: "owner", action: "plan_item_converted", subjectType: "plan_item", subjectId: item.item_id, detail: { cardId: card.id } });
          return send(res, 201, { card, note: "The card needs media and your approval before anything is scheduled." });
        }
        return send(res, 404, { error: "Not found" });
      }
      if (req.method === "GET" && pathname === "/api/activity") {
        return send(res, 200, { events: await recentAudit(account.account_id, url.searchParams.get("limit")) });
      }
      const cancelTarget = pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/cancel$/i);
      if (req.method === "POST" && cancelTarget) {
        const existing = await getTask(cancelTarget[1], account.account_id);
        if (!existing) return send(res, 404, { error: "Task not found" });
        const cancelled = await cancelTask(existing.task_id, account.account_id);
        if (!cancelled) return send(res, 409, { error: "This task has already finished", status: existing.status });
        await recordAudit({ accountId: account.account_id, actor: "owner", action: "task_cancelled", subjectType: "task", subjectId: existing.task_id });
        return send(res, 200, { task: cancelled });
      }
    }

    if (req.method === "GET" && pathname === "/api/instagram/test") {
      const apiVersion = process.env.IG_GRAPH_API_VERSION;
      const userId = process.env.IG_USER_ID;
      const token = process.env.IG_ACCESS_TOKEN;
      if (!apiVersion || !/^v\d+\.\d+$/.test(apiVersion) || !userId || !token) {
        return send(res, 503, { connected: false, error: "Instagram API credentials are not configured" });
      }
      try {
        // Unified Login SUAT credentials use the Facebook Graph host and
        // the Instagram professional account ID, not the Instagram Login /me route.
        const profileUrl = new URL("https://graph.facebook.com/" + apiVersion + "/" + encodeURIComponent(userId));
        profileUrl.searchParams.set("fields", "id,username");
        profileUrl.searchParams.set("access_token", token);
        const response = await fetch(profileUrl, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(10000)
        });
        const profile = await response.json().catch(() => ({}));
        if (!response.ok || profile.error) {
          const code = Number(profile.error?.code) || null;
          return send(res, 502, {
            connected: false,
            error: "Meta could not verify the Instagram account. Check token permissions and assigned account assets.",
            metaErrorCode: code,
            metaErrorMessage: clean(profile.error?.message, 300) || "Meta rejected the profile request"
          });
        }
        const verifiedUserId = String(profile.id || "");
        if (!verifiedUserId || verifiedUserId !== String(userId)) {
          return send(res, 502, { connected: false, error: "Meta returned a different Instagram account than the configured account." });
        }
        return send(res, 200, {
          connected: true,
          account: {
            id: verifiedUserId,
            username: clean(profile.username, 100),
            accountType: clean(profile.account_type, 40) || null,
            mediaCount: Number.isFinite(Number(profile.media_count)) ? Number(profile.media_count) : null
          },
          checkedAt: new Date().toISOString()
        });
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return send(res, timedOut ? 504 : 502, {
          connected: false,
          error: timedOut ? "Meta profile check timed out. Try again." : "Could not reach Meta to verify the Instagram account."
        });
      }
    }


    if (req.method === "GET" && pathname === "/api/providers") {
      return send(res, 200, providerSummary(await readState()));
    }

    if (req.method === "GET" && pathname === "/api/providers/text/models") {
      const provider = textProvider(await readState());
      if (!provider.keyPresent) return send(res, 503, { error: "Gemini API key is not configured on the server." });
      try {
        return send(res, 200, { models: await listGeminiTextModels({ apiKey: process.env.GEMINI_API_KEY }), current: provider.model });
      } catch (error) {
        return send(res, error?.status || 502, { error: clean(error?.message, 300) || "Could not list models." });
      }
    }

    if (req.method === "POST" && pathname === "/api/providers/text/model") {
      const input = await readBody(req);
      const model = normalizeModel(input.model);
      if (!isValidModelId(model)) return send(res, 400, { error: "Invalid model name." });
      if (!process.env.GEMINI_API_KEY) return send(res, 503, { error: "Gemini API key is not configured on the server." });
      let available;
      try { available = await listGeminiTextModels({ apiKey: process.env.GEMINI_API_KEY }); }
      catch (error) { return send(res, error?.status || 502, { error: clean(error?.message, 300) || "Could not verify the model." }); }
      if (!available.some(item => item.id === model)) return send(res, 400, { error: "That model is not available to your API key." });
      await mutateState(state => { state.settings.textModel = model; audit(state, "text_model_selected", { model }); });
      return send(res, 200, { ok: true, model });
    }

    if (req.method === "POST" && pathname === "/api/providers/text/test") {
      const provider = textProvider(await readState());
      if (!provider.enabled) return send(res, 403, { error: "Gemini text generation is disabled. Set GEMINI_TEXT_ENABLED=true on the server to enable it." });
      if (!provider.keyPresent) return send(res, 503, { error: "Gemini API key is not configured on the server." });
      const reservation = await mutateState(state => reserveText(state, provider.dailyLimit));
      if (!reservation.allowed) {
        return send(res, 429, reservation.reason === "rate_limited"
          ? { error: "Gemini's free-tier limit was reached recently. Creator OS is waiting before trying again.", blockedUntil: reservation.blockedUntil }
          : { error: "Daily text-generation limit reached.", dailyLimit: provider.dailyLimit, used: reservation.used });
      }
      try {
        const result = await generateGeminiText({ prompt: "Reply with one short sentence confirming the Creator OS text provider works.", apiKey: process.env.GEMINI_API_KEY, model: provider.model, temperature: 0, maxOutputTokens: 60 });
        await mutateState(state => { recordTextSuccess(state, result.usage); audit(state, "provider_text_test_succeeded", { model: result.model, ...result.usage }); });
        return send(res, 200, { ok: true, model: result.model, text: result.text.slice(0, 300), usage: result.usage });
      } catch (error) {
        const message = clean(error?.message, 300) || "Text generation failed.";
        await mutateState(state => { recordTextFailure(state, error); audit(state, "provider_text_test_failed", { model: provider.model, status: error?.status || 502 }); });
        return send(res, error?.status === 429 ? 429 : (error?.status || 502), { error: message });
      }
    }

    if (req.method === "POST" && pathname === "/api/agent/media/image") {
      if (process.env.GEMINI_IMAGE_GENERATION_ENABLED !== "true") return send(res, 403, { error: "Gemini image generation is disabled." });
      if (!process.env.GEMINI_API_KEY) return send(res, 503, { error: "Gemini API key is not configured on the server." });
      const input = await readBody(req);
      const prompt = clean(input.prompt, 2000);
      if (prompt.length < 20) return send(res, 400, { error: "Provide an image prompt between 20 and 2000 characters." });
      const model = clean(process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL, 100);
      const imageInfo = imageProvider({});
      if (imageInfo.costClass === "paid" && input.confirmPaid !== true) {
        return send(res, 400, {
          error: "This image model is treated as paid. Confirm the charge to continue.",
          requiresConfirmation: true, costClass: imageInfo.costClass, costNote: imageInfo.costNote,
          estimatedCostUsdPerImage: imageInfo.estimatedCostUsdPerImage, dailyLimit: imageInfo.dailyLimit
        });
      }
      const today = new Date().toISOString().slice(0, 10);
      const dailyLimit = Math.min(5, Math.max(1, Number.parseInt(process.env.MAX_IMAGE_GENERATIONS_PER_DAY || "2", 10) || 2));
      const reservation = await mutateState(state => {
        state.mediaUsage ||= {};
        const usage = state.mediaUsage[today] || { attempts: 0 };
        if (usage.attempts >= dailyLimit) return { allowed: false, used: usage.attempts };
        usage.attempts += 1; state.mediaUsage[today] = usage;
        for (const day of Object.keys(state.mediaUsage)) if (day < new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)) delete state.mediaUsage[day];
        audit(state, "agent_image_generation_started", { provider: "gemini", model, dailyCount: usage.attempts, paidConfirmed: imageInfo.costClass === "paid" });
        return { allowed: true, used: usage.attempts };
      });
      if (!reservation.allowed) return send(res, 429, { error: "Daily image-generation limit reached. Try again tomorrow.", dailyLimit, used: reservation.used });
      try {
        const generated = await generateGeminiImage({ prompt, apiKey: process.env.GEMINI_API_KEY, model });
        await mutateState(state => audit(state, "agent_image_generation_succeeded", { provider: "gemini", model: generated.model, sizeBytes: generated.sizeBytes }));
        return send(res, 200, { ok: true, provider: "gemini", model: generated.model, mimeType: generated.mimeType, base64: generated.base64, sizeBytes: generated.sizeBytes, dailyAttemptsUsed: reservation.used, dailyLimit, persistence: "temporary_preview_only", notice: "This preview is not stored in the media library. Download it before leaving this page." });
      } catch (error) {
        const message = clean(error?.message, 300) || "Image generation failed.";
        await mutateState(state => audit(state, "agent_image_generation_failed", { provider: "gemini", model, error: message }));
        return send(res, error?.status || 502, { error: message, dailyAttemptsUsed: reservation.used, dailyLimit });
      }
    }

    if (req.method === "POST" && pathname === "/api/agent/plans") {
      const input = await readBody(req);
      let plan;
      try { plan = buildContentPlan(input); }
      catch (error) { return send(res, 400, { error: clean(error.message, 300) }); }
      await mutateState(state => {
        state.agentPlans ||= [];
        state.agentPlans.unshift(plan);
        state.agentPlans = state.agentPlans.slice(0, 30);
        audit(state, "agent_plan_created", { planId: plan.id, itemCount: plan.items.length, source: plan.source });
      });
      return send(res, 201, { plan, notice: "Blueprint created. No content was generated or published." });
    }

    const planDecision = pathname.match(/^\/api\/agent\/plans\/([a-f0-9-]+)\/decision$/i);
    if (req.method === "POST" && planDecision) {
      const input = await readBody(req);
      if (!["approved", "rejected"].includes(input.decision)) return send(res, 400, { error: "Decision must be approved or rejected" });
      const outcome = await mutateState(state => {
        state.agentPlans ||= [];
        const plan = state.agentPlans.find(item => item.id === planDecision[1]);
        if (!plan) return { status: 404, body: { error: "Plan not found" } };
        if (plan.status !== "awaiting_approval") return { status: 409, body: { error: "This plan has already been reviewed", status: plan.status } };
        plan.status = input.decision;
        plan.reviewedAt = new Date().toISOString();
        audit(state, input.decision === "approved" ? "agent_plan_approved" : "agent_plan_rejected", { planId: plan.id });
        return { status: 200, body: { plan } };
      });
      return send(res, outcome.status, outcome.body);
    }

    if (req.method === "POST" && pathname === "/api/board/generate") {
      const input = await readBody(req);
      const config = scheduleConfig();
      let cards;
      try {
        cards = await mutateState(state => generateBoard(state, input, new Date(), config));
      } catch (error) {
        return send(res, 400, { error: clean(error.message, 300) });
      }
      return send(res, 201, { cards, notice: "Content cards created. Review prompts and captions, attach public media URLs, then approve each card to schedule it." });
    }

    const uploadAction = pathname.match(/^\/api\/board\/([a-f0-9-]{36})\/(presign|media)$/i);
    if (req.method === "POST" && uploadAction) {
      const [, cardId, step] = uploadAction;
      const config = storageConfig();
      if (!config.configured) return send(res, 503, { error: "Media storage is not configured on the server. Set the CLOUDINARY_* variables (see the README, Media storage)." });
      const input = await readBody(req);
      const limits = storageLimits();
      const card = ((await readState()).boardCards || []).find(item => item.id === cardId);
      if (!card) return send(res, 404, { error: "Content card not found" });
      if (card.status === "scheduled") return send(res, 409, { error: "Cancel the scheduled post before changing its media" });

      if (step === "presign") {
        const contentType = clean(input.contentType, 100).toLowerCase();
        const size = Number(input.size);
        const problem = validateUpload(card, contentType, size, limits);
        if (problem) return send(res, 400, { error: problem });
        const key = mediaKeyFor(card);
        const reservation = await mutateState(state => {
          const expired = expirePendingUploads(state);
          const result = reserveUpload(state, size, limits, new Date(), key, cardId, resourceFor(card.format));
          return { ...result, expired };
        });
        for (const item of reservation.expired || []) await deleteStoredObject(item.key, item.resource, config);
        if (!reservation.ok) return send(res, reservation.status, { error: reservation.error });
        return send(res, 200, { key, method: "POST", ...presignUpload(card.format, key, config) });
      }

      if (!keyBelongsToCard(card, input.key)) return send(res, 400, { error: "Invalid media key for this card" });
      const ext = normalizeFormat(card.format, input.format);
      if (!ext) return send(res, 400, { error: card.format === "reel" ? "Reels must be MP4 or MOV." : "Images must be JPEG." });
      const resource = resourceFor(card.format);
      const publicUrl = publicUrlFor(config, resource, input.key, ext);
      const verified = await verifyPublicMedia(publicUrl, card.format, ext, input.bytes, limits);
      if (!verified.ok) return send(res, 422, { error: verified.error });
      const outcome = await mutateState(state => {
        const target = (state.boardCards || []).find(item => item.id === cardId);
        if (!target || target.status === "scheduled") return { status: 409, body: { error: "Card is already scheduled" } };
        const reservation = consumeUploadReservation(state, input.key, cardId);
        if (!reservation) return { status: 409, body: { error: "This upload reservation is missing or expired. Please upload the file again." }, expired: true };
        if (verified.bytes > reservation.bytes) return { status: 409, body: { error: "The uploaded file is larger than the size reserved. Please upload it again." }, expired: true };
        const previous = target.mediaKey && target.mediaKey !== input.key ? { key: target.mediaKey, bytes: target.mediaBytes || 0, resource: target.mediaResource || resource } : null;
        if (target.mediaKey !== input.key) recordStored(state, verified.bytes);
        if (previous) recordRemoved(state, previous.bytes);
        Object.assign(target, { mediaUrl: publicUrl, mediaKey: input.key, mediaBytes: verified.bytes, mediaFormat: ext, mediaResource: resource, mediaSource: "upload", status: "ready" });
        audit(state, "content_card_media_uploaded", { cardId, format: card.format, bytes: verified.bytes });
        return { status: 200, body: { card: target }, previous };
      });
      if (outcome.previous) await deleteStoredObject(outcome.previous.key, outcome.previous.resource, config);
      if (outcome.expired) await deleteStoredObject(input.key, resource, config);
      return send(res, outcome.status, outcome.body);
    }

    const boardAction = pathname.match(/^\/api\/board\/([a-f0-9-]{36})\/(update|approve|discard)$/i);
    if (req.method === "POST" && boardAction) {
      const [, cardId, action] = boardAction;
      const config = scheduleConfig();
      const input = action === "update" ? await readBody(req) : {};
      const outcome = await mutateState(state => {
        const before = (state.boardCards || []).find(item => item.id === cardId);
        const stored = before?.mediaKey ? { key: before.mediaKey, bytes: before.mediaBytes || 0, resource: before.mediaResource || resourceFor(before.format) } : null;
        let result;
        if (action === "update") result = updateBoardCard(state, cardId, input);
        else if (action === "approve") result = approveBoardCard(state, cardId, new Date(), config);
        else result = discardBoardCard(state, cardId);
        // Free storage when the card no longer uses the file we stored for it.
        const stillUsed = (state.boardCards || []).some(item => item.mediaKey === stored?.key);
        if (stored && result.status === 200 && !stillUsed) { recordRemoved(state, stored.bytes); result.removed = stored; }
        return result;
      });
      if (outcome.removed) await deleteStoredObject(outcome.removed.key, outcome.removed.resource);
      return send(res, outcome.status, outcome.body);
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const state = await readState();
      return send(res, 200, {
        settings: state.settings, posts: state.posts, audit: state.audit.slice(0, 30), agentPlans: state.agentPlans || [], boardCards: state.boardCards || [],
        media: {
          geminiImageEnabled: process.env.GEMINI_IMAGE_GENERATION_ENABLED === "true",
          geminiImageConfigured: process.env.GEMINI_IMAGE_GENERATION_ENABLED === "true" && Boolean(process.env.GEMINI_API_KEY),
          imageModel: clean(process.env.GEMINI_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL, 100),
          costClass: imageProvider({}).costClass,
          estimatedCostUsdPerImage: imageProvider({}).estimatedCostUsdPerImage,
          dailyImageLimit: Math.min(5, Math.max(1, Number.parseInt(process.env.MAX_IMAGE_GENERATIONS_PER_DAY || "2", 10) || 2)),
          dailyImageAttempts: state.mediaUsage?.[new Date().toISOString().slice(0, 10)]?.attempts || 0
        },
        schedule: scheduleConfig(),
        storage: storageSummary(state),
        connection: {
          configured: Boolean(process.env.IG_ACCESS_TOKEN),
          metaConfigured: Boolean(process.env.IG_GRAPH_API_VERSION && process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN),
          autoPublishEnabled: process.env.ENABLE_AUTOPUBLISH === "true"
        }
      });
    }


    if (req.method === "POST" && pathname === "/api/posts/publish-now") {
      const input = await readBody(req);
      const caption = clean(input.caption, 2200);
      const mediaUrl = clean(input.mediaUrl, 2048);
      const type = input.type === "reel" ? "reel" : "image";
      if (input.confirm !== true) return send(res, 400, { error: "Explicit publish confirmation is required" });
      if (!caption || !safeUrl(mediaUrl)) return send(res, 400, { error: "A caption and publicly accessible HTTPS media URL are required" });
      if (!process.env.IG_GRAPH_API_VERSION || !process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) {
        return send(res, 503, { error: "Direct Instagram publishing is not configured" });
      }
      const now = new Date().toISOString();
      const post = { id: crypto.randomUUID(), type, caption, mediaUrl, scheduledAt: now, createdAt: now, status: "publishing", manual: true };
      const inserted = await mutateState(state => {
        if (state.settings.killSwitch) return false;
        state.posts.unshift(post);
        audit(state, "manual_publish_started", { postId: post.id, type, adapter: "meta" });
        return true;
      });
      if (!inserted) return send(res, 423, { error: "Emergency stop is ON. Turn it OFF before starting this manual test." });
      try {
        const externalId = await publishDirect(post);
        await mutateState(state => {
          const saved = state.posts.find(item => item.id === post.id);
          if (!saved) return;
          saved.status = "published";
          saved.instagramMediaId = externalId;
          saved.publishedAt = new Date().toISOString();
          audit(state, "manual_publish_succeeded", { postId: post.id, adapter: "meta" });
        });
        return send(res, 200, { ok: true, postId: post.id, status: "published", instagramMediaId: externalId });
      } catch (error) {
        const message = clean(error?.message, 300) || "Meta did not confirm the publishing result";
        await mutateState(state => {
          const saved = state.posts.find(item => item.id === post.id);
          if (!saved) return;
          saved.status = "delivery_unknown";
          saved.lastError = message;
          audit(state, "manual_publish_delivery_unknown", { postId: post.id, error: message });
        });
        return send(res, 502, {
          ok: false, postId: post.id, status: "delivery_unknown",
          error: "Creator OS could not confirm the publishing outcome. Check Instagram before retrying to avoid a duplicate. " + message
        });
      }
    }

    if (req.method === "POST" && pathname === "/api/posts") {
      const input = await readBody(req);
      const caption = clean(input.caption);
      const mediaUrl = clean(input.mediaUrl, 2048);
      const type = input.type === "reel" ? "reel" : "image";
      const when = new Date(input.scheduledAt || Date.now() + 60000);
      if (!caption || !safeUrl(mediaUrl) || Number.isNaN(+when) || +when < Date.now() - 60000) {
        return send(res, 400, { error: "Caption, public HTTPS media URL and a future schedule are required" });
      }
      const post = { id: crypto.randomUUID(), type, caption, mediaUrl, scheduledAt: when.toISOString(), status: "scheduled", createdAt: new Date().toISOString() };
      await mutateState(state => { state.posts.unshift(post); audit(state, "post_scheduled", { postId: post.id, type }); });
      return send(res, 201, { post });
    }

    if (req.method === "POST" && pathname === "/api/kill-switch") {
      const input = await readBody(req);
      const enabled = input.enabled !== false;
      await mutateState(state => {
        state.settings.killSwitch = enabled;
        audit(state, enabled ? "kill_switch_enabled" : "kill_switch_disabled");
      });
      return send(res, 200, { killSwitch: enabled });
    }

    const cancelMatch = pathname.match(/^\/api\/posts\/([a-f0-9-]+)\/cancel$/i);
    if (req.method === "POST" && cancelMatch) {
      const id = cancelMatch[1];
      const outcome = await mutateState(state => {
        const post = state.posts.find(p => p.id === id);
        if (!post) return { status: 404, body: { error: "Post not found" } };
        // "awaiting_confirmation" is a legacy status from the removed Zapier bridge; it stays cancellable so old items can be cleared.
        if (!["scheduled", "awaiting_confirmation"].includes(post.status)) return { status: 409, body: { error: "This post can no longer be cancelled safely" } };
        post.status = "cancelled"; releaseBoardCard(state, post); audit(state, "post_cancelled", { postId: id });
        return { status: 200, body: { post } };
      });
      return send(res, outcome.status, outcome.body);
    }

    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Creator OS request failed:", error);
    return send(res, 500, { error: "Internal server error" });
  }
}
