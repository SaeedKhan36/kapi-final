# Verification record

Repository verification was refreshed on 2026-09-15 after the final pre-deployment audit.

## Completed repository and local-runtime gates

- `DATABASE_URL= pnpm verify`
  - Deployment topology and secret-boundary contract passed.
  - TypeScript type-check passed across the monorepo and web application.
  - 157 backend checks passed.
  - 18 embedded queue checks passed; four real-contention checks were explicitly skipped here.
  - Eight deterministic UI checks passed.
  - Agent, API, operations worker, migration, and production web builds passed.
- `pnpm test:queue` against the configured PostgreSQL service used a disposable isolated schema.
  All 22 checks passed, including 100 simultaneous claimers, cross-run contention, fleet-budget
  races, lease recovery, dependency gating, retry/dead-letter behavior, cancellation, and event
  consistency. The test removed its schema afterward.
- `pnpm test:e2e` passed three Chromium journeys: authentication boundary, client-side project
  creation, and a real browser through Vite, the API, and PGlite.
- `pnpm test:runtime` passed compiled migration, API readiness/shutdown, and worker
  liveness/shutdown checks.
- `pnpm audit:prod` reported no known production dependency vulnerabilities.
- `pnpm release:preflight` passed the API, worker, and web production contracts and found a
  launchable Codex App Server executable.
- A real Daytona provider probe created a sandbox, wrote and executed a file, ran a detached
  process, read its output, and destroyed the sandbox.
- The supported Codex App Server device-code flow was started and cancelled safely, and its local
  browser UI/polling path passed. Completing account authorization remains a user action.
- The read-only `pnpm release:readiness` gate passes production configuration, Codex executable,
  PostgreSQL connectivity/migrations, WorkOS API authentication, and Daytona SDK/key/accounting
  configuration. It currently reports exactly two unresolved account gates: no active Codex grant
  and no GitHub App installation on `SaeedKhan36/kapi-final`.

Both the `Release candidate` workflow—including PostgreSQL 16, Chromium, compiled runtime, and
Docker image jobs—and CodeQL passed for commit `4b1bd48` on 2026-09-15.

All database-backed suites use independent in-memory PGlite databases or disposable
`kapi_test_*` PostgreSQL schemas. They do not truncate the configured application schema. Azure
Bicep compilation and deployment contract tests are local/read-only; no Azure resource was created
or changed during this verification.

## Gates that require account or deployed-environment authority

1. A user must complete the OpenAI device authorization so Kapi can store an encrypted Codex
   subscription grant.
2. A GitHub owner must install the Kapi GitHub App with Contents write access on the canary
   repository and configure the signed webhook destination.
3. After Azure deployment, configure the final WorkOS callback and GitHub webhook URLs,
   then verify login/refresh/logout over HTTPS.
4. Run the authenticated production smoke test and one real Captain → Build → PR/CI → Review →
   Captain canary lifecycle.
5. Configure metrics/alerts, backup/restore evidence, rollback evidence, and the staged
   reconciliation rollout described in `OPERATIONS.md`.

These are deliberately not marked as repository failures: they require the user's account
authorization or a running Azure environment. Operational commands and required variables are
documented in [`AZURE.md`](./AZURE.md) and [`OPERATIONS.md`](./OPERATIONS.md).
