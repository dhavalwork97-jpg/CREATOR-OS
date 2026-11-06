# Creator OS architecture

Dashboard
  -> Agent orchestrator
  -> Modular skill registry
  -> Content planning and generation
  -> Safety and publishing policy
  -> Scheduler / durable worker
  -> Publishing adapter (Meta Graph API OR Make.com webhook)
  -> Instagram
  -> Audit log and analytics

## Boundaries
- Agent core plans and selects skills; it never handles Instagram passwords.
- Skills are versioned instructions with narrow tool contracts.
- Content assets must be user-owned, licensed, or otherwise approved.
- Policy engine checks account permissions, claims, media rights, quotas, idempotency and kill switch.
- Publisher adapters isolate Meta API details from orchestration.
- Audit records every state transition and external publishing result.

## Full autonomy
Full autonomy is bounded autonomy: the agent can plan, draft, edit, schedule and publish approved types of content without per-post confirmation. It cannot bypass policy checks. Sensitive claims, unclear asset rights, platform errors, uncertain publish outcomes, or unusual activity must pause for review.

## Production target
Next.js dashboard, TypeScript services, transactional database, durable queue, encrypted OAuth tokens, public media storage, monitoring, idempotent retries, account-scoped quotas and authenticated admin access.

## Make.com option
Make can act as a publishing adapter via a webhook scenario. Its Instagram connector still requires an authorized Meta/Instagram connection. It is orchestration, not a way to avoid Meta permissions.