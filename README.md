# Creator OS

A free-first modular creator agent for Instagram. This repository is separate from all existing projects.

## MVP foundation
- Dashboard and API with local JSON queue/audit log
- Scheduled worker and modular skills
- Direct Instagram Graph API adapter (optional)
- Zapier webhook publishing adapter for Creator and Business professional accounts
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

## Zapier publishing route (Instagram Creator)

Zapier's official Instagram for Business integration supports Creator and Business professional accounts linked to a Facebook Page. The Facebook profile used to connect must have permission to create content on that Page. The integration provides **Publish Photo(s)** and **Publish Video** (Reels) actions.

1. In Zapier, create a Zap with **Webhooks by Zapier → Catch Hook** as its trigger.
2. Copy the Catch Hook URL into `ZAPIER_PUBLISH_WEBHOOK_URL`.
3. Add **Instagram for Business → Publish Photo(s)** for image posts and **Publish Video** for Reels. Use Paths/Filter so each post type reaches the matching action. Map `mediaUrl` to the media/video field and `caption` to Caption.
4. Add a final **Webhooks by Zapier → POST** action. Set its URL to `https://YOUR-CREATOR-OS-HOST/api/publishing/callback`, payload type JSON, and map:
   - `postId` = Catch Hook `postId`
   - `status` = literal `published`
   - `externalPostId` = the Instagram action's returned media/post ID (if the action exposes it)
   Add header `X-Creator-OS-Callback-Secret` with the exact value of `ZAPIER_CALLBACK_SECRET`.
5. For the Instagram action's error path, add a separate callback with `postId`, `status=failed`, and an error message. Do not send a success callback unless the Instagram action succeeded and returned an external ID.
6. Deploy Creator OS to a public HTTPS host before enabling callbacks. Set `CREATOR_OS_PUBLIC_URL` to that origin. Set the Catch Hook URL, a long random `ZAPIER_CALLBACK_SECRET`, and keep `ENABLE_AUTOPUBLISH=false` while testing.
7. Test an image and a Reel manually. Verify each appears on Instagram and Creator OS changes from `awaiting_confirmation` to `published`. Only then consider enabling automatic publishing.

Creator OS sends this JSON event to Zapier: `event`, `postId`, `type`, `caption`, `mediaUrl`, `scheduledAt`, and `callbackUrl`. Zapier's initial Catch Hook response only confirms receipt. Creator OS waits for the authenticated callback before recording success. Ambiguous network delivery is marked `delivery_unknown` and is not automatically retried, to avoid accidental duplicate posts.

**Plan note:** Zapier's current documentation lists Catch Hook as unavailable on its Free plan; Professional or higher is required for that trigger. Check your Zapier plan before building the workflow.

## Security and deployment status

This is still a development MVP. Dashboard/API routes other than the callback do not yet have user authentication, and JSON storage is single-process development storage. Do not expose this server publicly or enable unattended publishing until authentication, persistent transactional storage, secrets management, HTTPS deployment, rate limits and operational monitoring are implemented. Never commit `.env`, expose tokens in browser code, or share the private webhook URL / callback secret.

## Media requirements
The Instagram action requires media that Zapier/Meta can fetch. Use publicly accessible HTTPS URLs; do not use local file paths or private Dropbox links.

## Existing media pipeline
The existing Hugging Face vertical-video pipeline is not modified. A future adapter can pass its finished public media URLs into Creator OS.

## Roadmap
1. Secure dashboard authentication and persistent storage
2. Harden callback reconciliation and delivery idempotency
3. Reuse the existing vertical-video pipeline through a separate adapter
4. Add content planning, analytics and performance feedback

## Vercel + Neon deployment

The Vercel app uses a Vercel Node.js Function for API requests and Neon Postgres for durable state. The local `server.mjs` entry point uses the same request handler for development; JSON files are no longer used for application state.

### Required Vercel environment variables

- `DATABASE_URL`: supplied by the Neon Marketplace integration.
- `NEON_AUTH_BASE_URL`: supplied by Neon Auth when Auth is enabled for the connected database.
- `OWNER_EMAIL`: the single email address allowed to sign in to this Creator OS instance.
- `CRON_SECRET`: a random secret of at least 32 characters used by the worker endpoint.
- Keep `ENABLE_AUTOPUBLISH=false` until authentication, callbacks and a real test publish have been verified.

The login page supports creating the initial owner account and signing in through Neon Auth. The API proxies only the required auth endpoints and checks that the active session email exactly matches `OWNER_EMAIL`. All queue, state and kill-switch APIs require that owner session. The publishing callback and worker use separate shared secrets.

### Scheduled worker

Vercel Hobby cron is limited to once per day, which is not suitable for scheduled social posts. The repository includes a GitHub Actions worker that checks every five minutes. Configure these **GitHub repository Actions secrets** after the preview app is ready:

- `CREATOR_OS_URL`: the HTTPS URL of the deployed Creator OS app.
- `CREATOR_OS_CRON_SECRET`: the same value as Vercel's `CRON_SECRET`.

If Vercel Deployment Protection is enabled for the preview URL, the workflow also needs a Vercel protection-bypass secret header; do not disable deployment protection just to make the worker work. The worker endpoint is idempotent and claims a due item with a version-checked database update. Uncertain publish attempts are marked for review rather than blindly retried.

### Safety

The default database state starts with the kill switch ON. Autopublishing remains disabled unless `ENABLE_AUTOPUBLISH=true` is explicitly configured. Never put Instagram tokens, database URLs, or worker secrets in browser code or GitHub commits. The legal website project is separate and is not changed by this application.
