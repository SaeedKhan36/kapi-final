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

With `DATABASE_URL` unset, application development and the deterministic verification gate
use embedded PGlite. The queue suite skips only its labelled contention cases because
PGlite serializes transactions and cannot prove `FOR UPDATE SKIP LOCKED` behavior. GitHub CI
always runs those cases against PostgreSQL 16.

## One-command local stack

```bash
pnpm dev
```

Turborepo first builds the VM agent bundle, then keeps the control plane and Vite UI running
together at `http://localhost:8787` and `http://localhost:3000`. The control plane also runs
the scheduler, provisioner, reaper, accounting, and reconciler in-process. A queued Captain
or child job is provisioned as a local subprocess in its own temporary worktree; no standalone
operations process is needed.

The local launcher supplies safe defaults before `.env` is loaded: development mode, embedded
PGlite, dev authentication, `KAPI_OPERATIONS=on`, and `VM_PROVIDER=local`. This prevents an
ignored `.env` used for deployment administration from accidentally connecting `pnpm dev` to
a production database or Daytona account. Explicit shell values still win, for example:

```bash
DATABASE_URL=postgres://postgres:kapi@127.0.0.1:5432/kapi \
VM_PROVIDER=docker pnpm dev
```

`pnpm dev:api` and `pnpm dev:web` remain available when only one side is needed.
For real local GitHub App testing, set `GITHUB_APP_PRIVATE_KEY_FILE` to the downloaded PEM
instead of flattening a multi-line key into `.env`.

For a disposable local database:

```bash
docker run --rm --name kapi-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=kapi -e POSTGRES_DB=kapi postgres:16-alpine
export DATABASE_URL=postgres://postgres:kapi@127.0.0.1:5432/kapi
pnpm db:migrate
pnpm verify
```

Every backend suite that sees `DATABASE_URL` creates and removes its own unique
`kapi_test_*` schema. Concurrent test runs therefore cannot truncate application data or
claim each other's work. With no URL, each suite gets an independent in-memory PGlite
database.

## Verification commands

```bash
pnpm typecheck       # all TypeScript packages and the web app
pnpm build           # Turbo build for the agent, API/worker/migration, and web
pnpm test:backend    # protocol, roles, API, operations, VM, LLM and agent-core
pnpm test:queue      # real-Postgres contention, leases and event consistency
pnpm test:ui         # deterministic component states
pnpm build:agent     # single-file VM agent bundle
pnpm build:control-plane # compiled API, worker, and migration entrypoints
pnpm build:web       # production Vite build
pnpm test:runtime    # compiled migration/API/worker smoke checks
pnpm exec playwright install chromium # one-time local browser install
pnpm test:e2e        # Chromium auth boundary and project journey
pnpm audit:prod      # production dependency vulnerability gate
pnpm verify          # complete local release-candidate gate
```

GitHub Actions also builds the final Docker image, checks its non-root user, runs CodeQL, and
runs browser tests against the production web bundle. Never point tests at a production database.

### Recovering local Build output

Each successful Build checkpoint atomically stores a workspace export alongside its transcript.
The run panel exposes a download link per Build agent, also available at
`GET /api/runs/:runId/jobs/:jobId/workspace` with ordinary run-owner authentication.
Exports survive VM cleanup, including cancellation after a checkpoint. They contain a thin Git
bundle for unpublished commits, binary staged/unstaged patches and non-ignored untracked files.
Clone the original repository into a fresh directory, then run:

```bash
pnpm restore:workspace /path/to/workspace.json /path/to/fresh-clone
```

The export records `publication: local|published`; finishing a local task does not imply a PR exists.
Snapshots are limited to 1 MB to leave room for the transcript in the default 2 MiB API body limit.
Oversized or failed snapshots stop the Build rather than advancing an unrestorable transcript.
Changes made after the last acknowledged checkpoint cannot be recovered after an abrupt VM loss.

### Reliability verification

See [RELIABILITY_VERIFICATION.md](./RELIABILITY_VERIFICATION.md) for the executed local/PostgreSQL
checks, saved synthetic-load samples and the remaining live integration gate. `pnpm test:load:local`
uses real local agent processes with an echo role; `pnpm test:live:local` uses the connected user's
real model and GitHub installation and creates a documentation PR on the explicitly selected project.
