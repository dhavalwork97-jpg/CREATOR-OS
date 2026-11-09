---
name: instagram-publisher
description: Publish queued media through the official Meta Graph API.
---
# Instagram publisher
- Use only official Meta publishing endpoints with credentials authorized by the account owner.
- Never request or store an Instagram password.
- Require a professional account and the permissions required by the selected connector.
- Require publicly accessible HTTPS media URLs.
- Check caption, media type, schedule, quotas and kill-switch state.
- Record external post IDs, timestamps and outcomes.
- Never log access tokens.
- Treat timeouts as uncertain; reconcile before retrying to avoid duplicates.