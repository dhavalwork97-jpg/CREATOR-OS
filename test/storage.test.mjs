import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signParams, storageConfig, storageLimits, presignUpload, destroyRequest, normalizeFormat, publicUrlFor, resourceFor } from "../lib/storage/cloudinary.mjs";
import { validateUpload, mediaKeyFor, keyBelongsToCard, reserveUpload, recordStored, recordRemoved, verifyPublicMedia, deleteStoredObject, storageSummary } from "../lib/storage/media.mjs";

const config = { configured: true, cloudName: "democloud", apiKey: "123456789012345", apiSecret: "SECRET-VALUE-XYZ" };
const card = { id: "11111111-1111-1111-1111-111111111111", format: "image" };
const reel = { id: "22222222-2222-2222-2222-222222222222", format: "reel" };
const limits = { imageMaxBytes: 8 * 1048576, videoMaxBytes: 100 * 1048576, totalMaxBytes: 50 * 1048576, uploadsPerDay: 2 };
const head = (status, headers) => async () => new Response(null, { status, headers });
const sha1 = text => crypto.createHash("sha1").update(text).digest("hex");

test("signature reproduces the example from Cloudinary's documentation", () => {
  assert.equal(
    signParams({ eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: "1315060510" }, "abcd"),
    "bfd09f95f331f558cbd1320e67aa8d488770583e"
  );
});

test("signature sorts parameters, appends the secret and skips unsigned or empty values", () => {
  const sig = signParams({ timestamp: "5", public_id: "a/b", file: "x", api_key: "k", cloud_name: "c", resource_type: "image", signature: "old", empty: "" }, "S");
  assert.equal(sig, sha1("public_id=a/b&timestamp=5S"));
});

test("storage needs cloud name, API key and secret", () => {
  const env = { CLOUDINARY_CLOUD_NAME: "democloud", CLOUDINARY_API_KEY: "123456789012345", CLOUDINARY_API_SECRET: "a-long-secret-value" };
  assert.equal(storageConfig(env).configured, true);
  assert.equal(storageConfig({ ...env, CLOUDINARY_API_SECRET: "" }).configured, false);
  assert.equal(storageConfig({ ...env, CLOUDINARY_CLOUD_NAME: "bad name!" }).configured, false);
  assert.equal(storageConfig({}).configured, false);
  const defaults = storageLimits({});
  assert.equal(defaults.videoMaxBytes, 100 * 1048576, "matches the free plan's 100 MB video limit");
  assert.ok(storageLimits({ STORAGE_MAX_VIDEO_MB: "500" }).videoMaxBytes <= 100 * 1048576, "cannot be raised past the free plan limit");
});

test("signed upload restricts file types and never exposes the secret", () => {
  const now = new Date("2026-11-08T00:00:00Z");
  const image = presignUpload("image", "board/x/y", config, now);
  const video = presignUpload("reel", "board/x/z", config, now);
  assert.equal(image.uploadUrl, "https://api.cloudinary.com/v1_1/democloud/image/upload");
  assert.equal(video.uploadUrl, "https://api.cloudinary.com/v1_1/democloud/video/upload");
  assert.equal(image.fields.allowed_formats, "jpg");
  assert.equal(video.fields.allowed_formats, "mp4,mov");
  assert.equal(image.fields.timestamp, String(Math.floor(now.getTime() / 1000)));
  assert.equal(image.fields.signature, sha1("allowed_formats=jpg&public_id=board/x/y&timestamp=" + image.fields.timestamp + config.apiSecret));
  assert.equal(JSON.stringify([image, video]).includes(config.apiSecret), false);
  assert.throws(() => presignUpload("image", "k", { configured: false }), /not configured/);
});

test("delete request is signed and targets the right resource type", () => {
  const request = destroyRequest("video", "board/x/z", config, new Date("2026-11-08T00:00:00Z"));
  assert.equal(request.url, "https://api.cloudinary.com/v1_1/democloud/video/destroy");
  const body = Object.fromEntries(request.body);
  assert.equal(body.public_id, "board/x/z");
  assert.equal(body.signature, sha1("invalidate=true&public_id=board/x/z&timestamp=" + body.timestamp + config.apiSecret));
  assert.equal(request.body.toString().includes(config.apiSecret), false);
});

test("formats and URLs", () => {
  assert.equal(normalizeFormat("image", "jpg"), "jpg");
  assert.equal(normalizeFormat("image", "JPEG"), "jpg");
  assert.equal(normalizeFormat("image", "png"), null);
  assert.equal(normalizeFormat("reel", "mp4"), "mp4");
  assert.equal(normalizeFormat("reel", "mov"), "mov");
  assert.equal(normalizeFormat("reel", "webm"), null);
  assert.equal(resourceFor("reel"), "video");
  assert.equal(publicUrlFor(config, "image", "board/a/b", "jpg"), "https://res.cloudinary.com/democloud/image/upload/board/a/b.jpg");
});

test("images must be JPEG and reels MP4/MOV, within size limits", () => {
  assert.equal(validateUpload(card, "image/jpeg", 1000, limits), null);
  assert.match(validateUpload(card, "image/png", 1000, limits), /JPEG/);
  assert.match(validateUpload(card, "image/jpeg", 9 * 1048576, limits), /larger/);
  assert.equal(validateUpload(reel, "video/mp4", 50 * 1048576, limits), null);
  assert.equal(validateUpload(reel, "video/quicktime", 1000, limits), null);
  assert.match(validateUpload(reel, "video/webm", 1000, limits), /MP4 or MOV/);
  assert.match(validateUpload(card, "image/jpeg", 0, limits), /empty/);
});

test("keys are bound to their card and unguessable", () => {
  const key = mediaKeyFor(card);
  assert.match(key, new RegExp("^board/" + card.id + "/[a-f0-9-]{36}$"));
  assert.ok(keyBelongsToCard(card, key));
  assert.ok(!keyBelongsToCard(reel, key));
  assert.ok(!keyBelongsToCard(card, "board/" + card.id + "/../../secret"));
  assert.notEqual(mediaKeyFor(card), mediaKeyFor(card));
});

test("spend protection: daily upload cap and total storage cap, with space freed on removal", () => {
  const state = {};
  const now = new Date("2026-11-08T10:00:00Z");
  assert.equal(reserveUpload(state, 10 * 1048576, limits, now).ok, true);
  recordStored(state, 40 * 1048576);
  const full = reserveUpload(state, 20 * 1048576, limits, now);
  assert.equal(full.ok, false); assert.equal(full.status, 409);
  recordRemoved(state, 40 * 1048576);
  assert.equal(reserveUpload(state, 20 * 1048576, limits, now).ok, true);
  assert.equal(reserveUpload(state, 1, limits, now).status, 429);
  assert.equal(reserveUpload(state, 1, limits, new Date("2026-11-09T10:00:00Z")).ok, true, "a new day resets the upload count");
});

test("verifies reachability, content type and size (header first, browser-reported size as fallback)", async () => {
  const url = "https://res.cloudinary.com/democloud/image/upload/board/a/b.jpg";
  assert.deepEqual(await verifyPublicMedia(url, "image", "jpg", 999, limits, head(200, { "content-type": "image/jpeg", "content-length": "1234" })), { ok: true, bytes: 1234 });
  assert.deepEqual(await verifyPublicMedia(url, "image", "jpg", 777, limits, head(200, { "content-type": "image/jpeg" })), { ok: true, bytes: 777 });
  assert.match((await verifyPublicMedia(url, "image", "jpg", 5, limits, head(404, {}))).error, /not publicly reachable/);
  assert.match((await verifyPublicMedia(url, "image", "jpg", 5, limits, head(200, { "content-type": "image/png", "content-length": "5" }))).error, /unexpected type/);
  assert.match((await verifyPublicMedia(url, "image", "jpg", 0, limits, head(200, { "content-type": "image/jpeg" }))).error, /confirm the size/);
  assert.match((await verifyPublicMedia(url, "image", "jpg", 5, limits, head(200, { "content-type": "image/jpeg", "content-length": String(20 * 1048576) }))).error, /exceeds/);
  assert.match((await verifyPublicMedia(url, "image", "jpg", 5, limits, async () => { throw new Error("net"); })).error, /Could not reach/);
  assert.deepEqual(await verifyPublicMedia("https://x/v.mov", "reel", "mov", 10, limits, head(200, { "content-type": "video/quicktime", "content-length": "10" })), { ok: true, bytes: 10 });
});

test("deleting is best-effort, never throws and only touches keys we created", async () => {
  const key = "board/" + card.id + "/33333333-3333-3333-3333-333333333333";
  let seen;
  assert.equal(await deleteStoredObject(key, "image", config, async (url, init) => { seen = { url, init }; return Response.json({ result: "ok" }); }), true);
  assert.equal(seen.init.method, "POST");
  assert.match(seen.url, /\/image\/destroy$/);
  assert.equal(await deleteStoredObject(key, "image", config, async () => { throw new Error("down"); }), false);
  assert.equal(await deleteStoredObject("other/file", "image", config, async () => { throw new Error("must not call"); }), false);
  assert.equal(await deleteStoredObject(key, "raw", config, async () => { throw new Error("must not call"); }), false);
  assert.equal(await deleteStoredObject(key, "image", { configured: false }, async () => { throw new Error("must not call"); }), false);
});

test("summary exposes usage but never credentials", () => {
  const env = { CLOUDINARY_CLOUD_NAME: "democloud", CLOUDINARY_API_KEY: "123456789012345", CLOUDINARY_API_SECRET: "SECRET-456-LONG" };
  const summary = storageSummary({ storageUsage: { totalBytes: 5, objects: 1, uploads: { "2026-11-08": 3 } } }, env, new Date("2026-11-08T00:00:00Z"));
  assert.equal(summary.configured, true); assert.equal(summary.uploadsToday, 3); assert.equal(summary.provider, "Cloudinary");
  assert.equal(/SECRET-456|123456789012345/.test(JSON.stringify(summary)), false);
});
