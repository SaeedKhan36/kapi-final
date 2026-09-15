# Azure deployment

Azure is the primary deployment target. The repository provisions this topology with Bicep:

```text
Internet -> public kapi-web Container App -> private kapi-api Container App
                                                |
                          private PostgreSQL <- Container Apps environment
                                                |
                                      kapi-operations worker -> Daytona

Azure Container Registry <- managed identity -> Container Apps
Azure Key Vault          <- managed identity -> API, worker, migration job
```

The web gateway keeps browser traffic same-origin, including WebSockets. The API has no public
ingress. PostgreSQL has no public network access and is reached through its delegated subnet and
private DNS. A dedicated always-on operations worker provisions and reconciles agents; the API
cannot accidentally run those loops. A manually triggered Container Apps Job is the only schema
writer during deployment.

Committing these files does not create Azure resources. Account activation, provider quotas, and
the command in step 3 are operator actions.

## 1. Activate and select the Azure subscription

Finish Azure for Students activation, then install the local tools on macOS:

```bash
brew update
brew install azure-cli jq
az login
az account list --output table
az account set --subscription YOUR_SUBSCRIPTION_ID
```

Use the subscription ID shown by Azure, not its display name. The deployer prints only the selected
account's safe name, ID, and state before changing anything. PostgreSQL Flexible Server and
Container Apps quotas vary by subscription and region; if `centralindia` is unavailable, choose one
supported region and set `AZURE_LOCATION` before the first deployment.

## 2. Complete the local `.env`

Keep `.env` ignored by Git. The deployer reads it locally, validates it, creates a mode-`0600`
temporary ARM parameter file, and deletes that file on exit. It never passes secret values as Azure
CLI arguments.

Required application/provider values:

| Variable | Source |
| --- | --- |
| `KAPI_SECRET_KEY` | `openssl rand -base64 32`; retain permanently because it encrypts stored grants |
| `KAPI_SESSION_SECRET` | `openssl rand -base64 48` |
| `KAPI_METRICS_TOKEN` | `openssl rand -hex 32` |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY` | WorkOS dashboard |
| `GITHUB_APP_ID` | GitHub App settings |
| `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE` | Full GitHub App PEM or its local path |
| `GITHUB_WEBHOOK_SECRET` | `openssl rand -hex 32`; use the same value in GitHub |
| `DAYTONA_API_KEY` | Daytona dashboard |
| `KAPI_DAYTONA_CENTS_PER_HOUR` | Authoritative hourly rate for the selected Daytona sandbox |

Required Azure operator values:

```dotenv
AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000
AZURE_RESOURCE_GROUP=kapi-production
AZURE_LOCATION=centralindia
AZURE_PREFIX=kapi
AZURE_POSTGRES_ADMIN_LOGIN=kapiadmin
AZURE_POSTGRES_ADMIN_PASSWORD=<a unique 16-128 character password>
AZURE_POSTGRES_TIER=Burstable
AZURE_POSTGRES_SKU=Standard_B1ms
AZURE_POSTGRES_HA=Disabled
AZURE_POSTGRES_BACKUP_DAYS=7
AZURE_SCHEDULER_ENABLED=false
AZURE_RECONCILE_DELETE_ENABLED=false
```

Generate the database password once and save it in a password manager:

```bash
openssl rand -base64 32
```

Do not replace `KAPI_SECRET_KEY` during redeployments: doing so makes encrypted Codex connections
and vault entries unreadable. Do not commit `.env`, generated parameter JSON, PEM files, cookies, or
tokens.

## 3. Deploy

From a clean `main` checkout:

```bash
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm deploy:azure
```

The command registers required resource providers, creates the resource group, network, private
PostgreSQL 16 server, Log Analytics workspace, registry, managed identity, and Key Vault. It builds
immutable images in Azure Container Registry, deploys the API/worker/web apps, runs the migration
job, waits for it to succeed, and then waits for `/ready` through the public gateway.

The final output contains three safe values to copy:

- application URL;
- WorkOS callback: `<application-url>/auth/callback`;
- GitHub webhook: `<application-url>/webhooks/github`.

If deployment stops, fix the reported error and rerun the same command. Resource names are
deterministic and Bicep updates the existing deployment. Image tags default to the current commit
SHA. Never work around a PostgreSQL quota error by enabling public network access; choose an allowed
region/SKU or request quota instead.

## 4. Connect the external accounts

1. Add the emitted callback URL to the WorkOS redirect allowlist.
2. Set the emitted webhook URL on the GitHub App, use the same `GITHUB_WEBHOOK_SECRET`, enable SSL
   verification, and subscribe to check-run/check-suite events.
3. Install the GitHub App on a dedicated canary repository with Contents read/write permission.
4. Open the deployed app, sign in through WorkOS, and complete the Codex device authorization.

These consent/install steps cannot be completed by infrastructure code because they require the
account owner in the provider UI.

## 5. Prove the live lifecycle

Keep `AZURE_SCHEDULER_ENABLED=false` and `AZURE_RECONCILE_DELETE_ENABLED=false` for the initial
deployment. First verify the read-only surface:

```bash
export KAPI_SMOKE_URL=https://YOUR_AZURE_APP_HOST
export KAPI_SMOKE_REQUIRE_PRODUCTION=true
export KAPI_METRICS_TOKEN='from-your-local-env'
pnpm test:smoke
```

After login, obtain a short-lived test session cookie in a private operator shell and run the
Captain lifecycle against the canary project:

```bash
export KAPI_SMOKE_COOKIE='private-session-cookie'
export KAPI_SMOKE_PROJECT_ID='canary-project-id'
export KAPI_STAGING_GOAL='Make the documented canary change, test it, and have it reviewed.'
pnpm release:staging
```

The gate requires Captain -> Build -> pull request/CI -> Review -> Captain evidence and cancels an
unfinished run on timeout. It never prints the cookie.

Once the API and worker are healthy, redeploy with scheduling enabled:

```bash
AZURE_SCHEDULER_ENABLED=true pnpm deploy:azure
```

Leave reconciliation deletion disabled through at least one full orphan grace window. Enable it
only after audit logs show no false positives:

```bash
AZURE_SCHEDULER_ENABLED=true AZURE_RECONCILE_DELETE_ENABLED=true pnpm deploy:azure
```

## 6. Production hardening

The defaults minimize student-credit usage: `Standard_B1ms`, seven-day backup retention, and no
high availability. Before relying on the service for important production data, change to a
supported General Purpose SKU, enable zone-redundant or same-zone HA, increase backup retention,
and verify the resulting cost and regional quota:

```dotenv
AZURE_POSTGRES_TIER=GeneralPurpose
AZURE_POSTGRES_SKU=Standard_D2ds_v5
AZURE_POSTGRES_HA=ZoneRedundant
AZURE_POSTGRES_BACKUP_DAYS=14
```

Configure Azure Monitor alerts for failed revisions/jobs, `/ready` failures, worker restarts, and
PostgreSQL resource pressure. Scrape the authenticated `/metrics` route and load
`ops/prometheus-rules.yml`. Before general availability, restore a backup into an isolated database,
run `pnpm release:verify-restore`, and prove that the prior application image can be redeployed.

The full ordered rollout, rollback, incident, and canary rules are in
[`OPERATIONS.md`](./OPERATIONS.md); remaining human/live gates are tracked in
[`RELEASE.md`](./RELEASE.md).
