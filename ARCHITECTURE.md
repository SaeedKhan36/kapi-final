# Architecture

Kapi is a durable control plane for an adaptive engineering fleet. The Captain is a live
agent: it explores, spawns Build or Review agents, waits for evidence, answers questions,
cancels unnecessary work, and may spawn again. It never emits or executes a frozen DAG.

```text
Browser ──REST/WS──> API ──SQL/NOTIFY──> Postgres
                         <──leases────── Operations worker ──> VM provider
                                               │
                                               └──> Agent VM ──> GitHub PR/CI
                                                        └──HTTPS──> API/model proxy
```

## Ownership boundaries

- `apps/web`: authenticated projects, setup, schedules, thread chat, live fleet tree and trace.
- `apps/control-plane`: user/job APIs, WebSockets, scheduling, provisioning, reaping,
  accounting, reconciliation, GitHub webhooks and lifecycle decisions.
- `apps/agent`: the one-job VM process. It claims, heartbeats, runs one explicit role and
  reports through outbound HTTPS only.
- `packages/queue`: leased jobs plus the ordered event stream. Queue transactions lock
  `jobs → agents → runs/events`.
- `packages/db`: connection, migration verification and advisory-locked bootstrap.
- `packages/agent-core`: model loop and the Captain, Build and Review toolsets.
- `packages/identity`, `llm`, `vm`, `protocol`: authentication/vault, Codex routing,
  provider abstraction and shared wire contracts.

## Durable run lifecycle

1. A user message creates a run and queues its root Captain atomically.
2. The operations worker provisions a VM; the agent claims a job with `SKIP LOCKED`.
3. Every mutation and its event commit together under a gap-free per-run sequence.
4. Build agents commit/push/open PRs; GitHub check webhooks return CI evidence.
5. Review verdicts return to the Captain, which decides whether to finish or spawn a fixer.
6. Lost leases are requeued from checkpoints. A terminal root Captain closes the run and
   writes its final response into the thread. Pull-request merging remains human-controlled.

## Deployment boundary

Production API and worker processes only connect and verify migration state. Render's
pre-deploy command is the only production schema writer. Runtime work is split so the API
serves traffic while one operations worker owns scheduled/background loops; database locks
keep rolling overlap safe.
