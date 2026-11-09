# Creator OS 2.0 — Engineering Handoff

## Purpose

This document is the starting brief for the next development phase of Creator OS. The immediate prerequisite is to integrate and verify the supplied PR0, PR1, and PR2 patch series. Creator OS 2.0 work should build on that verified baseline, not bypass it.

## Repository baseline

- Repository: `dhavalwork97-jpg/CREATOR-OS`
- Base branch: `main`
- Verified base commit: `f5b341e6f5b17f2b9f33be7838b110abba4805fa`
- Working branch: `feature/integrate-pr0-pr1-pr2`
- The working branch was created from the verified base and, at handoff creation, contains no code changes yet.

## Required prerequisite: integrate the patch series

The uploaded `CREATOR-OS-prs-0-2.zip` contains three stacked patches and an integrated snapshot under `CREATOR-OS-prs/repo`.

Apply patches in this exact order:

1. PR0 — remove Zapier bridge, unify timezone configuration, add integration-test harness.
2. PR1 — provider layer, opt-in Gemini free-tier text adapter, usage ledger/daily cap, cooldown handling, provider dashboard.
3. PR2 — optional Cloudinary media storage and signed browser uploads, preserving URL-attachment fallback.

Before applying, confirm the local checkout is clean and based on the verified base commit above. Apply each patch sequentially; stop and investigate any conflict rather than forcing it. Do not copy the integrated snapshot over the repository blindly.

After integration, run:

- `npm ci`
- `npm run check`
- `npm test`

The reviewed integrated snapshot previously passed 37 unit tests and 26 integration tests (63 total). This is a reference result, not proof that the local patch application or live external integrations work. Re-run all checks in the actual checkout and report the results.

## Integration invariants

- Meta Graph API remains the only Instagram publishing path.
- Remove the Zapier adapter/callback/configuration; do not add an unofficial publishing or scraping fallback.
- Preserve cancellation handling for legacy `awaiting_confirmation` posts.
- Gemini text provider remains opt-in and disabled until configured.
- Never silently switch providers.
- Paid image generation requires explicit user confirmation and a visible cost estimate.
- Cloudinary remains optional; existing URL attachment flow must continue working.
- Keep secrets server-side. Never expose provider API secrets in browser code or logs.
- Do not run real publishing, enable autonomous publishing, deploy, or merge to `main` during this prerequisite phase.

## Creator OS 2.0 product direction

Evolve Creator OS into a bounded-autonomy Instagram operations platform with a human-supervised control plane. Prefer small, testable modules and durable task state over a large monolithic agent.

### Proposed specialist responsibilities

1. **Instagram Monitor** — ingest supported account/post insights and permitted webhook events; identify changes and operational alerts.
2. **Opportunity Researcher** — gather permitted trend, audience, and competitor context; record source, timestamp, and confidence for each finding.
3. **Content Strategist** — turn goals and evidence into a weekly plan, campaign briefs, and measurable hypotheses.
4. **Creative Production** — draft captions, concepts, image/video briefs, and asset variants through configured providers; track usage and estimated cost.
5. **Safety Reviewer** — validate brand rules, claims, rights, links, disclosure requirements, and publishing constraints; block risky actions.
6. **Publishing Agent** — use the existing Meta Graph API integration only, with explicit approval and idempotent jobs.
7. **Analytics & Learning** — compare content outcomes against goals, identify patterns without overstating causality, and feed evidence into future planning.

These are proposed bounded responsibilities, not permission to create autonomous agents that can freely call tools or publish.

### Autonomy levels

- **Copilot:** drafts and recommendations only; user performs actions.
- **Supervised:** agent prepares actions; user approves each external side effect.
- **Bounded autonomy:** only explicitly allowlisted actions within configured limits; publishing remains disabled by default and requires a separate deliberate enablement.

### Safety and reliability requirements

- Global pause/kill switch for all external actions.
- Per-account and per-action daily limits.
- Explicit approval records for consequential actions.
- Idempotency keys and duplicate prevention for jobs.
- Durable task states, retries with backoff, and dead-letter/error visibility.
- Reconcile uncertain Meta delivery outcomes before retrying; never blindly republish a post with `delivery_unknown`.
- Audit log of inputs, decisions, approvals, provider/model, estimated and actual usage, and outcomes.
- No unofficial Instagram scraping, auto-following, auto-liking, mass commenting, or engagement manipulation.
- No new paid API/runtime dependency without an explicit cost and value assessment.

## Recommended implementation sequence after prerequisite merge

1. Audit the integrated architecture and document current routes, data model, provider boundaries, scheduler, and publishing lifecycle.
2. Define a durable task/job model and event/audit model; write migration and rollback plans before schema changes.
3. Implement the global pause switch, approval records, idempotency, retry/reconciliation, and action limits.
4. Add read-only monitoring and analytics ingestion using supported Meta permissions.
5. Add evidence-backed research and weekly strategy workflows.
6. Add creative production workflows with explicit provider selection and usage/cost visibility.
7. Add the safety review gate before any external action.
8. Add supervised publishing workflows; only consider bounded autonomy after end-to-end tests, observability, and explicit user enablement.

## Claude Code working rules

- Work only on `feature/integrate-pr0-pr1-pr2` for the prerequisite patch integration.
- Do not modify `main`, deploy, or merge without explicit user approval.
- Inspect the existing code before changing architecture; preserve working behavior.
- Make focused commits and explain each architectural change.
- Add tests for every new state transition and external-action boundary.
- Never claim live provider functionality based only on mocks.
- At the end, report changed files, commits, test output, required environment variables, external dashboard setup, known limitations, and any manual actions still required.
- Once the prerequisite branch is verified and merged by the user, create a separate `creator-os-2.0/*` feature branch for the next roadmap phase.
