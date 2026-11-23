targetScope = 'resourceGroup'

@description('Nombre del Container Apps Environment aislado ya aprobado.')
param environmentName string = 'env-g6-h5-int'

@description('Nombre DNS de la región ACA usada para construir origins internos.')
param environmentDefaultDomain string

@description('Client ID de la UAMI Promotions con RBAC limitado a la cola autorizada.')
param promotionsIdentityResourceId string

@description('SHA exacto de master del que provienen las cinco imágenes.')
@minLength(40)
@maxLength(40)
param sourceSha string

@description('Digests OCI sha256 por nombre de servicio, nunca tags mutables.')
param imageDigests object

@description('Configuración por app. Cada entrada contiene env (incluye secretRef) y secrets (name,value). Envía la estructura por un archivo temporal protegido.')
@secure()
param appConfiguration object

var appNames = [ 'api-gateway', 'catalog-svc', 'inventory-svc', 'pricing-svc', 'promotions-svc' ]
var ports = [ 3000, 3001, 3005, 3002, 3004 ]
var probePaths = [ '/health', '/health', '/health', '/health', '/health' ]
var readyPaths = [ '/health', '/health/ready', '/health/readiness', '/health/ready', '/health/ready' ]
var guardedEnv = [
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'API_GATEWAY_PORT', value: '3000' }
    { name: 'G6_SECURITY_MODE', value: 'G7_AUTHENTICATED' }
    { name: 'GATEWAY_DEMO_NO_AUTH_ENABLED', value: 'false' }
    { name: 'GATEWAY_G5_H5_ENABLED', value: 'false' }
  ]
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'CATALOG_SVC_PORT', value: '3001' }
  ]
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'INVENTORY_SVC_PORT', value: '3005' }
    { name: 'G6_SECURITY_MODE', value: 'G7_AUTHENTICATED' }
    { name: 'INVENTORY_DEMO_NO_AUTH_ENABLED', value: 'false' }
    { name: 'INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED', value: 'false' }
  ]
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'PRICING_SVC_PORT', value: '3002' }
    { name: 'G6_SECURITY_MODE', value: 'G7_AUTHENTICATED' }
    { name: 'PRICING_PRICE_CHANGED_PUBLISH_ENABLED', value: 'false' }
  ]
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'PROMOTIONS_SVC_PORT', value: '3004' }
    { name: 'G6_SECURITY_MODE', value: 'G7_AUTHENTICATED' }
    { name: 'PROMOTIONS_COUPON_RUNTIME_ENABLED', value: 'false' }
    { name: 'GATEWAY_DEMO_NO_AUTH_ENABLED', value: 'false' }
  ]
]
var images = [for appName in appNames: 'ghcr.io/taller-sw-web/g6-productos-ofertas-backend/${appName}@${imageDigests[appName]}']
var caddyImage = 'caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9'
var environmentId = resourceId('Microsoft.App/managedEnvironments', environmentName)
var caddyfile = 'admin off\nauto_https off\n:8080 {\n request_body { max_size 10MB }\n header { X-Content-Type-Options nosniff\n X-Frame-Options DENY\n Referrer-Policy no-referrer\n -Server }\n @published path /health /api/v1/*\n handle @published { reverse_proxy 127.0.0.1:3000 { transport http { dial_timeout 3s\n response_header_timeout 45s } } }\n handle { respond 404 }\n}\n'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource apps 'Microsoft.App/containerApps@2025-01-01' = [for (appName, i) in appNames: {
  name: appName
  location: resourceGroup().location
  identity: i == 4 ? {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${promotionsIdentityResourceId}': {}
    }
  } : null
  tags: {
    project: 'g6-h5-isolated'
    sourceSha: sourceSha
    environment: 'nonproduction'
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: i == 0 ? 8080 : ports[i]
        allowInsecure: false
        transport: 'auto'
        traffic: [ { latestRevision: true, weight: 100 } ]
      }
      secrets: concat(appConfiguration[appName].secrets, i == 0 ? [ { name: 'edge-config', value: caddyfile } ] : [])
    }
    template: {
      scale: {
        minReplicas: i == 4 ? 1 : 0
        maxReplicas: 2
      }
      volumes: i == 0 ? [{
        name: 'edge-config'
        storageType: 'Secret'
        secrets: [ { secretRef: 'edge-config', path: 'Caddyfile' } ]
      }] : []
      containers: concat([
        {
          name: appName
          image: images[i]
          env: concat(guardedEnv[i], appConfiguration[appName].env)
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          probes: [
            { type: 'Startup', httpGet: { path: probePaths[i], port: ports[i], scheme: 'HTTP' }, initialDelaySeconds: 5, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 60 }
            { type: 'Liveness', httpGet: { path: probePaths[i], port: ports[i], scheme: 'HTTP' }, initialDelaySeconds: 10, periodSeconds: 30, timeoutSeconds: 3, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: readyPaths[i], port: ports[i], scheme: 'HTTP' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 }
          ]
        }
      ], i == 0 ? [{
          name: 'caddy'
          image: caddyImage
          command: [ 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile' ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          volumeMounts: [ { volumeName: 'edge-config', mountPath: '/etc/caddy' } ]
        }] : [])
    }
  }
}]

output provisionedNames array = appNames
output privateOrigins object = {
  apiGateway: 'https://api-gateway.internal.${environmentDefaultDomain}'
  catalog: 'https://catalog-svc.internal.${environmentDefaultDomain}'
  inventory: 'https://inventory-svc.internal.${environmentDefaultDomain}'
  pricing: 'https://pricing-svc.internal.${environmentDefaultDomain}'
  promotions: 'https://promotions-svc.internal.${environmentDefaultDomain}'
}
