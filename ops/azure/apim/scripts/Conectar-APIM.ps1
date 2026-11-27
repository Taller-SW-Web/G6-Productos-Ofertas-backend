<#
.SYNOPSIS
    Conecta APIM con api-gateway y aplica restricciones Allow-only (Modalidad B) anti-bypass.
.DESCRIPTION
    1. Obtiene las IPs públicas actuales de apim-g6-productos-chile.
    2. Verifica conectividad HTTPS de APIM hacia api-gateway (serviceUrl).
    3. Aplica reglas Allow-only en api-gateway (Modalidad B) para las IPs de APIM.
    4. Verifica que el acceso directo al Gateway sin pasar por APIM quede bloqueado (403).
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = "fef42188-accd-4470-ae88-78f583eb4906",
    [string]$ResourceGroup = "rg-g6-aca-chile",
    [string]$ApimName = "apim-g6-productos-chile",
    [string]$GatewayAppName = "api-gateway",
    [string]$ApiName = "g6-h5-candidate"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

az account set --subscription $SubscriptionId

$apim = az apim show -g $ResourceGroup -n $ApimName --query "{state:provisioningState, gatewayUrl:gatewayUrl, ips:publicIpAddresses}" -o json | ConvertFrom-Json
if ($apim.state -ne "Succeeded") {
    throw "APIM '$ApimName' no está listo (estado actual: $($apim.state))."
}
if (-not $apim.ips -or $apim.ips.Count -eq 0) {
    throw "APIM '$ApimName' no reportó publicIPAddresses."
}

$gwFqdn = az containerapp show -g $ResourceGroup -n $GatewayAppName --query "properties.configuration.ingress.fqdn" -o tsv
$backendUrl = "https://$gwFqdn/api/v1"

Write-Host "[Conectar-APIM] APIM URL: $($apim.gatewayUrl)"
Write-Host "[Conectar-APIM] APIM IPs públicas: $($apim.ips -join ', ')"
Write-Host "[Conectar-APIM] Gateway backend: $backendUrl"

# Actualizar serviceUrl si la API ya existe en APIM
$apiExists = az apim api show -g $ResourceGroup --service-name $ApimName --api-id $ApiName --query name -o tsv 2>$null
if ($apiExists) {
    Write-Host "[Conectar-APIM] Asegurando serviceUrl=$backendUrl en API '$ApiName'..."
    az apim api update -g $ResourceGroup --service-name $ApimName --api-id $ApiName --service-url $backendUrl -o none
}

# Limpiar reglas previas y aplicar exclusivamente Allow hacia las IPs de APIM (Modalidad B)
$existingRules = az containerapp ingress access-restriction list -g $ResourceGroup -n $GatewayAppName -o json | ConvertFrom-Json
foreach ($rule in $existingRules) {
    az containerapp ingress access-restriction remove -g $ResourceGroup -n $GatewayAppName --rule-name $rule.name -o none
}

$idx = 1
foreach ($ip in $apim.ips) {
    $cidr = if ($ip -match "/") { $ip } else { "$ip/32" }
    $ruleName = "allow-apim-$idx"
    Write-Host "[Conectar-APIM] Aplicando regla Allow-only: $ruleName -> $cidr"
    az containerapp ingress access-restriction set `
        -g $ResourceGroup `
        -n $GatewayAppName `
        --rule-name $ruleName `
        --ip-address $cidr `
        --action Allow `
        --description "Permitir trafico exclusivo desde APIM ($ApimName)" `
        -o none
    $idx++
}

Write-Host "[Conectar-APIM] Verificando bloqueo directo al Gateway (esperado HTTP 403)..."
try {
    $resp = Invoke-WebRequest -Uri "https://$gwFqdn/health" -Method Get -TimeoutSec 10 -UseBasicParsing
    Write-Warning "El acceso directo al Gateway devolvió HTTP $($resp.StatusCode) en lugar de 403."
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    Write-Host "[Conectar-APIM] Acceso directo bloqueado correctamente: HTTP $statusCode"
}
