# Creator OS architecture

Dashboard
  -> Agent orchestrator
  -> Modular skills
  -> Content planning and generation
  -> Safety and publishing policy
  -> Scheduler / worker
  -> Publishing adapter (direct Meta Graph API)
  -> Instagram
  -> Audit log and analytics

## Boundaries
- Agent core never handles Instagram passwords.
- Skills are versioned instructions with narrow tool contracts.
- Content assets must be user-owned, licensed, or otherwise approved.
- Policy engine checks account permissions, media rights, quotas, kill switch and duplicate-delivery risk.
- Publisher adapters isolate platform details from orchestration.
- Every state transition and external publishing result is audited.

## Publishing delivery
1. The worker claims one due, scheduled post with a version-checked database update, so two runs cannot publish the same item.
2. It creates an Instagram media container, waits for processing, then publishes it.
3. Uncertain outcomes become `delivery_unknown` and are never retried automatically; this avoids duplicate content.
4. Legacy `awaiting_confirmation` items from the removed Zapier bridge can be cancelled from the dashboard.

## Full autonomy
Full autonomy is bounded autonomy. It remains disabled until authentication, permissions, idempotency, durable storage, quotas, monitoring and kill-switch controls are verified. Failures or uncertain outcomes pause for review.

## Production target
Authenticated dashboard, transactional database, durable queue, encrypted secrets, public media storage, idempotent callbacks, monitoring, account-scoped quotas and controlled deployment.
