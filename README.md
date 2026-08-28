# kapi

An autonomous engineering team. A **Captain AI** plans, explores, delegates, monitors and
triages; it spawns **Build** and **Review** agents freely — as many as the work needs, at any
moment — each on its own VM, on its own branch, behind a pull request.

```
        USER
          │
   CONTROL PLANE          auth · projects · threads · runs · secrets · scheduler
          │
   POSTGRES / QUEUE       jobs · events · agent state
      ╱        ╲          HTTPS · VMs pull, nothing pushes
 MASTER VM   WORKER VM…
 Captain AI   Build AI  ─→ PR ─→ CI ─→ REVIEW VM ─→ verdict ─→ Captain
                                                      pass → merge
                                                      fail → respawn a fixer
```

There is **no fixed workflow**. The Captain is a live agent, not a planner that emits a
frozen DAG: it decides what to spawn after seeing what came back. The only limits are
budgets, and a budget being reached is reported to the Captain as a tool result for it to
reason about — never as a killed run.

## Status: Phase 1 — control plane

The plane is live: you can create a project, open a thread, and post a message, which opens
a run and queues its root captain job. **Nothing claims that job yet** — VMs and agents are
Phase 2, so a run sits at `queued` by design.

| Package | What it is |
|---|---|
| `apps/control-plane` | Hono HTTP + websocket API, auth, the event stream, the reaper |
| `packages/protocol` | zod wire types — jobs, events, addressing, review verdicts |
| `packages/db` | Drizzle schema, dual Postgres/PGlite bootstrap, idempotent DDL |
| `packages/queue` | the leased job queue: claim, heartbeat, complete, fail, reap, cancel |
| `packages/identity` | WorkOS sessions and the AES-256-GCM secrets vault |
| `packages/env` | dependency-free `.env` loader that never clobbers real config |

## Getting started

```bash
pnpm install
cp .env.example .env
openssl rand -base64 32        # put this in KAPI_SECRET_KEY
pnpm dev:api                   # control plane on :8787
```

With `DATABASE_URL` unset everything runs on embedded PGlite — real Postgres compiled to
WASM, no account, no container, no network.

```bash
curl localhost:8787/api/health
PID=$(curl -s -XPOST localhost:8787/api/projects -H 'content-type: application/json' \
  -d '{"name":"demo","repoUrl":"https://github.com/you/repo.git"}' | jq -r .id)
TID=$(curl -s -XPOST localhost:8787/api/projects/$PID/threads -d '{}' \
  -H 'content-type: application/json' | jq -r .id)
curl -XPOST localhost:8787/api/threads/$TID/messages -H 'content-type: application/json' \
  -d '{"content":"add a /health endpoint"}'
```

## API

| Route | Does |
|---|---|
| `GET /api/health` | database, auth mode, vault status, queue depth |
| `GET /api/me` | the authenticated principal |
| `GET·POST /api/projects` | list and create projects |
| `GET /api/projects/:id` | one project with its threads and runs |
| `POST /api/projects/:id/threads` | open a thread |
| `GET /api/threads/:id` | a thread with its messages |
| `POST /api/threads/:id/messages` | **starts work** — opens a run, queues the root captain |
| `GET /api/runs/:id` | run with jobs, agents, events, artifacts |
| `GET /api/runs/:id/events?after=` | events after a sequence number |
| `POST /api/runs/:id/cancel` | cancel the captain and everything it spawned |
| `PUT·GET·DELETE /api/secrets` | vault — values go in, only names come back |
| `WS /ws?runId=&cursor=` | live event stream, resumable from a cursor |

### Auth

With `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` set, requests carry a WorkOS AuthKit bearer
token. Without them the plane runs as a single named local user and `/api/health` reports
`"auth": "dev"` — an unauthenticated mode that is indistinguishable from a real one is how a
dev shortcut ends up deployed, so this one says so out loud.

### Secrets

Encrypted with AES-256-GCM under `KAPI_SECRET_KEY`. There is no route and no function that
returns a stored value to a caller — listings return names and scopes only. The single
egress is `resolve()`, which the plane will call to inject credentials into a VM.

Scope precedence is **task → project → user**, narrowest first. That is what makes per-task
BYO API keys work: a key attached to one task overrides the project's, which overrides the
user's.

## The two mechanisms

**Leased jobs.** A VM claims work with a single `FOR UPDATE SKIP LOCKED` statement, so N VMs
poll concurrently with no coordinator. A claim carries a lease; the holder heartbeats to
extend it, and a reaper requeues anything whose lease expires. A VM can be destroyed, lose
the network, or hang, and its work returns to the queue without any component noticing the
failure.

`heartbeat` returns **false** rather than throwing when the lease is gone. That is the whole
contract with an agent: a VM the reaper evicted must discover it and stop, or two VMs end up
pushing the same branch.

**One event stream.** Every job state change writes an `events` row in the same transaction
as the change itself, with a gap-free per-run sequence number. That single table is the audit
log, the UI feed, and the resume cursor at once — and replaying it reproduces every job's
status exactly, which the test suite asserts.

## Why not the previous version

`../kapi-old` works, and much of it is ported here — the Daytona/Docker/local VM providers,
the git helpers, WorkOS, the GitHub App, the dark UI theme. Two things could not be
retrofitted:

- **Its master was a function, not an agent.** `planTasks()` emitted a frozen task graph,
  then the master's sandbox was destroyed and a hardcoded pipeline walked that graph with at
  most four workers. There was no seam where a master could spawn anything mid-flight.
- **It had no queue.** The whole run lived in one in-process drain loop, so restarting the
  orchestrator killed the run.

Both land on the same foundation, which is why it is Phase 0.

## Testing

```bash
pnpm test:unit    # protocol schemas, the queue, the control plane end to end
pnpm typecheck
pnpm dev:api      # control plane, watch mode
pnpm db:reset     # wipe every table (--force required against real Postgres)
```

The queue's **concurrency tests require real Postgres and refuse to run on PGlite.** PGlite
is single-process, so its transactions serialise and `FOR UPDATE SKIP LOCKED` is never
contended — a green run there would prove nothing about the one part of this phase with
genuine concurrency risk. Point `DATABASE_URL` at any scratch Postgres:

```bash
docker run -d --name kapi-pg -p 5432:5432 -e POSTGRES_PASSWORD=kapi postgres:16
export DATABASE_URL=postgres://postgres:kapi@localhost:5432/postgres
pnpm test:unit
```

Requires Node 22+ and pnpm 10.

## Roadmap

1. ~~Control plane~~ — done
2. VM layer + agent bootstrap — a single-file agent that claims jobs over HTTPS
3. Models on the Vercel AI SDK — Codex subscription OAuth, Gemini/Groq/Cerebras failover,
   per-task BYO keys
4. `agent-core` loop + the Build agent — edit, test, commit, push, open a PR
5. **Captain AI** — unbounded spawn, monitor, triage
6. GitHub App + CI check-runs
7. Review agent + the fail → fix → re-review → merge loop
8. Web UI — thread-based chat with the Captain, live agent tree
9. Scheduler, orphan-VM reaping, cost accounting
# kapi-final
