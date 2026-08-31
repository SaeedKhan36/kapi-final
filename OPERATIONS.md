# Production operations

## Render topology

`render.yaml` creates managed Postgres, a public API service, a private operations worker,
and the static React UI. The API runs with `KAPI_OPERATIONS=off`; only the worker schedules,
reaps, meters, reconciles, and provisions. All queue and scheduler claims are database-locked,
so a temporary second worker remains safe during a rolling deploy.

Set `VITE_API_URL`, `KAPI_WEB_URL`, `CONTROL_PLANE_PUBLIC_URL`, and
`KAPI_ALLOWED_ORIGINS` to the final HTTPS service URLs. Configure the WorkOS callback as
`$CONTROL_PLANE_PUBLIC_URL/auth/callback` and the GitHub webhook as
`$CONTROL_PLANE_PUBLIC_URL/webhooks/github`.

## Rollout and rollback

1. Deploy the database migration and API with the operations worker scaled to zero.
2. Start the worker with `KAPI_SCHEDULER=off` and `KAPI_RECONCILE_DELETE=false`.
3. Confirm queue, VM, usage, and orphan audit metrics. Enable the scheduler.
4. After at least one orphan grace window without false positives, set
   `KAPI_RECONCILE_DELETE=true`.

Migrations are forward-compatible column/table additions. To roll application code back,
redeploy the prior image and leave the added schema in place. Never manually delete a
migration row. A destructive schema rollback requires a verified backup and a maintenance
window.

## Backup and restore

Enable Render Postgres point-in-time recovery and take an on-demand backup before each
migration. Quarterly, restore the newest backup into a separate database, run
`pnpm db:migrate`, then verify project/thread/run counts and a read-only `/ready` smoke test.
Record the restore duration and any missing secrets; encrypted connection records require
the matching `KAPI_SECRET_KEY`.

## Secrets and rotation

- Rotate `KAPI_SESSION_SECRET` by forcing all sessions to sign in again.
- Rotate `KAPI_SECRET_KEY` only with an envelope re-encryption procedure; changing it alone
  makes stored secrets and Codex grants unreadable.
- Rotate the GitHub webhook secret in GitHub and Render in the same maintenance window.
- Rotate WorkOS and Daytona credentials in their provider consoles, update Render, and
  restart both services.

## Alerts

Scrape `/metrics` with `Authorization: Bearer $KAPI_METRICS_TOKEN`. Alert on readiness
failure, scheduler lag over 120 seconds, any sustained expired-lease growth, failed jobs,
orphan detection, reconciliation deletion failure, VM counts above budget, webhook
signature failures, and model/VM budget exhaustion. Logs are JSON and carry request IDs;
run, job, and agent identifiers are included in domain events.

## Incident response

Pause new work by setting `KAPI_PROVISIONER=off` and `KAPI_SCHEDULER=off`. Leave the reaper
and accounting enabled so leases and charges settle. For suspected bad deletion, immediately
set `KAPI_RECONCILE_DELETE=false`; the audit pass remains available. Restore database state
before restarting agents, because provider resources without matching live database rows are
deliberately classified as orphans after the grace period.
