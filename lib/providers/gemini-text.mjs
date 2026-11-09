// Gemini text provider. Text generation is the free-first part of the stack: it only works for free
// while the API key belongs to a Google project WITHOUT billing enabled (Creator OS cannot verify that).
// Error messages never include provider response bodies or secrets.
const BASE = "https://generativelanguage.googleapis.com/v1beta/";
// Alias that follows Google's current lightweight Flash model. Override with GEMINI_TEXT_MODEL or pick one in the dashboard.
export const DEFAULT_TEXT_MODEL = "gemini-flash-lite-latest";
const MODEL_RE = /^[a-zA-Z0-9._-]{3,100}$/;
const NOT_TEXT = /(image|imagen|veo|tts|audio|live|embedding|aqa|robotics|computer-use|native-audio)/i;

export const normalizeModel = value => String(value || "").trim().replace(/^models\//, "");
export const isValidModelId = value => MODEL_RE.test(normalizeModel(value));

function providerError(message, status, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function retryAfterSeconds(response) {
  const value = Number.parseInt(response.headers?.get?.("retry-after") || "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 24 * 3600) : null;
}

export async function generateGeminiText({
  prompt, system, apiKey, model = DEFAULT_TEXT_MODEL, temperature = 0.7, maxOutputTokens = 800,
  json = false, fetchImpl = fetch
}) {
  if (!apiKey) throw providerError("Gemini API key is not configured", 503);
  const id = normalizeModel(model);
  if (!MODEL_RE.test(id)) throw providerError("Invalid Gemini text model", 400);
  if (typeof prompt !== "string" || prompt.trim().length < 3 || prompt.length > 30000) {
    throw providerError("Prompt must be between 3 and 30000 characters", 400);
  }
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt.trim() }] }],
    generationConfig: { temperature, maxOutputTokens, ...(json ? { responseMimeType: "application/json" } : {}) }
  };
  if (system) body.systemInstruction = { parts: [{ text: String(system).slice(0, 8000) }] };

  let response;
  try {
    response = await fetchImpl(BASE + "models/" + encodeURIComponent(id) + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    });
  } catch {
    throw providerError("Could not reach Gemini. Try again shortly.", 502);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) throw providerError("Gemini free-tier limit reached. Creator OS will wait before trying again.", 429, { retryAfterSeconds: retryAfterSeconds(response) });
    if (response.status === 404) throw providerError("Gemini does not recognise the model \"" + id + "\". Pick one from the model list.", 400);
    if (response.status === 401 || response.status === 403) throw providerError("Gemini rejected the API key or the model is not available to it.", 502);
    if (response.status >= 500) throw providerError("Gemini is temporarily unavailable.", 502);
    throw providerError("Gemini rejected the request.", 502);
  }
  if (payload.promptFeedback?.blockReason) throw providerError("Gemini declined this prompt (" + String(payload.promptFeedback.blockReason).slice(0, 40) + ").", 422);
  const text = (payload.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("").trim();
  if (!text) throw providerError("Gemini returned no text.", 502);
  return {
    text, model: id,
    usage: {
      inputTokens: Number(payload.usageMetadata?.promptTokenCount) || 0,
      outputTokens: Number(payload.usageMetadata?.candidatesTokenCount) || 0
    }
  };
}

export async function listGeminiTextModels({ apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw providerError("Gemini API key is not configured", 503);
  const found = [];
  let pageToken = "";
  for (let page = 0; page < 4; page++) {
    let response;
    try {
      response = await fetchImpl(BASE + "models?pageSize=100" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""), {
        headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(20000)
      });
    } catch { throw providerError("Could not reach Gemini. Try again shortly.", 502); }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(response.status === 401 || response.status === 403 ? "Gemini rejected the API key." : "Could not list Gemini models.", 502);
    for (const model of payload.models || []) {
      const id = normalizeModel(model.name);
      if (!MODEL_RE.test(id) || NOT_TEXT.test(id)) continue;
      if (!(model.supportedGenerationMethods || []).includes("generateContent")) continue;
      found.push({ id, displayName: String(model.displayName || id).slice(0, 80) });
    }
    pageToken = payload.nextPageToken || "";
    if (!pageToken) break;
  }
  return found;
}
