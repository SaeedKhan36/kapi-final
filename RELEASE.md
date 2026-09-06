# Release sign-off

This checklist separates evidence produced by the repository from actions that require
access to the deployment and provider accounts. A release is ready for general availability
only when every required item has an evidence link or dated operator note.

## Repository gates

- [x] Changes are committed and pushed to `main`.
- [x] The hosted `Release candidate` workflow passed for commit `41f8609`.
- [x] PostgreSQL contention, fleet-budget races, UI checks, and production builds passed.
- [x] Local health, readiness, and authenticated-metrics smoke checks passed.

See [`VERIFICATION.md`](./VERIFICATION.md) for the recorded commands and counts.

## Staging gates

- [ ] Production configuration preflight passes for the API and operations worker.
- [ ] WorkOS login, refresh, logout, and authenticated API access work through HTTPS.
- [ ] A user can connect and revoke a real Codex subscription grant.
- [ ] The GitHub App is installed with Contents write permission on the canary repository.
- [ ] Signed `check_run` or `check_suite` deliveries reach the Captain's inbox.
- [ ] The Daytona provider probe creates, executes in, and destroys a sandbox.
- [ ] One real run completes Captain → Build → PR/CI → Review → Captain.
- [ ] The production smoke command passes with an authenticated session and project.

For each item, record the date, environment, commit SHA, operator, and a link to redacted
logs. Never paste cookies, OAuth grants, private keys, installation tokens, or vault values.

## Operational gates

- [ ] Metrics are scraped and alert rules are loaded.
- [ ] Reconciliation remains audit-only for at least one orphan grace window.
- [ ] A fresh backup has been restored into an isolated database and verified.
- [ ] The previous application image has been redeployed successfully against the additive schema.
- [ ] A controlled production canary completes without leaked VMs or unresolved failed jobs.
- [ ] Reconciliation deletion is enabled only after the audit and canary are clean.

The ordered rollout and rollback procedure is in [`OPERATIONS.md`](./OPERATIONS.md).
