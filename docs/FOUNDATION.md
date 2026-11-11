# Creator OS 2.0 — Orchestration foundation

What this adds (Phase 0 plan, step 1–2). Existing publishing, board, auth and kill switch are unchanged.

## Components
- `lib/sql.mjs` — parameterised Postgres access for 2.0 tables (legacy JSON state stays in `lib/db.mjs`).
- `migrations/` + `lib/migrate.mjs` + `scripts/migrate.mjs` — additive migrations with a `down` per migration.
- `lib/tasks/queue.mjs` — durable task queue: statuses `pending|queued|running|waiting_approval|completed|failed|cancelled|retrying`, idempotency keys, dependencies, exponential backoff, timeouts, cancellation, `FOR UPDATE SKIP LOCKED` claiming.
- `lib/supervisor.mjs` — deterministic tick: recover timed-out tasks, claim due tasks, run registered handlers, record `agent_runs` and audit events. Recurring work is created once per interval bucket via idempotency keys.
- `GET /api/worker/tick` (Bearer `CRON_SECRET`), `GET /api/tasks`, `POST /api/tasks/:id/cancel`, `GET /api/activity` (owner session, account-scoped).

## Safety properties (covered by tests)
- Tasks flagged `external_effect` are never claimed while the existing kill switch is ON; they stay queued (paused), not deleted.
- Tasks flagged `retry_safe = false` (publishing, later) are never retried automatically after a timeout or error.
- Only the worker holding a task's lock can complete or fail it; a cancelled task's late result is discarded.
- A task with no registered handler fails visibly (`no_handler`).
- Audit details redact keys named token/secret/api key/password/authorization.
- Agents have no code path that writes `agent_settings` (autonomy defaults to `copilot`).

## Deploy (do on a Neon branch first)
1. `node --env-file-if-exists=.env scripts/migrate.mjs status`
2. `node --env-file-if-exists=.env scripts/migrate.mjs up`
3. Merge/deploy. Until step 2 is done, `/api/worker/tick` and `/api/tasks` return 503 with instructions; everything else works.
4. The existing GitHub Actions worker now also calls `/api/worker/tick` (non-blocking step). No new secrets or environment variables.

## Rollback
`node --env-file-if-exists=.env scripts/migrate.mjs down` removes the 2.0 tables from the latest migration only; `creator_os_state` is untouched. Reverting the deploy is safe at any time because nothing in the legacy path depends on the new tables.

## Verification status
Tests run against pglite (real Postgres in WASM) and the existing Neon stub. **Not yet verified against a real Neon database or real Meta API.**
