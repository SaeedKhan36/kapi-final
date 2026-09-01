# kapi

An autonomous engineering team. A **Captain AI** plans, explores, delegates, monitors and
triages; it spawns **Build** and **Review** agents freely — as many as the work needs, at any
moment — each on its own VM, on its own branch, behind a pull request.

```
        USER
          │
   CONTROL PLANE          auth · projects · threads · runs · secrets
          │
   POSTGRES / QUEUE       jobs · events · agent state
      ╱        ╲          HTTPS · VMs pull, nothing pushes
 MASTER VM   WORKER VM…
 Captain AI   Build AI  ─→ PR ─→ CI ─→ REVIEW VM ─→ verdict ─→ Captain
                                                      pass → a human merges
                                                      fail → respawn a fixer
```

There is **no fixed workflow**. The Captain is a live agent, not a planner that emits a
frozen DAG: it decides what to spawn after seeing what came back. The only limits are
budgets, and a budget being reached is reported to the Captain as a tool result for it to
reason about — never as a killed run.

## Status: release-candidate engineering

The adaptive fleet, queue, UI, setup flows and production operations primitives are
implemented. Local and CI verification are defined; real staging integration evidence,
deployment sign-off and production rollout remain separate gates and are not claimed by
this document. See [ARCHITECTURE.md](./ARCHITECTURE.md),
[DEVELOPMENT.md](./DEVELOPMENT.md), and [OPERATIONS.md](./OPERATIONS.md).

The Captain is a live agent, not a plan. It explores a repository, then delegates by calling
**`spawn_agents`** with as many workers as the work needs — no fixed count, no fixed order.
It watches what comes back with `check_agents`/`wait_for_agents`, answers a blocked worker
with `reply_to_agent`, cancels a line of work that turned out unnecessary with
`cancel_agent`, and decides what to spawn next from what it just learned. Budgets
(`maxTotalSpawns`, `maxSpawnDepth`) come back as tool results the model reasons about, never
as an exception that kills the run.

This is the mechanism the whole rebuild exists for. `kapi-old`'s master emitted a frozen task
graph before any worker started; this Captain cannot do that even if it tried — spawning
*is* delegation, and it happens whenever the model calls the tool, including strictly after
seeing an earlier agent's result. That ordering is asserted directly from the event stream's
sequence numbers in `scripts/test-captain.ts`, not inferred from the model's narration.

The Captain's checkout is deliberately **read-only** — no editor tools, no branch. A captain
that can write code stops delegating, and the fleet collapses back into one agent, which is
the exact failure this architecture exists to avoid.

The **Review** role independently inspects a candidate diff with read-only tools and ends
with a structured verdict. A `request_changes` result returns to the Captain as evidence;
only the Captain decides whether to spawn a fixer or request another review.

| Package | What it is |
|---|---|
| `apps/control-plane` | Hono API, AuthKit sessions, websocket stream, scheduler, accounting, reaper, reconciler |
| `apps/agent` | the in-VM binary — one bundled file, claims a job and dials home |
| `apps/web` | the browser UI — thread chat, and the fleet as it spawns itself |
| `packages/agent-core` | the turn loop, tools, and Build, Captain, and Review roles |
| `packages/llm` | Codex subscription routing on the Vercel AI SDK: OAuth and budgets |
| `packages/vm` | `VmProvider`: local, docker, daytona |
| `packages/protocol` | zod wire types — jobs, events, addressing, agent + model API, verdicts |
| `packages/db` | Drizzle schema, connect/verify path, advisory-locked bootstrap, PGlite |
| `packages/queue` | the leased job queue: claim, heartbeat, complete, fail, reap, cancel |
| `packages/identity` | WorkOS sessions, the AES-256-GCM vault, scoped job tokens |
| `packages/env` | dependency-free `.env` loader that never clobbers real config |

### The fleet surface

Everything a Captain uses to command other agents dials out through the same `/agent/*`
job-token auth as the rest of the agent API.

| Route | Does |
|---|---|
| `POST /agent/spawn` | enqueue one or more children, gated by the run's total-spawn and depth budgets |
| `GET /agent/children` | this agent's direct children and their status |
| `POST /agent/cancel-child` | cancel a child and its whole subtree |

`spawn_agents` returns `{ spawned, refused }` rather than all-or-nothing: a captain over
budget gets what it can and a reason for the rest, and decides what matters most with what
is left. `wait_for_agents` polls rather than blocking on a socket — the VM has no inbound
connectivity, so everything a captain learns, it learns by dialing out and asking — and
returns early the moment a worker asks a question, since a question answered late is a
worker that already guessed.

## Getting started

```bash
pnpm install
cp .env.example .env
openssl rand -base64 32        # put this in KAPI_SECRET_KEY
pnpm dev:api                   # control plane on :8787
pnpm dev:web                   # browser UI on :3000, proxied to the plane
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
| `GET /api/setup` | safe auth, Codex, GitHub, vault and VM readiness metadata |
| `GET·POST /api/projects` | list and create projects |
| `GET /api/projects/:id` | one project with its threads and runs |
| `GET /api/projects/:id/integrations` | repository-scoped GitHub App readiness |
| `POST /api/projects/:id/threads` | open a thread |
| `GET·POST /api/projects/:id/schedules` | list and create timezone-aware scheduled work |
| `PATCH·DELETE /api/schedules/:id` | edit, pause/resume, or soft-delete a schedule |
| `POST /api/schedules/:id/run` | run a schedule immediately when no occurrence is active |
| `GET /api/threads/:id` | a thread with its messages |
| `POST /api/threads/:id/messages` | **starts work** — opens a run, queues the root captain |
| `GET /api/runs/:id` | run with jobs, agents, events, artifacts |
| `GET /api/runs/:id/events?after=` | events after a sequence number |
| `POST /api/runs/:id/cancel` | cancel the captain and everything it spawned |
| `PUT·GET·DELETE /api/secrets` | vault — values go in, only names come back |
| `GET·POST·DELETE /api/connections/codex/*` | connect and revoke a Codex subscription |
| `POST /webhooks/github` | GitHub `check_run` / `check_suite` completions |
| `WS /ws?runId=&cursor=` | live event stream, resumable from a cursor |

### The agent surface

A separate API under `/agent/*`, authenticated by a **job token** rather than a user session
and mounted outside CORS — no browser belongs here.

| Route | Does |
|---|---|
| `POST /agent/claim` | take the job this token was minted for |
| `POST /agent/start` | claimed → running, and opens the run |
| `POST /agent/heartbeat` | extend the lease; `ok: false` means stop immediately |
| `POST /agent/events` | append a batch of events |
| `GET /agent/inbox?after=` | messages addressed to this agent |
| `POST /agent/complete` | finish with a result, or an error to fail |
| `POST /agent/model` | one model call, routed and budgeted by the plane |
| `PUT·GET /agent/checkpoint` | save and resume the agent's transcript mid-job |
| `GET /agent/git-token` | a push credential, issued only when a tool needs one |

Every call is **outbound from the VM**. A VM is not addressable inbound — it may sit behind
NAT, be destroyed at any moment, or never have been reachable at all — so the plane never
pushes and the agent dials.

Identity comes from the token, never the body: `runId`, `jobId` and the `from` address are
all taken from the verified token, so a compromised VM cannot write into another run's
stream or complete a job that is not its own. Tokens are HMAC-signed under a key *derived*
from `KAPI_SECRET_KEY`, name exactly one job, and expire.

### GitHub App and CI

Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` and install the App on each project
repository with **Contents: read and write** permission. Git operations receive a one-hour
installation token narrowed to that repository; the control plane no longer reads or hands
out a raw `GITHUB_TOKEN`.

Point the App's webhook URL at `POST /webhooks/github` and subscribe to **Check run** and
**Check suite**. Completed checks are correlated by the `kapi/<jobId>` branch, appended as
`ci.completed`, streamed to browsers, and delivered to the root captain's inbox. Set
`GITHUB_WEBHOOK_SECRET` to make the route require GitHub's HMAC signature.

### Review and fix loop

A review agent receives either `context.branch` or exactly one build dependency, from which
it infers `kapi/<jobId>`. Its toolset can inspect the diff and files and run the detected test
suite, but cannot edit, invoke arbitrary shell commands, commit, push, or open a PR. Its only
terminal is `submit_verdict`.

Verdicts are normalized against their findings, persisted as `review.verdict` artifacts,
and appended to the run stream. `wait_for_agents` returns the structured findings to the
Captain. Nothing automatically creates a fixer: the Captain may spawn one with the exact
blocking evidence and branch context, or decide that another action is more appropriate.

### VMs

`VM_PROVIDER` selects `local` (subprocess in a temp dir — fast, no isolation), `docker`
(container per agent), or `daytona` (real cloud VMs, ~2s cold start).

The architecture is pull-based, but a VM has to exist before it can pull. The **provisioner**
creates one per queued job and points it at that job; the agent still claims through the
ordinary lease, so heartbeats, eviction and the reaper behave exactly as they would for a
pooled worker. Provisioning targets the job — it does not bypass the queue.

`maxConcurrentVms` caps how many VMs a run holds at once. It is a spend guard applied at
provisioning rather than at spawn time, so a captain is never refused work it can
legitimately queue and wait for.

## The web UI

`apps/web` is a Vite + React app that talks to the plane and nothing else. There is no
server half and no SSR: every page is a view onto an authenticated API, so there is nothing
worth rendering before the session exists. The dark theme is ported from `kapi-old` — it is
the one part of that UI that needed no rethinking.

```bash
pnpm dev:web        # :3000, with /api and /ws proxied to the plane, same-origin
```

A thread is two panes, fed two different ways.

**The conversation is REST.** A turn is `POST /api/threads/:id/messages`, which is not a
chat completion — it opens a run and queues a root captain. The reply is written when that
captain's job completes, so minutes of a fleet's work can sit between one message and the
next, and the UI re-reads the thread exactly once, when the run reaches a terminal state,
rather than polling throughout.

**The fleet is the event stream.** A run emits thousands of events; a browser polling for
them is permanently behind the thing it is watching. `WS /ws?runId=&cursor=` streams them
as they are committed.

### A spawn tree, not a plan

kapi-old drew the run as dependency waves because a frozen task graph existed to draw. Here
there is nothing to lay out in advance: a captain spawns when it decides to, often strictly
after seeing what an earlier agent came back with. The only structure a run has is who
spawned whom, so that is what the view shows — each agent's node carries its own trace, and
a sub-captain's fleet nests inside it.

The tree is seeded from `GET /api/runs/:id` and then maintained entirely from events:
`agent.spawned` adds a node under its parent, `job.status` moves it, `review.verdict` and
`ci.completed` decorate it, and `log` carries the loop's thinking and its tool calls. A
node whose parent has not arrived yet renders as a root rather than disappearing.

### The cursor is the whole reconnect story

History is paged with `GET /api/runs/:id/events?after=` until it runs out, and the sequence
number that page-walk ends on is what the socket opens with. The plane replays everything
after it before going live, so nothing falls into the gap between the last page and the
socket, and nothing is fetched twice.

The same number is the reconnect point: a dropped socket comes back with the last seq the
browser rendered, and anything with a lower one is discarded. This works because `events.seq`
is allocated under the run's row lock — gap-free and strictly ordered per run. A timestamp
or a global id would be subject to commit-order races and could not be resumed from at all.

## The agent loop

`packages/agent-core` is the reasoning loop, and it runs **on the VM**. Only the model call
travels — tools execute right there, against the real filesystem and the real checkout.

Tool calls are native to the model, not prose to be parsed. The old build had to ask for a
JSON batch of actions and parse it back out, and every malformed response was a lost step;
that entire failure class is gone.

### Context, and why it is windowed

Appending every observation forever is what makes a long agent loop expensive: each call
re-sends everything before it, so cost grows quadratically with steps. The old build burned
**833k tokens in a single run** this way. `compact()` keeps the brief and a sliding window
of recent steps in full, and reduces older ones to a bare list of the actions taken —
the agent still knows what it already tried, without paying for the payloads again.

### Landing rather than being cut off

At the step cap the agent is told how many steps remain and asked to commit what it has and
call `finish` stating what is left. An agent that simply runs out mid-thought leaves a
branch nobody can interpret, which is worse than an honest partial result.

### Failures that must not kill the job

A tool that throws is caught and its error handed back to the model as text, so it can route
around the problem the way a human engineer would. A lost lease or a cancelled job is
checked between steps and stops the loop cleanly. Every step writes a checkpoint, so a job
that is reaped and retried resumes instead of repaying for the work already done.

### The tools

`list_files`, `read_file`, `grep`, `write_file`, `edit_file`, `run_command`, `run_tests`,
`git_commit`, `git_push`, `open_pr`, `ask_captain`, `finish`.

A few of these are shaped by what goes wrong rather than by what is convenient. `edit_file`
refuses a match that is not unique, because a model that meant one occurrence and got three
has silently corrupted the file. A path resolving outside the repository is refused
outright. `run_command` refuses `git` and points at the git tools, so branch handling stays
in one place. Commands are killed on a timeout rather than being allowed to hold the job
open. Push tokens are scrubbed out of any output before the model or the event stream can
see them. And a push credential is fetched lazily, only when something actually pushes — a
token in the VM's environment from the first second is a token in every `env` dump and every
crash log for the life of the job.

`ask_captain` waits a bounded time and then tells the agent to use its own judgement and
record the assumption. A worker blocked forever on a captain that is busy, finished or dead
is a deadlocked run.

## Models

Built on the Vercel AI SDK, so **native tool calling** replaces the JSON-action-batch parsing
the old build needed. All calls use the connected user's **Codex subscription** and the
`gpt-5.6-sol` model. Gemini, Groq, Cerebras, Grok, and provider API keys are not routing
candidates, even if corresponding environment variables are present.

A malformed request stops immediately. A rejected or expired Codex grant is surfaced as a
connection error so the user can sign in again; it never falls through to another provider.

### Budgets

A captain can spawn without limit — that is the point of the architecture, and also how an
unbounded bill happens. Concurrency is capped by VM budget. Total spend is capped by two
different things: `KAPI_MAX_LLM_REQUESTS` globally, and the run's own `max_tokens` column.
Both are checked *before* each call rather than after, because the point is not to make the
request that crosses the line.

Requests, tokens, aggregate VM-seconds, and provider cost are metered per run. Codex
subscription tokens are never assigned invented dollar prices. `max_usd_cents` is enforced
only when an authoritative provider rate such as `KAPI_DAYTONA_CENTS_PER_HOUR` is configured;
otherwise the UI reports cost as unavailable and the VM-time budget remains the hard guard.

### Codex sign-in

`POST /api/connections/codex/start` returns a PKCE authorization URL; the callback stores a
refreshable grant in the same AES-256-GCM envelope as every other secret, and short-lived
access tokens are minted from it per job.

This is the only model credential accepted by the router. OpenAI API keys are intentionally
not used because they are usage-billed separately from a ChatGPT/Codex subscription.

> **Daytona needs a reachable control plane.** A cloud VM cannot dial `localhost`. Expose the
> plane through a tunnel and set `CONTROL_PLANE_PUBLIC_URL`; the provisioner refuses to start
> a Daytona VM pointed at a loopback address rather than letting it fail silently.

### Auth

With `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` set, AuthKit sign-in establishes HttpOnly
access and refresh cookies. REST and websocket handshakes verify the same session, and a
socket checks run ownership before replaying history. Without WorkOS the plane runs as a
single named local user and `/api/health` reports
`"auth": "dev"` — an unauthenticated mode that is indistinguishable from a real one is how a
dev shortcut ends up deployed, so this one says so out loud.

### Secrets

Encrypted with AES-256-GCM under `KAPI_SECRET_KEY`. There is no route and no function that
returns a stored value to a caller — listings return names and scopes only. The single
egress is `resolve()`, which the plane will call to inject credentials into a VM.

Scope precedence is **task → project → user**, narrowest first. This remains available for
non-model integrations such as source control; model credentials bypass this vault and come
only from the user's Codex connection.

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

Both are exercised against real Postgres and a real VM: the suite kills a VM mid-job and
asserts that the lease expires, the reaper requeues, a replacement VM starts, and the job
finishes on its second attempt.

### A run outlives no agent

The queue reports facts about jobs; it knows nothing of runs, threads, or the messages a
finished run writes into one. So `apps/control-plane/src/run-lifecycle.ts` owns every
`runs.status` transition and translates one into the other. A run opens when any of its
agents starts, and ends when its **root captain** does — whether that captain reported its own
result or lost its lease and was dead-lettered by the reaper, which is wired to the same
function.

That second path is the one that matters. Without it a reaped root leaves a run queued with a
null `finished_at` forever: a live-looking run in the UI that nothing will ever resolve, under
exactly the failure this design claims to survive. Ending a run also writes the captain's
closing summary into the thread as a turn, in the same transaction as the status — a thread
you can only talk into is not a conversation.

Both transitions are a single guarded `UPDATE ... WHERE`, so the HTTP path and the reaper can
race freely: the loser's statement matches nothing. A run is never announced running twice,
never walked backwards out of a terminal state, and never finished twice.

## Why not the previous version

`../kapi-old` works, and much of it is ported here — the Daytona/Docker/local VM providers,
the git helpers, WorkOS, the GitHub App, the dark UI theme. Two things could not be
retrofitted:

- **Its master was a function, not an agent.** `planTasks()` emitted a frozen task graph,
  then the master's sandbox was destroyed and a hardcoded pipeline walked that graph with at
  most four workers. There was no seam where a master could spawn anything mid-flight.
- **It had no queue.** The whole run lived in one in-process drain loop, so restarting the
  orchestrator killed the run.

Both failures are resolved by the same durable queue and live-Captain foundation.

## Testing

```bash
pnpm verify         # complete release-candidate gate
pnpm test:backend   # protocol, roles, control plane, operations, VM, LLM and agent-core
pnpm test:queue     # real-Postgres contention, leases and event consistency
pnpm test:ui        # deterministic web component states
pnpm typecheck
pnpm dev:api        # builds the agent bundle, then runs the plane in watch mode
pnpm build:agent    # bundle apps/agent to a single dist/agent.mjs
pnpm probe:daytona  # create one real Daytona VM, exercise it, destroy it
pnpm db:reset       # wipe every table (--force required against real Postgres)

# drive a real run end to end - a Build agent, or a Captain that delegates
pnpm run:agent --repo=<path|url> --goal="add a subtract function with a test"
pnpm run:agent --kind=captain --role=captain --repo=<path|url> \
  --goal="two independent changes - delegate them to separate agents"
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

The queue suite uses a unique disposable schema, so concurrent invocations never share a
global `TRUNCATE` or claim each other's jobs. See [DEVELOPMENT.md](./DEVELOPMENT.md) for the
fresh-clone and CI commands. Requires Node 22+ and pnpm 10.30.0.

## Release gates

- Implemented and locally verified: control plane, adaptive roles, queue recovery,
  setup/workbench UI, scheduling, accounting, reconciliation and CI baseline.
- Next: real WorkOS/Codex/GitHub/Daytona staging lifecycle evidence.
- Then: Render staging, controlled production canaries/restore, and final GA hardening.

A run ends at an open pull request. **Merging is always a human decision.**
# kapi-final
