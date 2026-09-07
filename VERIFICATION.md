# Verification record

Repository verification was refreshed on 2026-09-08 after the production-hardening work.

## Completed gates

- `DATABASE_URL= pnpm verify`
  - TypeScript type-check passed.
  - Agent bundle build passed.
  - 154 backend checks passed.
  - 18 embedded queue checks passed; four real-contention checks were explicitly skipped.
  - Six deterministic UI checks passed.
  - Compiled API, worker, migration, and production web builds passed.
- `pnpm test:queue` against an isolated PostgreSQL schema: 22 checks passed, including all
  concurrent-claim stress cases.
- Captain and provisioner budget races passed against isolated PostgreSQL schemas.
- `pnpm test:runtime` passed migration, API readiness/shutdown, and worker liveness/shutdown.
- `pnpm test:e2e` passed two Chromium journeys covering the auth boundary and authenticated
  project creation with client-side navigation.
- `pnpm audit:prod` reported no known production dependency vulnerabilities.
- `pnpm test:smoke` against a local control plane passed `/live`, `/ready`, unauthorized
  `/metrics`, and authorized `/metrics` checks.

All database-backed suites use either independent in-memory PGlite databases or disposable
`kapi_test_*` PostgreSQL schemas. They do not truncate the configured application schema.

## External release gates

Both the `Release candidate` workflow (including PostgreSQL 16, Chromium, compiled-runtime,
and Docker-image jobs) and CodeQL passed for commit `e607614`. Every later release commit must
have both current workflows green. Release sign-off still requires environment-owned evidence:

1. Deploy staging with real WorkOS, Codex, GitHub App, and Daytona integrations.
2. Run the authenticated staging smoke test and one real repository lifecycle.
3. Exercise database restore and application rollback procedures.
4. Complete a controlled production canary before general availability.

Operational commands and required environment variables are documented in
[`OPERATIONS.md`](./OPERATIONS.md).
