---
name: instagram-publisher
description: Publish queued media through Meta Graph API or an authorized Make.com scenario.
---
# Instagram publisher
- Use official Meta publishing endpoints or a Make.com connection authorized by the account owner.
- Never request or store an Instagram password.
- Require a professional account and the permissions required by the selected connector.
- Require publicly accessible HTTPS media URLs.
- Check caption, media type, schedule, quotas and kill-switch state.
- Record external post IDs, timestamps and outcomes.
- Never log access tokens.
- Treat timeouts as uncertain; reconcile before retrying to avoid duplicates.