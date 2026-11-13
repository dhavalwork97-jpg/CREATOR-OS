# Phase 4: Creative Production

## What it does
`creative.draft_package` (owner-requested per plan item) writes a **text-only** creative package: caption, hashtags, hook, CTA, media prompt, alt text and, for Reels, a shot list.

## What it deliberately does not do
- **No image or video generation.** The existing image endpoint is paid by default and needs the owner's explicit confirmation; the Creative agent never calls it. The package contains a media prompt the owner can use there, or replace with their own media.
- **No approval, scheduling or publishing.** A package has no `approved` state. Applying one updates a Content Board card's caption/prompt/alt text; the card stays `needs_media` / `ready` and still needs media, the Phase 5 safety review and owner approval. Cards that are already scheduled or published cannot be changed.
- **No fabricated facts.** The prompt forbids statistics, trends, sources and promised results. Validator warnings flag "trending" and absolute-claim wording.

## Provider and cost
Reuses the existing Gemini text provider through `lib/agents/text-dep.mjs`, which uses the legacy usage ledger (daily cap `MAX_TEXT_GENERATIONS_PER_DAY`, 429 back-off). If the provider is off, unconfigured, capped or returns invalid output, a plain template is used and the package is labelled `source: template`. Strategy's research now uses the same shared path.

## Validation (format only, not safety)
Caption + hashtags <= 2200 chars, <= 30 valid unique hashtags, media prompt 20-2000 chars, alt text <= 100 chars, reel <= 8 shots and <= 90 s. Invalid model output is replaced by the template rather than truncated. Invalid owner edits set `needs_fixes` and block applying.

## Database (migration `0005_creative`, reversible)
`creative_packages` (versioned per plan item; new drafts supersede unedited older ones; owner-edited ones are kept).

## Routes (owner session, account-scoped, audited)
`GET /api/creative/packages[?planItemId=]`, `POST /api/creative/plan/:id/draft` (idempotent per minute), `POST /api/creative/packages/:id` (edit + revalidate), `/reject`, `/apply`.

## Env vars
None new.

## Limitations
No real media production. Verified with pglite and a mocked text provider only. Format validation is not content safety: Phase 5 adds the Safety Reviewer.

## Rollback
`scripts/migrate.mjs down` (one step) drops `creative_packages`; nothing else depends on it.
