import { claim, complete, fail, release, recoverTimedOut, recordRun, enqueue, promoteReady, TaskError } from "./tasks/queue.mjs";
import { recordAudit } from "./audit-log.mjs";

// The Supervisor is deterministic orchestration: it claims due tasks, dispatches each to a registered handler,
// and records the outcome. It never decides to publish, never edits settings, and never bypasses the kill switch.
// Handlers are looked up by "<agent>.<task_type>"; a task with no handler fails permanently and visibly.

const errorOf = error => ({ code: error?.code || "error", message: String(error?.message || error).slice(0, 500) });

async function runWithTimeout(handler, context, ms) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new TaskError("timeout", "Task exceeded its time limit", { retryable: true })); }, ms);
  });
  try { return await Promise.race([handler({ ...context, signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}

export async function tick({ handlers = {}, workerId = "worker", now = () => new Date(), budgetMs = 45000, maxTasks = 5, killSwitch = true } = {}) {
  const startedAt = now();
  const deadline = Date.now() + budgetMs;
  const summary = { recovered: 0, claimed: 0, completed: 0, failed: 0, retried: 0, released: 0, killSwitch };

  const recovered = await recoverTimedOut(now());
  summary.recovered = recovered.length;
  for (const row of recovered) {
    await recordRun({ ...row, retry_count: row.retry_count }, "timeout", { startedAt: row.started_at, now: now() });
    await recordAudit({ accountId: row.account_id, action: "task_timed_out", subjectType: "task", subjectId: row.task_id,
      detail: { agent: row.agent, type: row.task_type, nextStatus: row.status } });
  }
  await promoteReady(now());

  const tasks = await claim({ workerId, limit: maxTasks, now: now(), allowExternal: !killSwitch });
  summary.claimed = tasks.length;

  for (const task of tasks) {
    const remaining = deadline - Date.now();
    if (remaining < 2000) { await release(task, now()); summary.released += 1; continue; }
    const handler = handlers[task.agent + "." + task.task_type];
    const started = now();
    if (!handler) {
      const error = new TaskError("no_handler", "No handler is registered for " + task.agent + "." + task.task_type);
      const result = await fail(task, error, { retryable: false, now: now() });
      if (result) { summary.failed += 1; await recordRun(task, "failed", { error: errorOf(error), startedAt: started, now: now() }); }
      continue;
    }
    try {
      const result = await runWithTimeout(handler, { task, now, killSwitch }, Math.min(task.timeout_seconds * 1000, remaining - 500)) || {};
      const done = await complete(task, result.output ?? {}, now());
      if (done) {
        summary.completed += 1;
        await recordRun(task, "completed", { decision: result.decision || {}, startedAt: started, now: now() });
      } else {
        // The task was cancelled or reclaimed while running; its result is discarded, not applied.
        await recordRun(task, "cancelled", { decision: { discarded: true }, startedAt: started, now: now() });
      }
    } catch (error) {
      const retryable = error instanceof TaskError ? error.retryable : false;
      const outcome = await fail(task, error, { retryable, now: now() });
      if (outcome) {
        if (outcome.retried) summary.retried += 1; else summary.failed += 1;
        await recordRun(task, outcome.retried ? "retry" : "failed", { error: errorOf(error), startedAt: started, now: now() });
        await recordAudit({ accountId: task.account_id, action: outcome.retried ? "task_retry_scheduled" : "task_failed",
          subjectType: "task", subjectId: task.task_id, detail: { agent: task.agent, type: task.task_type, ...errorOf(error) } });
      }
    }
  }
  summary.durationMs = now().getTime() - startedAt.getTime();
  return summary;
}

// Recurring work without a timer process: each interval bucket has one deterministic idempotency key,
// so any number of ticks (or restarts) creates at most one task per bucket.
export async function ensureRecurring({ accountId, definitions = [], now = new Date() }) {
  const created = [];
  for (const def of definitions) {
    const intervalMs = def.intervalMinutes * 60000;
    if (!(intervalMs > 0)) continue;
    const bucket = Math.floor(now.getTime() / intervalMs);
    const { task, created: isNew } = await enqueue({
      accountId, agent: def.agent, type: def.type, input: def.input || {}, priority: def.priority ?? 0,
      idempotencyKey: def.agent + "." + def.type + ":" + accountId + ":" + bucket,
      maxRetries: def.maxRetries ?? 3, timeoutSeconds: def.timeoutSeconds ?? 120,
      externalEffect: Boolean(def.externalEffect), retrySafe: def.retrySafe !== false
    });
    if (isNew) created.push(task.task_id);
  }
  return created;
}
