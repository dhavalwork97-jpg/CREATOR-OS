import crypto from "node:crypto";

// Cloudinary storage for uploaded media. The free plan needs no payment details, so it cannot be billed.
// The browser uploads straight to Cloudinary with a server-signed request (the API secret never leaves the server),
// which avoids serverless request-size limits that Reels would exceed.
const API = "https://api.cloudinary.com/v1_1/";
const UNSIGNED_KEYS = new Set(["file", "cloud_name", "resource_type", "api_key", "signature"]);

// Cloudinary signature: sort parameters by name, join as name=value with "&", append the API secret, SHA-1 hex.
export function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter(key => !UNSIGNED_KEYS.has(key) && params[key] !== undefined && params[key] !== "")
    .sort().map(key => key + "=" + params[key]).join("&");
  return crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
}

export function storageConfig(env = process.env) {
  const cloudName = (env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = (env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = (env.CLOUDINARY_API_SECRET || "").trim();
  return {
    configured: /^[A-Za-z0-9_-]{2,64}$/.test(cloudName) && /^[A-Za-z0-9_-]{6,64}$/.test(apiKey) && apiSecret.length >= 10,
    cloudName, apiKey, apiSecret
  };
}

export const resourceFor = format => (format === "reel" ? "video" : "image");

// Normalises the format Cloudinary reports to one extension we accept for this card type, or null.
export function normalizeFormat(cardFormat, reported) {
  const value = String(reported || "").toLowerCase();
  if (cardFormat === "reel") return value === "mp4" || value === "mov" ? value : null;
  return value === "jpg" || value === "jpeg" ? "jpg" : null;
}

export const publicUrlFor = (config, resource, key, ext) =>
  "https://res.cloudinary.com/" + config.cloudName + "/" + resource + "/upload/" + key + "." + ext;

export function presignUpload(cardFormat, key, config = storageConfig(), now = new Date()) {
  if (!config.configured) throw new Error("Media storage is not configured");
  const resource = resourceFor(cardFormat);
  // allowed_formats is part of the signature, so Cloudinary itself rejects other file types.
  const params = { allowed_formats: cardFormat === "reel" ? "mp4,mov" : "jpg", public_id: key, timestamp: String(Math.floor(now.getTime() / 1000)) };
  return {
    uploadUrl: API + config.cloudName + "/" + resource + "/upload",
    fields: { ...params, api_key: config.apiKey, signature: signParams(params, config.apiSecret) },
    expiresInSeconds: 3600
  };
}

export function destroyRequest(resource, key, config = storageConfig(), now = new Date()) {
  if (!config.configured) throw new Error("Media storage is not configured");
  const params = { invalidate: "true", public_id: key, timestamp: String(Math.floor(now.getTime() / 1000)) };
  return {
    url: API + config.cloudName + "/" + resource + "/destroy",
    body: new URLSearchParams({ ...params, api_key: config.apiKey, signature: signParams(params, config.apiSecret) })
  };
}

const mb = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.parseFloat(value) || fallback)) * 1024 * 1024;
export function storageLimits(env = process.env) {
  return {
    // Free plan: images up to 10 MB, videos up to 100 MB. Instagram itself limits feed images to 8 MB.
    imageMaxBytes: mb(env.STORAGE_MAX_IMAGE_MB, 8, 1, 8),
    videoMaxBytes: mb(env.STORAGE_MAX_VIDEO_MB, 100, 1, 100),
    // The free plan has 25 monthly credits shared by storage, bandwidth and transformations (1 GB of storage = 1 credit).
    totalMaxBytes: mb(env.STORAGE_MAX_TOTAL_MB, 3000, 100, 20000),
    uploadsPerDay: Math.min(200, Math.max(1, Number.parseInt(env.STORAGE_MAX_UPLOADS_PER_DAY, 10) || 20))
  };
}
