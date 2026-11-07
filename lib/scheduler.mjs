// Pure scheduling helper shared by the board and approval workflow.
const ACTIVE = new Set(["scheduled", "publishing", "processing", "published", "delivery_unknown"]);

export function scheduleConfig(env = process.env) {
  const hours = String(env.POSTING_HOURS || "12,19").split(",")
    .map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value) && value >= 0 && value <= 23);
  return {
    hours: [...new Set(hours.length ? hours : [12, 19])].sort((a, b) => a - b),
    offsetMinutes: Number.parseInt(env.POSTING_UTC_OFFSET_MINUTES || "0", 10) || 0,
    maxPerDay: Math.max(1, Number(env.MAX_POSTS_PER_DAY || 3)),
    minGapMinutes: Math.max(30, Number(env.MIN_MINUTES_BETWEEN_POSTS || 180))
  };
}

const localDay = (milliseconds, offsetMinutes) =>
  new Date(milliseconds + offsetMinutes * 60000).toISOString().slice(0, 10);

export function pickSlot({ posts, now = new Date(), earliestDay, config, horizonDays = 28 }) {
  const { hours, offsetMinutes, maxPerDay, minGapMinutes } = config;
  const taken = (posts || []).filter(post => ACTIVE.has(post.status))
    .map(post => Date.parse(post.status === "published" ? (post.publishedAt || post.scheduledAt) : post.scheduledAt))
    .filter(Number.isFinite);
  const earliest = now.getTime() + 10 * 60000;
  const today = localDay(now.getTime(), offsetMinutes);
  const startDay = earliestDay && earliestDay > today ? earliestDay : today;
  const [year, month, day] = startDay.split("-").map(Number);
  for (let offset = 0; offset < horizonDays; offset++) {
    for (const hour of hours) {
      const candidate = Date.UTC(year, month - 1, day + offset, hour, 0, 0) - offsetMinutes * 60000;
      if (candidate < earliest) continue;
      const candidateDay = localDay(candidate, offsetMinutes);
      if (taken.filter(timestamp => localDay(timestamp, offsetMinutes) === candidateDay).length >= maxPerDay) continue;
      if (taken.some(timestamp => Math.abs(timestamp - candidate) < minGapMinutes * 60000)) continue;
      return new Date(candidate).toISOString();
    }
  }
  return null;
}
