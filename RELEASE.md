# Release sign-off

This checklist separates evidence produced by the repository from actions that require
access to the deployment and provider accounts. A release is ready for general availability
only when every required item has an evidence link or dated operator note.

## Repository gates

- [x] Changes are committed and pushed to `main`.
- [x] Hosted `Release candidate` and CodeQL workflows passed for commit `4b1bd48`, including the
  PostgreSQL, Chromium, compiled-runtime, and Docker-image jobs.
- [x] PostgreSQL contention, fleet-budget races, deterministic UI checks, Chromium E2E,
  compiled-runtime smoke checks, dependency audit, and production builds passed.
- [x] Local health, readiness, and authenticated-metrics smoke checks passed.

See [`VERIFICATION.md`](./VERIFICATION.md) for the recorded commands and counts.

## Current deployment gaps

- [x] Azure Bicep provisions the VNet-integrated Container Apps environment, private PostgreSQL,
  private DNS, Key Vault, managed identity, Container Registry, Log Analytics, private API,
  dedicated operations worker, migration job, and public same-origin web gateway.
- [x] `pnpm deploy:azure` validates local secrets, creates resources and images, runs migrations,
  and waits for application readiness without committing or logging credential values.
- [ ] Azure for Students and the target subscription are active with sufficient regional quotas.
- [ ] The Azure deployment command has completed and every app/job runs the same current SHA.
- [ ] The emitted WorkOS callback and GitHub webhook URLs are configured in their provider UIs.
- [ ] Azure Monitor alerts, authenticated metrics scraping, an isolated restore, and rollback
  evidence are configured and recorded.

No Azure resources have been created by repository verification. Follow
[`AZURE.md`](./AZURE.md) after the subscription is active.

## Staging gates

- [x] `pnpm release:preflight` passes for the API, operations worker, and web build.
- [ ] WorkOS login, refresh, logout, and authenticated API access work through HTTPS.
- [ ] A user can connect and revoke a real Codex subscription grant.
- [ ] The GitHub App is installed with Contents write permission on the canary repository.
- [ ] Signed `check_run` or `check_suite` deliveries reach the Captain's inbox.
- [x] The Daytona provider probe creates, executes in, and destroys a sandbox.
- [ ] `pnpm release:staging` proves one real Captain → Build → PR/CI → Review → Captain run.
- [ ] The production smoke command passes with an authenticated session and project.

The read-only integration gate additionally passes WorkOS API authentication, PostgreSQL
connectivity/current migrations, Daytona configuration and cost accounting, and Codex App Server
availability. As of 2026-09-15 it reports only the missing user-authorized Codex grant and GitHub
App installation. See [`VERIFICATION.md`](./VERIFICATION.md).

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
