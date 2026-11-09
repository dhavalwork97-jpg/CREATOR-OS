import { dayKey } from "./util.mjs";

// Pure helpers over the state object. Text usage lives in state.textUsage; image attempts keep using
// the existing state.mediaUsage so earlier data and limits stay valid.
const KEEP_DAYS = 14;

function prune(map, now) {
  const cutoff = dayKey(new Date(now.getTime() - KEEP_DAYS * 86400000));
  for (const day of Object.keys(map)) if (day < cutoff) delete map[day];
}

export function textUsageToday(state, now = new Date()) {
  return state.textUsage?.[dayKey(now)] || { requests: 0, errors: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0 };
}

// Reserves one text request. Counts BEFORE calling the provider so failures cannot be retried past the cap.
export function reserveText(state, dailyLimit, now = new Date()) {
  const blockedUntil = state.providerStatus?.text?.blockedUntil;
  if (blockedUntil && Date.parse(blockedUntil) > now.getTime()) return { allowed: false, reason: "rate_limited", blockedUntil };
  state.textUsage ||= {};
  const day = dayKey(now);
  const usage = state.textUsage[day] || { requests: 0, errors: 0, rateLimited: 0, inputTokens: 0, outputTokens: 0 };
  if (usage.requests >= dailyLimit) return { allowed: false, reason: "daily_limit", used: usage.requests };
  usage.requests += 1;
  state.textUsage[day] = usage;
  prune(state.textUsage, now);
  return { allowed: true, used: usage.requests };
}

export function recordTextSuccess(state, usage, now = new Date()) {
  const today = state.textUsage?.[dayKey(now)];
  if (today) { today.inputTokens += usage.inputTokens || 0; today.outputTokens += usage.outputTokens || 0; }
  if (state.providerStatus?.text) delete state.providerStatus.text.blockedUntil;
}

export function recordTextFailure(state, error, now = new Date()) {
  const today = state.textUsage?.[dayKey(now)];
  if (today) today.errors += 1;
  if (error?.status === 429) {
    if (today) today.rateLimited += 1;
    const waitSeconds = error.retryAfterSeconds || 15 * 60;
    state.providerStatus ||= {};
    state.providerStatus.text = { ...(state.providerStatus.text || {}), blockedUntil: new Date(now.getTime() + waitSeconds * 1000).toISOString() };
  }
}
