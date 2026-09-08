# DigitalOcean deployment

The repository is prepared for a DigitalOcean-only production deployment. The source of truth
is [`.do/app.yaml`](./.do/app.yaml). It describes one App Platform application with:

- a public API service running `apps/control-plane/dist/api.mjs`;
- a dedicated private operations worker running `apps/control-plane/dist/worker.mjs`;
- a `PRE_DEPLOY` migration job running `apps/control-plane/dist/migrate.mjs`;
- the `apps/web/dist` static SPA;
- a private connection to an existing DigitalOcean Managed PostgreSQL cluster;
- same-origin ingress, `/ready` health checks, and deployment/domain alerts.

Nothing in this file creates resources merely by being committed. Complete the following steps
after the student credit is active.

## 1. Prepare the account

1. Claim the student credit and finish DigitalOcean account verification.
2. Install `doctl` and run `doctl auth init` with a personal access token.
3. In DigitalOcean, connect GitHub and grant App Platform access to
   `SaeedKhan36/kapi-final`.
4. Keep the app and database in `sgp` as specified, or change both before creation. A private
   database URL only works when the app and database can use the same VPC.

## 2. Create managed PostgreSQL first

Create a production DigitalOcean Managed PostgreSQL cluster named `kapi-postgres` in the same
region as the app. Create database `kapi` and user `kapi`, matching the `databases` binding in
`.do/app.yaml`. Do not use an App Platform development database for production.

After the app exists, add the App Platform app as a trusted source for the cluster. The spec
injects `${kapi-db.DATABASE_PRIVATE_URL}` into the API, worker, and migration job; do not paste a
public database URL into those components.

## 3. Supply secrets before the first deployment

In the App Platform review screen, open each component's environment variables, replace every
`CHANGE_ME` value, and keep each value encrypted. Generate independent values locally:

```bash
openssl rand -base64 32  # KAPI_SECRET_KEY
openssl rand -base64 48  # KAPI_SESSION_SECRET
openssl rand -hex 32     # GITHUB_WEBHOOK_SECRET
openssl rand -hex 32     # KAPI_METRICS_TOKEN
```

Do not paste generated values into `.do/app.yaml`, a shell script, an issue, or a commit.

### API secrets

| Variable | Source |
| --- | --- |
| `KAPI_SECRET_KEY` | First command above; also put the exact same value on the worker |
| `KAPI_SESSION_SECRET` | Second command above |
| `WORKOS_CLIENT_ID` | WorkOS dashboard |
| `WORKOS_API_KEY` | WorkOS dashboard |
| `GITHUB_APP_ID` | GitHub App settings |
| `GITHUB_APP_PRIVATE_KEY` | Full downloaded PEM, including header and footer |
| `GITHUB_WEBHOOK_SECRET` | Third command above; also configure it in the GitHub App |
| `KAPI_METRICS_TOKEN` | Fourth command above |

### Worker secrets

| Variable | Source |
| --- | --- |
| `KAPI_SECRET_KEY` | Exactly the same value used by the API |
| `DAYTONA_API_KEY` | Daytona dashboard |

The worker deliberately does not receive WorkOS, GitHub App, session, webhook, or metrics
secrets. `DATABASE_URL`, app URLs, and all safe control flags are bound by the spec. Replace
`KAPI_DAYTONA_CENTS_PER_HOUR=0` with the real provider rate before relying on cost reports.

## 4. Create the App Platform app

Review the spec first, especially the region, GitHub repository, component sizes, database
cluster name, and every `CHANGE_ME` value. Then create it:

```bash
doctl apps create --spec .do/app.yaml --format ID,DefaultIngress,Created
```

App Platform builds all components from the monorepo. The migration job must finish before the
API and worker revision becomes live. Auto-deploy is enabled for `main`; GitHub branch protection
and CI remain the release gate.

Once DigitalOcean assigns the HTTPS app URL, verify that these bindable values resolved to that
same URL:

- API: `KAPI_ALLOWED_ORIGINS`, `KAPI_WEB_URL`, and `CONTROL_PLANE_PUBLIC_URL`;
- API: `WORKOS_REDIRECT_URI=<app-url>/auth/callback`;
- worker: `CONTROL_PLANE_PUBLIC_URL`;
- web build: `VITE_API_URL`.

Set the WorkOS redirect URI to `<app-url>/auth/callback`. Set the GitHub App webhook URL to
`<app-url>/webhooks/github`, paste the same webhook secret, enable SSL verification, and subscribe
to check-suite/check-run events used by the app.

## 5. Safe first rollout

The committed spec uses `KAPI_SCHEDULER=off` and `KAPI_RECONCILE_DELETE=false`. Keep those values
for the first deployment.

1. Confirm that the pre-deploy migration succeeded.
2. Confirm that both `api` and `operations` run the same commit SHA.
3. Run the production preflight locally using environment exports copied from DigitalOcean's
   values, without printing them:

   ```bash
   pnpm release:preflight -- --role=api
   pnpm release:preflight -- --role=worker
   pnpm release:preflight -- --role=web
   ```

4. Verify the public surface:

   ```bash
   curl -fsS https://YOUR_APP_DOMAIN/live
   curl -fsS https://YOUR_APP_DOMAIN/ready
   curl -fsS -H "Authorization: Bearer $KAPI_METRICS_TOKEN" \
     https://YOUR_APP_DOMAIN/metrics >/dev/null
   KAPI_SMOKE_URL=https://YOUR_APP_DOMAIN \
     KAPI_METRICS_TOKEN="$KAPI_METRICS_TOKEN" \
     KAPI_SMOKE_REQUIRE_PRODUCTION=true pnpm test:smoke
   ```

5. Test WorkOS login/logout, connect and revoke a Codex grant, install the GitHub App on a canary
   repository, and run `pnpm probe:daytona` from an operator environment.
6. Change only the worker's `KAPI_SCHEDULER` to `on`, redeploy, and run a real canary:

   ```bash
   KAPI_SMOKE_URL=https://YOUR_APP_DOMAIN \
   KAPI_SMOKE_COOKIE=... \
   KAPI_SMOKE_PROJECT_ID=... \
   KAPI_STAGING_GOAL="Make the documented canary change, test it, and have it reviewed." \
   pnpm release:staging
   ```

7. Leave `KAPI_RECONCILE_DELETE=false` for at least one orphan grace window. Enable it only after
   the inventory and audit metrics show no false positives.

## 6. Backups, alerts, and cutover

Enable Managed PostgreSQL backups and point-in-time recovery before production traffic. Take a
fresh backup before migrations. Restore into an isolated cluster at least quarterly and verify it
with `pnpm release:verify-restore` as documented in `OPERATIONS.md`.

Configure DigitalOcean alert destinations for the deployment/domain alerts in the spec. Add an
external uptime check for `/ready` and a Prometheus-compatible scraper for the authenticated
`/metrics` endpoint and `ops/prometheus-rules.yml`.

This repository setup does not migrate or delete an existing deployment. When ready to cut over,
restore current data into DigitalOcean, run the smoke/canary gates, switch DNS, observe one full
grace window, and only then retire the former infrastructure.
