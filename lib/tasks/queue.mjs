import { query } from "../sql.mjs";

// Durable task queue on Postgres. Every transition is a single guarded UPDATE, so concurrent
// workers (or a worker that died mid-task) cannot double-complete, double-retry or lose a task.

export const STATUSES = ["pending", "queued", "running", "waiting_approval", "completed", "failed", "cancelled", "retrying"];
export const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const TRANSITIONS = {
  pending: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  retrying: ["running", "cancelled"],
  running: ["completed", "failed", "retrying", "queued", "waiting_approval", "cancelled"],
  waiting_approval: ["queued", "failed", "cancelled"],
  completed: [], failed: [], cancelled: []
};
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// 30 s, 60 s, 120 s ... capped at one hour.
export const backoffSeconds = retryCount => Math.min(3600, 30 * 2 ** Math.max(0, retryCount));

export class TaskError extends Error {
  constructor(code, message, { retryable = false, detail } = {}) {
    super(message);
    this.name = "TaskError";
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

const iso = value => (value instanceof Date ? value : new Date(value ?? Date.now())).toISOString();
const json = value => JSON.stringify(value ?? null);

export async function enqueue({
  accountId, agent, type, input = {}, priority = 0, idempotencyKey, parentTaskId = null,
  dependsOn = [], runAfter, maxRetries = 3, timeoutSeconds = 120, externalEffect = false, retrySafe = true,
  metadata = {}
}) {
  if (!accountId || !agent || !type || !idempotencyKey) throw new Error("accountId, agent, type and idempotencyKey are required");
  const status = dependsOn.length ? "pending" : "queued";
  const rows = await query(
    `INSERT INTO agent_tasks (account_id, agent, task_type, input, status, priority, idempotency_key, parent_task_id,
       external_effect, retry_safe, max_retries, timeout_seconds, run_after, metadata)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [accountId, agent, type, json(input), status, priority, idempotencyKey, parentTaskId, externalEffect, retrySafe,
      maxRetries, timeoutSeconds, iso(runAfter), json(metadata)]
  );
  if (!rows.length) {
    const [existing] = await query(`SELECT * FROM agent_tasks WHERE idempotency_key = $1`, [idempotencyKey]);
    return { task: existing, created: false };
  }
  const task = rows[0];
  for (const dep of dependsOn) {
    await query(`INSERT INTO agent_task_deps (task_id, depends_on) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [task.task_id, dep]);
  }
  if (dependsOn.length) await promoteReady();
  return { task, created: true };
}

// Dependents of a failed or cancelled task are cancelled; tasks whose dependencies all completed become queued.
export async function promoteReady(now = new Date()) {
  const blocked = await query(
    `UPDATE agent_tasks t SET status = 'cancelled', completed_at = $1::timestamptz, updated_at = $1::timestamptz,
       error = jsonb_build_object('code','dependency_failed','message','A task this one depends on did not complete.')
     WHERE t.status = 'pending' AND EXISTS (
       SELECT 1 FROM agent_task_deps d JOIN agent_tasks p ON p.task_id = d.depends_on
       WHERE d.task_id = t.task_id AND p.status IN ('failed','cancelled')) RETURNING t.task_id`, [iso(now)]);
  const ready = await query(
    `UPDATE agent_tasks t SET status = 'queued', updated_at = $1::timestamptz
     WHERE t.status = 'pending' AND NOT EXISTS (
       SELECT 1 FROM agent_task_deps d JOIN agent_tasks p ON p.task_id = d.depends_on
       WHERE d.task_id = t.task_id AND p.status <> 'completed') RETURNING t.task_id`, [iso(now)]);
  return { cancelled: blocked.length, promoted: ready.length };
}

// Claims due tasks. FOR UPDATE SKIP LOCKED means parallel ticks never receive the same task.
// Tasks with external side effects are skipped when allowExternal is false (kill switch ON): they stay queued, paused.
export async function claim({ workerId, limit = 5, now = new Date(), allowExternal = true }) {
  return query(
    `UPDATE agent_tasks SET status = 'running', started_at = $2::timestamptz, locked_by = $1, locked_at = $2::timestamptz,
       timeout_at = $2::timestamptz + make_interval(secs => timeout_seconds), updated_at = $2::timestamptz
     WHERE task_id IN (
       SELECT task_id FROM agent_tasks
       WHERE status IN ('queued','retrying') AND run_after <= $2::timestamptz AND ($4::boolean OR NOT external_effect)
       ORDER BY priority DESC, run_after ASC LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [workerId, iso(now), limit, allowExternal]
  );
}

export async function complete(task, output, now = new Date()) {
  const rows = await query(
    `UPDATE agent_tasks SET status = 'completed', output = $3::jsonb, error = NULL, completed_at = $4::timestamptz,
       updated_at = $4::timestamptz, locked_by = NULL, timeout_at = NULL
     WHERE task_id = $1 AND status = 'running' AND locked_by = $2 RETURNING *`,
    [task.task_id, task.locked_by, json(output), iso(now)]);
  if (rows.length) await promoteReady(now);
  return rows[0] || null;
}

// Retries only when the error is retryable, the task is marked retry-safe and attempts remain.
export async function fail(task, error, { retryable = false, now = new Date() } = {}) {
  const willRetry = retryable && task.retry_safe && task.retry_count < task.max_retries;
  const errorJson = json({ code: error?.code || "error", message: String(error?.message || error).slice(0, 500), detail: error?.detail ?? null });
  const rows = willRetry
    ? await query(
      `UPDATE agent_tasks SET status = 'retrying', retry_count = retry_count + 1, error = $3::jsonb,
         run_after = $4::timestamptz + make_interval(secs => $5::int), updated_at = $4::timestamptz, locked_by = NULL, timeout_at = NULL
       WHERE task_id = $1 AND status = 'running' AND locked_by = $2 RETURNING *`,
      [task.task_id, task.locked_by, errorJson, iso(now), backoffSeconds(task.retry_count)])
    : await query(
      `UPDATE agent_tasks SET status = 'failed', error = $3::jsonb, completed_at = $4::timestamptz,
         updated_at = $4::timestamptz, locked_by = NULL, timeout_at = NULL
       WHERE task_id = $1 AND status = 'running' AND locked_by = $2 RETURNING *`,
      [task.task_id, task.locked_by, errorJson, iso(now)]);
  if (rows.length && !willRetry) await promoteReady(now);
  return rows[0] ? { task: rows[0], retried: willRetry } : null;
}

// Puts a claimed-but-unstarted task back without consuming a retry (used when the tick runs out of time).
export async function release(task, now = new Date()) {
  const rows = await query(
    `UPDATE agent_tasks SET status = 'queued', locked_by = NULL, timeout_at = NULL, started_at = NULL, updated_at = $3::timestamptz
     WHERE task_id = $1 AND status = 'running' AND locked_by = $2 RETURNING *`,
    [task.task_id, task.locked_by, iso(now)]);
  return rows[0] || null;
}

// Recovers tasks whose worker died or exceeded its timeout. Retry-unsafe tasks (e.g. publishing) go to failed, never to a blind retry.
export async function recoverTimedOut(now = new Date()) {
  return query(
    `UPDATE agent_tasks SET
       status = CASE WHEN retry_safe AND retry_count < max_retries THEN 'retrying' ELSE 'failed' END,
       retry_count = CASE WHEN retry_safe AND retry_count < max_retries THEN retry_count + 1 ELSE retry_count END,
       run_after = CASE WHEN retry_safe AND retry_count < max_retries
         THEN $1::timestamptz + make_interval(secs => LEAST(3600, 30 * power(2, retry_count))::int) ELSE run_after END,
       completed_at = CASE WHEN retry_safe AND retry_count < max_retries THEN NULL ELSE $1::timestamptz END,
       error = jsonb_build_object('code','timeout','message','The task exceeded its time limit or its worker stopped.'),
       locked_by = NULL, timeout_at = NULL, updated_at = $1::timestamptz
     WHERE status = 'running' AND timeout_at < $1::timestamptz
     RETURNING task_id, account_id, agent, task_type, status, retry_count, started_at`, [iso(now)]);
}

export async function cancel(taskId, accountId, now = new Date()) {
  const rows = await query(
    `UPDATE agent_tasks SET status = 'cancelled', completed_at = $3::timestamptz, updated_at = $3::timestamptz,
       locked_by = NULL, timeout_at = NULL
     WHERE task_id = $1 AND account_id = $2 AND status IN ('pending','queued','retrying','waiting_approval','running') RETURNING *`,
    [taskId, accountId, iso(now)]);
  if (rows.length) await promoteReady(now);
  return rows[0] || null;
}

export async function listTasks(accountId, { limit = 50, status } = {}) {
  const max = Math.min(200, Math.max(1, Number(limit) || 50));
  return status
    ? query(`SELECT * FROM agent_tasks WHERE account_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3`, [accountId, status, max])
    : query(`SELECT * FROM agent_tasks WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`, [accountId, max]);
}

export async function getTask(taskId, accountId) {
  const [row] = await query(`SELECT * FROM agent_tasks WHERE task_id = $1 AND account_id = $2`, [taskId, accountId]);
  return row || null;
}

export async function recordRun(task, outcome, { decision = {}, error = null, startedAt, now = new Date() } = {}) {
  await query(
    `INSERT INTO agent_runs (task_id, account_id, agent, attempt, outcome, decision, error, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::timestamptz,$9::timestamptz)`,
    [task.task_id, task.account_id, task.agent, (task.retry_count ?? 0) + 1, outcome, json(decision), error ? json(error) : null,
      iso(startedAt || task.started_at || now), iso(now)]);
}
