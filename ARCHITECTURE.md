# Creator OS architecture

Dashboard
  -> Agent orchestrator
  -> Modular skills
  -> Content planning and generation
  -> Safety and publishing policy
  -> Scheduler / worker
  -> Publishing adapter (Zapier webhook OR direct Meta API)
  -> Instagram
  -> Authenticated delivery callback
  -> Audit log and analytics

## Boundaries
- Agent core never handles Instagram passwords.
- Skills are versioned instructions with narrow tool contracts.
- Content assets must be user-owned, licensed, or otherwise approved.
- Policy engine checks account permissions, media rights, quotas, kill switch and duplicate-delivery risk.
- Publisher adapters isolate platform details from orchestration.
- Every state transition and external publishing result is audited.

## Zapier asynchronous delivery
1. Creator OS POSTs a scheduled item to the Zapier Catch Hook.
2. A successful webhook HTTP response means only that Zapier accepted the trigger.
3. Zapier runs the matching Instagram photo/carousel or Reel action.
4. A final Zapier Webhooks POST calls `/api/publishing/callback` with the post ID, outcome and Instagram media ID.
5. The callback must include the shared `X-Creator-OS-Callback-Secret` header. Only a valid callback can move an item to published/failed.
6. Uncertain delivery is not blindly retried; this avoids duplicate content.

## Full autonomy
Full autonomy is bounded autonomy. It remains disabled until authentication, permissions, idempotency, durable storage, quotas, monitoring and kill-switch controls are verified. Failures or uncertain outcomes pause for review.

## Production target
Authenticated dashboard, transactional database, durable queue, encrypted secrets, public media storage, idempotent callbacks, monitoring, account-scoped quotas and controlled deployment.
