# Release sign-off

This checklist separates evidence produced by the repository from actions that require
access to the deployment and provider accounts. A release is ready for general availability
only when every required item has an evidence link or dated operator note.

## Repository gates

- [x] Changes are committed and pushed to `main`.
- [x] Hosted `Release candidate` and CodeQL workflows passed for commit `38e10fa`; the release
  SHA itself must also be green.
- [x] PostgreSQL contention, fleet-budget races, deterministic UI checks, Chromium E2E,
  compiled-runtime smoke checks, dependency audit, and production builds passed.
- [x] Local health, readiness, and authenticated-metrics smoke checks passed.

See [`VERIFICATION.md`](./VERIFICATION.md) for the recorded commands and counts.

## Current deployment gaps

- [x] The DigitalOcean App Platform topology is committed in `.do/app.yaml`.
- [ ] Student credit and account verification are active.
- [ ] A production DigitalOcean Managed PostgreSQL cluster named `kapi-postgres` exists in the
  app region, is bound through its private URL, and has the app as a trusted source.
- [ ] Every `CHANGE_ME` placeholder is replaced through DigitalOcean's encrypted environment
  editor; the API and worker share the same `KAPI_SECRET_KEY`.
- [ ] The DigitalOcean app is created and its API, operations worker, migration job, and web
  components are running the same current SHA.
- [ ] Backups/point-in-time recovery, alert destinations, metrics scraping, and an
  operator-tested isolated restore are configured.

No DigitalOcean resources have been created yet. Follow [`DIGITALOCEAN.md`](./DIGITALOCEAN.md)
after the student credit is active.

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
