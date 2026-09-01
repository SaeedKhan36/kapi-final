# Development and release-candidate checks

## Fresh clone

Requires Node 22+, pnpm 10.30.0 and PostgreSQL 16 for queue contention tests.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:migrate
pnpm verify
```

With `DATABASE_URL` unset, application development uses embedded PGlite. The queue stress
suite intentionally requires real PostgreSQL because PGlite serializes transactions and
cannot prove `FOR UPDATE SKIP LOCKED` behavior.

For a disposable local database:

```bash
docker run --rm --name kapi-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=kapi -e POSTGRES_DB=kapi postgres:16-alpine
export DATABASE_URL=postgres://postgres:kapi@127.0.0.1:5432/kapi
pnpm db:migrate
pnpm verify
```

The real-Postgres queue suite creates and removes a unique `kapi_test_*` schema for each
process. Concurrent test runs therefore cannot truncate or claim each other's work.

## Verification commands

```bash
pnpm typecheck       # all TypeScript packages and the web app
pnpm test:backend    # protocol, roles, API, operations, VM, LLM and agent-core
pnpm test:queue      # real-Postgres contention, leases and event consistency
pnpm test:ui         # deterministic component states
pnpm build:agent     # single-file VM agent bundle
pnpm build:web       # production Vite build
pnpm verify          # complete local release-candidate gate
```

GitHub Actions runs the same categories against a disposable Postgres 16 service. Never
point tests at a production database.
