# Release sign-off

This checklist separates evidence produced by the repository from actions that require
access to the deployment and provider accounts. A release is ready for general availability
only when every required item has an evidence link or dated operator note.

## Repository gates

- [x] Changes are committed and pushed to `main`.
- [x] Hosted `Release candidate` and CodeQL workflows passed for commit `e607614`; the release
  SHA itself must also be green.
- [x] PostgreSQL contention, fleet-budget races, deterministic UI checks, Chromium E2E,
  compiled-runtime smoke checks, dependency audit, and production builds passed.
- [x] Local health, readiness, and authenticated-metrics smoke checks passed.

See [`VERIFICATION.md`](./VERIFICATION.md) for the recorded commands and counts.

## Current deployment gaps

- [ ] Render has deployed the current `main` SHA to both the API and static web service.
- [ ] The `kapi-operations` worker exists and is running the same SHA as the API.
- [ ] Migration 2 (`api_rate_limits`) has run through the compiled pre-deploy entrypoint.
- [ ] Managed PostgreSQL is on a non-expiring production plan with restricted network access,
  backups/point-in-time recovery, and an operator-tested restore path.
- [ ] The Render account has billing enabled; the latest blueprint validation was blocked from
  creating the database/worker by missing payment information.

Observed before this hardening series: the live API reported commit `23a0968`, the web service
reported commit `17be0ac`, and no operations worker was present. Treat those services as stale
until the deployment checks above are recorded against one current SHA.

## Staging gates

- [ ] `pnpm release:preflight` passes for the API, operations worker, and web build.
- [ ] WorkOS login, refresh, logout, and authenticated API access work through HTTPS.
- [ ] A user can connect and revoke a real Codex subscription grant.
- [ ] The GitHub App is installed with Contents write permission on the canary repository.
- [ ] Signed `check_run` or `check_suite` deliveries reach the Captain's inbox.
- [ ] The Daytona provider probe creates, executes in, and destroys a sandbox.
- [ ] `pnpm release:staging` proves one real Captain → Build → PR/CI → Review → Captain run.
- [ ] The production smoke command passes with an authenticated session and project.

For each item, record the date, environment, commit SHA, operator, and a link to redacted
logs. Never paste cookies, OAuth grants, private keys, installation tokens, or vault values.

## Operational gates

- [ ] Metrics are scraped and `ops/prometheus-rules.yml` is loaded.
- [ ] Reconciliation remains audit-only for at least one orphan grace window.
- [ ] A fresh backup has been restored and passes `pnpm release:verify-restore`.
- [ ] The previous application image has been redeployed successfully against the additive schema.
- [ ] `pnpm release:canary` completes without leaked VMs or unresolved failed jobs.
- [ ] Reconciliation deletion is enabled only after the audit and canary are clean.

The ordered rollout and rollback procedure is in [`OPERATIONS.md`](./OPERATIONS.md).
