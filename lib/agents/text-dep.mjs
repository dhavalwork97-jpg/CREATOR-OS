import { TaskError } from "../tasks/queue.mjs";

// The single path agents use to reach the existing Gemini text provider. It reuses the legacy usage ledger
// (daily cap, 429 back-off), so agents cannot spend more than the dashboard's own text generation could.
// Returns { skipped } when the provider is off, unconfigured, capped or rate-limited; never throws for those.
export async function generateJsonText(prompt, system, { temperature = 0.7, maxOutputTokens = 1200 } = {}) {
  const { readState, mutateState } = await import("../db.mjs");
  const { textProvider } = await import("../providers/registry.mjs");
  const { generateGeminiText } = await import("../providers/gemini-text.mjs");
  const { reserveText, recordTextSuccess, recordTextFailure } = await import("../usage.mjs");
  const provider = textProvider(await readState());
  if (!provider.configured) return { skipped: "text_provider_not_configured" };
  const reservation = await mutateState(state => reserveText(state, provider.dailyLimit));
  if (!reservation.allowed) return { skipped: reservation.reason };
  try {
    const result = await generateGeminiText({ prompt, system, apiKey: process.env.GEMINI_API_KEY, model: provider.model, temperature, maxOutputTokens, json: true });
    await mutateState(state => recordTextSuccess(state, result.usage));
    return { text: result.text, model: result.model };
  } catch (error) {
    await mutateState(state => recordTextFailure(state, error));
    if (error?.status === 429 || error?.status >= 500) throw new TaskError("text_provider_error", "Gemini text request failed (" + (error.status || "network") + ")", { retryable: true });
    return { skipped: "text_provider_failed" };
  }
}
