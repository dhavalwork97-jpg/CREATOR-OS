import crypto from "node:crypto";

const clean = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";

export function buildContentPlan(input, now = new Date()) {
  const niche = clean(input.niche, 120);
  const audience = clean(input.audience, 160);
  const objective = clean(input.objective, 300);
  const pillars = [...new Set((Array.isArray(input.pillars) ? input.pillars : [])
    .map(value => clean(value, 80)).filter(Boolean))].slice(0, 5);
  const postsPerWeek = Math.min(7, Math.max(1, Number.parseInt(input.postsPerWeek, 10) || 3));

  if (!niche || !audience || !objective || pillars.length < 1) {
    throw new Error("Add a niche, target audience, objective and at least one content pillar.");
  }

  const formats = ["reel", "image", "reel", "image", "reel", "image", "reel"];
  const angles = [
    "A quick beginner-friendly tip about",
    "A common mistake people make with",
    "A behind-the-scenes look at",
    "A short myth-versus-fact post about",
    "A practical checklist for",
    "A question that starts a conversation about",
    "A simple before-and-after story around"
  ];
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  const items = Array.from({ length: postsPerWeek }, (_, index) => {
    const dayOffset = Math.floor(index * 7 / postsPerWeek);
    const pillar = pillars[index % pillars.length];
    const angle = angles[index % angles.length];
    const date = new Date(start);
    date.setDate(date.getDate() + dayOffset);
    return {
      id: crypto.randomUUID(),
      day: date.toISOString().slice(0, 10),
      format: formats[index],
      pillar,
      idea: angle + " " + pillar + " for " + audience + ".",
      status: "idea"
    };
  });

  return {
    id: crypto.randomUUID(),
    createdAt: now.toISOString(),
    status: "awaiting_approval",
    source: "rules_based_blueprint",
    niche,
    audience,
    objective,
    pillars,
    postsPerWeek,
    items
  };
}
