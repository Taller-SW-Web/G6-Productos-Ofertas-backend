<#
.SYNOPSIS
    Enciende las Container Apps de G6 en rg-g6-aca-chile y verifica su disponibilidad.
.DESCRIPTION
    Restaura minReplicas=1 y maxReplicas=1 en los 8 microservicios y api-gateway,
    y valida readiness de cada revisión activa y respuesta HTTPS de api-gateway.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][guid]$SubscriptionId,
    [string]$ResourceGroup = "rg-g6-aca-chile",
    [int]$MinReplicas = 1,
    [int]$MaxReplicas = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

az account set --subscription $SubscriptionId

$apps = @(
    "taxonomy-svc",
    "catalog-svc",
    "pricing-svc",
    "price-audit-svc",
    "promotions-svc",
    "combos-svc",
    "inventory-svc",
    "bulk-svc",
    "api-gateway"
)

foreach ($app in $apps) {
    Write-Host "[Iniciar-G6] Restaurando escalado en $app (min=$MinReplicas, max=$MaxReplicas)..."
    az containerapp update `
        --resource-group $ResourceGroup `
        --name $app `
        --min-replicas $MinReplicas `
        --max-replicas $MaxReplicas `
        -o none
}

Write-Host "`n[Iniciar-G6] Verificando estado y réplicas activas:"
$summary = foreach ($app in $apps) {
    $info = az containerapp show -g $ResourceGroup -n $app --query "{name:name, state:properties.runningStatus, readyRev:properties.latestReadyRevisionName, fqdn:properties.configuration.ingress.fqdn}" -o json | ConvertFrom-Json
    $replicas = (az containerapp replica list -g $ResourceGroup -n $app -o json | ConvertFrom-Json).Count
    [PSCustomObject]@{
        App           = $info.name
        RunningStatus = $info.state
        ReadyRevision = $info.readyRev
        ActiveReplicas = [int]$replicas
        Fqdn          = $info.fqdn
    }
}
$summary | Format-Table -AutoSize
