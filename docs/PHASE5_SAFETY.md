# Phase 5: Safety Reviewer

## Verdicts
Exactly four: `approved`, `needs_revision`, `human_review`, `blocked`. Precedence: blocked > needs_revision > human_review > approved. `approved` requires **zero** findings.

## How it decides
Deterministic rules (`lib/safety/rules.mjs`, version `2026-11-v1`), not an AI model, so a rule cannot be argued away.
- **blocked:** credential/private key in caption, no media, non-HTTPS media, unknown format, any owner-blocked term.
- **needs_revision:** caption too short/long, >30 or duplicate hashtags, shouting, >5 mentions, absolute claims ("guaranteed", "cure"), "trending" claims, email/phone in caption, near-duplicate of a recent caption.
- **human_review:** engagement bait/giveaways, promotional wording (disclosure check), health or finance wording, owner review terms, media from an external URL (rights cannot be verified).

Rules are keyword and pattern heuristics. They will miss things and will flag harmless text; they are a floor, not a guarantee. They do not judge images or video.

## Binding to content
Each review stores a hash of caption, media URL, format and alt text. Editing any of them makes the review **stale**; only a **current** review counts. Reviews are append-only (history is kept, no update path).

## What it can and cannot do
- The agent only INSERTs reviews. It has no access to settings, autonomy, the kill switch or approval functions, so it cannot loosen a rule or approve content.
- The owner (authenticated route only) can set extra blocked and review terms. Learning/analytics never touch these.

## Effect on the existing approval flow (backward compatible)
- A **current `blocked`** review makes `POST /api/board/:id/approve` return 409 with the findings.
- Unreviewed, stale, `needs_revision` or `human_review` cards can still be approved by the owner (the owner's approval is the human decision). The response reports `safety: {state, status}`.
- If migrations are not applied or the check errors, owner approval proceeds as before (`state: "unavailable"`).
- **Phase 6 autonomous publishing will fail closed instead:** it will require a current `approved` review.

## Database (migration `0006_safety`, reversible)
`safety_reviews`, column `agent_settings.safety`.

## Routes (owner session, account-scoped, audited)
`GET /api/safety/reviews[?cardId=]`, `POST /api/safety/cards/:id/review`, `POST /api/safety/settings`. Dashboard: "Safety review" button on each Content Board card.

## Env vars
None.

## Limitations
Text-only heuristics; no image/video analysis; no external moderation service; verified with pglite only.

## Rollback
`scripts/migrate.mjs down` (one step). The approval gate reverts to "unavailable" and legacy behaviour.
