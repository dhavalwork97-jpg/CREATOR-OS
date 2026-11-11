# Phase 2 — Analytics & Learning

A daily task (`analytics.compute`, scheduled by the worker tick, also runnable from the dashboard) turns **stored** Meta metrics into observations and recommendations. It makes no external calls and cannot change permissions.

## What it analyses
At one observation checkpoint at a time (`d7`, else `h72`, else `h24`, whichever has enough posts; checkpoints are never mixed), per post:
reach, saves per reach, shares per reach, interactions per reach, compared across
- **format** (Reels vs feed posts)
- **time of day** (night/morning/afternoon/evening in the configured posting timezone, `POSTING_UTC_OFFSET_MINUTES`)

Also: strongest/weakest posts (observation only) and 7- and 30-day follower change from stored profile snapshots.

## Rules that keep it honest
- A comparison needs at least **5 posts in each of two groups**; otherwise the row is `insufficient_data` with the reason.
- **Medians**, a lead of at least **25%**, and the lead must survive removing the leading group's single best post. One viral or failed post cannot produce a recommendation.
- A metric Meta did not return is excluded, never treated as 0. Zero or missing reach gives no rate.
- Confidence: `none` (<5 per group), `low`, `medium` (8+ per group), `high` (15+ per group and 40%+ lead).
- Wording is associative. Every recommendation states sample size, confidence, window and the caveat that topic, timing and audience were not controlled.
- Rows are stored in `performance_insights` (migration `0003_analytics`, reversible), one per (kind, group, day).

## Feedback loop
`strategistFeedback(accountId)` returns only `recommendation` rows with confidence low or higher, as structured objects (observation, supporting metrics, sample size, confidence, suggested action, window). The Content Strategist (Phase 3) will read this; it is also exposed at `GET /api/analytics/report`.

## Separation from permissions
The analytics modules contain no reference to `agent_settings`, autonomy, the kill switch, safety rules or publishing; a test greps the source to enforce this, and another asserts settings are unchanged after a run.

## Routes (owner session, account-scoped)
`GET /api/analytics/report`, `POST /api/analytics/run` (idempotent per minute).

## Not implemented yet (and why)
- **Topic, hook and content-pillar performance:** these need content metadata (topic, pillar, hook) that only exists once the Strategist and Creative agents tag posts (Phases 3–4). Posts published before that cannot be classified without guessing, so they are not.
- **Likes/comments rates** are not in the comparison set (likes and comments are mostly reach-driven noise at small sizes); the raw values stay stored and visible.
- **Weekly report and notifications** arrive with the notification system.
- **1-hour checkpoint** analysis is not used for comparisons because it is too early to be stable; it is still stored.

## Verification status
Mocked/stored-data tests on real Postgres semantics only. With few posts the dashboard will correctly say "not enough data" for weeks; that is intended.
