<#
.SYNOPSIS
    Conecta APIM (g6-productos-ofertas) con api-gateway y aplica restricciones Allow-only (Modalidad B)
    sin ventana de exposición, con preflight, validación HTTP 403 y rollback automático.
.DESCRIPTION
    1. Preflight: valida APIM Succeeded, publicIpAddresses no vacío y existencia de api-gateway.
    2. Snapshot de rollback: guarda las ipSecurityRestrictions actuales antes de cualquier cambio.
    3. Asegura serviceUrl=https://<gwFqdn>/api/v1 en g6-productos-ofertas (sin duplicar /api/v1).
    4. Actualización segura sin ventana de exposición: agrega/actualiza las reglas Allow de APIM
       PRIMERO y solo después elimina reglas obsoletas que no correspondan a las IPs vigentes.
    5. Valida explícitamente HTTP 403 directo en https://<gwFqdn>/health; si falla, ejecuta rollback.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][guid]$SubscriptionId,
    [string]$ResourceGroup = "rg-g6-aca-chile",
    [string]$ApimName = "apim-g6-productos-chile",
    [string]$GatewayAppName = "api-gateway",
    [string]$ApiId = "g6-productos-ofertas",
    [string]$RollbackFile = "$env:TEMP\api-gateway-ip-restrictions-rollback.json",
    [switch]$RollbackOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

az account set --subscription $SubscriptionId

function Restore-GatewayIpRestrictions {
    param([string]$Rg, [string]$App, [array]$Rules)
    Write-Warning "[Conectar-APIM] Ejecutando rollback de ipSecurityRestrictions en $App..."
    $current = az containerapp ingress access-restriction list -g $Rg -n $App -o json | ConvertFrom-Json
    foreach ($r in $current) {
        az containerapp ingress access-restriction remove -g $Rg -n $App --rule-name $r.name -o none
    }
    foreach ($r in $Rules) {
        az containerapp ingress access-restriction set `
            -g $Rg -n $App `
            --rule-name $r.name `
            --ip-address $r.ipAddressRange `
            --action $r.action `
            --description ($r.description ?? "Restaurada por rollback") `
            -o none
    }
}

if ($RollbackOnly) {
    if (-not (Test-Path $RollbackFile)) {
        throw "No existe archivo de rollback en '$RollbackFile'."
    }
    $saved = @(Get-Content $RollbackFile -Raw -Encoding UTF8 | ConvertFrom-Json)
    Restore-GatewayIpRestrictions -Rg $ResourceGroup -App $GatewayAppName -Rules $saved
    Write-Host "[Conectar-APIM] Rollback completado desde $RollbackFile."
    return
}

# 1. Preflight
$apim = az apim show -g $ResourceGroup -n $ApimName --query "{state:provisioningState, gatewayUrl:gatewayUrl, ips:publicIpAddresses}" -o json | ConvertFrom-Json
if ($apim.state -ne "Succeeded") {
    throw "Preflight FAIL: APIM '$ApimName' en estado '$($apim.state)' (requiere Succeeded)."
}
if (-not $apim.ips -or $apim.ips.Count -eq 0) {
    throw "Preflight FAIL: APIM '$ApimName' no reportó publicIpAddresses."
}

$gw = az containerapp show -g $ResourceGroup -n $GatewayAppName --query "{fqdn:properties.configuration.ingress.fqdn, external:properties.configuration.ingress.external}" -o json | ConvertFrom-Json
if (-not $gw.fqdn) {
    throw "Preflight FAIL: no se obtuvo FQDN de '$GatewayAppName'."
}
$gwFqdn = $gw.fqdn
$backendUrl = "https://$gwFqdn/api/v1"

# 2. Snapshot de rollback antes de mutar
$existingRules = @(az containerapp ingress access-restriction list -g $ResourceGroup -n $GatewayAppName -o json | ConvertFrom-Json)
$existingRules | ConvertTo-Json -Depth 5 | Set-Content -Path $RollbackFile -Encoding UTF8
Write-Host "[Conectar-APIM] Snapshot de rollback guardado en: $RollbackFile"

# 3. Asegurar serviceUrl sin duplicar /api/v1
$apiExists = az apim api show -g $ResourceGroup --service-name $ApimName --api-id $ApiId --query name -o tsv 2>$null
if ($apiExists) {
    Write-Host "[Conectar-APIM] Asegurando serviceUrl=$backendUrl en API '$ApiId'..."
    az apim api update -g $ResourceGroup --service-name $ApimName --api-id $ApiId --service-url $backendUrl -o none
}

# 4. Actualización segura sin ventana de exposición:
#    Primero agregar/actualizar reglas Allow para las IPs vigentes; luego remover obsoletas.
$desiredRules = @{}
$idx = 1
foreach ($ip in $apim.ips) {
    $cidr = if ($ip -match "/") { $ip } else { "$ip/32" }
    $desiredRules["allow-apim-$idx"] = $cidr
    $idx++
}

try {
    foreach ($ruleName in $desiredRules.Keys) {
        $cidr = $desiredRules[$ruleName]
        Write-Host "[Conectar-APIM] Aplicando/actualizando regla Allow-only: $ruleName -> $cidr"
        az containerapp ingress access-restriction set `
            -g $ResourceGroup -n $GatewayAppName `
            --rule-name $ruleName `
            --ip-address $cidr `
            --action Allow `
            --description "Modalidad B: permitir trafico exclusivo desde APIM ($ApimName)" `
            -o none
    }

    foreach ($oldRule in $existingRules) {
        if (-not $desiredRules.ContainsKey($oldRule.name)) {
            Write-Host "[Conectar-APIM] Eliminando regla obsoleta: $($oldRule.name)"
            az containerapp ingress access-restriction remove -g $ResourceGroup -n $GatewayAppName --rule-name $oldRule.name -o none
        }
    }

    # 5. Validación explícita de HTTP 403 directo (anti-bypass)
    Write-Host "[Conectar-APIM] Validando bloqueo directo al Gateway (obligatorio HTTP 403)..."
    $directStatus = $null
    try {
        $resp = Invoke-WebRequest -Uri "https://$gwFqdn/health" -Method Get -TimeoutSec 15 -UseBasicParsing
        $directStatus = [int]$resp.StatusCode
    } catch {
        if ($_.Exception.Response) {
            $directStatus = [int]$_.Exception.Response.StatusCode
        } else {
            throw "No se pudo verificar bloqueo directo: $($_.Exception.Message)"
        }
    }

    if ($directStatus -ne 403) {
        throw "Validación anti-bypass FAIL: acceso directo devolvió HTTP $directStatus (se esperaba 403)."
    }
    Write-Host "[Conectar-APIM] PASS: acceso directo bloqueado con HTTP 403."
} catch {
    Restore-GatewayIpRestrictions -Rg $ResourceGroup -App $GatewayAppName -Rules $existingRules
    throw
}
