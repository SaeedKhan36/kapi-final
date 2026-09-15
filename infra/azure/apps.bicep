targetScope = 'resourceGroup'

param prefix string = 'kapi'
param location string = resourceGroup().location
param imageTag string
param containerEnvironmentName string
param containerRegistryName string
param runtimeIdentityName string
param keyVaultName string

@description('Keep false for the first rollout; enable after API and worker health are proven.')
param schedulerEnabled bool = false

@description('Keep false through at least one clean orphan-audit grace window.')
param reconcileDeleteEnabled bool = false

@description('Current authoritative Daytona cents per hour for the default sandbox.')
param daytonaCentsPerHour string = '6.6924'

var apiName = '${prefix}-api'
var workerName = '${prefix}-operations'
var migrationJobName = '${prefix}-migrate'
var webName = '${prefix}-web'

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: containerEnvironmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: runtimeIdentityName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

var runtimeImage = '${registry.properties.loginServer}/kapi-runtime:${imageTag}'
var webImage = '${registry.properties.loginServer}/kapi-web:${imageTag}'
var webOrigin = 'https://${webName}.${containerEnvironment.properties.defaultDomain}'
var keyVaultBase = '${keyVault.properties.vaultUri}secrets/'
var userAssignedIdentities = {
  '${runtimeIdentity.id}': {}
}
var registryConfiguration = [
  {
    server: registry.properties.loginServer
    identity: runtimeIdentity.id
  }
]

resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: apiName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: userAssignedIdentities
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      secrets: [
        { name: 'database-url', keyVaultUrl: '${keyVaultBase}database-url', identity: runtimeIdentity.id }
        { name: 'kapi-secret-key', keyVaultUrl: '${keyVaultBase}kapi-secret-key', identity: runtimeIdentity.id }
        { name: 'kapi-session-secret', keyVaultUrl: '${keyVaultBase}kapi-session-secret', identity: runtimeIdentity.id }
        { name: 'workos-client-id', keyVaultUrl: '${keyVaultBase}workos-client-id', identity: runtimeIdentity.id }
        { name: 'workos-api-key', keyVaultUrl: '${keyVaultBase}workos-api-key', identity: runtimeIdentity.id }
        { name: 'github-app-id', keyVaultUrl: '${keyVaultBase}github-app-id', identity: runtimeIdentity.id }
        { name: 'github-app-private-key', keyVaultUrl: '${keyVaultBase}github-app-private-key', identity: runtimeIdentity.id }
        { name: 'github-webhook-secret', keyVaultUrl: '${keyVaultBase}github-webhook-secret', identity: runtimeIdentity.id }
        { name: 'metrics-token', keyVaultUrl: '${keyVaultBase}metrics-token', identity: runtimeIdentity.id }
      ]
      ingress: {
        external: false
        allowInsecure: false
        targetPort: 8787
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
    }
    template: {
      terminationGracePeriodSeconds: 120
      containers: [
        {
          name: 'api'
          image: runtimeImage
          command: [
            'node'
          ]
          args: [
            'apps/control-plane/dist/api.mjs'
          ]
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8787' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'KAPI_SECRET_KEY', secretRef: 'kapi-secret-key' }
            { name: 'KAPI_SESSION_SECRET', secretRef: 'kapi-session-secret' }
            { name: 'WORKOS_CLIENT_ID', secretRef: 'workos-client-id' }
            { name: 'WORKOS_API_KEY', secretRef: 'workos-api-key' }
            { name: 'GITHUB_APP_ID', secretRef: 'github-app-id' }
            { name: 'GITHUB_APP_PRIVATE_KEY', secretRef: 'github-app-private-key' }
            { name: 'GITHUB_WEBHOOK_SECRET', secretRef: 'github-webhook-secret' }
            { name: 'KAPI_METRICS_TOKEN', secretRef: 'metrics-token' }
            { name: 'KAPI_OPERATIONS', value: 'off' }
            { name: 'KAPI_ALLOWED_ORIGINS', value: webOrigin }
            { name: 'KAPI_WEB_URL', value: webOrigin }
            { name: 'CONTROL_PLANE_PUBLIC_URL', value: webOrigin }
            { name: 'WORKOS_REDIRECT_URI', value: '${webOrigin}/auth/callback' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/live', port: 8787, scheme: 'HTTP' }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 6
            }
            {
              type: 'Readiness'
              httpGet: { path: '/ready', port: 8787, scheme: 'HTTP' }
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 6
              successThreshold: 1
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
    workloadProfileName: 'Consumption'
  }
}

resource worker 'Microsoft.App/containerApps@2025-01-01' = {
  name: workerName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: userAssignedIdentities
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      secrets: [
        { name: 'database-url', keyVaultUrl: '${keyVaultBase}database-url', identity: runtimeIdentity.id }
        { name: 'kapi-secret-key', keyVaultUrl: '${keyVaultBase}kapi-secret-key', identity: runtimeIdentity.id }
        { name: 'daytona-api-key', keyVaultUrl: '${keyVaultBase}daytona-api-key', identity: runtimeIdentity.id }
      ]
    }
    template: {
      terminationGracePeriodSeconds: 120
      containers: [
        {
          name: 'operations'
          image: runtimeImage
          command: [
            'node'
          ]
          args: [
            'apps/control-plane/dist/worker.mjs'
          ]
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'KAPI_SECRET_KEY', secretRef: 'kapi-secret-key' }
            { name: 'DAYTONA_API_KEY', secretRef: 'daytona-api-key' }
            { name: 'CONTROL_PLANE_PUBLIC_URL', value: webOrigin }
            { name: 'KAPI_OPERATIONS', value: 'on' }
            { name: 'KAPI_PLANE_ID', value: '${prefix}-azure-production' }
            { name: 'VM_PROVIDER', value: 'daytona' }
            { name: 'KAPI_PROVISIONER', value: 'on' }
            { name: 'KAPI_RECONCILER', value: 'on' }
            { name: 'KAPI_SCHEDULER', value: schedulerEnabled ? 'on' : 'off' }
            { name: 'KAPI_RECONCILE_DELETE', value: reconcileDeleteEnabled ? 'true' : 'false' }
            { name: 'KAPI_DAYTONA_CENTS_PER_HOUR', value: daytonaCentsPerHour }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
    workloadProfileName: 'Consumption'
  }
}

resource migration 'Microsoft.App/jobs@2025-01-01' = {
  name: migrationJobName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: userAssignedIdentities
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: registryConfiguration
      secrets: [
        { name: 'database-url', keyVaultUrl: '${keyVaultBase}database-url', identity: runtimeIdentity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: runtimeImage
          command: [
            'node'
          ]
          args: [
            'apps/control-plane/dist/migrate.mjs'
          ]
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
    workloadProfileName: 'Consumption'
  }
}

resource web 'Microsoft.App/containerApps@2025-01-01' = {
  name: webName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: userAssignedIdentities
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registryConfiguration
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'web'
          image: webImage
          env: [
            { name: 'KAPI_API_ORIGIN', value: 'http://${apiName}' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/gateway-health', port: 8080, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/gateway-health', port: 8080, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
              successThreshold: 1
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
    workloadProfileName: 'Consumption'
  }
}

output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
output apiName string = api.name
output workerName string = worker.name
output migrationJobName string = migration.name
output webName string = web.name
output imageTag string = imageTag
