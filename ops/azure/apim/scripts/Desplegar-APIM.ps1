<#
.SYNOPSIS
    Despliega o actualiza APIM Developer clásico mediante Bicep en dos etapas (infrastructure | effective).
.DESCRIPTION
    - Verifica red compartida (vm-g6-backendVNET / snet-g6-apim / nsg-g6-apim) y Application Insights.
    - Advierte sobre soft-delete de APIM (48h de retención del nombre y posible cambio de IP pública al recrear).
    - Ejecuta validate-parameters.py antes de desplegar cuando se suministra ParametersFile.
    - Asigna el rol Monitoring Metrics Publisher a la Managed Identity de APIM sobre Application Insights.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ParametersFile,
    [ValidateSet("infrastructure", "effective")]
    [string]$DeploymentStage = "infrastructure",
    [Parameter(Mandatory = $true)][guid]$SubscriptionId,
    [string]$ResourceGroup = "rg-g6-aca-chile",
    [string]$ApimName = "apim-g6-productos-chile",
    [string]$Location = "chilecentral",
    [string]$AppInsightsName = "appi-g6-apim-chile",
    [string]$ExpectedDocsSha = "5f30802129ba4bbc0674dcc5878f10065f443118",
    [string]$ExpectedGatewaySha = "097dac1bf4a8dcf5c6e799742d2df340f6d893d5"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$apimRoot = Split-Path -Parent $scriptDir
$bicepFile = Join-Path $apimRoot "main.bicep"

az account set --subscription $SubscriptionId

# Verificar soft-delete previo antes de recrear
$deleted = az apim deletedservice list --query "[?name=='$ApimName']" -o json | ConvertFrom-Json
if ($deleted.Count -gt 0) {
    Write-Warning "El nombre '$ApimName' está en soft-delete en $Location. Si deseas recrearlo con el mismo nombre antes de 48h, ejecuta primero: az apim deletedservice purge --location $Location --service-name $ApimName"
    throw "APIM en estado soft-delete."
}

Write-Host "[Desplegar-APIM] Validando parámetros locales (etapa=$DeploymentStage)..."
python (Join-Path $apimRoot "validate-parameters.py") $ParametersFile `
    --openapi (Join-Path $apimRoot "openapi\gateway-filtered.json") `
    --manifest (Join-Path $apimRoot "openapi\operation-security.json") `
    --expected-docs-sha $ExpectedDocsSha `
    --expected-gateway-sha $ExpectedGatewaySha

$deploymentName = "apim-g6-$DeploymentStage-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Write-Host "[Desplegar-APIM] Ejecutando Bicep deployment '$deploymentName'..."
az deployment group create `
    --resource-group $ResourceGroup `
    --name $deploymentName `
    --template-file $bicepFile `
    --parameters "@$ParametersFile" `
    --parameters deploymentStage=$DeploymentStage `
    -o json

$principalId = az apim show -g $ResourceGroup -n $ApimName --query identity.principalId -o tsv
$appInsightsId = az monitor app-insights component show -g $ResourceGroup -a $AppInsightsName --query id -o tsv

if ($principalId -and $appInsightsId) {
    Write-Host "[Desplegar-APIM] Asegurando rol Monitoring Metrics Publisher para Managed Identity ($principalId)..."
    az role assignment create `
        --assignee-object-id $principalId `
        --assignee-principal-type ServicePrincipal `
        --role "Monitoring Metrics Publisher" `
        --scope $appInsightsId `
        -o none
}

az apim show -g $ResourceGroup -n $ApimName --query "{name:name, provisioningState:provisioningState, gatewayUrl:gatewayUrl, publicIpAddresses:publicIpAddresses}" -o json
