import { accessSync, constants, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const foundation = readFileSync(new URL("infra/azure/foundation.bicep", root), "utf8");
const apps = readFileSync(new URL("infra/azure/apps.bicep", root), "utf8");
const deploy = readFileSync(new URL("deploy/azure/deploy.sh", root), "utf8");
const parameters = readFileSync(new URL("scripts/write-azure-parameters.ts", root), "utf8");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Azure deployment contract: ${message}`);
}

function contains(source: string, expected: string, message: string): void {
  assert(source.includes(expected), message);
}

for (const secret of [
  "postgresAdminPassword",
  "kapiSecretKey",
  "kapiSessionSecret",
  "workosClientId",
  "workosApiKey",
  "githubAppId",
  "githubAppPrivateKey",
  "githubWebhookSecret",
  "metricsToken",
  "daytonaApiKey",
]) {
  assert(new RegExp(`@secure\\(\\)\\s+param ${secret} string`).test(foundation), `${secret} must be a secure parameter`);
}

contains(foundation, "serviceName: 'Microsoft.App/environments'", "Container Apps subnet must be delegated");
contains(foundation, "addressPrefix: '10.42.0.0/23'", "Container Apps subnet must meet workload-profile sizing");
contains(foundation, "serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'", "PostgreSQL subnet must be delegated");
contains(foundation, "Microsoft.Network/privateDnsZones", "PostgreSQL must use private DNS");
contains(foundation, "publicNetworkAccess: 'Disabled'", "PostgreSQL public networking must be disabled");
contains(foundation, "version: '16'", "PostgreSQL major version must remain pinned");
assert(!foundation.includes("0.0.0.0"), "foundation must not allow the public internet into PostgreSQL");

contains(foundation, "adminUserEnabled: false", "ACR admin credentials must remain disabled");
contains(foundation, "7f951dda-4ed3-4680-a7ca-43fe172d538d", "runtime identity must receive AcrPull");
contains(foundation, "enableRbacAuthorization: true", "Key Vault must use Azure RBAC");
contains(foundation, "enablePurgeProtection: true", "Key Vault purge protection must remain enabled");
contains(foundation, "4633458b-17de-408a-b874-0445c86b69e6", "runtime identity must receive Key Vault Secrets User");

contains(apps, "resource api 'Microsoft.App/containerApps", "private API app is missing");
contains(apps, "resource worker 'Microsoft.App/containerApps", "operations worker is missing");
contains(apps, "resource migration 'Microsoft.App/jobs", "migration job is missing");
contains(apps, "resource web 'Microsoft.App/containerApps", "public web gateway is missing");
contains(apps, "{ name: 'KAPI_API_ORIGIN', value: 'http://${apiName}' }", "web must use private Container Apps service discovery");
contains(apps, "keyVaultUrl: '${keyVaultBase}", "runtime secrets must reference Key Vault");
contains(apps, "identity: runtimeIdentity.id", "ACR and Key Vault access must use managed identity");
contains(apps, "triggerType: 'Manual'", "migration must remain an explicitly started job");
contains(apps, "{ name: 'KAPI_OPERATIONS', value: 'off' }", "API must not run background operations");
contains(apps, "{ name: 'KAPI_OPERATIONS', value: 'on' }", "worker must run background operations");
contains(apps, "{ name: 'VM_PROVIDER', value: 'daytona' }", "production worker must use Daytona");
contains(apps, "param schedulerEnabled bool = false", "first rollout must keep the scheduler disabled");
contains(apps, "param reconcileDeleteEnabled bool = false", "first rollout must keep deletion disabled");

const apiBlock = apps.slice(apps.indexOf("resource api "), apps.indexOf("resource worker "));
const workerBlock = apps.slice(apps.indexOf("resource worker "), apps.indexOf("resource migration "));
contains(apiBlock, "external: false", "API ingress must be private");
contains(webBlock(), "external: true", "web ingress must be public");
for (const apiOnlySecret of ["workos-api-key", "github-app-private-key", "github-webhook-secret", "kapi-session-secret"]) {
  assert(!workerBlock.includes(apiOnlySecret), `worker must not receive API-only secret ${apiOnlySecret}`);
}

function webBlock(): string {
  return apps.slice(apps.indexOf("resource web "));
}

contains(parameters, "mode: 0o600", "generated parameter file must be private");
contains(parameters, "validateAppPrivateKey(github)", "GitHub private key must be validated before deployment");
contains(parameters, "KAPI_SECRET_KEY must decode to exactly 32 bytes", "vault key strength must be validated");
assert(!deploy.includes("set -x"), "deployment must not enable shell tracing around secrets");
contains(deploy, "mktemp -d", "deployment must use a temporary secret parameter file");
contains(deploy, "trap cleanup EXIT HUP INT TERM", "temporary secret parameters must always be removed");
contains(deploy, "az acr build", "images must be built in Azure without requiring local Docker");
assert(deploy.indexOf("az containerapp job start") < deploy.indexOf('"$web_url/ready"'), "migration must finish before readiness is accepted");

accessSync(new URL("deploy/azure/deploy.sh", root), constants.X_OK);
console.log("ok Azure topology, identity, network, secret, migration, and rollout boundaries");
