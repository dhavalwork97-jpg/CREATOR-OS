import test from "node:test";
import assert from "node:assert/strict";
import { startApp } from "../helpers/harness.mjs";

const SECRET = "AIza-test-secret-key";
const google = [];
let textResponse = () => Response.json({ candidates: [{ content: { parts: [{ text: "The provider works." }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } });
const app = await startApp({
  env: { GEMINI_API_KEY: SECRET, GEMINI_TEXT_ENABLED: "false", GEMINI_IMAGE_GENERATION_ENABLED: "false", MAX_TEXT_GENERATIONS_PER_DAY: "3" },
  routes: [{
    match: url => url.startsWith("https://generativelanguage.googleapis.com/"),
    respond: (url, init) => {
      google.push((init.method || "GET") + " " + url.replace("https://generativelanguage.googleapis.com/v1beta/", ""));
      if (url.includes(":generateContent") && url.includes("image")) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }] });
      if (url.includes(":generateContent")) return textResponse();
      return Response.json({ models: [{ name: "models/gemini-free-flash", displayName: "Free Flash", supportedGenerationMethods: ["generateContent"] }] });
    }
  }]
});
test.after(() => app.close());

const everyBody = [];
const track = async (...args) => { const r = await app.call(...args); everyBody.push(JSON.stringify(r.body)); return r; };

test("providers are visible, text is off by default and costs are explicit", async () => {
  const { status, body } = await track("/api/providers");
  assert.equal(status, 200);
  assert.equal(body.text.enabled, false);
  assert.equal(body.text.costClass, "free_tier");
  assert.equal(body.image.costClass, "paid");
  assert.equal(body.image.estimatedCostUsdPerImage, null);
});

test("disabled text provider makes no Google call", async () => {
  const r = await track("/api/providers/text/test", {});
  assert.equal(r.status, 403);
  assert.equal(google.length, 0);
});

test("enabled provider works, counts usage and enforces the daily limit", async () => {
  process.env.GEMINI_TEXT_ENABLED = "true";
  const first = await track("/api/providers/text/test", {});
  assert.equal(first.status, 200);
  assert.equal(first.body.text, "The provider works.");
  assert.deepEqual(first.body.usage, { inputTokens: 9, outputTokens: 4 });
  await track("/api/providers/text/test", {});
  await track("/api/providers/text/test", {});
  const before = google.length;
  const over = await track("/api/providers/text/test", {});
  assert.equal(over.status, 429);
  assert.equal(google.length, before, "no provider call once the cap is reached");
  const { body } = await track("/api/providers");
  assert.equal(body.text.usageToday.requests, 3);
  assert.equal(body.text.usageToday.inputTokens, 27);
});

test("model selection is validated against the models your key can use", async () => {
  assert.equal((await track("/api/providers/text/model", { model: "not a model" })).status, 400);
  assert.equal((await track("/api/providers/text/model", { model: "gemini-unknown" })).status, 400);
  assert.equal((await track("/api/providers/text/model", { model: "gemini-free-flash" })).status, 200);
  assert.equal((await track("/api/providers")).body.text.model, "gemini-free-flash");
  assert.deepEqual((await track("/api/providers/text/models")).body.models.map(m => m.id), ["gemini-free-flash"]);
});

test("a free-tier 429 pauses further calls instead of hammering the API", async () => {
  await app.db.mutateState(state => { state.textUsage = {}; });
  textResponse = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
  assert.equal((await track("/api/providers/text/test", {})).status, 429);
  const before = google.length;
  const paused = await track("/api/providers/text/test", {});
  assert.equal(paused.status, 429);
  assert.ok(paused.body.blockedUntil);
  assert.equal(google.length, before, "paused: no outbound call");
  assert.ok((await track("/api/providers")).body.text.rateLimitedUntil);
});

test("paid image generation needs explicit confirmation and never runs silently", async () => {
  Object.assign(process.env, { GEMINI_IMAGE_GENERATION_ENABLED: "true", GEMINI_IMAGE_COST_USD_PER_IMAGE: "0.04" });
  const before = google.length;
  const prompt = "A calm coastline at blue hour, no people, no text";
  const refused = await track("/api/agent/media/image", { prompt });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.requiresConfirmation, true);
  assert.equal(refused.body.estimatedCostUsdPerImage, 0.04);
  assert.equal(google.length, before, "unconfirmed request never reaches Google");
  assert.equal((await track("/api/state")).body.media.costClass, "paid");
  const allowed = await track("/api/agent/media/image", { prompt, confirmPaid: true });
  assert.equal(allowed.status, 200);
  assert.equal(google.length, before + 1);
  const { body } = await track("/api/providers");
  assert.equal(body.image.usageToday.attempts, 1);
  assert.equal(body.image.estimatedCostTodayUsd, 0.04);
});

test("the API key never appears in any response", () => {
  assert.ok(everyBody.length > 8);
  assert.equal(everyBody.some(body => body.includes(SECRET)), false);
});
