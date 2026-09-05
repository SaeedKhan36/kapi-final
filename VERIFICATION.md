# Verification record

Repository verification completed on 2026-09-05 after the release-candidate hardening work.

## Completed gates

- `DATABASE_URL= pnpm verify`
  - TypeScript type-check passed.
  - Agent bundle build passed.
  - 145 backend checks passed.
  - 18 embedded queue checks passed; four real-contention checks were explicitly skipped.
  - Six deterministic UI checks passed.
  - Production web build passed.
- `pnpm test:queue` against an isolated PostgreSQL schema: 22 checks passed, including all
  concurrent-claim stress cases.
- Captain and provisioner budget races passed against isolated PostgreSQL schemas.
- `pnpm test:smoke` against a local control plane passed `/live`, `/ready`, unauthorized
  `/metrics`, and authorized `/metrics` checks.

All database-backed suites use either independent in-memory PGlite databases or disposable
`kapi_test_*` PostgreSQL schemas. They do not truncate the configured application schema.

## External release gates

The repository is locally verified, but release sign-off still requires environment-owned
evidence:

1. Push the commit series and pass hosted CI.
2. Deploy staging with real WorkOS, Codex, GitHub App, and Daytona integrations.
3. Run the authenticated staging smoke test and one real repository lifecycle.
4. Exercise database restore and application rollback procedures.
5. Complete a controlled production canary before general availability.

Operational commands and required environment variables are documented in
[`OPERATIONS.md`](./OPERATIONS.md).
