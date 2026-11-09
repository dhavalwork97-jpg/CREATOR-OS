import test from "node:test";
import assert from "node:assert/strict";
import { generateGeminiText, listGeminiTextModels, isValidModelId } from "../lib/providers/gemini-text.mjs";

const ok = body => async () => new Response(JSON.stringify(body), { status: 200 });
const status = (code, headers = {}, body = { error: { message: "SECRET-PROVIDER-DETAIL" } }) => async () => new Response(JSON.stringify(body), { status: code, headers });

test("returns text and token usage", async () => {
  let seen;
  const result = await generateGeminiText({
    prompt: "Write a hook", apiKey: "k", model: "models/gemini-test",
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello " }, { text: "world" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } })); }
  });
  assert.equal(result.text, "Hello world");
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2 });
  assert.equal(result.model, "gemini-test");
  assert.match(seen.url, /models\/gemini-test:generateContent$/);
  assert.equal(seen.init.headers["x-goog-api-key"], "k");
  assert.equal(seen.url.includes("k="), false, "key is sent in a header, never the URL");
});

test("validates inputs before any request", async () => {
  const never = async () => { throw new Error("must not call"); };
  await assert.rejects(generateGeminiText({ prompt: "hi there", apiKey: "", fetchImpl: never }), /not configured/);
  await assert.rejects(generateGeminiText({ prompt: "hi there", apiKey: "k", model: "bad model!", fetchImpl: never }), /Invalid/);
  await assert.rejects(generateGeminiText({ prompt: "x", apiKey: "k", fetchImpl: never }), /Prompt/);
  assert.equal(isValidModelId("gemini-3.5-flash-lite"), true);
  assert.equal(isValidModelId("../etc"), false);
});

test("maps provider errors to safe messages without leaking response bodies", async () => {
  for (const [code, pattern] of [[429, /free-tier limit/], [404, /does not recognise/], [403, /rejected the API key/], [500, /temporarily unavailable/], [400, /rejected the request/]]) {
    await assert.rejects(generateGeminiText({ prompt: "hello there", apiKey: "k", fetchImpl: status(code) }), error => {
      assert.match(error.message, pattern);
      assert.equal(error.message.includes("SECRET-PROVIDER-DETAIL"), false);
      return true;
    });
  }
});

test("carries Retry-After on rate limits and handles blocked or empty answers", async () => {
  await assert.rejects(generateGeminiText({ prompt: "hello there", apiKey: "k", fetchImpl: status(429, { "retry-after": "90" }) }), error => error.status === 429 && error.retryAfterSeconds === 90);
  await assert.rejects(generateGeminiText({ prompt: "hello there", apiKey: "k", fetchImpl: ok({ promptFeedback: { blockReason: "SAFETY" } }) }), /declined/);
  await assert.rejects(generateGeminiText({ prompt: "hello there", apiKey: "k", fetchImpl: ok({ candidates: [] }) }), /no text/);
});

test("lists only text-capable models", async () => {
  const models = await listGeminiTextModels({ apiKey: "k", fetchImpl: ok({ models: [
    { name: "models/gemini-a-flash", displayName: "A Flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-a-flash-image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-1", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-b-pro", supportedGenerationMethods: ["countTokens"] }
  ] }) });
  assert.deepEqual(models.map(m => m.id), ["gemini-a-flash"]);
});
