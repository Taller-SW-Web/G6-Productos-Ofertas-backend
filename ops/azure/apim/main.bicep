targetScope = 'resourceGroup'

@description('Nombre del servicio APIM.')
param apimName string
@description('Si es true, reutiliza una instancia APIM existente compatible en el resource group sin aprovisionar una nueva.')
param reuseExistingApim bool = false
@description('Región aprobada para el laboratorio.')
param location string
@description('Nombre del publicador responsable del servicio APIM.')
param publisherName string
@description('Correo operativo del publicador APIM.')
param publisherEmail string
@description('Subred dedicada de APIM en la VNet existente. No se crea red.')
param apimSubnetResourceId string
@description('Base URL privada aprobada del Gateway: https://<hostname>/api/v1, sin ruta adicional.')
param gatewayBackendUrl string
@description('Issuer exacto publicado por G7.')
param g7Issuer string
@description('URL OpenID/JWKS de G7, sin credenciales.')
param g7OpenIdConfigurationUrl string
@description('Audience técnica autorizada por G7 para operaciones M2M.')
param g7Audience string
@description('Lista explícita de orígenes CORS aprobados; no admite wildcard.')
@minLength(1)
param corsAllowedOrigins array
@description('Límite de ráfaga por defecto cuando un perfil no sobreescribe.')
@minValue(1)
param burstCalls int
@description('Ventana de ráfaga en segundos.')
@minValue(1)
@maxValue(300)
param burstWindowSeconds int
@description('Cuota por identidad y operación.')
@minValue(1)
param quotaCalls int
@description('Ventana de cuota en segundos.')
@minValue(300)
param quotaWindowSeconds int
@description('Nivel de ambiente aprobado (lab o production).')
@allowed([
  'lab'
  'production'
])
param environmentTier string
@description('Perfiles de protección parametrizados obligatorios (commercial_read, admin_read, business_write, multipart_import, expensive_export, g5_protected).')
param rateProfiles object
@description('Resource ID del recurso Application Insights autorizado.')
param applicationInsightsResourceId string
@secure()
@description('Cadena de conexión de Application Insights; no se almacena en el repositorio.')
param applicationInsightsConnectionString string
@description('OpenAPI JSON efectivo generado por filter-openapi.py; se suministra al deployment autorizado.')
param filteredOpenApi string
@description('SHA-256 esperado de operationSetSha256 del manifiesto efectivo autorizado.')
param expectedOperationSetSha256 string
@description('SHA-256 esperado del OpenAPI filtrado efectivo autorizado.')
param expectedFilteredOpenApiSha256 string
@description('Confirmación explícita de autorización efectiva de publicación (debe coincidir con effectivePublication.authorized).')
param requireEffectivePublication bool = true

var apiName = 'g6-productos-ofertas'
var operationsManifest = loadJsonContent('./openapi/operation-security.json')
var publicationGatePassed = !requireEffectivePublication || (operationsManifest.effectivePublication.authorized == true && operationsManifest.operationSetSha256 == expectedOperationSetSha256 && operationsManifest.filteredOpenApiCanonicalSha256 == expectedFilteredOpenApiSha256)
var authorizedOperations = publicationGatePassed ? filter(operationsManifest.operations, op => op.environmentEnabled == true) : []
var corsOriginNodes = join(map(corsAllowedOrigins, origin => '<origin>${xmlEscape(origin)}</origin>'), '')
var apiPolicyTemplate = loadTextContent('./policies/api.xml')
var securedOperationPolicyTemplate = loadTextContent('./policies/operation-secured.xml')
var publicOperationPolicyTemplate = loadTextContent('./policies/operation-public.xml')

func xmlEscape(value string) string => replace(replace(replace(value, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')

resource apim 'Microsoft.ApiManagement/service@2022-08-01' = if (!reuseExistingApim) {
  name: apimName
  location: location
  sku: {
    name: 'Developer'
    capacity: 1
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherName: publisherName
    publisherEmail: publisherEmail
    virtualNetworkType: 'External'
    virtualNetworkConfiguration: {
      subnetResourceId: apimSubnetResourceId
    }
    publicNetworkAccess: 'Enabled'
  }
}

resource existingApim 'Microsoft.ApiManagement/service@2022-08-01' existing = if (reuseExistingApim) {
  name: apimName
}

resource api 'Microsoft.ApiManagement/service/apis@2022-08-01' = if (publicationGatePassed && !empty(authorizedOperations)) {
  name: '${apimName}/${apiName}'
  dependsOn: [
    apim
    existingApim
  ]
  properties: {
    displayName: 'G6 Productos y Ofertas'
    path: 'api/v1'
    protocols: [
      'https'
    ]
    serviceUrl: gatewayBackendUrl
    subscriptionRequired: false
    format: 'openapi+json'
    value: filteredOpenApi
  }
}

resource openIdNamedValue 'Microsoft.ApiManagement/service/namedValues@2022-08-01' = {
  name: '${apimName}/g7-openid-config-url'
  dependsOn: [
    apim
    existingApim
  ]
  properties: {
    displayName: 'g7-openid-config-url'
    value: g7OpenIdConfigurationUrl
    secret: false
  }
}

resource issuerNamedValue 'Microsoft.ApiManagement/service/namedValues@2022-08-01' = {
  name: '${apimName}/g7-issuer'
  dependsOn: [
    apim
    existingApim
  ]
  properties: {
    displayName: 'g7-issuer'
    value: g7Issuer
    secret: false
  }
}

resource audienceNamedValue 'Microsoft.ApiManagement/service/namedValues@2022-08-01' = {
  name: '${apimName}/g7-audience'
  dependsOn: [
    apim
    existingApim
  ]
  properties: {
    displayName: 'g7-audience'
    value: g7Audience
    secret: false
  }
}

resource apiPolicy 'Microsoft.ApiManagement/service/apis/policies@2022-08-01' = if (publicationGatePassed && !empty(authorizedOperations)) {
  parent: api
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: replace(apiPolicyTemplate, '{{cors-origin-elements}}', corsOriginNodes)
  }
}

resource operationPolicies 'Microsoft.ApiManagement/service/apis/operations/policies@2022-08-01' = [for operation in authorizedOperations: {
  name: '${apimName}/${apiName}/${operation.apimOperationId}/policy'
  dependsOn: [
    api
    openIdNamedValue
    issuerNamedValue
    audienceNamedValue
  ]
  properties: {
    format: 'rawxml'
    value: replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(
                            replace(
                              operation.secured ? securedOperationPolicyTemplate : publicOperationPolicyTemplate,
                              '{{audience-check-element}}',
                              operation.audienceRequired ? '<audiences><audience>${xmlEscape(empty(operation.audience) ? g7Audience : operation.audience)}</audience></audiences>' : ''
                            ),
                            '{{identity-type}}',
                            xmlEscape(operation.identityType)
                          ),
                          '{{required-roles}}',
                          xmlEscape(join(operation.roles, ','))
                        ),
                        '{{required-scopes}}',
                        xmlEscape(join(operation.scopes, ','))
                      ),
                      '{{allowed-clients}}',
                      xmlEscape(join(operation.allowedClients, ','))
                    ),
                    '{{m2m-audience}}',
                    xmlEscape(empty(operation.audience) ? '' : operation.audience)
                  ),
                  '{{burst-calls}}',
                  string(contains(rateProfiles, operation.rateProfile) ? rateProfiles[operation.rateProfile].burstCalls : burstCalls)
                ),
                '{{burst-window-seconds}}',
                string(contains(rateProfiles, operation.rateProfile) ? rateProfiles[operation.rateProfile].burstWindowSeconds : burstWindowSeconds)
              ),
              '{{quota-calls}}',
              string(contains(rateProfiles, operation.rateProfile) ? rateProfiles[operation.rateProfile].quotaCalls : quotaCalls)
            ),
            '{{quota-window-seconds}}',
            string(contains(rateProfiles, operation.rateProfile) ? rateProfiles[operation.rateProfile].quotaWindowSeconds : quotaWindowSeconds)
          ),
          '{{concurrency-limit-open}}',
          (contains(rateProfiles, operation.rateProfile) && rateProfiles[operation.rateProfile].maxConcurrency > 0) ? '<limit-concurrency key="@((string)context.Variables[&quot;rateIdentity&quot;] + &quot;:${operation.operationId}&quot;)" max-count="${string(rateProfiles[operation.rateProfile].maxConcurrency)}">' : ''
        ),
        '{{concurrency-limit-close}}',
        (contains(rateProfiles, operation.rateProfile) && rateProfiles[operation.rateProfile].maxConcurrency > 0) ? '</limit-concurrency>' : ''
      ),
      '{{operation-id}}',
      operation.operationId
    )
  }
}]

resource applicationInsightsLogger 'Microsoft.ApiManagement/service/loggers@2022-08-01' = {
  name: '${apimName}/applicationinsights'
  dependsOn: [
    apim
    existingApim
  ]
  properties: {
    loggerType: 'applicationInsights'
    description: 'Logger APIM para Application Insights con identidad administrada del sistema'
    resourceId: applicationInsightsResourceId
    credentials: {
      connectionString: applicationInsightsConnectionString
      identityClientId: 'systemAssigned'
    }
  }
}

resource apiDiagnostics 'Microsoft.ApiManagement/service/apis/diagnostics@2022-08-01' = if (publicationGatePassed && !empty(authorizedOperations)) {
  parent: api
  name: 'applicationinsights'
  properties: {
    alwaysLog: 'allErrors'
    loggerId: applicationInsightsLogger.id
    sampling: {
      samplingType: 'fixed'
      percentage: 10
    }
    frontend: {
      request: {
        headers: [
          'x-correlation-id'
        ]
        body: {
          bytes: 0
        }
      }
      response: {
        headers: [
          'x-correlation-id'
        ]
        body: {
          bytes: 0
        }
      }
    }
    backend: {
      request: {
        headers: [
          'x-correlation-id'
        ]
        body: {
          bytes: 0
        }
      }
      response: {
        headers: [
          'x-correlation-id'
        ]
        body: {
          bytes: 0
        }
      }
    }
    httpCorrelationProtocol: 'W3C'
  }
}
