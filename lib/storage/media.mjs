import crypto from "node:crypto";
import { dayKey } from "../util.mjs";
import { destroyRequest, resourceFor, storageConfig, storageLimits } from "./cloudinary.mjs";

// Upload rules, usage ledger and verification for media stored in the owner's Cloudinary account.
const RULES = {
  image: { types: ["image/jpeg"], limit: "imageMaxBytes" },
  reel: { types: ["video/mp4", "video/quicktime"], limit: "videoMaxBytes" }
};
const CONTENT_TYPE_FOR = { jpg: "image/jpeg", mp4: "video/mp4", mov: "video/quicktime" };
const mbText = bytes => Math.round(bytes / 1048576) + " MB";

export function validateUpload(card, contentType, size, limits = storageLimits()) {
  const rule = RULES[card.format];
  if (!rule) return "Unsupported format.";
  if (!rule.types.includes(contentType)) return card.format === "reel" ? "Reels must be an MP4 or MOV video." : "Images must be JPEG (the dashboard converts PNG and WebP for you).";
  if (!Number.isFinite(size) || size <= 0) return "The file is empty.";
  if (size > limits[rule.limit]) return "File is larger than the " + mbText(limits[rule.limit]) + " limit for " + (card.format === "reel" ? "Reels" : "images") + ".";
  return null;
}

// The storage "key" is the Cloudinary public_id: one folder per card plus a random, unguessable name.
export const mediaKeyFor = card => "board/" + card.id + "/" + crypto.randomUUID();
export const keyBelongsToCard = (card, key) => typeof key === "string" && new RegExp("^board/" + card.id + "/[a-f0-9-]{36}$").test(key);

const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;

export function expirePendingUploads(state, now = new Date()) {
  state.storageUsage ||= { totalBytes: 0, objects: 0, uploads: {} };
  const pending = state.storageUsage.pending ||= {};
  const expired = [];
  for (const [key, item] of Object.entries(pending)) {
    if (!item || !Number.isFinite(Date.parse(item.createdAt)) || now.getTime() - Date.parse(item.createdAt) >= PENDING_UPLOAD_TTL_MS) {
      expired.push({ key, resource: item?.resource || "image" });
      delete pending[key];
    }
  }
  return expired;
}

// Pending reservations count against the cap before a browser can upload to Cloudinary.
export function reserveUpload(state, size, limits = storageLimits(), now = new Date(), key = null, cardId = null, resource = "image") {
  state.storageUsage ||= { totalBytes: 0, objects: 0, uploads: {} };
  const usage = state.storageUsage;
  const day = dayKey(now);
  if ((usage.uploads[day] || 0) >= limits.uploadsPerDay) return { ok: false, status: 429, error: "Daily upload limit reached (" + limits.uploadsPerDay + "). It resets tomorrow." };
  const pendingBytes = Object.values(usage.pending || {}).reduce((sum, item) => sum + (Number(item?.bytes) || 0), 0);
  if (usage.totalBytes + pendingBytes + size > limits.totalMaxBytes) return { ok: false, status: 409, error: "Storage limit reached (" + mbText(limits.totalMaxBytes) + "). Discard unused cards or wait for pending uploads to expire." };
  usage.uploads[day] = (usage.uploads[day] || 0) + 1;
  if (key) {
    usage.pending ||= {};
    usage.pending[key] = { bytes: size, cardId, resource, createdAt: now.toISOString() };
  }
  for (const oldDay of Object.keys(usage.uploads)) if (oldDay < dayKey(new Date(now.getTime() - 14 * 86400000))) delete usage.uploads[oldDay];
  return { ok: true };
}

export function consumeUploadReservation(state, key, cardId) {
  const pending = state.storageUsage?.pending;
  const item = pending?.[key];
  if (!item || item.cardId !== cardId) return false;
  delete pending[key];
  return item;
}
export function recordStored(state, bytes) {
  state.storageUsage ||= { totalBytes: 0, objects: 0, uploads: {} };
  state.storageUsage.totalBytes += bytes; state.storageUsage.objects += 1;
}
export function recordRemoved(state, bytes) {
  state.storageUsage ||= { totalBytes: 0, objects: 0, uploads: {} };
  state.storageUsage.totalBytes = Math.max(0, state.storageUsage.totalBytes - (bytes || 0));
  state.storageUsage.objects = Math.max(0, state.storageUsage.objects - 1);
}

// Confirms the file is publicly reachable (Instagram must fetch it) and is what we expect.
// Size comes from the Content-Length header when present, otherwise from the size the browser reported (bounded by the limit).
export async function verifyPublicMedia(url, cardFormat, ext, declaredBytes, limits = storageLimits(), fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(8000) }); }
  catch { return { ok: false, error: "Could not reach the uploaded file. Try uploading again." }; }
  if (!response.ok) return { ok: false, error: "The uploaded file is not publicly reachable yet (HTTP " + response.status + "). Try again in a moment." };
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== CONTENT_TYPE_FOR[ext] || !RULES[cardFormat].types.includes(type)) return { ok: false, error: "The stored file has an unexpected type (" + (type || "unknown") + ")." };
  const header = Number.parseInt(response.headers.get("content-length") || "", 10);
  const bytes = Number.isFinite(header) && header > 0 ? header : Math.floor(Number(declaredBytes));
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, error: "Could not confirm the size of the stored file." };
  if (bytes > limits[RULES[cardFormat].limit]) return { ok: false, error: "The stored file exceeds the size limit." };
  return { ok: true, bytes };
}

// Best-effort removal of a file we stored. Never throws: a failed delete must not block the dashboard.
export async function deleteStoredObject(key, resource, config = storageConfig(), fetchImpl = fetch) {
  if (!config.configured || !["image", "video"].includes(resource) || !/^board\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key || "")) return false;
  try {
    const request = destroyRequest(resource, key, config);
    const response = await fetchImpl(request.url, { method: "POST", body: request.body, signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch { return false; }
}

export function storageSummary(state, env = process.env, now = new Date()) {
  const config = storageConfig(env);
  const limits = storageLimits(env);
  const usage = state.storageUsage || { totalBytes: 0, objects: 0, uploads: {} };
  return {
    configured: config.configured, provider: "Cloudinary", publicHost: config.configured ? "res.cloudinary.com" : null,
    usedBytes: usage.totalBytes, reservedBytes: Object.values(usage.pending || {}).reduce((sum, item) => sum + (Number(item?.bytes) || 0), 0), objects: usage.objects, maxBytes: limits.totalMaxBytes,
    uploadsToday: usage.uploads[dayKey(now)] || 0, maxUploadsPerDay: limits.uploadsPerDay,
    imageMaxBytes: limits.imageMaxBytes, videoMaxBytes: limits.videoMaxBytes,
    costNote: "Free plan: 25 monthly credits (1 credit = 1 GB storage, 1 GB bandwidth or 1,000 transformations), no payment details required, so it cannot be billed. If you exceed the allowance Cloudinary may restrict uploads instead. Creator OS keeps its own limits well inside it."
  };
}
export { resourceFor };
