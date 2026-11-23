targetScope = 'resourceGroup'

@description('Nombre del servicio APIM clásico en laboratorio.')
param apimName string
@description('Región aprobada para el laboratorio.')
param location string
@description('Nombre del publicador responsable del servicio APIM.')
param publisherName string
@description('Correo operativo del publicador APIM.')
param publisherEmail string
@description('Subred dedicada de APIM en la VNet existente. No se crea red.')
param apimSubnetResourceId string
@description('URL HTTPS privada del Gateway existente alcanzable desde APIM.')
param gatewayBackendUrl string
@description('Issuer exacto publicado por G7.')
param g7Issuer string
@description('URL OpenID/JWKS de G7, sin credenciales.')
param g7OpenIdConfigurationUrl string
@description('Audience autorizada por G7.')
param g7Audience string
@description('Lista explícita de orígenes CORS aprobados; no admite wildcard.')
@minLength(1)
param corsAllowedOrigins array
@description('Límite de ráfaga por identidad y operación.')
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
@description('Resource ID del logger de observabilidad aprobado.')
param loggerResourceId string
@description('OpenAPI JSON generado por filter-openapi.py; se suministra al deployment autorizado.')
param filteredOpenApi string


var apiName = 'g6-productos-ofertas'
var operationsManifest = loadJsonContent('./openapi/operation-security.json')
var corsOriginNodes = join(map(corsAllowedOrigins, origin => '<origin>${xmlEscape(origin)}</origin>'), '')
var apiPolicyTemplate = loadTextContent('./policies/api.xml')
var securedOperationPolicyTemplate = loadTextContent('./policies/operation-secured.xml')
var publicOperationPolicyTemplate = loadTextContent('./policies/operation-public.xml')

func xmlEscape(value string) string => replace(replace(replace(value, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')

resource apim 'Microsoft.ApiManagement/service@2022-08-01' = {
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

resource api 'Microsoft.ApiManagement/service/apis@2022-08-01' = {
  parent: apim
  name: apiName
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
  parent: apim
  name: 'g7-openid-config-url'
  properties: {
    displayName: 'g7-openid-config-url'
    value: g7OpenIdConfigurationUrl
    secret: false
  }
}

resource issuerNamedValue 'Microsoft.ApiManagement/service/namedValues@2022-08-01' = {
  parent: apim
  name: 'g7-issuer'
  properties: {
    displayName: 'g7-issuer'
    value: g7Issuer
    secret: false
  }
}

resource audienceNamedValue 'Microsoft.ApiManagement/service/namedValues@2022-08-01' = {
  parent: apim
  name: 'g7-audience'
  properties: {
    displayName: 'g7-audience'
    value: g7Audience
    secret: false
  }
}

resource apiPolicy 'Microsoft.ApiManagement/service/apis/policies@2022-08-01' = {
  parent: api
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: replace(apiPolicyTemplate, '{{cors-origin-elements}}', corsOriginNodes)
  }
}

resource operationPolicies 'Microsoft.ApiManagement/service/apis/operations/policies@2022-08-01' = [for operation in operationsManifest.operations: {
  name: '${apiName}/${operation.operationId}/policy'
  dependsOn: [
    api
  ]
  properties: {
    format: 'rawxml'
    value: replace(
      replace(
        replace(
          replace(
            replace(
              operation.secured ? securedOperationPolicyTemplate : publicOperationPolicyTemplate,
              '{{burst-calls}}',
              string(burstCalls)
            ),
            '{{burst-window-seconds}}',
            string(burstWindowSeconds)
          ),
          '{{quota-calls}}',
          string(quotaCalls)
        ),
        '{{quota-window-seconds}}',
        string(quotaWindowSeconds)
      ),
      '{{operation-id}}',
      operation.operationId
    )
  }
}]

resource apiDiagnostics 'Microsoft.ApiManagement/service/apis/diagnostics@2022-08-01' = {
  parent: api
  name: 'applicationinsights'
  properties: {
    alwaysLog: 'allErrors'
    loggerId: loggerResourceId
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
