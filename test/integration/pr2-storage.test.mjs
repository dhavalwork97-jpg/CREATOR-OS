import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startApp } from "../helpers/harness.mjs";

const CLOUD = "democloud", API_KEY = "123456789012345", API_SECRET = "TOP-SECRET-API-VALUE";
const uploaded = new Map();   // public URL -> { type, bytes, header }
const deleted = [];           // { resource, publicId }

const app = await startApp({
  env: { CLOUDINARY_CLOUD_NAME: CLOUD, CLOUDINARY_API_KEY: API_KEY, CLOUDINARY_API_SECRET: API_SECRET, STORAGE_MAX_UPLOADS_PER_DAY: "6", STORAGE_MAX_TOTAL_MB: "100" },
  routes: [
    { match: url => url.startsWith("https://res.cloudinary.com/" + CLOUD + "/"), respond: url => {
        const file = uploaded.get(url);
        if (!file) return new Response(null, { status: 404 });
        const headers = { "content-type": file.type };
        if (file.header !== false) headers["content-length"] = String(file.bytes);
        return new Response(null, { status: 200, headers });
      } },
    { match: url => url.startsWith("https://api.cloudinary.com/v1_1/" + CLOUD + "/") && url.endsWith("/destroy"), respond: (url, init) => {
        const body = Object.fromEntries(init.body);
        // The server must sign every destroy request with the secret.
        const expected = crypto.createHash("sha1").update("invalidate=true&public_id=" + body.public_id + "&timestamp=" + body.timestamp + API_SECRET).digest("hex");
        if (body.signature !== expected) return new Response("{}", { status: 401 });
        deleted.push({ resource: url.split("/").at(-2), publicId: body.public_id });
        for (const key of [...uploaded.keys()]) if (key.includes("/" + body.public_id + ".")) uploaded.delete(key);
        return Response.json({ result: "ok" });
      } }
  ]
});
test.after(() => app.close());
const bodies = [];
const call = async (...args) => { const r = await app.call(...args); bodies.push(JSON.stringify(r.body)); return r; };
const brief = { niche: "coastal travel", audience: "quiet travel fans", objective: "grow", pillars: ["escapes"], postsPerWeek: 3 };
let cards;

// Simulates the browser's successful upload to Cloudinary using the signed fields the server returned.
function browserUpload(pre, resource, ext, type, bytes, header) {
  assert.equal(pre.fields.api_key, API_KEY);
  const expected = crypto.createHash("sha1").update("allowed_formats=" + pre.fields.allowed_formats + "&public_id=" + pre.key + "&timestamp=" + pre.fields.timestamp + API_SECRET).digest("hex");
  assert.equal(pre.fields.signature, expected, "the signature Cloudinary will verify is valid");
  uploaded.set("https://res.cloudinary.com/" + CLOUD + "/" + resource + "/upload/" + pre.key + "." + ext, { type, bytes, header });
  return { format: ext, bytes };
}

test("board prompts use Instagram-valid aspect ratios", async () => {
  cards = (await call("/api/board/generate", brief)).body.cards;
  assert.match(cards.find(c => c.format === "image").prompt, /4:5/);
  assert.doesNotMatch(cards.find(c => c.format === "image").prompt, /9:16/);
  assert.match(cards.find(c => c.format === "reel").prompt, /9:16/);
});

test("state reports Cloudinary usage and limits without credentials", async () => {
  const { body } = await call("/api/state");
  assert.equal(body.storage.configured, true);
  assert.equal(body.storage.provider, "Cloudinary");
  assert.equal(body.storage.maxBytes, 100 * 1048576);
});

test("presign rejects wrong types, oversize files and unknown cards", async () => {
  const image = cards.find(c => c.format === "image");
  assert.equal((await call("/api/board/" + image.id + "/presign", { contentType: "image/png", size: 1000 })).status, 400);
  assert.equal((await call("/api/board/" + image.id + "/presign", { contentType: "image/jpeg", size: 50 * 1048576 })).status, 400);
  assert.equal((await call("/api/board/99999999-9999-9999-9999-999999999999/presign", { contentType: "image/jpeg", size: 10 })).status, 404);
});

test("image: presign -> upload -> attach makes the card ready and approvable", async () => {
  const image = cards.find(c => c.format === "image");
  const pre = (await call("/api/board/" + image.id + "/presign", { contentType: "image/jpeg", size: 500000 })).body;
  assert.equal(pre.uploadUrl, "https://api.cloudinary.com/v1_1/" + CLOUD + "/image/upload");
  assert.equal(pre.fields.allowed_formats, "jpg");
  assert.equal((await call("/api/board/" + image.id + "/media", { key: pre.key, format: "jpg", bytes: 500000 })).status, 422, "not uploaded yet");
  const result = browserUpload(pre, "image", "jpg", "image/jpeg", 500000);
  assert.equal((await call("/api/board/" + image.id + "/media", { key: "board/" + image.id + "/not-a-valid-key", format: "jpg" })).status, 400);
  assert.equal((await call("/api/board/" + image.id + "/media", { key: pre.key, format: "png", bytes: 5 })).status, 400, "format must match the card");
  const attached = await call("/api/board/" + image.id + "/media", { key: pre.key, ...result });
  assert.equal(attached.status, 200);
  assert.equal(attached.body.card.status, "ready");
  assert.equal(attached.body.card.mediaUrl, "https://res.cloudinary.com/" + CLOUD + "/image/upload/" + pre.key + ".jpg");
  assert.equal((await call("/api/state")).body.storage.usedBytes, 500000);
  const approved = await call("/api/board/" + image.id + "/approve", {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.post.mediaUrl, attached.body.card.mediaUrl);
});

test("a stored file with the wrong content type is refused", async () => {
  const reel = cards.find(c => c.format === "reel");
  const pre = (await call("/api/board/" + reel.id + "/presign", { contentType: "video/mp4", size: 3000000 })).body;
  assert.equal(pre.fields.allowed_formats, "mp4,mov");
  assert.equal(pre.uploadUrl, "https://api.cloudinary.com/v1_1/" + CLOUD + "/video/upload");
  browserUpload(pre, "video", "mp4", "image/jpeg", 3000000);
  const result = await call("/api/board/" + reel.id + "/media", { key: pre.key, format: "mp4", bytes: 3000000 });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /unexpected type/);
});

test("size falls back to the browser-reported value when the CDN sends no Content-Length", async () => {
  const reel = cards.filter(c => c.format === "reel")[1];
  const pre = (await call("/api/board/" + reel.id + "/presign", { contentType: "video/mp4", size: 2000000 })).body;
  browserUpload(pre, "video", "mp4", "video/mp4", 2000000, false);
  assert.equal((await call("/api/board/" + reel.id + "/media", { key: pre.key, format: "mp4" })).status, 422, "no size anywhere: refused");
  const ok = await call("/api/board/" + reel.id + "/media", { key: pre.key, format: "mp4", bytes: 2000000 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.card.mediaBytes, 2000000);
  await call("/api/board/" + reel.id + "/discard", {}); // keep later totals simple
});

test("replacing an uploaded file deletes the old one and keeps usage accurate", async () => {
  const reel = cards.filter(c => c.format === "reel")[0];
  const first = (await call("/api/board/" + reel.id + "/presign", { contentType: "video/mp4", size: 4000000 })).body;
  const r1 = browserUpload(first, "video", "mp4", "video/mp4", 4000000);
  assert.equal((await call("/api/board/" + reel.id + "/media", { key: first.key, ...r1 })).status, 200);
  const second = (await call("/api/board/" + reel.id + "/presign", { contentType: "video/quicktime", size: 6000000 })).body;
  const movedFile = browserUpload(second, "video", "mov", "video/quicktime", 6000000);
  const attached = await call("/api/board/" + reel.id + "/media", { key: second.key, ...movedFile });
  assert.equal(attached.status, 200);
  assert.ok(attached.body.card.mediaUrl.endsWith(".mov"));
  assert.ok(deleted.some(d => d.publicId === first.key && d.resource === "video"), "old file removed from Cloudinary");
  assert.equal((await call("/api/state")).body.storage.usedBytes, 500000 + 6000000);
});

test("pasting a URL still works and frees the uploaded file", async () => {
  const reel = cards.filter(c => c.format === "reel")[0];
  const before = deleted.length;
  const saved = await call("/api/board/" + reel.id + "/update", { mediaUrl: "https://elsewhere.example.com/clip.mp4" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.card.mediaSource, "url");
  assert.equal(saved.body.card.mediaKey, undefined);
  assert.equal(deleted.length, before + 1);
  assert.equal((await call("/api/state")).body.storage.usedBytes, 500000);
});

test("saving a card without changing its uploaded media keeps the file", async () => {
  const image = cards.find(c => c.format === "image");
  const card = (await call("/api/state")).body.boardCards.find(c => c.id === image.id);
  await call("/api/posts/" + card.postId + "/cancel", {});
  const before = deleted.length;
  const saved = await call("/api/board/" + image.id + "/update", { caption: "New caption #travel", mediaUrl: card.mediaUrl });
  assert.equal(saved.status, 200);
  assert.equal(deleted.length, before, "unchanged media is not deleted");
  assert.ok(saved.body.card.mediaKey);
});

test("discarding a card removes its stored file and frees the space", async () => {
  const image = cards.find(c => c.format === "image");
  const before = deleted.length;
  assert.equal((await call("/api/board/" + image.id + "/discard", {})).status, 200);
  assert.equal(deleted.length, before + 1);
  assert.equal(deleted.at(-1).resource, "image");
  assert.equal((await call("/api/state")).body.storage.usedBytes, 0);
});

test("presigned uploads reserve storage and an unreserved key cannot be attached", async () => {
  const image = cards.find(c => c.format === "image");
  const presigned = (await call("/api/board/" + image.id + "/presign", { contentType: "image/jpeg", size: 1000000 })).body;
  assert.equal((await call("/api/state")).body.storage.reservedBytes, 1000000);
  const otherKey = "board/" + image.id + "/66666666-6666-6666-6666-666666666666";
  const rejected = await call("/api/board/" + image.id + "/media", { key: otherKey, format: "jpg", bytes: 1000000 });
  assert.equal(rejected.status, 409);
  assert.equal((await call("/api/state")).body.storage.reservedBytes, 1000000);
  const uploaded = browserUpload(presigned, "image", "jpg", "image/jpeg", 1000000);
  assert.equal((await call("/api/board/" + image.id + "/media", { key: presigned.key, ...uploaded })).status, 200);
  const state = (await call("/api/state")).body.storage;
  assert.equal(state.reservedBytes, 0);
  assert.equal(state.usedBytes, 1500000);
});

test("daily upload cap blocks further presigns", async () => {
  const reel = cards.find(c => c.format === "reel");
  const results = [];
  for (let i = 0; i < 8; i++) results.push((await call("/api/board/" + reel.id + "/presign", { contentType: "video/mp4", size: 1000 })).status);
  assert.ok(results.includes(429), "a 429 appears once the daily cap is hit: " + results.join(","));
});

test("clear error when storage is not configured, and the API secret never leaks", async () => {
  assert.ok(bodies.length > 10);
  assert.equal(bodies.some(b => b.includes(API_SECRET)), false);
  // The API key is a public identifier that Cloudinary expects in every browser upload; it may appear only inside presign "fields".
  const withoutFields = bodies.map(b => b.replace(/"fields":\{[^}]*\}/g, '"fields":"[signed]"'));
  assert.equal(withoutFields.some(b => b.includes(API_KEY)), false);
  const saved = process.env.CLOUDINARY_API_SECRET;
  delete process.env.CLOUDINARY_API_SECRET;
  const reel = cards.find(c => c.format === "reel");
  const r = await call("/api/board/" + reel.id + "/presign", { contentType: "video/mp4", size: 1000 });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not configured/);
  process.env.CLOUDINARY_API_SECRET = saved;
});
