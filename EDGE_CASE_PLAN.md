# Eight edge-case hardening steps

One commit per numbered issue, validated before pushing to main.

1. Durable idempotency for child spawning and GitHub PR lookup/replay.
2. Chunked, checksummed workspace checkpoint transport beyond the old 1 MB cap.
3. Persist tool intentions and checkpoint after individual tool results; safe interrupted-action recovery.
4. Abort running commands, process trees, HTTP/model requests and retries on lease loss or cancellation.
5. Account for uncertain model usage explicitly; reconcile expired reservations and expose conservative charges.
6. Serialize refresh of a user's rotating Codex grant across replicas and preserve concurrent revoke/reconnect decisions.
7. Recover ambiguous provider creation through durable reservation labels and inventory reconciliation; fault-injection tests.
8. Sustained mixed-duration load/failure verification, bounded event retention in memory, and honest live integration evidence.

External actions cannot be made universally exactly-once: arbitrary repository shell commands may have
external side effects. Interrupted unsafe commands must be reported for reconciliation rather than
blindly re-executed. Provider-enforced token caps and live cloud verification remain dependent on provider capability/access.

## Execution result

All eight implementation/verification steps have dedicated commits on main. Local and PostgreSQL
checks and mixed-duration fault soaks passed. See `EDGE_CASE_VERIFICATION.md` for evidence and the
explicit external gates: live Codex sign-in and an active Daytona account. Per-tool recovery does
not imply that an unacknowledged in-flight disk write survives destruction of the VM's disk.
