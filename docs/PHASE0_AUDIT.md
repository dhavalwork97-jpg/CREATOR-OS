# Creator OS 2.0 — Phase 0 Repository Audit

Audited commit: `5d979c3` (main, "Merge pull request #18 … integrate-pr0-pr1-pr2", 2026-11-09).
Method: read every source file, ran `npm run check` and `npm test` on Node 22.
Limits: the checkout was read-only (no GitHub API, no push), so PR state is inferred from git history, and nothing was run against real Meta, Gemini, Cloudinary or Neon.

## 1. Verified baseline

- `npm run check`: passes (16 files). `npm test`: **38 unit + 28 integration = 66 passing, 0 failing** (all mocked/stubbed; the Neon driver is replaced by an in-memory stub).
- There is **no CLAUDE.md**. Project instructions live in README.md, ARCHITECTURE.md, `docs/CREATOR_OS_2_0_HANDOFF.md` and `skills/*/SKILL.md`.
- PR state from history: #11, #12, #15, #16 and #18 appear as merge/squash commits. The Meta publishing work, the board and the Gemini image studio are all in `main`. #10, #13, #14, #17 have no visible PR numbers; their content (publishing fixes, Milestone 5 planner, scheduler helper) is present as plain commits. I could not confirm PR numbers without the GitHub API.
- The handoff's PR0/PR1/PR2 series is merged: Zapier is gone, the provider/usage layer and Cloudinary storage are present.

## 2. Existing architecture

- **Runtime:** one handler, `lib/api-handler.mjs` (596 lines), manual `pathname` routing. Vercel entry points under `api/` re-export it; `server.mjs` serves it locally. `maxDuration = 60`.
- **Auth:** Neon Auth proxied at `/api/auth/*`. Single owner, matched by `OWNER_EMAIL`; signup gated by `OWNER_SETUP_SECRET`. POSTs require same-origin. Worker uses `CRON_SECRET` bearer token with timing-safe compare. **There is no account ID anywhere; the app is single-tenant.**
- **Database:** one table, `creator_os_state(id='owner', version, data jsonb)`. All state (settings, posts, audit, plans, board cards, usage counters, storage reservations) is one JSON document, updated by optimistic-lock `mutateState` (8 retries). Audit log is truncated to 300 entries.
- **Publishing:** `publishDirect()` — Graph container, poll status up to 10×5 s, `media_publish`. Called from the worker (`processDuePost`) and `/api/posts/publish-now`. Worker claims one due post by version-checked update, enforces `MAX_POSTS_PER_DAY` and `MIN_MINUTES_BETWEEN_POSTS`, honours kill switch and `ENABLE_AUTOPUBLISH`. Stale `publishing` claims (>10 min) become `delivery_unknown`.
- **Worker trigger:** GitHub Actions cron every 5 minutes hitting `GET /api/worker/run` (Vercel Hobby cron is daily only).
- **Gemini:** text (`lib/providers/gemini-text.mjs`, opt-in, daily cap, 429 cooldown, usage ledger in state) and image (`lib/media-providers/gemini-image.mjs`, paid-by-default, confirmation required, daily cap, temporary preview only). Registry in `lib/providers/registry.mjs`.
- **Storage:** Cloudinary signed browser uploads with reservations, caps and cleanup (`lib/storage/*`). URL attachment still works.
- **Agent foundation:** `lib/agent-planner.mjs` is a deterministic, rules-based blueprint (no LLM). `lib/content-board.mjs` turns it into editable cards; approval schedules a post. Skills are 5 short markdown files that nothing loads at runtime.
- **Safety:** kill switch (`state.settings.killSwitch`, defaults ON), per-day cap, min gap, delivery_unknown protection, manual-publish confirmation, per-card approval. The "safety-reviewer" is a markdown skill only; there is no code that evaluates content.
- **Dashboard:** static `public/index.html` (one dense page, inline script), `content-board.js`, `providers.js`. Polls `/api/state` every 10 s.
- **CI:** `checks.yml` (check + test on push/PR), `creator-os-worker.yml` (5-min cron).

## 3. Existing functionality to preserve

Login, `/api/instagram/test` verification, manual publish, scheduled post queue, cancel (including legacy `awaiting_confirmation`), kill switch, board generate/update/approve/discard, Cloudinary presign/attach, Gemini text test/model selection, Gemini image preview, providers panel, worker endpoint.

## 4. Gaps against the 2.0 brief

| Area | Status |
|---|---|
| Instagram monitoring (account/media/insights, history, token health) | **Missing.** Only a one-off profile check exists. |
| Durable task system (status, retries, idempotency, dependencies, timeouts) | **Missing.** Only the post-status state machine. |
| Supervisor / agent runs / decision log | **Missing.** |
| Analytics & learning | **Missing.** No metrics stored at all. |
| Opportunity research | **Missing.** No web research, no source/evidence model. |
| Strategist | Rules-based planner only; no performance input, no evidence/confidence. |
| Creative production (scripts, scene plans, carousels) | **Missing** (captions are a template string). Gemini text is wired only to a test button. |
| Safety Reviewer code and statuses | **Missing** (skill markdown only). |
| Autonomy modes, bounded settings, windows, budgets | **Missing.** Only `ENABLE_AUTOPUBLISH` env + kill switch. |
| Notifications | **Missing.** |
| Webhooks + signature verification | **Missing.** |
| Per-account isolation | **Missing** (single owner). |
| Publish reconciliation | **Missing.** `delivery_unknown` is terminal and manual. |
| Provider selection | Not needed: Zapier was removed, Meta is the only path. `PUBLISH_PROVIDER=meta` can be added as a validated no-op guard. |

## 5. Defects and risks found in existing code

1. `error.definitive` is checked in `processDuePost` but **never set anywhere**, so every publish error becomes `delivery_unknown`. Safe, but there is no automatic retry path for clearly rejected requests (e.g. a validation error before the container exists).
2. Publishing polls up to ~50 s inside one request (`maxDuration` 60). A container that needs longer is reported as an error after the container already exists. Phase 6 should persist the container ID and poll across worker ticks.
3. `/api/instagram/test` reads `account_type` and `media_count` but never requests those fields, so they are always null.
4. Single-document state cannot hold time-series metrics or task history: every write rewrites the whole document, the audit log caps at 300, and concurrent writers contend on one version. Monitoring writes would collide with dashboard edits.
5. `ready()` and the `ENABLE_AUTOPUBLISH` env flag gate publishing globally. Autonomy modes must layer on this, not replace it.
6. The integration test stub understands exactly four SQL statements. Any relational table needs the stub extended, and stub tests do not prove Neon behaviour.
7. GitHub Actions cron can be delayed by minutes; the 15-minute reconciliation target is realistic, a hard guarantee is not.
8. `IG_ACCESS_TOKEN` is an env var (no stored expiry). Token health can only be inferred from Graph errors (and `debug_token` if the app credentials exist), not read from a stored expiry date.

## 6. Reusable components

`mutateState`/`readState` (keep for existing features), `publishDirect` (extract into a module, behaviour unchanged), `scheduleConfig`/`pickSlot`, `registry.mjs` + `usage.mjs` (extend for the generation budget), `gemini-text.mjs` (JSON mode already supported), `cloudinary.mjs`, `ownerSession`/same-origin checks, the audit helper (move to a table), `buildContentPlan` (keep as the offline fallback strategist).

## 7. Proposed design

**Orchestration (no new runtime, no new dependency).** Keep Vercel + Neon + the GitHub Actions cron. Add a tick endpoint (`GET /api/worker/tick`, same `CRON_SECRET`) that claims due tasks with `SELECT … FOR UPDATE SKIP LOCKED` and runs each as a short unit under a time budget. Keep `/api/worker/run` working unchanged during migration. A separate worker host is **not** required. The cron cadence (5 min) is the only granularity limit.

**New tables (additive only, `CREATE TABLE IF NOT EXISTS`, forward migration files plus matching `down` files):**

- `ig_accounts` (account_id, ig_user_id, username, connection_status, token_status, token_checked_at, monitoring/autonomy settings reference). Seeded from the existing env-configured account. **No token stored in the DB.**
- `agent_tasks` (task_id, account_id, agent, type, input, output, status ∈ the 8 required, priority, idempotency_key UNIQUE, parent_task_id FK, run_after, timeout_at, retry_count, max_retries, error, locked_by/locked_at, timestamps), `agent_task_deps`, `agent_runs` (decisions/outputs), `audit_events` (append-only, replaces the 300-entry list for new events; the old list stays).
- `account_snapshots` (account_id, collected_at, followers, following, media_count, reach, views, … each nullable, `unavailable jsonb` with reasons, `source`).
- `media_items`, `media_insights` (media_id, collected_at, checkpoint ∈ {1h,24h,72h,7d,sync}, metrics nullable, `unavailable` reasons) with UNIQUE (media_id, checkpoint) to avoid re-collecting.
- `performance_insights` (observation, metrics, sample_size, confidence, suggested_action, window).
- `content_opportunities`, `content_strategies`, `content_items` (package + review_status ∈ approved/needs_revision/human_review/blocked), `content_assets`, `safety_reviews`, `publishing_jobs` (idempotency key, container_id, state, instagram_media_id), `agent_settings` (autonomy mode, limits, windows, budgets), `notifications`, `webhook_events`.

Existing `posts` and `boardCards` stay in the JSON state through Phases 1–5. `publishing_jobs` links to a post by ID in Phase 6, so nothing is migrated destructively.

**New modules (`lib/`):** `sql.mjs` (db access), `tasks/queue.mjs`, `supervisor.mjs`, `meta/graph.mjs` (read-only Graph client + metric registry), `agents/{monitor,analytics,researcher,strategist,creative,safety,publisher}.mjs`, `autonomy.mjs`.

**Routes (existing ones untouched):** `/api/monitor/*`, `/api/analytics/*`, `/api/tasks/*`, `/api/settings/automation`, `/api/notifications`, plus later `/api/opportunities`, `/api/content/*`, `/api/publishing/*`, `/api/webhooks/meta`. Each: owner session, account check, input validation, audit event.

**Frontend:** extend the existing page with new sections in separate script files (as `content-board.js` already does) instead of enlarging the inline script.

## 8. Phase 1 plan (Instagram Monitor) and an open dependency

Use the existing `IG_*` credentials via `graph.facebook.com` (same host and token type as `publishDirect`). Planned calls: profile fields, `/{ig-user}/insights` for account metrics, `/{ig-user}/media` for recent media, `/{media}/insights` per media. **Which metric names and `metric_type`/period combinations are currently valid depends on the Graph API version in `IG_GRAPH_API_VERSION`, and Meta has been deprecating metrics (e.g. `impressions`, `plays`).** I will verify the current metric list against Meta's documentation before writing the metric registry, store anything the API rejects as null with the reason, and never infer it.

## 9. Implementation sequence

1. SQL layer, migrations (+ down), extended in-memory test stub, `audit_events`.
2. Task queue + supervisor + `/api/worker/tick` (idempotency, retry/backoff, timeouts, cancel, restart recovery tests).
3. Phase 1 Monitor + Command Center/Monitor dashboard sections.
4. Phase 2 Analytics & Learning.
5. Phase 3 Researcher + Strategist; Phase 4 Creative; Phase 5 Safety Reviewer (before any new publishing path).
6. Phase 6 publishing jobs, container-ID polling, reconciliation.
7. Phase 7 autonomy modes, bounded limits, kill switch extension.
8. Phase 8 webhooks.

## 10. Potential regressions to guard

Board approval → scheduling → worker publish path; kill-switch defaulting to ON; `delivery_unknown` never auto-retried; `/api/state` response shape (dashboard depends on it); upload reservations; Gemini daily caps; auth/origin checks. Each gets a regression test before its neighbouring code changes.

## 11. Environment and permissions

No new variables are needed for Phase 1–2 (existing `IG_*`, `DATABASE_URL`, `CRON_SECRET`). Likely later additions: `META_APP_SECRET` (webhook signature, and `debug_token`), `META_WEBHOOK_VERIFY_TOKEN`, optional `MONITOR_*` interval overrides. Insights require `instagram_manage_insights`; webhook comments need `instagram_manage_comments`. Confirm which scopes the current token holds before relying on them; do not request more than needed.

## 12. Verification statement

All results above are from mocked/stubbed tests. **No real Meta, Neon, Gemini or Cloudinary call was made**, and none will be made without explicit authorization. In particular no real publishing test will run.
