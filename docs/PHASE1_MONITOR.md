# Phase 1 — Instagram Monitor

Read-only monitoring of the connected account using the **existing** `IG_GRAPH_API_VERSION`, `IG_USER_ID`, `IG_ACCESS_TOKEN`. No second auth system, no new environment variables, no new Meta permissions requested by this code.

## What runs
Registered by the worker tick (`GET /api/worker/tick`), one task per interval bucket (idempotent, survives restarts):

| Task | Default | Graph calls (GET only) |
|---|---|---|
| `monitor.account_health` | 6 h | `/{ig-user}?fields=username,followers_count,follows_count,media_count` |
| `monitor.media_sync` | 6 h | `/{ig-user}/media` (25 most recent) |
| `monitor.account_insights` | 24 h | `/{ig-user}/insights` per metric, `period=day`, `metric_type=total_value`, previous UTC day |
| `monitor.media_insights` | 24 h | `/{media}/insights` at due checkpoints, max 15 items per run |

Intervals are editable on the dashboard (`POST /api/monitor/settings`), with enforced minimums (health 15 min, media sync 60 min, insights 6 h). The GitHub Actions cron is every 5 minutes, so the real cadence is "at least the interval, at most about 5 minutes late". The brief's 15-minute publishing reconciliation belongs to Phase 6.

## Data rules
- Only values returned by Meta are stored. A metric Meta does not return is **absent from `metrics`** and recorded in `unavailable` with a reason (`no_data_returned`, `not_returned`, or the Graph error code). A real `0` is kept as `0`.
- Every row has `collected_at` and a `source` string. Insights rows also store the requested window.
- Insert-only history. Account insights are unique per window; media insights are unique per (media, checkpoint). A failed or partial run writes nothing and cannot overwrite earlier rows.
- Network, 5xx and rate-limit failures retry with backoff and never create an "unavailable" row. Only Meta's definitive answers are recorded as unavailable.
- Checkpoints (`h1`, `h24`, `h72`, `d7`) are only labelled when the observation falls inside the window. A post first seen later gets one `baseline` row, never a fake checkpoint label.
- Stories, ads and unknown media types are not requested.

## Metrics requested (verified against Meta docs on 2026-11-10)
Media (Feed): reach, views, likes, comments, shares, saved, total_interactions. Reels add `ig_reels_avg_watch_time`. `impressions` (deprecated for media after 2024-07-02) and `plays` are **not** requested.
Account (day totals): reach, views, accounts_engaged, total_interactions, likes, comments, saves, shares, replies, reposts, follows_and_unfollows. `impressions` (deprecated 2025-04-21) is not requested. Meta documents that `follows_and_unfollows` is not returned under 100 followers; those show as "not available".
Carousel children, and Meta's own limits such as the 48 h data delay, apply. Re-check the metric list when changing `IG_GRAPH_API_VERSION`.

## Token health
A Graph error code 190 marks the account `token_status = invalid` / `connection_status = error`, writes an audit event once, and is **not** retried. The next successful health check sets it back to `valid` and records `token_recovered`. Token *expiry dates* are not available from the stored env token, so "expiring soon" is not reported; it is not invented.

## Routes (owner session required, account-scoped)
`GET /api/monitor/overview`, `POST /api/monitor/settings`, `POST /api/monitor/run` (queues read-only health and media-sync tasks, at most one per minute).

## Database (migration `0002_monitor`, additive, reversible)
`account_snapshots`, `media_items`, `media_insights`. Rollback: `node --env-file-if-exists=.env scripts/migrate.mjs down` (removes only these three tables).

## Verification status
- **Mocked:** all Graph behaviour is tested against mocked responses shaped like Meta's documented payloads and error codes, on real Postgres semantics (pglite).
- **Not verified:** no real Meta call has been made. Before relying on it, run the migration on a Neon branch, deploy, trigger "Refresh now", and check the dashboard against the Instagram app. Insights permission (`instagram_manage_insights`) on the current token is unconfirmed; without it the dashboard will show metrics as unavailable with the Graph error code.
