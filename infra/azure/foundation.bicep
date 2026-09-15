targetScope = 'resourceGroup'

@description('Short lowercase prefix used for Azure resource names.')
@minLength(3)
@maxLength(12)
param prefix string = 'kapi'

@description('Azure region. The resource group should use the same region.')
param location string = resourceGroup().location

@description('PostgreSQL administrator login. This is not an application user.')
param postgresAdminLogin string = 'kapiadmin'

@secure()
param postgresAdminPassword string

@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresTier string = 'Burstable'

@description('Use Standard_D2ds_v5 or larger before enabling zone-redundant HA.')
param postgresSkuName string = 'Standard_B1ms'

@allowed([
  'Disabled'
  'ZoneRedundant'
  'SameZone'
])
param postgresHighAvailability string = 'Disabled'

@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 7

@secure()
param kapiSecretKey string

@secure()
param kapiSessionSecret string

@secure()
param workosClientId string

@secure()
param workosApiKey string

@secure()
param githubAppId string

@secure()
param githubAppPrivateKey string

@secure()
param githubWebhookSecret string

@secure()
param metricsToken string

@secure()
param daytonaApiKey string

var suffix = uniqueString(subscription().id, resourceGroup().id)
var compactPrefix = toLower(replace(prefix, '-', ''))
var vnetName = '${prefix}-network'
var environmentName = '${prefix}-environment'
var workspaceName = '${prefix}-logs'
var identityName = '${prefix}-runtime'
var registryName = take('${compactPrefix}${suffix}', 50)
var keyVaultName = take('${compactPrefix}-${suffix}', 24)
var postgresServerName = take('${compactPrefix}-${suffix}-pg', 63)
var privateDnsZoneName = '${compactPrefix}-${suffix}.postgres.database.azure.com'

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/16'
      ]
    }
    subnets: [
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.42.0.0/23'
          delegations: [
            {
              name: 'container-apps-environment'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'postgresql'
        properties: {
          addressPrefix: '10.42.2.0/28'
          delegations: [
            {
              name: 'postgresql-flexible-server'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logWorkspace.properties.customerId
        sharedKey: logWorkspace.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, 'container-apps')
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
  dependsOn: [
    virtualNetwork
  ]
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    policies: {
      retentionPolicy: {
        days: 7
        status: 'enabled'
      }
    }
  }
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
}

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, runtimeIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource runtimeSecretsReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, runtimeIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: keyVault
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: privateDnsZoneName
  location: 'global'
}

resource privateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: privateDnsZone
  name: '${prefix}-postgres-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  sku: {
    name: postgresSkuName
    tier: postgresTier
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    version: '16'
    createMode: 'Create'
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: postgresBackupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: postgresHighAvailability
    }
    network: {
      delegatedSubnetResourceId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, 'postgresql')
      privateDnsZoneArmResourceId: privateDnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
  }
  dependsOn: [
    privateDnsLink
  ]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresServer
  name: 'kapi'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

var databaseUrl = 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgresServer.properties.fullyQualifiedDomainName}:5432/${database.name}?sslmode=require'
var secretValues = [
  {
    name: 'kapi-secret-key'
    value: kapiSecretKey
  }
  {
    name: 'kapi-session-secret'
    value: kapiSessionSecret
  }
  {
    name: 'workos-client-id'
    value: workosClientId
  }
  {
    name: 'workos-api-key'
    value: workosApiKey
  }
  {
    name: 'github-app-id'
    value: githubAppId
  }
  {
    name: 'github-app-private-key'
    value: githubAppPrivateKey
  }
  {
    name: 'github-webhook-secret'
    value: githubWebhookSecret
  }
  {
    name: 'metrics-token'
    value: metricsToken
  }
  {
    name: 'daytona-api-key'
    value: daytonaApiKey
  }
]

resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [for item in secretValues: {
  parent: keyVault
  name: item.name
  properties: {
    value: item.value
  }
}]

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'database-url'
  properties: {
    value: databaseUrl
  }
}

output containerEnvironmentName string = containerEnvironment.name
output containerRegistryName string = registry.name
output containerRegistryLoginServer string = registry.properties.loginServer
output runtimeIdentityName string = runtimeIdentity.name
output keyVaultName string = keyVault.name
output postgresServerName string = postgresServer.name
output networkName string = virtualNetwork.name
