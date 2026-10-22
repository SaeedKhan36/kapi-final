# Eight edge-case hardening commits

The first seven primary commits are `15fc0b6`, `cefc016`, `36b7356`, `fe58f23`,
`1dc02d1`, `a057d6b` and `f301fd2`. This report accompanies the eighth commit.
All are pushed individually to `main` as requested.

| Case | Implemented behavior |
| --- | --- |
| 1. Lost action responses | Job-scoped spawn receipts replay the same child IDs under a transactional lock. Reusing a key for different instructions returns 409. PR creation looks up the exact branch/base pair and reconciles competing creates. |
| 2. Large workspaces | Checksummed 512 KiB chunks support both upload and agent recovery download. Serialized snapshots are bounded to 64 MiB. An incomplete/corrupt manifest cannot replace the last good checkpoint. |
| 3. Crash between actions/checkpoints | Model tool intentions are persisted before execution; each tool result and workspace are acknowledged together. Recovery resumes the recorded sequence. Terminal checkpoints do not repeat model work. An interrupted arbitrary shell/test command blocks subsequent actions for reconciliation rather than claiming success. |
| 4. Cancellation in progress | Lease loss, cancellation and termination abort agent HTTP work, queued retries, running process groups and GitHub requests. A local watchdog stops work when lease renewal cannot be proven. The model proxy watches job ownership/lease and propagates cancellation to inference. |
| 5. Uncertain model usage | Expired reservations become conservative, auditable usage receipts. Late verified usage replaces estimates idempotently. An operator CLI requires an evidence reference. Missing credentials consume no inference budget before dispatch. |
| 6. Refresh/revoke races | A per-user connection row lock serializes bounded rotating-grant refresh across replicas. Revoke/reconnect writes cannot be overwritten by a stale refresh. Transient failures do not revoke the grant. |
| 7. Ambiguous provider creation | Durable reservation labels retain quota after a lost response. Inventory matches the actual resource for cleanup before retry; late responses are retained for deletion without starting another agent. Known Daytona startup failures delete their created sandbox. |
| 8. Sustained operation | Mixed-duration failure profiles test global/user caps, retries, ambiguous creations, API outage recovery and actual WebSocket delivery. Unwatched stream state is pruned; replay buffers, debug caches and connection count are bounded. Stale checkpoint revisions cannot regress recovery; abandoned uploads are collected without deleting queued recovery data or durable exports. |

The eighth commit also includes validation-driven corrections to the earlier cases: fail-closed
handling of interrupted commands, chunked recovery downloads, checkpoint protocol acknowledgement
for rolling upgrades, and excluding unavailable credentials from inference spend.

## Executed verification

- `pnpm verify` against an isolated local PostgreSQL 16.14 database: **232 checks passed; no skips**.
- `pnpm verify` with embedded PGlite: **228 passed; four PostgreSQL-only contention cases skipped**.
- Deployment contracts, TypeScript and agent/API/web production builds passed in both gates.
- Compiled migration/API/worker smoke: **3 passed**.
- Chromium browser tests: **3 passed** in the final run.
- Recovery, large checkpoint transport, cancellation, concurrent refresh/revoke, provider ambiguity,
  conservative usage reconciliation and upload-retention regressions are included in the backend gates.

Tests ran on Node 24.11.0 / macOS arm64; the repository CI continues to target Node 22.
The disposable PostgreSQL server was separate from the user's configured application database.

## Mixed-duration fault-soak evidence

Raw output is in `verification/2026-10-21/edge-cases/soak-pglite.json` and `soak-postgres.json`.
These profiles use real HTTP/SQL/local agent processes and actual WebSockets, with deterministic echo
work instead of AI inference. WebSocket fixture authentication is intentionally limited to the test
owner; this is not a benchmark of WorkOS or production session authentication.

| Measurement | PGlite | PostgreSQL |
| --- | ---: | ---: |
| Simulated users | 10 | 10 |
| Jobs completed | 400 | 400 |
| First-attempt worker failures recovered | 100 | 100 |
| Ambiguous create responses recovered | 27 | 27 |
| Injected API 503 responses | 23 | 26 |
| Runtime | 62.05 s | 58.60 s |
| Maximum allocated resources | 8 | 8 |
| Maximum resources per user allowed/checked | 2 | 2 |
| Live WebSocket event samples | 350 | 350 |
| p95 event-to-socket delay | 6 ms | 4 ms |
| p95 queue wait | 44.92 s | 39.31 s |
| Remaining resources | 0 | 0 |

Jobs wait deliberately behind an eight-resource cap. These are one-minute mixed-duration fault
soaks, not hours-long production soak evidence or a claim about real-AI user capacity. Heap samples
cover the Node control-plane heap, not total machine/VM/database memory. Other verification processes
were running on the same host. Longer profiles can set `KAPI_LOAD_TIMEOUT_SECONDS` up to 86,400.

Reproduce:

```bash
DATABASE_URL= pnpm verify
DATABASE_URL=postgres://kapi@127.0.0.1:5432/postgres pnpm verify
DATABASE_URL=postgres://kapi@127.0.0.1:5432/postgres pnpm test:soak:local
```

## Deployment and remaining external boundaries

Apply database migrations **5 and 6** before updating production services. Update API replicas
before starting new agent bundles. New agents require checkpoint protocol acknowledgement and
fail closed on an older control plane that cannot preserve their tool journal. Older agents retain
inline checkpoint compatibility during the API rollout.

A 64 MiB bound is on serialized snapshot data, including base64 overhead; ignored files and unsafe
untracked symlinks are not exported. An unacknowledged in-flight filesystem write can still be lost
when a VM's disk is destroyed. Per-tool journaling bounds the recovery window and prevents unsafe
continuation; an absolute in-flight data-loss guarantee would require a durable shared filesystem.
Arbitrary external shell effects cannot be made universally exactly-once. Reconciliation blocks
must be investigated before creating replacement work with an explicit account of existing effects.

The Codex service does not accept a hard output-token cap. One response can exceed its reserved
allowance; usage is recorded and future admission is stopped. Unknown usage is not automatically
refunded. Use `pnpm reconcile:model <call-id> <actual-tokens> <provider-evidence-reference>` only
with authoritative usage evidence.

Provider inventory can be eventually consistent. Unknown creations hold capacity during the grace
window. A healthy inventory with no matching resource after that window releases the reservation;
extremely late resources are still labelled and subsequently cleaned as orphans. This cannot promise
an absolute physical-resource ceiling during unbounded provider inconsistency.

**Live gates remain explicit:** the user's local Kapi account has no connected Codex grant at the
last readiness check; device sign-in was presented but not completed. GitHub App readiness for the
authorized `SaeedKhan36/kapi-final` repository passed earlier. The live AI → Build → Review → PR probe
is available as `pnpm test:live:local`, but no live success is claimed. Real Daytona restart/outage
validation awaits an active account; the provider failure tests use an injected SDK/local inventory.
