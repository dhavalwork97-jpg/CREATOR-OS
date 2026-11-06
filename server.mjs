import http from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const db = path.join(dataDir, "state.json");
const port = Number(process.env.PORT || 3000);
const apiVersion = process.env.IG_GRAPH_API_VERSION;
const igUserId = process.env.IG_USER_ID;
const token = process.env.IG_ACCESS_TOKEN;
const zapierWebhook = process.env.ZAPIER_PUBLISH_WEBHOOK_URL;
const callbackSecret = process.env.ZAPIER_CALLBACK_SECRET;
const publicUrl = (process.env.CREATOR_OS_PUBLIC_URL || "").replace(/\/$/, "");
const auto = process.env.ENABLE_AUTOPUBLISH === "true";
const poll = Math.max(10000, Number(process.env.AUTOPUBLISH_POLL_MS || 30000));
const cap = Math.max(1, Number(process.env.MAX_POSTS_PER_DAY || 3));
const gap = Math.max(30, Number(process.env.MIN_MINUTES_BETWEEN_POSTS || 180)) * 60000;

await mkdir(dataDir, { recursive: true });
if (!existsSync(db)) await writeFile(db, JSON.stringify({ settings: { killSwitch: false }, posts: [], audit: [] }, null, 2));
let state = JSON.parse(await readFile(db, "utf8"));
let busy = false;

const save = () => writeFile(db, JSON.stringify(state, null, 2));
const clean = (s, n = 2200) => typeof s === "string" ? s.trim().slice(0, n) : "";
const audit = (action, detail = {}) => {
  state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail });
  state.audit = state.audit.slice(0, 300);
};
const send = (res, code, value) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let raw = "";
  for await (const part of req) {
    raw += part;
    if (raw.length > 1e6) throw Error("Request too large");
  }
  return raw ? JSON.parse(raw) : {};
}
const metaReady = () => Boolean(apiVersion && /^v\d+\.\d+$/.test(apiVersion) && igUserId && token);
const zapierReady = () => Boolean(zapierWebhook && callbackSecret && publicUrl.startsWith("https://"));
const publisherReady = () => zapierReady() || metaReady();

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
async function graphPost(endpoint, values) {
  const response = await fetch("https://graph.facebook.com/" + apiVersion + "/" + endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...values, access_token: token })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw Error(data.error?.message || "Meta API request failed");
  return data;
}
async function publishDirect(post) {
  const mediaUrl = safeUrl(post.mediaUrl);
  if (!mediaUrl) throw Error("Media must use a public HTTPS URL");
  const reel = post.type === "reel";
  const container = await graphPost(igUserId + "/media", reel
    ? { media_type: "REELS", video_url: mediaUrl, caption: post.caption }
    : { image_url: mediaUrl, caption: post.caption });
  if (!container.id) throw Error("Meta did not return a media container ID");
  let status = "IN_PROGRESS";
  for (let i = 0; i < 18; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const response = await fetch("https://graph.facebook.com/" + apiVersion + "/" + container.id +
      "?fields=status_code&access_token=" + encodeURIComponent(token));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw Error(data.error?.message || "Could not check media processing");
    status = data.status_code;
    if (status === "FINISHED") break;
    if (status === "ERROR" || status === "EXPIRED") throw Error("Media processing: " + status);
  }
  if (status !== "FINISHED") throw Error("Media processing still pending");
  const result = await graphPost(igUserId + "/media_publish", { creation_id: container.id });
  if (!result.id) throw Error("Meta did not confirm publish");
  return result.id;
}
async function submitToZapier(post) {
  const response = await fetch(zapierWebhook, {
    method: "POST",
    headers: { "content-type": "application/json", "x-creator-os-event": "publish" },
    body: JSON.stringify({
      event: "creator_os.publish",
      postId: post.id,
      type: post.type,
      caption: post.caption,
      mediaUrl: post.mediaUrl,
      scheduledAt: post.scheduledAt,
      callbackUrl: publicUrl + "/api/publishing/callback"
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const error = new Error("Zapier rejected the webhook request (HTTP " + response.status + ")");
    error.definitive = true;
    throw error;
  }
  return true; // Catch Hook acceptance is NOT proof that Instagram published the post.
}

const today = () => new Date().toISOString().slice(0, 10);
const publishedToday = () => state.posts.filter(post => post.status === "published" && post.publishedAt?.startsWith(today())).length;
const lastPublished = () => Math.max(0, ...state.posts.filter(post => post.status === "published").map(post => Date.parse(post.publishedAt || 0)));

async function tick() {
  if (busy || state.settings.killSwitch || !auto || !publisherReady()) return;
  const post = state.posts
    .filter(item => item.status === "scheduled" && Date.parse(item.scheduledAt) <= Date.now())
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
  if (!post || publishedToday() >= cap || Date.now() - lastPublished() < gap) return;

  busy = true;
  post.status = "publishing";
  audit("publish_started", { postId: post.id, adapter: zapierReady() ? "zapier" : "meta" });
  await save();
  try {
    if (zapierReady()) {
      await submitToZapier(post);
      post.status = "awaiting_confirmation";
      post.submittedAt = new Date().toISOString();
      audit("zapier_webhook_accepted", { postId: post.id });
    } else {
      post.instagramMediaId = await publishDirect(post);
      post.status = "published";
      post.publishedAt = new Date().toISOString();
      audit("publish_succeeded", { postId: post.id, adapter: "meta" });
    }
  } catch (error) {
    post.lastError = clean(error.message, 500);
    if (error.definitive) {
      post.status = "scheduled";
      post.scheduledAt = new Date(Date.now() + 300000).toISOString();
      audit("publish_rejected_retry_scheduled", { postId: post.id, error: post.lastError });
    } else {
      post.status = "delivery_unknown";
      audit("publish_delivery_unknown", { postId: post.id, error: post.lastError });
    }
  } finally {
    await save();
    busy = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(path.join(root, "public/index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, {
        ok: true, publisherConfigured: publisherReady(), zapierConfigured: zapierReady(),
        metaConfigured: metaReady(), autoPublishEnabled: auto, killSwitch: state.settings.killSwitch
      });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return send(res, 200, {
        settings: state.settings, posts: state.posts, audit: state.audit.slice(0, 30),
        connection: {
          configured: publisherReady(), zapierConfigured: zapierReady(), metaConfigured: metaReady(),
          adapter: zapierReady() ? "zapier" : metaReady() ? "meta" : "none",
          autoPublishEnabled: auto, pollMs: poll
        }
      });
    }
    if (req.method === "GET" && url.pathname === "/api/skills") {
      const dirs = await readdir(path.join(root, "skills"), { withFileTypes: true });
      const skills = [];
      for (const dir of dirs.filter(item => item.isDirectory())) {
        try { skills.push({ id: dir.name, instructions: await readFile(path.join(root, "skills", dir.name, "SKILL.md"), "utf8") }); } catch {}
      }
      return send(res, 200, { skills });
    }
    if (req.method === "POST" && url.pathname === "/api/posts") {
      const input = await body(req);
      const caption = clean(input.caption);
      const mediaUrl = clean(input.mediaUrl, 2048);
      const type = input.type === "reel" ? "reel" : "image";
      const when = new Date(input.scheduledAt || Date.now() + 60000);
      if (!caption || !safeUrl(mediaUrl) || Number.isNaN(+when)) {
        return send(res, 400, { error: "Caption, public HTTPS media URL and valid schedule are required" });
      }
      const post = {
        id: crypto.randomUUID(), type, caption, mediaUrl,
        scheduledAt: when.toISOString(), status: "scheduled", createdAt: new Date().toISOString()
      };
      state.posts.unshift(post);
      audit("post_scheduled", { postId: post.id, type });
      await save();
      return send(res, 201, { post });
    }
    if (req.method === "POST" && url.pathname === "/api/publishing/callback") {
      if (!callbackSecret || !safeEqual(req.headers["x-creator-os-callback-secret"], callbackSecret)) {
        return send(res, 401, { error: "Invalid callback credentials" });
      }
      const input = await body(req);
      const post = state.posts.find(item => item.id === clean(input.postId, 100));
      if (!post) return send(res, 404, { error: "Post not found" });
      if (post.status === "published" || post.status === "failed") {
        return send(res, 200, { ok: true, duplicate: true, status: post.status });
      }
      if (post.status !== "awaiting_confirmation") {
        return send(res, 409, { error: "Post is not awaiting a Zapier confirmation", status: post.status });
      }
      if (input.status === "published" && clean(input.externalPostId, 200)) {
        post.status = "published";
        post.instagramMediaId = clean(input.externalPostId, 200);
        post.publishedAt = new Date().toISOString();
        delete post.lastError;
        audit("publish_succeeded", { postId: post.id, adapter: "zapier", externalPostId: post.instagramMediaId });
      } else if (input.status === "failed") {
        post.status = "failed";
        post.lastError = clean(input.error || "Zapier/Instagram reported a publishing failure", 500);
        audit("publish_failed", { postId: post.id, adapter: "zapier", error: post.lastError });
      } else {
        return send(res, 400, { error: "Callback status must be published or failed; published requires externalPostId" });
      }
      await save();
      return send(res, 200, { ok: true, postId: post.id, status: post.status });
    }
    if (req.method === "POST" && url.pathname === "/api/kill-switch") {
      const input = await body(req);
      state.settings.killSwitch = input.enabled !== false;
      audit(state.settings.killSwitch ? "kill_switch_enabled" : "kill_switch_disabled");
      await save();
      return send(res, 200, { killSwitch: state.settings.killSwitch });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/posts/") && url.pathname.endsWith("/cancel")) {
      const id = url.pathname.split("/")[3];
      const post = state.posts.find(item => item.id === id);
      if (!post) return send(res, 404, { error: "Post not found" });
      if (!["scheduled", "awaiting_confirmation"].includes(post.status)) {
        return send(res, 409, { error: "This post can no longer be cancelled safely" });
      }
      post.status = "cancelled";
      audit("post_cancelled", { postId: id });
      await save();
      return send(res, 200, { post });
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    return send(res, 500, { error: clean(error.message, 500) });
  }
});

server.listen(port, () => console.log("Creator OS running at http://localhost:" + port));
setInterval(tick, poll);
