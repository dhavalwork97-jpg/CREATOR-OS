import test from "node:test";
import assert from "node:assert/strict";
import { buildContentPlan } from "../lib/agent-planner.mjs";

test("builds a seven-day blueprint with the requested number of ideas", () => {
  const plan = buildContentPlan({
    niche: "home cooking",
    audience: "busy beginners",
    objective: "grow engaged followers",
    pillars: ["quick meals", "kitchen tips"],
    postsPerWeek: 4
  }, new Date("2026-11-07T00:00:00.000Z"));

  assert.equal(plan.items.length, 4);
  assert.equal(plan.status, "awaiting_approval");
  assert.ok(plan.items.every(item => item.status === "idea"));
  assert.ok(plan.items.every(item => item.day >= "2026-11-07"));
});

test("rejects incomplete briefs", () => {
  assert.throws(() => buildContentPlan({ niche: "food" }), /niche, target audience, objective/);
});

test("limits plans to seven posts and removes duplicate pillars", () => {
  const plan = buildContentPlan({
    niche: "food", audience: "families", objective: "educate",
    pillars: ["recipes", "recipes", "safety"], postsPerWeek: 99
  });
  assert.equal(plan.items.length, 7);
  assert.deepEqual(plan.pillars, ["recipes", "safety"]);
});
