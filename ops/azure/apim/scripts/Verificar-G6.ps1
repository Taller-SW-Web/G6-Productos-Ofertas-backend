<#
.SYNOPSIS
    Verifica disponibilidad, revisiones, conectividad, seguridad anti-bypass y estado operativo de G6 + APIM.
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = "fef42188-accd-4470-ae88-78f583eb4906",
    [string]$ResourceGroup = "rg-g6-aca-chile",
    [string]$NetworkResourceGroup = "rg-g6-productos-azure",
    [string]$ApimName = "apim-g6-productos-chile",
    [string]$GatewayAppName = "api-gateway"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

az account set --subscription $SubscriptionId

Write-Host "=== 1. Red compartida ==="
az network vnet subnet show -g $NetworkResourceGroup --vnet-name vm-g6-backendVNET -n snet-g6-apim `
    --query "{name:name, prefix:addressPrefix, nsg:networkSecurityGroup.id, state:provisioningState}" -o json

Write-Host "`n=== 2. APIM ==="
$apim = az apim show -g $ResourceGroup -n $ApimName --query "{name:name, sku:sku.name, state:provisioningState, gatewayUrl:gatewayUrl, ips:publicIpAddresses, vnetType:virtualNetworkType}" -o json 2>$null
if ($apim) { $apim } else { Write-Warning "APIM '$ApimName' no encontrado." }

Write-Host "`n=== 3. Gateway ACA y Modalidad B ==="
az containerapp show -g $ResourceGroup -n $GatewayAppName `
    --query "{fqdn:properties.configuration.ingress.fqdn, external:properties.configuration.ingress.external, ipRestrictions:properties.configuration.ingress.ipSecurityRestrictions, readyRev:properties.latestReadyRevisionName}" -o json

Write-Host "`n=== 4. Réplicas ACA ==="
$apps = @("taxonomy-svc", "catalog-svc", "pricing-svc", "price-audit-svc", "promotions-svc", "combos-svc", "inventory-svc", "bulk-svc", "api-gateway")
foreach ($app in $apps) {
    $count = (az containerapp replica list -g $ResourceGroup -n $app -o json | ConvertFrom-Json).Count
    Write-Host "  $app -> réplicas activas: $count"
}
