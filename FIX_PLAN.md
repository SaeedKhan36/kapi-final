# Reliability fix plan

Each numbered issue gets one independently reviewable commit, pushed to `codex/reliability-fixes` after targeted checks.

1. Preserve provider resource identity through job claim; verify actual resource cleanup.
2. Persist and restore Build workspace state together with its transcript; reject unsafe/incomplete recovery.
3. Export durable downloadable Build output before resource cleanup; distinguish local and published work.
4. Retain failed cleanup references, retry them, and expose failures.
5. Coordinate model admission across replicas, reserve tokens, cap per-run/user concurrency, and document provider-limit uncertainty.
6. Add shared global/user VM admission, fair selection, and bounded parallel provisioning.
7. Add reproducible lifecycle and capacity verification; run local and real-Postgres checks where available, recording external integration gates honestly.

Validation uses explicit local database configuration; live production credentials are not required for deterministic regressions. No claimed user capacity without workload evidence.

## Execution status

- Issues 1–6: implemented, targeted regressions passed, and separately committed/pushed.
- Issue 7: local and real-PostgreSQL verification and synthetic load gates implemented/executed.
  Live GitHub App readiness passed for the user-authorized repository; live AI → PR evidence
  awaits the user's Codex device sign-in. See `RELIABILITY_VERIFICATION.md` for commands and limits.
