# Reliability fixes and verification — 21 October 2026

Changes are on `codex/reliability-fixes`, one primary commit per reported issue.

## Implemented fixes

1. **Provider identity:** `agents.vm_id` retains the actual provider resource ID; `jobs.vm_id`
   remains the lease identity from the token. A regression exercises provision, claim,
   reconciliation and destruction with a real local resource.
2. **Crash recovery:** Build checkpoints atomically pair the transcript with a thin Git bundle,
   binary index/worktree patches and non-ignored untracked files. A fresh checkout restores
   these before resuming. Transcript-only legacy checkpoints restart safely.
3. **Output preservation:** each acknowledged workspace checkpoint also persists a downloadable
   `workspace.export`. The run owner can download it after completion/cancellation and restore
   it with `pnpm restore:workspace <export.json> <fresh-clone>`. Exports distinguish local output
   from a successfully published commit. Run-detail responses omit large checkpoint/export bodies.
4. **Cleanup retries:** failed deletion retains the provider ID, increments attempts and emits
   a warning, metric and alert. Actual provider handles survive deletion errors; confirmed absence
   is idempotent success. Cleanup checks provider identity and does not clear a newer reservation.
5. **Model budgets:** replica-safe SQL reservations enforce per-user/run model concurrency and
   reserve input bytes plus an output allowance. Success settles actual usage; unknown usage is
   charged conservatively. Expired calls free concurrency but retain unaccounted token reservations.
   Capacity waits do not consume transport retry attempts.
6. **VM admission:** SQL admission serializes global/user resource reservations across workers.
   Fair candidate selection favors users with fewer resources, then their queue position.
   Provider startup is bounded in parallel. Failed-cleanup resources continue occupying capacity.
7. **Verification:** new real-role/Git lifecycle regression, admission tests, client retry tests,
   repeatable process/queue load runner, CI load gate, live-local probe, and saved load evidence.
   Verification also covered provider deletion error/absence edge cases and schema consistency.

## Executed checks

Host: macOS arm64, Node 24.11.0, pnpm 10.30.0, 10 logical CPUs, 16 GiB RAM.
The project targets Node 22+; CI retains Node 22 coverage.

| Gate | Result |
| --- | --- |
| Embedded PGlite `pnpm verify` | Passed: 211 backend/queue/UI checks; 4 PostgreSQL-only checks skipped |
| Disposable local PostgreSQL 16.14 `pnpm verify` | Passed: 215 backend/queue/UI checks; no skips |
| Deployment contracts and TypeScript | Passed in both verification runs |
| Agent, control-plane and web builds | Passed |
| Compiled migration/API/worker smoke | 3 passed |
| Chromium browser tests | 3 passed |
| Real Captain/Build/Review role fixture | Passed, including real tests, Git diff and workspace destruction/restoration |

The role fixture uses scripted model decisions and a local Git remote. It does not claim live AI,
GitHub PR, CI webhook or Daytona evidence. Provider-adapter Docker/Daytona behavior still needs live
provider validation; local tests exercise the corresponding lifecycle and failure semantics.

## Synthetic load evidence

Raw samples are in `verification/2026-10-21/load-pglite.json` and `load-postgres.json`.
The workload uses real HTTP endpoints, SQL queue transitions and local agent subprocesses running
an echo role. It excludes AI inference, GitHub traffic, repository builds and Daytona startup.
These are smoke-load samples, not production capacity estimates or a sustained soak test.

| Database | Simulated users | Jobs | Global resource cap | Remaining resources |
| --- | ---: | ---: | ---: | ---: |
| PGlite | 10 | 30 | 8 | 0 |
| PostgreSQL | 50 | 150 | 8 | 0 |

The PostgreSQL sample completed 150 synthetic jobs in approximately 4.6 seconds, with p95 queue
waiting around 4.25 seconds and p95 health latency around 8.6 ms. Other verification processes were
running on the same host. No real-AI user-capacity number is inferred from this sample.

Reproduce against an explicitly local PostgreSQL database (each run uses a disposable schema):

```bash
DATABASE_URL=postgres://kapi@127.0.0.1:5432/postgres pnpm verify
DATABASE_URL=postgres://kapi@127.0.0.1:5432/postgres pnpm test:admission
DATABASE_URL=postgres://kapi@127.0.0.1:5432/postgres \
  KAPI_LOAD_USERS=50 KAPI_LOAD_RUNS_PER_USER=3 pnpm test:load:local
```

## Remaining live gate and explicit limits

The authorized live-test repository is `SaeedKhan36/kapi-final`. The local project GitHub App
readiness check passed (`configured=true`, `installed=true`). The local Kapi user initially had
no Codex grant; device sign-in was initiated and requires the user's completion. No live AI/PR
success is claimed until the probe emits successful evidence.

After signing in through Kapi Setup and starting ordinary local operations:

```bash
KAPI_LOCAL_PROJECT_ID=<authorized-project-id> pnpm test:live:local
```

This creates a small documentation PR, independently reviews it, records terminal run evidence,
and never merges it. Set `KAPI_LOCAL_SMOKE_OUTPUT` to save JSON evidence. A public webhook tunnel
is required to demand CI webhook evidence; opt in with `KAPI_LOCAL_REQUIRE_CI=true`. Production
staging retains its stricter WorkOS/integration gate through `pnpm release:staging`.

Workspace snapshots are bounded to 1 MB to fit the default API request limit with a transcript.
Oversized snapshots fail explicitly. Only the last acknowledged checkpoint is durable; edits
made immediately before an abrupt crash cannot be guaranteed. Ignored files are not exported.

Codex does not accept a provider-enforced output-token cap. One response may exceed its reserved
allowance; actual usage is recorded and future calls are blocked. This is not represented as a
strict provider token ceiling. Crashed/unknown calls intentionally retain conservative reservations.

Apply database migrations before updating production API/worker processes. All replicas sharing
one deployment database must use identical capacity settings. Defaults: 32 global VMs, 8 per user,
4 provider startups per worker, 1 model call per run and 2 per user.
