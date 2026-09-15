#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

for tool in az jq git curl pnpm; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "$tool is required for Azure deployment" >&2
    exit 1
  }
done

if [ -n "${AZURE_SUBSCRIPTION_ID:-}" ]; then
  az account set --subscription "$AZURE_SUBSCRIPTION_ID"
fi
az account show --query '{name:name,id:id,state:state}' --output table

resource_group=${AZURE_RESOURCE_GROUP:-kapi-production}
location=${AZURE_LOCATION:-centralindia}
prefix=${AZURE_PREFIX:-kapi}
image_tag=${AZURE_IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}

case "$resource_group" in
  ''|*[!a-zA-Z0-9_.-]*) echo "AZURE_RESOURCE_GROUP contains unsafe characters" >&2; exit 1 ;;
esac
case "$location" in
  ''|*[!a-z0-9]*) echo "AZURE_LOCATION must be an Azure location code" >&2; exit 1 ;;
esac
case "$prefix" in
  ''|*[!a-z0-9-]*) echo "AZURE_PREFIX contains unsafe characters" >&2; exit 1 ;;
esac
case "$image_tag" in
  ''|*[!a-zA-Z0-9_.-]*) echo "AZURE_IMAGE_TAG contains unsafe characters" >&2; exit 1 ;;
esac

if [ -n "$(git status --porcelain)" ] && [ "${AZURE_ALLOW_DIRTY:-false}" != "true" ]; then
  echo "the worktree is dirty; commit it or set AZURE_ALLOW_DIRTY=true intentionally" >&2
  exit 1
fi

tmp_dir=$(mktemp -d)
parameters_file="$tmp_dir/foundation.parameters.json"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM

pnpm exec tsx scripts/write-azure-parameters.ts --output "$parameters_file"

echo "Registering Azure resource providers..."
for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.Network Microsoft.DBforPostgreSQL Microsoft.OperationalInsights Microsoft.ManagedIdentity; do
  az provider register --namespace "$provider" --wait --output none
done
az extension add --name containerapp --upgrade --yes --output none

echo "Creating resource group $resource_group in $location..."
az group create --name "$resource_group" --location "$location" --output none

echo "Deploying the private data, identity, registry, and logging foundation..."
foundation_outputs=$(az deployment group create \
  --name "kapi-foundation-$image_tag" \
  --resource-group "$resource_group" \
  --template-file infra/azure/foundation.bicep \
  --parameters "@$parameters_file" \
  --query properties.outputs \
  --output json)

container_environment=$(printf '%s' "$foundation_outputs" | jq -er '.containerEnvironmentName.value')
container_registry=$(printf '%s' "$foundation_outputs" | jq -er '.containerRegistryName.value')
runtime_identity=$(printf '%s' "$foundation_outputs" | jq -er '.runtimeIdentityName.value')
key_vault=$(printf '%s' "$foundation_outputs" | jq -er '.keyVaultName.value')

echo "Building immutable runtime and web images in Azure Container Registry..."
az acr build --registry "$container_registry" --image "kapi-runtime:$image_tag" --file Dockerfile .
az acr build --registry "$container_registry" --image "kapi-web:$image_tag" --file Dockerfile.web .

echo "Deploying the private API, operations worker, migration job, and public web gateway..."
apps_outputs=$(az deployment group create \
  --name "kapi-apps-$image_tag" \
  --resource-group "$resource_group" \
  --template-file infra/azure/apps.bicep \
  --parameters \
    prefix="$prefix" \
    location="$location" \
    imageTag="$image_tag" \
    containerEnvironmentName="$container_environment" \
    containerRegistryName="$container_registry" \
    runtimeIdentityName="$runtime_identity" \
    keyVaultName="$key_vault" \
    schedulerEnabled="${AZURE_SCHEDULER_ENABLED:-false}" \
    reconcileDeleteEnabled="${AZURE_RECONCILE_DELETE_ENABLED:-false}" \
    daytonaCentsPerHour="${KAPI_DAYTONA_CENTS_PER_HOUR:-6.6924}" \
  --query properties.outputs \
  --output json)

migration_job=$(printf '%s' "$apps_outputs" | jq -er '.migrationJobName.value')
web_url=$(printf '%s' "$apps_outputs" | jq -er '.webUrl.value')

echo "Starting the database migration job..."
az containerapp job start --name "$migration_job" --resource-group "$resource_group" --output none

deadline=$(( $(date +%s) + 1800 ))
while :; do
  migration_status=$(az containerapp job execution list \
    --name "$migration_job" \
    --resource-group "$resource_group" \
    --query 'sort_by(@, &properties.startTime)[-1].properties.status' \
    --output tsv)
  case "$migration_status" in
    Succeeded) echo "Database migration succeeded."; break ;;
    Failed|Stopped|Degraded) echo "Database migration ended with status $migration_status" >&2; exit 1 ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Database migration did not finish within 30 minutes" >&2
    exit 1
  fi
  echo "Migration status: ${migration_status:-Pending}"
  sleep 10
done

echo "Waiting for the public gateway and private API readiness..."
curl --fail --silent --show-error --retry 18 --retry-delay 10 --retry-all-errors \
  "$web_url/ready" >/dev/null

printf '\nAzure deployment completed.\n'
printf 'Application: %s\n' "$web_url"
printf 'WorkOS callback: %s/auth/callback\n' "$web_url"
printf 'GitHub webhook: %s/webhooks/github\n' "$web_url"
printf 'Scheduler enabled: %s\n' "${AZURE_SCHEDULER_ENABLED:-false}"
printf 'Reconciliation deletion enabled: %s\n' "${AZURE_RECONCILE_DELETE_ENABLED:-false}"
