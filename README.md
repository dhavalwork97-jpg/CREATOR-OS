# Creator OS

A free-first modular creator agent for Instagram. This repository is separate from all existing projects.

## MVP foundation
- Minimal dashboard and API
- Local JSON post queue and audit history
- Scheduled worker
- Modular skills under skills/
- Instagram Graph API publishing adapter for image posts and Reels
- Emergency kill switch, post cancellation, daily cap and minimum spacing
- Make.com webhook adapter contract documented in architecture

## Run locally
Requires Node.js 20+.

```bash
cp .env.example .env
npm run check
npm start
```

Open http://localhost:3000.

## Instagram requirements
The direct publisher requires an Instagram Creator or Business professional account, Meta app permissions, an access token and public HTTPS media URLs. Never provide your Instagram password to this app.

## Make.com
Make can receive a webhook from Creator OS and run its Instagram publishing module. However, Make still requires you to authorize Instagram/Meta. Make's documented Facebook Login connector requires an Instagram Business account linked to a Facebook Page with a Facebook admin. Its documentation currently says Creator accounts are not supported by that connector. If you want to keep Creator, verify whether a supported Instagram Login connector is available in your Make account before switching account type.

## Safety
Auto-publishing is disabled by default. Dashboard authentication is not implemented, so run locally only. JSON storage is single-process development storage and must be replaced with a transactional database and durable queue before public deployment. Never commit .env or expose tokens in browser code.

## Roadmap
1. Account connection and secure token storage
2. AI content planning and caption skills
3. Media pipeline adapter to reuse the existing vertical-video pipeline without modifying it
4. Make.com adapter and delivery receipts
5. Transactional persistence, durable jobs, authentication and deployment hardening
6. Insights and performance feedback loop