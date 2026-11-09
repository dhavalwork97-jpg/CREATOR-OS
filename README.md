# Creator OS

A free-first modular creator agent for Instagram. This repository is separate from all existing projects.

## MVP foundation
- Dashboard and API with local JSON queue/audit log
- Scheduled worker and modular skills
- Direct Instagram Graph API adapter (optional)
- Direct Instagram publishing through the official Meta Graph API
- Authenticated asynchronous delivery callback; webhook acceptance is never treated as proof of publication
- Emergency kill switch, cancellation, daily cap and minimum spacing

## Run locally
Requires Node.js 20+.

```bash
cp .env.example .env
npm run check
npm start
```

Open http://localhost:3000.

## Security and deployment status

Creator OS uses owner-only dashboard/API authentication and Neon Postgres in the deployed app. Keep unattended publishing disabled until delivery reconciliation and operational safeguards are complete. Never commit `.env`, expose tokens in browser code, or share the private webhook URL / callback secret.

## Media requirements
Instagram must be able to fetch your media, so use publicly accessible HTTPS URLs; do not use local file paths or private Dropbox links.

## Existing media pipeline
The existing Hugging Face vertical-video pipeline is not modified. A future adapter can pass its finished public media URLs into Creator OS.

## Milestone 5 — Autonomous Creator Agent

The first approval-first agent workspace is available in the dashboard. It creates a transparent, rules-based weekly content blueprint from the owner's niche, audience, objective and content pillars. Each idea is saved for review and can be approved or rejected.

Current boundaries:
- This first planner does not call an LLM, scrape trends, generate media, or claim performance insights.
- Approving a blueprint records editorial approval only; it does not create a publish job or publish to Instagram.
- The existing manual publisher remains available. Scheduled publishing remains controlled by `ENABLE_AUTOPUBLISH` and the emergency kill switch.
- Future agent capabilities should be added behind explicit tools and approval gates: opportunity research, model-assisted drafts, media-pipeline import, analytics feedback and finally supervised execution.

## Roadmap
1. Secure dashboard authentication and persistent storage — complete
2. Harden callback reconciliation and delivery idempotency
3. Reuse the existing vertical-video pipeline through a separate adapter
4. Add content planning, analytics and performance feedback
5. Autonomous Creator Agent — approval-first planning foundation in progress

## Vercel + Neon deployment

The Vercel app uses a Vercel Node.js Function for API requests and Neon Postgres for durable state. The local `server.mjs` entry point uses the same request handler for development; JSON files are no longer used for application state.

### Required Vercel environment variables

- `DATABASE_URL`: supplied by the Neon Marketplace integration.
- `NEON_AUTH_BASE_URL`: supplied by Neon Auth when Auth is enabled for the connected database.
- `OWNER_EMAIL`: the single email address allowed to sign in to this Creator OS instance.
- `OWNER_SETUP_SECRET`: a temporary random code required only to create the first owner account; remove it from Vercel after signup.
- `CRON_SECRET`: a random secret of at least 32 characters used by the worker endpoint.
- Keep `ENABLE_AUTOPUBLISH=false` until authentication, callbacks and a real test publish have been verified.

The login page supports creating the initial owner account and signing in through Neon Auth. Initial account creation requires `OWNER_SETUP_SECRET` and is restricted to `OWNER_EMAIL`; remove the setup secret after the account is created. The API proxies only the required auth endpoints and checks that the active session email exactly matches `OWNER_EMAIL`. All queue, state and kill-switch APIs require that owner session. The publishing callback and worker use separate shared secrets.

### Scheduled worker

Vercel Hobby cron is limited to once per day, which is not suitable for scheduled social posts. The repository includes a GitHub Actions worker that checks every five minutes. Configure these **GitHub repository Actions secrets** after the preview app is ready:

- `CREATOR_OS_URL`: the HTTPS URL of the deployed Creator OS app.
- `CREATOR_OS_CRON_SECRET`: the same value as Vercel's `CRON_SECRET`.

If Vercel Deployment Protection is enabled for the preview URL, the workflow also needs a Vercel protection-bypass secret header; do not disable deployment protection just to make the worker work. The worker endpoint is idempotent and claims a due item with a version-checked database update. Uncertain publish attempts are marked for review rather than blindly retried.

### Safety

The default database state starts with the kill switch ON. Autopublishing remains disabled unless `ENABLE_AUTOPUBLISH=true` is explicitly configured. Never put Instagram tokens, database URLs, or worker secrets in browser code or GitHub commits. The legal website project is separate and is not changed by this application.

## Weekly content board

The owner-only dashboard includes an approval-first weekly content board. It creates editable cards from the existing rules-based planner, with an original-media prompt, editable caption, content pillar, format, date and suggested posting slot. Posting-slot suggestions use Ahmedabad time (UTC+05:30) unless `POSTING_UTC_OFFSET_MINUTES` is explicitly configured.

- Each card must be reviewed and individually approved before it is added to the existing scheduled-post queue.
- Approval schedules a post; it does not publish immediately. The existing scheduler, kill switch, publisher and auto-publishing setting remain authoritative.
- Attach media by providing a direct, publicly accessible HTTPS URL. The app does not host binary uploads and this feature adds no object-storage service.
- No new authentication system or database is introduced. Board cards are stored in the existing owner-scoped Neon state.
- Cards can be edited or discarded before scheduling. Cancelling a scheduled post returns its card to the ready state.


## Gemini image generation
Optional original-image generation is disabled by default. It requires a server-side GEMINI_API_KEY and explicit GEMINI_IMAGE_GENERATION_ENABLED=true. API billing is separate from a consumer Gemini subscription. Attempts are capped (default 2/day, maximum 5); failed attempts count. Previews are temporary and are not persisted, scheduled or published. No new storage service or credentials are configured.

## Providers, usage and costs

The **Providers & usage** panel shows each provider, its model, today's usage against your daily limit, and whether it is free or paid.

- **Gemini text** is opt-in (`GEMINI_TEXT_ENABLED=true` plus `GEMINI_API_KEY`). It is free only while the key belongs to a Google project **without billing**. In that setup, hitting the free limit returns an error (Creator OS then pauses calls for the `Retry-After` time, or 15 minutes) instead of charging you. Free-tier prompts may be used by Google to improve its products.
- Pick the model in the dashboard (it lists the models your key can use) or set `GEMINI_TEXT_MODEL`. Only some models have a free tier; check Google's pricing page.
- **Gemini image** generation is treated as **paid** and stays off by default. Each generation needs an explicit confirmation, shows your configured estimate (`GEMINI_IMAGE_COST_USD_PER_IMAGE`), and counts against a daily cap. A free text model cannot generate images.
- Creator OS never switches providers automatically. The API key is only used on the server and never appears in responses.

## Media storage (Cloudinary, free plan)

Instagram downloads your media from a public HTTPS URL, and Reels are too large to send through a serverless function. So the browser uploads straight to **your own Cloudinary account** using a short-lived request signed by the server. You can still paste a public URL instead.

**What it costs.** The Cloudinary Free plan needs **no credit card or other payment details**, so it cannot charge you. It includes 25 monthly credits shared by storage, bandwidth and transformations (1 credit is 1 GB of storage, 1 GB of bandwidth or 1,000 transformations), with a 10 MB limit per image and 100 MB per video. If you ever exceed the allowance, Cloudinary may restrict your account instead of billing you. Creator OS stays well inside it with its own limits (defaults: 3 GB stored, 20 uploads per day, 8 MB per image, 100 MB per video; see `.env.example`) and deletes a file from Cloudinary when you replace or discard it. Check Cloudinary's pricing page for current terms.

**Setup (about five minutes)**
1. Sign up for the free plan at cloudinary.com (email, Google or GitHub; no card).
2. In the dashboard open *Settings > API Keys* and copy your **cloud name**, **API key** and **API secret**.
3. In Vercel add `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` as server-side environment variables and redeploy. No bucket, public-access or CORS settings are needed.

**How uploads are protected.** The server signs each upload for one card, one random file name and one file type (JPEG for images, MP4 or MOV for Reels), so Cloudinary itself rejects anything else. The API secret never reaches the browser. Before a card becomes *Ready* the server checks that the file is publicly reachable with the expected type and size. Uploaded files are publicly fetchable by anyone who knows their (unguessable) URL, so do not upload anything private. PNG and WebP images are converted to JPEG in your browser, and images outside Instagram's 4:5 to 1.91:1 range are rejected with a clear message.
