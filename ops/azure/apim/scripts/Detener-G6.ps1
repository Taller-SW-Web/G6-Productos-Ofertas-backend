<#
.SYNOPSIS
    Detiene las Container Apps de G6 de forma segura sin perder mensajes ni jobs activos.
.DESCRIPTION
    1. Verifica ejecuciones activas del ACA Job azure-h5-smoke-chile.
    2. Verifica mensajes activos en Azure Service Bus (g6-sb-h5-chile-261127) SIN purgar colas.
    3. Escala las 9 Container Apps a minReplicas=0, maxReplicas=0 y confirma 0 réplicas activas.
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = "fef42188-accd-4470-ae88-78f583eb4906",
    [string]$ResourceGroup = "rg-g6-aca-chile",
    [string]$ServiceBusNamespace = "g6-sb-h5-chile-261127",
    [string]$SmokeJobName = "azure-h5-smoke-chile",
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

az account set --subscription $SubscriptionId

Write-Host "[Detener-G6] Verificando jobs activos en $SmokeJobName..."
$runningJobs = az containerapp job execution list -g $ResourceGroup -n $SmokeJobName --query "[?properties.status=='Running'].name" -o json | ConvertFrom-Json
if ($runningJobs.Count -gt 0 -and -not $Force) {
    throw "Hay ejecuciones activas en $SmokeJobName ($($runningJobs -join ', ')). Espera a que terminen o usa -Force."
}

Write-Host "[Detener-G6] Verificando colas en Service Bus $ServiceBusNamespace (sin purgar datos)..."
$queues = az servicebus queue list -g $ResourceGroup --namespace-name $ServiceBusNamespace --query "[].{name:name, active:countDetails.activeMessageCount, deadLetter:countDetails.deadLetterMessageCount}" -o json | ConvertFrom-Json
$pendingQueues = @($queues | Where-Object { $_.active -gt 0 })
if ($pendingQueues.Count -gt 0 -and -not $Force) {
    $pendingText = ($pendingQueues | ForEach-Object { "$($_.name)=$($_.active)" }) -join ", "
    throw "Hay mensajes activos pendientes en Service Bus ($pendingText). Espera a que se procesen o usa -Force."
}

$apps = @(
    "api-gateway",
    "bulk-svc",
    "combos-svc",
    "inventory-svc",
    "promotions-svc",
    "price-audit-svc",
    "pricing-svc",
    "catalog-svc",
    "taxonomy-svc"
)

foreach ($app in $apps) {
    Write-Host "[Detener-G6] Deteniendo réplicas de $app (min=0, max=0)..."
    az containerapp update `
        --resource-group $ResourceGroup `
        --name $app `
        --min-replicas 0 `
        --max-replicas 0 `
        -o none
}

Start-Sleep -Seconds 5
Write-Host "`n[Detener-G6] Comprobando réplicas activas:"
$activeTotal = 0
foreach ($app in $apps) {
    $count = (az containerapp replica list -g $ResourceGroup -n $app -o json | ConvertFrom-Json).Count
    $activeTotal += $count
    Write-Host "  $app -> réplicas activas: $count"
}

if ($activeTotal -gt 0) {
    Write-Warning "Aún hay $activeTotal réplica(s) terminando su apagado ordenado. Reintenta Verificar-G6.ps1 en unos segundos."
} else {
    Write-Host "[Detener-G6] Todas las Container Apps están detenidas (0 réplicas activas)."
}
