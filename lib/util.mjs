export const clean = (value, limit = 2200) => typeof value === "string" ? value.trim().slice(0, limit) : "";
export const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);
