# Phase 3: Opportunity Researcher and Content Strategist

## What it does
- **Researcher** (`researcher.discover`, weekly or on request) records *opportunities*, each with an evidence class, confidence, research date and source URLs.
- **Strategist** (`strategist.plan_week`, on request only) proposes a rolling 7-day plan from opportunities plus the Analytics agent's confidence-filtered recommendations.
- The owner can accept/reject opportunities, edit/reject plan items, and send an item to the Content Board.

## Evidence classes (never blended)
| class | meaning |
|---|---|
| `account_analytics` | Derived from your own stored metrics or captions. Associations, not proven cause. |
| `ai_hypothesis` | Idea from the existing Gemini text provider. Always `low` confidence, no sources, labelled "not a verified trend". |
| `external_research`, `verified_fact` | Reserved for a configured research adapter that supplies source URLs. **No adapter is built in, so nothing is labelled this way today** and the API reports `externalResearch: "not_configured"`. |

No trend, statistic or source is ever invented. AI ideas are produced only when `GEMINI_TEXT_ENABLED=true`, a key exists, niche and pillars are set, and the daily text cap (existing usage ledger) allows it; otherwise the reason is recorded in the task output.

## Planning rules
- Accepted opportunities first, then by confidence and evidence class.
- Rejected or already-planned opportunities are skipped.
- Duplicates (token Jaccard >= 0.5) against recent captions (60 days), existing plan items and Content Board cards are skipped.
- If evidence is thin, **fewer items are proposed** (the task output says so). No filler.
- A format recommendation from analytics (e.g. Reels) biases the default format only when the opportunity has none.
- Regenerating replaces only future `proposed` items; edited, rejected and converted items are kept.
- Converting an item creates a Content Board card with status `needs_media`. It still needs media, safety review and owner approval. Agents cannot approve, schedule or publish.

## Database (migration `0004_strategy`, reversible)
`content_opportunities`, `content_plan_items`, and column `agent_settings.strategy`. `down` drops only these.

## Routes (owner session, account-scoped, origin-checked, audited)
`GET /api/strategy/overview`, `POST /api/strategy/settings`, `POST /api/strategy/research`, `POST /api/strategy/plan` (both idempotent per minute), `POST /api/strategy/opportunities/:id/(accept|reject)`, `POST /api/strategy/plan/:id` (edit or `{reject:true}`), `POST /api/strategy/plan/:id/to-board`.

## Env vars
None new. Uses `GEMINI_TEXT_ENABLED`, `GEMINI_API_KEY`, `MAX_TEXT_GENERATIONS_PER_DAY`.

## Limitations
- No external web/trend research (needs a provider decision from the owner).
- Pillar-gap detection is a caption keyword match; image-only themes can be missed.
- Hooks are not generated yet (Phase 4 Creative); owner can type one.
- Verified only with pglite and mocked Gemini; no real Gemini/Neon check.

## Rollback
`node --env-file-if-exists=.env scripts/migrate.mjs down` (one step), or leave tables unused: no legacy path depends on them.
