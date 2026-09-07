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

- [x] Render deployed hardened commit `d4de703` to both the API and static web service; the
  release-evidence commit that records this deployment must be deployed next.
- [ ] The `kapi-operations` worker exists and is running the same SHA as the API.
- [x] Migration 2 (`api_rate_limits`) is present in the Render database and API startup verified it.
- [ ] Managed PostgreSQL is on a non-expiring production plan with restricted network access,
  backups/point-in-time recovery, and an operator-tested restore path.
- [ ] The Render account has billing enabled; the latest blueprint validation was blocked from
  creating the database/worker by missing payment information.

Deployment evidence recorded on 2026-09-08: both services reported commit `d4de703`; `/live`,
`/ready`, public/authenticated metrics behavior, WorkOS redirect, and the production web asset
passed. The API reports `operations=external-worker`, so agent execution remains unavailable
until the paid worker is created. Before this deployment, API `23a0968` and web `17be0ac` were
the live revisions.

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
