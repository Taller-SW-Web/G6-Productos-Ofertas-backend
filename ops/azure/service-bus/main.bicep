targetScope = 'resourceGroup'

@minLength(6)
@maxLength(50)
param namespaceName string = 'g6-sb-h5-int-32cdqgbnlk7ow'
param location string = 'chilecentral'
@description('Object ID of the pre-existing Pricing workload identity, never its client secret.')
param pricingPrincipalId string = ''
@description('Object ID of a different pre-existing Audit workload identity.')
param auditPrincipalId string = ''
param catalogPrincipalId string = ''
param taxonomyPrincipalId string = ''
param bulkPrincipalId string = ''
param inventoryPrincipalId string = ''
param promotionsPrincipalId string = ''
param combosPrincipalId string = ''
@minValue(1)
@maxValue(100)
param maxDeliveryCount int = 10
param defaultMessageTimeToLive string = 'P14D'
param enableFullTopology bool = true

var pilotQueueName = 'g6.price-audit.from.pricing'
var senderRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39')
var receiverRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0')

var principals = {
  catalog: catalogPrincipalId
  taxonomy: taxonomyPrincipalId
  bulk: bulkPrincipalId
  pricing: pricingPrincipalId
  inventory: inventoryPrincipalId
  promotions: promotionsPrincipalId
  combos: combosPrincipalId
  'price-audit': auditPrincipalId
}

var topologyQueues = [
  { name: 'g6.catalog.from.taxonomy', sender: 'taxonomy', receiver: 'catalog' }
  { name: 'g6.catalog.from.bulk', sender: 'bulk', receiver: 'catalog' }
  { name: 'g6.catalog.from.pricing', sender: 'pricing', receiver: 'catalog' }
  { name: 'g6.catalog.from.inventory', sender: 'inventory', receiver: 'catalog' }
  { name: 'g6.bulk.from.catalog', sender: 'catalog', receiver: 'bulk' }
  { name: 'g6.bulk.from.inventory', sender: 'inventory', receiver: 'bulk' }
  { name: 'g6.bulk.from.pricing', sender: 'pricing', receiver: 'bulk' }
  { name: 'g6.pricing.from.catalog', sender: 'catalog', receiver: 'pricing' }
  { name: 'g6.pricing.from.bulk', sender: 'bulk', receiver: 'pricing' }
  { name: 'g6.inventory.from.catalog', sender: 'catalog', receiver: 'inventory' }
  { name: 'g6.inventory.from.bulk', sender: 'bulk', receiver: 'inventory' }
  { name: 'g6.promotions.from.catalog', sender: 'catalog', receiver: 'promotions' }
  { name: 'g6.promotions.from.pricing', sender: 'pricing', receiver: 'promotions' }
  { name: 'g6.promotions.from.inventory', sender: 'inventory', receiver: 'promotions' }
  { name: 'g6.combos.from.catalog', sender: 'catalog', receiver: 'combos' }
  { name: 'g6.combos.from.inventory', sender: 'inventory', receiver: 'combos' }
  { name: 'g6.taxonomy.from.catalog', sender: 'catalog', receiver: 'taxonomy' }
  { name: 'g6.promotions.commands', sender: 'promotions', receiver: 'promotions' }
]

resource serviceBus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  properties: {
    minimumTlsVersion: '1.2'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource pilotQueue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: serviceBus
  name: pilotQueueName
  properties: {
    lockDuration: 'PT1M'
    defaultMessageTimeToLive: defaultMessageTimeToLive
    deadLetteringOnMessageExpiration: true
    maxDeliveryCount: maxDeliveryCount
    maxSizeInMegabytes: 1024
  }
}

resource pricingSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(pricingPrincipalId)) {
  name: guid(pilotQueue.id, pricingPrincipalId, senderRole)
  scope: pilotQueue
  properties: {
    principalId: pricingPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: senderRole
  }
}

resource auditReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(auditPrincipalId)) {
  name: guid(pilotQueue.id, auditPrincipalId, receiverRole)
  scope: pilotQueue
  properties: {
    principalId: auditPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: receiverRole
  }
}

resource h5Queues 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = [for q in topologyQueues: if (enableFullTopology) {
  parent: serviceBus
  name: q.name
  properties: {
    lockDuration: 'PT1M'
    defaultMessageTimeToLive: defaultMessageTimeToLive
    deadLetteringOnMessageExpiration: true
    maxDeliveryCount: maxDeliveryCount
    maxSizeInMegabytes: 1024
  }
}]

resource h5QueueSenders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (q, idx) in topologyQueues: if (enableFullTopology && !empty(principals[q.sender])) {
  name: guid(serviceBus.id, q.name, principals[q.sender], senderRole)
  scope: h5Queues[idx]
  properties: {
    principalId: principals[q.sender]
    principalType: 'ServicePrincipal'
    roleDefinitionId: senderRole
  }
}]

resource h5QueueReceivers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (q, idx) in topologyQueues: if (enableFullTopology && !empty(principals[q.receiver])) {
  name: guid(serviceBus.id, q.name, principals[q.receiver], receiverRole)
  scope: h5Queues[idx]
  properties: {
    principalId: principals[q.receiver]
    principalType: 'ServicePrincipal'
    roleDefinitionId: receiverRole
  }
}]

output namespaceFqdn string = '${serviceBus.name}.servicebus.windows.net'
output queueResourceId string = pilotQueue.id
output topologyQueueCount int = enableFullTopology ? 1 + length(topologyQueues) : 1
