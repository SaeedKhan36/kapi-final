# Production operations

## DigitalOcean topology

`.do/app.yaml` defines a DigitalOcean App Platform app backed by an existing production
DigitalOcean Managed PostgreSQL cluster. It contains a public API service, a private operations
worker, a pre-deploy migration job, and the static React UI. The API runs with
`KAPI_OPERATIONS=off`; only the worker schedules,
reaps, meters, reconciles, and provisions. Queue and scheduler claims are database-locked,
and spawn/VM budgets use the run row as a cross-replica mutex, so a temporary second worker
remains safe during a rolling deploy.

The compiled `node apps/control-plane/dist/migrate.mjs` entrypoint runs as App Platform's
`PRE_DEPLOY` job and is the only production schema writer (`pnpm db:migrate` is the source
checkout equivalent). API and worker startup call the connect/verify path: if the migration is
missing they fail with an actionable readiness error instead of attempting DDL concurrently.

Set `VITE_API_URL`, `KAPI_WEB_URL`, `CONTROL_PLANE_PUBLIC_URL`, and
`KAPI_ALLOWED_ORIGINS` to the final HTTPS service URLs. Configure the WorkOS callback as
`$CONTROL_PLANE_PUBLIC_URL/auth/callback` and the GitHub webhook as
`$CONTROL_PLANE_PUBLIC_URL/webhooks/github`.

The exact account setup, secret ownership, creation command, and safe first rollout are in
[`DIGITALOCEAN.md`](./DIGITALOCEAN.md).

Before starting each service, load that service's production environment and run its strict
release preflight. This validates configuration without printing secret values:

```bash
pnpm release:preflight -- --role=api
pnpm release:preflight -- --role=worker
pnpm release:preflight -- --role=web
```

### Environment ownership

| Service | Required production values |
| --- | --- |
| API | `DATABASE_URL`, `KAPI_SECRET_KEY`, `KAPI_SESSION_SECRET`, `KAPI_ALLOWED_ORIGINS`, `KAPI_WEB_URL`, `CONTROL_PLANE_PUBLIC_URL`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `KAPI_METRICS_TOKEN`, and `KAPI_OPERATIONS=off` |
| Worker | The same `DATABASE_URL` and `KAPI_SECRET_KEY`, plus `CONTROL_PLANE_PUBLIC_URL`, a unique `KAPI_PLANE_ID`, non-local `VM_PROVIDER`, and `DAYTONA_API_KEY` when the provider is Daytona |
| Web build | `VITE_API_URL`, exactly matching `CONTROL_PLANE_PUBLIC_URL` |

`KAPI_RATE_LIMIT_SALT` is optional when `KAPI_SESSION_SECRET` is strong, and
`KAPI_DAYTONA_CENTS_PER_HOUR` is required for authoritative VM-cost reporting. The complete
runtime/tuning contract, including defaults and release-probe variables, is in `.env.example`.
Do not copy API-only OAuth or webhook credentials into the operations worker. Bootstrap values
such as `KAPI_JOB_TOKEN` and `KAPI_JOB_ID` are minted and injected by the provisioner; operators
must not configure them globally.

## Rollout and rollback

1. Deploy the database migration and API with the operations worker scaled to zero.
2. Start the worker with `KAPI_SCHEDULER=off` and `KAPI_RECONCILE_DELETE=false`.
3. Confirm queue, VM, usage, and orphan audit metrics. Enable the scheduler.
4. After at least one orphan grace window without false positives, set
   `KAPI_RECONCILE_DELETE=true`.

After each stage, run:

```bash
KAPI_SMOKE_URL=https://api.example.com \
KAPI_METRICS_TOKEN=... \
KAPI_SMOKE_REQUIRE_PRODUCTION=true pnpm test:smoke
```

For authenticated read-path coverage, add a short-lived test-session cookie through
`KAPI_SMOKE_COOKIE`; optionally set `KAPI_SMOKE_PROJECT_ID` to verify project and GitHub App
readiness. Keep the cookie in the deployment secret store, never in shell history or CI logs.

After the read-only smoke test passes, use a dedicated canary repository to prove the complete
adaptive lifecycle. The goal must be a small real change that requires Build and Review work.
The probe creates a thread and run, waits up to 45 minutes by default, requires PR and CI
evidence, and cancels an unfinished run on timeout:

```bash
KAPI_SMOKE_URL=https://api.example.com \
KAPI_SMOKE_COOKIE=... \
KAPI_SMOKE_PROJECT_ID=... \
KAPI_STAGING_GOAL="Make the documented canary change, test it, and have it reviewed." \
pnpm release:staging
```

Use `KAPI_STAGING_TIMEOUT_SECONDS` and `KAPI_STAGING_POLL_SECONDS` to adjust timing. The probe
never prints the session cookie.

Migrations are forward-compatible column/table additions. To roll application code back,
redeploy the prior image and leave the added schema in place. Never manually delete a
migration row. A destructive schema rollback requires a verified backup and a maintenance
window.

## Backup and restore

Enable DigitalOcean Managed PostgreSQL point-in-time recovery and take an on-demand backup before each
migration. Quarterly, restore the newest backup into a separate database, run
`pnpm db:migrate`, then verify project/thread/run counts and a read-only `/ready` smoke test.
Record the restore duration and any missing secrets; encrypted connection records require
the matching `KAPI_SECRET_KEY`.

At backup time, capture counts that contain no row contents:

```bash
pnpm release:snapshot-counts
```

After restoring into a separate database, run the repository verifier with that JSON. It
connects without applying schema changes, verifies every migration, compares all durable
table counts, checks event cursors and active leases, and decrypts every encrypted envelope
without printing its plaintext:

```bash
KAPI_RESTORE_DATABASE_URL=... \
KAPI_RESTORE_CONFIRM_ISOLATED=true \
KAPI_RESTORE_EXPECTED_COUNTS='{"users":1,"projects":1,...}' \
KAPI_SECRET_KEY=... pnpm release:verify-restore
```

## Secrets and rotation

- Rotate `KAPI_SESSION_SECRET` by forcing all sessions to sign in again.
- Rotate `KAPI_SECRET_KEY` only with an envelope re-encryption procedure; changing it alone
  makes stored secrets and Codex grants unreadable.
- Rotate the GitHub webhook secret in GitHub and DigitalOcean in the same maintenance window.
- Rotate WorkOS and Daytona credentials in their provider consoles, update DigitalOcean, and
  restart both services.

## Alerts

Scrape `/metrics` with `Authorization: Bearer $KAPI_METRICS_TOKEN`. Alert on readiness
failure, scheduler lag over 120 seconds, any sustained expired-lease growth, failed jobs,
orphan detection, reconciliation deletion failure, VM counts above budget, webhook
signature failures, and model/VM budget exhaustion. Logs are JSON and carry request IDs;
run, job, and agent identifiers are included in domain events.

Prometheus-compatible rules for the exported database-backed signals are provided in
[`ops/prometheus-rules.yml`](./ops/prometheus-rules.yml). Configure separate log alerts for
`vm.orphan_detected`, `queue.lease_expired`, webhook authentication failures, and reconciler
exceptions because those occur at process/provider boundaries rather than in durable counters.

The provisioner releases and destroys a VM that does not claim its queued job within
`KAPI_PROVISION_TIMEOUT_SECONDS` (default 120), then waits
`KAPI_PROVISION_RETRY_SECONDS` (default 15) before retrying provisioning failures.

## Incident response

Pause new work by setting `KAPI_PROVISIONER=off` and `KAPI_SCHEDULER=off`. Leave the reaper
and accounting enabled so leases and charges settle. For suspected bad deletion, immediately
set `KAPI_RECONCILE_DELETE=false`; the audit pass remains available. Restore database state
before restarting agents, because provider resources without matching live database rows are
deliberately classified as orphans after the grace period.

## Canary decision

Run `pnpm release:canary` with the smoke and staging-probe environment described above. Do
not enable general availability unless it passes, all alert rules remain quiet, the provider
inventory contains no unowned VM, and reconciliation has completed at least one full orphan
grace window in audit-only mode. Record the commit, run ID, pull request, CI delivery, start
and finish time, and operator in [`RELEASE.md`](./RELEASE.md).
