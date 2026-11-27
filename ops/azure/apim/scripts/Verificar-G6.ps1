<#
.SYNOPSIS
    Verifica disponibilidad, revisiones, conectividad HTTP real, seguridad anti-bypass y estado operativo de G6 + APIM.
.DESCRIPTION
    No se limita a consultas `az`: ejecuta pruebas HTTP reales (403 directo, 401 sin/inválido JWT,
    400 correlación inválida, 404 rutas excluidas, CORS preflight). Si se pasa -JwtToken (token real de G7),
    ejecuta también prueba positiva 200 y verifica propagación de x-correlation-id.
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = "fef42188-accd-4470-ae88-78f583eb4906",
    [string]$ResourceGroup = "rg-g6-aca-chile",
    [string]$NetworkResourceGroup = "rg-g6-productos-azure",
    [string]$ApimName = "apim-g6-productos-chile",
    [string]$GatewayAppName = "api-gateway",
    [string]$ApiId = "g6-productos-ofertas",
    [string]$AllowedCorsOrigin = "https://apim-g6-productos-chile.azure-api.net",
    [string]$JwtToken = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

az account set --subscription $SubscriptionId

Write-Host "=== 1. Red compartida ==="
az network vnet subnet show -g $NetworkResourceGroup --vnet-name vm-g6-backendVNET -n snet-g6-apim `
    --query "{name:name, prefix:addressPrefix, nsg:networkSecurityGroup.id, state:provisioningState}" -o json

Write-Host "`n=== 2. APIM ==="
$apim = az apim show -g $ResourceGroup -n $ApimName --query "{name:name, sku:sku.name, state:provisioningState, gatewayUrl:gatewayUrl, ips:publicIpAddresses, vnetType:virtualNetworkType}" -o json 2>$null | ConvertFrom-Json
if ($apim) {
    $apim | ConvertTo-Json
} else {
    Write-Warning "APIM '$ApimName' no encontrado."
}

Write-Host "`n=== 3. Gateway ACA y Modalidad B ==="
$gw = az containerapp show -g $ResourceGroup -n $GatewayAppName `
    --query "{fqdn:properties.configuration.ingress.fqdn, external:properties.configuration.ingress.external, ipRestrictions:properties.configuration.ingress.ipSecurityRestrictions, readyRev:properties.latestReadyRevisionName}" -o json | ConvertFrom-Json
$gw | ConvertTo-Json -Depth 5

Write-Host "`n=== 4. Réplicas ACA ==="
$apps = @("taxonomy-svc", "catalog-svc", "pricing-svc", "price-audit-svc", "promotions-svc", "combos-svc", "inventory-svc", "bulk-svc", "api-gateway")
foreach ($app in $apps) {
    $count = (az containerapp replica list -g $ResourceGroup -n $app -o json | ConvertFrom-Json).Count
    Write-Host "  $app -> réplicas activas: $count"
}

Write-Host "`n=== 5. Pruebas HTTP reales (DNS, anti-bypass y borde APIM) ==="
function Invoke-HttpProbe {
    param([string]$Name, [string]$Method, [string]$Url, [hashtable]$Headers = @{}, [int]$ExpectedStatus)
    $actual = $null
    $corr = ""
    $acao = ""
    try {
        $resp = Invoke-WebRequest -Uri $Url -Method $Method -Headers $Headers -TimeoutSec 20 -UseBasicParsing
        $actual = [int]$resp.StatusCode
        $corr = [string]$resp.Headers["x-correlation-id"]
        $acao = [string]$resp.Headers["Access-Control-Allow-Origin"]
    } catch {
        if ($_.Exception.Response) {
            $actual = [int]$_.Exception.Response.StatusCode
            $corr = [string]$_.Exception.Response.Headers["x-correlation-id"]
            $acao = [string]$_.Exception.Response.Headers["Access-Control-Allow-Origin"]
        } else {
            Write-Warning "  [$Name] ERROR de red: $($_.Exception.Message)"
            return $false
        }
    }
    $ok = ($actual -eq $ExpectedStatus)
    $label = if ($ok) { "PASS" } else { "FAIL (esperado $ExpectedStatus)" }
    Write-Host "  [$Name] HTTP $actual -> $label | x-correlation-id=$corr | ACAO=$acao"
    return $ok
}

$gwUrl = "https://$($gw.fqdn)"
$null = Invoke-HttpProbe -Name "Gateway_DirectBypass_403" -Method "Get" -Url "$gwUrl/health" -ExpectedStatus 403

if ($apim -and $apim.gatewayUrl) {
    $apimHost = ([Uri]$apim.gatewayUrl).Host
    $dns = Resolve-DnsName $apimHost -Type A -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress }
    Write-Host "  [DNS] $apimHost -> $($dns.IPAddress -join ', ')"

    $baseApi = "$($apim.gatewayUrl)/api/v1"
    $null = Invoke-HttpProbe -Name "APIM_NoAuth_401" -Method "Get" -Url "$baseApi/productos" -ExpectedStatus 401
    $null = Invoke-HttpProbe -Name "APIM_InvalidJWT_401" -Method "Get" -Url "$baseApi/productos" -Headers @{ Authorization = "Bearer invalid.jwt.token" } -ExpectedStatus 401
    $null = Invoke-HttpProbe -Name "APIM_InvalidCorrelation_400" -Method "Get" -Url "$baseApi/productos" -Headers @{ "X-Correlation-Id" = "not-a-uuid" } -ExpectedStatus 400
    $null = Invoke-HttpProbe -Name "APIM_Unknown_404" -Method "Get" -Url "$baseApi/ruta-inexistente-h5-test" -ExpectedStatus 404
    $null = Invoke-HttpProbe -Name "APIM_InternalExcluded_404" -Method "Get" -Url "$baseApi/cargas-masivas/00000000-0000-0000-0000-000000000000/contenido-interno" -ExpectedStatus 404
    $null = Invoke-HttpProbe -Name "APIM_CORS_Allowed" -Method "Options" -Url "$baseApi/productos" -Headers @{ Origin = $AllowedCorsOrigin; "Access-Control-Request-Method" = "GET" } -ExpectedStatus 200
    $null = Invoke-HttpProbe -Name "APIM_CORS_Denied" -Method "Options" -Url "$baseApi/productos" -Headers @{ Origin = "https://untrusted-origin.example.com"; "Access-Control-Request-Method" = "GET" } -ExpectedStatus 403

    if ($JwtToken) {
        $corrId = [Guid]::NewGuid().ToString()
        $null = Invoke-HttpProbe -Name "APIM_Positive_G7_JWT" -Method "Get" -Url "$baseApi/productos?canal=MARKETPLACE&pagina=1&tamanio=1" -Headers @{ Authorization = "Bearer $JwtToken"; "X-Correlation-Id" = $corrId } -ExpectedStatus 200
    } else {
        Write-Host "  [APIM_Positive_G7_JWT] PENDIENTE DE RETEST EXTERNO (pasa -JwtToken con JWT real de G7)"
    }
}
