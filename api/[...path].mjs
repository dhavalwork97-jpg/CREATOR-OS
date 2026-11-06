import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSchema, readState, mutateState } from "../lib/db.mjs";

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
  let raw = "";
  if (req.method !== "GET" && req.method !== "HEAD") raw = await readBody(req).then(JSON.stringify);
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
  return process.env.ENABLE_AUTOPUBLISH === "true" &&
    Boolean(process.env.ZAPIER_PUBLISH_WEBHOOK_URL && process.env.ZAPIER_CALLBACK_SECRET &&
    (process.env.CREATOR_OS_PUBLIC_URL || "").startsWith("https://"));
}
async function submitToZapier(post) {
  const base = process.env.CREATOR_OS_PUBLIC_URL.replace(/\/$/, "");
  const response = await fetch(process.env.ZAPIER_PUBLISH_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-creator-os-event": "publish" },
    body: JSON.stringify({
      event: "creator_os.publish", postId: post.id, type: post.type,
      caption: post.caption, mediaUrl: post.mediaUrl, scheduledAt: post.scheduledAt,
      callbackUrl: base + "/api/publishing/callback"
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const error = new Error("Zapier rejected the webhook request (HTTP " + response.status + ")");
    error.definitive = true;
    throw error;
  }
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
  const container = await graphPost(userId + "/media", reel
    ? { media_type: "REELS", video_url: media, caption: post.caption }
    : { image_url: media, caption: post.caption });
  if (!container.id) throw new Error("Meta did not return a media container ID");
  let status = "IN_PROGRESS";
  for (let i = 0; i < 18; i++) {
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
    const today = new Date().toISOString().slice(0, 10);
    const published = state.posts.filter(p => p.status === "published" && p.publishedAt?.startsWith(today)).length;
    const last = Math.max(0, ...state.posts.filter(p => p.status === "published").map(p => Date.parse(p.publishedAt || 0)));
    if (published >= cap || now - last < gap) return null;
    const post = state.posts.filter(p => p.status === "scheduled" && Date.parse(p.scheduledAt) <= now)
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
    if (!post) return null;
    post.status = "publishing";
    post.claimedAt = new Date(now).toISOString();
    audit(state, "publish_started", { postId: post.id, adapter: process.env.ZAPIER_PUBLISH_WEBHOOK_URL ? "zapier" : "meta" });
    return structuredClone(post);
  });
  if (!claimed) return { processed: false };
  try {
    if (process.env.ZAPIER_PUBLISH_WEBHOOK_URL && process.env.ZAPIER_CALLBACK_SECRET) {
      await submitToZapier(claimed);
      await mutateState(state => {
        const post = state.posts.find(p => p.id === claimed.id);
        if (!post || post.status !== "publishing") return;
        post.status = "awaiting_confirmation";
        post.submittedAt = new Date().toISOString();
        delete post.claimedAt;
        audit(state, "zapier_webhook_accepted", { postId: post.id });
      });
    } else {
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
    }
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

    if (req.method === "GET" && pathname === "/api/publishing/callback") {
      return send(res, 405, { error: "Method not allowed" });
    }

    if (req.method === "POST" && pathname === "/api/publishing/callback") {
      if (!safeEqual(req.headers["x-creator-os-callback-secret"], process.env.ZAPIER_CALLBACK_SECRET)) {
        return send(res, 401, { error: "Invalid callback credentials" });
      }
      const input = await readBody(req);
      const outcome = await mutateState(state => {
        const post = state.posts.find(p => p.id === clean(input.postId, 100));
        if (!post) return { status: 404, body: { error: "Post not found" } };
        if (["published", "failed"].includes(post.status)) return { status: 200, body: { ok: true, duplicate: true, status: post.status } };
        if (post.status !== "awaiting_confirmation") return { status: 409, body: { error: "Post is not awaiting confirmation", status: post.status } };
        if (input.status === "published" && clean(input.externalPostId, 200)) {
          post.status = "published"; post.instagramMediaId = clean(input.externalPostId, 200);
          post.publishedAt = new Date().toISOString(); delete post.lastError;
          audit(state, "publish_succeeded", { postId: post.id, adapter: "zapier" });
        } else if (input.status === "failed") {
          post.status = "failed"; post.lastError = clean(input.error || "Instagram publishing failed", 500);
          audit(state, "publish_failed", { postId: post.id, error: post.lastError });
        } else return { status: 400, body: { error: "Invalid callback outcome" } };
        return { status: 200, body: { ok: true, postId: post.id, status: post.status } };
      });
      return send(res, outcome.status, outcome.body);
    }

    if (req.method === "GET" && pathname === "/api/worker/run") {
      const secret = process.env.CRON_SECRET;
      if (!secret || !safeEqual(req.headers.authorization?.replace(/^Bearer\s+/i, ""), secret)) {
        return send(res, 401, { error: "Unauthorized worker request" });
      }
      return send(res, 200, await processDuePost());
    }

    const session = await ownerSession(req);
    if (!session) return send(res, 401, { error: "Sign in with the configured owner account" });

    if (req.method === "GET" && pathname === "/api/state") {
      const state = await readState();
      return send(res, 200, {
        settings: state.settings, posts: state.posts, audit: state.audit.slice(0, 30),
        connection: {
          configured: Boolean(process.env.ZAPIER_PUBLISH_WEBHOOK_URL || process.env.IG_ACCESS_TOKEN),
          zapierConfigured: Boolean(process.env.ZAPIER_PUBLISH_WEBHOOK_URL && process.env.ZAPIER_CALLBACK_SECRET),
          metaConfigured: Boolean(process.env.IG_GRAPH_API_VERSION && process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN),
          autoPublishEnabled: process.env.ENABLE_AUTOPUBLISH === "true"
        }
      });
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
        if (!["scheduled", "awaiting_confirmation"].includes(post.status)) return { status: 409, body: { error: "This post can no longer be cancelled safely" } };
        post.status = "cancelled"; audit(state, "post_cancelled", { postId: id });
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
