[CmdletBinding()]
param(
  [string]$ManifestPath = (Join-Path $env:LOCALAPPDATA 'G6\h5-runtime-preflight\parameters.private.json'),
  [switch]$ProbePostgres,
  [switch]$ProbeG7Token
)

$ErrorActionPreference = 'Stop'
$services = @('api-gateway', 'catalog-svc', 'inventory-svc', 'pricing-svc', 'promotions-svc')
$results = [System.Collections.Generic.List[object]]::new()
function Add-Result([string]$Check, [string]$Status, [string]$Detail) {
  $results.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
}
function Get-ParameterValue($Document, [string]$Name) {
  return $Document.parameters.$Name.value
}
function Get-AppEnvironment($Document, [string]$Service) {
  $app = (Get-ParameterValue $Document 'appConfiguration').$Service
  $values = @{}
  foreach ($entry in $app.env) {
    if ($entry.secretRef) {
      $secret = @($app.secrets | Where-Object { $_.name -ceq $entry.secretRef }) | Select-Object -First 1
      $values[$entry.name] = if ($secret) { [string]$secret.value } else { '' }
    } else { $values[$entry.name] = [string]$entry.value }
  }
  return $values
}
function Get-AppSecret($Document, [string]$Service, [string]$Name) {
  $app = (Get-ParameterValue $Document 'appConfiguration').$Service
  $secret = @($app.secrets | Where-Object { $_.name -ceq $Name }) | Select-Object -First 1
  if ($secret) { return [string]$secret.value }
  return ''
}
function Has-Value($Object, [string]$Name) {
  if ($null -eq $Object) { return $false }
  if ($Object -is [System.Collections.IDictionary]) {
    return $Object.Contains($Name) -and -not [string]::IsNullOrWhiteSpace([string]$Object[$Name])
  }
  return $Object.PSObject.Properties.Name -contains $Name -and -not [string]::IsNullOrWhiteSpace([string]$Object.$Name)
}
function Is-HttpsUrl([string]$Value) {
  try {
    $uri = [uri]$Value
    return $uri.Scheme -eq 'https' -and -not $uri.UserInfo -and -not $uri.Query -and -not $uri.Fragment
  } catch { return $false }
}

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  Add-Result 'private-manifest' 'MISSING' 'Run Initialize-PrivateManifest.ps1; provide authorized values outside Git.'
  $results | Format-Table -Wrap -AutoSize | Out-String | Write-Output
  exit 2
}
try { $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json }
catch {
  Add-Result 'private-manifest' 'INVALID' 'JSON could not be parsed; secret contents suppressed.'
  $results | Format-Table -Wrap -AutoSize | Out-String | Write-Output
  exit 2
}
Add-Result 'private-manifest' 'PRESENT' 'Bicep parameters are read locally; values are never printed.'

$runtime = @{}
foreach ($service in $services) { $runtime[$service] = Get-AppEnvironment $manifest $service }
$sourceSha = [string](Get-ParameterValue $manifest 'sourceSha')
$digests = Get-ParameterValue $manifest 'imageDigests'
$releaseOk = $sourceSha -cmatch '^[a-f0-9]{40}$'
foreach ($service in $services) { if ([string]$digests.$service -cnotmatch '^sha256:[a-f0-9]{64}$') { $releaseOk = $false } }
Add-Result 'final-release-sha-and-five-digests' $(if ($releaseOk) { 'PRESENT' } else { 'PENDING' }) 'Requires official release SHA and immutable digests.'

$gateway = $runtime['api-gateway']
$promotion = $runtime['promotions-svc']
$issuer = [string]$gateway.AUTH_ISSUER
$discoveryUrl = 'https://g7-auth-service.onrender.com/api/v1/auth/.well-known/openid-configuration'
$jwksUrl = [string]$gateway.AUTH_JWKS_URL
$discoveryOk = $false
$jwksOk = $false
try {
  if ((Is-HttpsUrl $discoveryUrl) -and (Is-HttpsUrl $jwksUrl)) {
    $discovery = Invoke-RestMethod -Uri $discoveryUrl -Method Get -TimeoutSec 20
    $jwks = Invoke-RestMethod -Uri $jwksUrl -Method Get -TimeoutSec 20
    $discoveryOk = $discovery.issuer -ceq $issuer -and $discovery.jwks_uri -ceq $jwksUrl
    $jwksOk = @($jwks.keys).Count -gt 0
  }
} catch { }
Add-Result 'g7-discovery-issuer-and-jwks' $(if ($discoveryOk -and $jwksOk) { 'PASS' } else { 'FAIL' }) 'Public metadata only; no token or grant is inferred.'

$promotionsSecret = Get-AppSecret $manifest 'promotions-svc' 'promotions-svc-client-secret'
$clientIdOk = $true # G7 client_id is intentionally fixed below; the Bicep parameter is a different Azure managed identity GUID.
$clientSecretAvailable = -not [string]::IsNullOrWhiteSpace($promotionsSecret)
Add-Result 'g7-promotions-svc-client-secret' $(if ($clientIdOk -and $clientSecretAvailable) { 'AVAILABLE' } else { 'EXTERNAL_DEPENDENCY' }) 'Client ID is promotions-svc; never substitute modulo-ventas.'
if ($ProbeG7Token -and $clientIdOk -and $clientSecretAvailable -and $discoveryOk) {
  try {
    $tokenBody = @{
      grant_type = 'client_credentials'
      client_id = 'promotions-svc'
      client_secret = $promotionsSecret
    }
    $tokenResponse = Invoke-RestMethod -Uri 'https://g7-auth-service.onrender.com/api/v1/auth/token' -Method Post -ContentType 'application/x-www-form-urlencoded' -Body $tokenBody -TimeoutSec 20
    $jwt = [string]$tokenResponse.accessToken
    $parts = $jwt.Split('.')
    if ($parts.Count -ne 3 -or $tokenResponse.tokenType -cne 'Bearer') { throw 'invalid-token-response' }
    $payloadText = $parts[1].Replace('-', '+').Replace('_', '/')
    while (($payloadText.Length % 4) -ne 0) { $payloadText += '=' }
    $claims = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadText)) | ConvertFrom-Json
    $audiences = @($claims.aud)
    $scopes = @(([string]$claims.scope -split '\s+') | Where-Object { $_ })
    $tokenClient = if ($claims.client_id) { [string]$claims.client_id } else { [string]$claims.sub }
    $validToken = [string]$claims.iss -ceq $issuer -and $audiences -contains 'api-productos' -and $tokenClient -ceq 'promotions-svc' -and [long]$claims.exp -gt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -and -not ($scopes -contains 'ventas:pedidos:evidencia-cupon:leer')
    $safeScopes = @($scopes | Where-Object { $_ -match '^[a-z0-9:_-]+$' } | Sort-Object -Unique) -join ','
    Add-Result 'g7-promotions-svc-token' $(if ($validToken) { 'PASS' } else { 'FAIL' }) ("iss/sub/aud/exp checked; scopes=" + $safeScopes + '; JWT suppressed.')
    $tokenResponse = $null; $jwt = $null; $claims = $null; $parts = $null; $tokenBody.client_secret = $null
  } catch { Add-Result 'g7-promotions-svc-token' 'FAIL' 'Token issuance/claims check failed; response and credentials suppressed.' }
} elseif ($ProbeG7Token) {
  Add-Result 'g7-promotions-svc-token' 'NOT_RUN' 'Authorized promotions-svc client secret or verified discovery is unavailable.'
}

$gatewayUpstreams = @('GATEWAY_CATALOG_SVC_URL','GATEWAY_INVENTORY_SVC_URL','GATEWAY_PRICING_SVC_URL','GATEWAY_PROMOTIONS_SVC_URL')
$upstreamStatus = 'PASS'
foreach ($name in $gatewayUpstreams) {
  $value = [string]$gateway[$name]
  if (-not (Is-HttpsUrl $value) -or ([uri]$value).AbsolutePath -ne '/') { $upstreamStatus = 'PENDING' }
}
Add-Result 'gateway-four-private-https-upstreams' $upstreamStatus 'Configured values must be isolated ACA private origins; endpoints were not contacted.'

foreach ($service in @('catalog-svc','inventory-svc','pricing-svc','promotions-svc')) {
  $envMap = $runtime[$service]
  $required = switch ($service) {
    'catalog-svc' { @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLROOTCERT','G6_EXPECTED_ROLE','G6_CONNECTION_MODE') }
    'inventory-svc' { @('PGHOST','PGDATABASE','PGUSER','PGPASSWORD','PGSSLROOTCERT') }
    'pricing-svc' { @('DATABASE_URL','PGSSLROOTCERT') }
    'promotions-svc' { @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLROOTCERT','SERVICE_BUS_NAMESPACE_FQDN','AZURE_CLIENT_ID') }
  }
  $missing = @($required | Where-Object { -not (Has-Value $envMap $_) })
  $tlsOk = switch ($service) {
    'catalog-svc' { [string]$envMap.PGSSLMODE -ceq 'verify-full' }
    'inventory-svc' { [string]$envMap.PGSSLMODE -ceq 'verify-full' }
    'pricing-svc' { ([string]$envMap.DATABASE_URL -match '[?&]sslmode=verify-full(?:&|$)') -and [string]$envMap.PGSSLMODE -ceq 'verify-full' }
    'promotions-svc' { [string]$envMap.PGSSLMODE -ceq 'verify-full' }
  }
  $caPath = [string]$envMap.PGSSLROOTCERT
  if ($service -eq 'pricing-svc' -and -not $caPath -and $envMap.DATABASE_URL) {
    try { $query = [System.Web.HttpUtility]::ParseQueryString(([uri]$envMap.DATABASE_URL).Query); $caPath = [string]$query['sslrootcert'] } catch { }
  }
  $caOk = $false
  if ($caPath -and (Test-Path -LiteralPath $caPath -PathType Leaf)) {
    try {
      $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($caPath)
      $caOk = $null -ne $cert
      $cert.Dispose()
    } catch { }
  }
  $configStatus = if ($missing.Count -gt 0 -or -not $tlsOk -or -not $caOk) { 'PENDING' } else { 'READY_TO_PROBE' }
  $detail = if ($missing.Count) { 'Missing: ' + ($missing -join ', ') } elseif (-not $tlsOk) { 'TLS must be verify-full.' } elseif (-not $caOk) { 'Configured CA path is absent or not a PEM certificate.' } else { 'Local values validated; database access still requires a live probe.' }
  Add-Result ($service + '-postgres-configuration') $configStatus $detail

  if ($ProbePostgres -and $configStatus -eq 'READY_TO_PROBE') {
    $psql = Get-Command psql -ErrorAction SilentlyContinue
    if (-not $psql) { Add-Result ($service + '-postgres-readonly-login') 'NOT_RUN' 'psql is not installed; no database connection attempted.'; continue }
    $schema = switch ($service) { 'catalog-svc' { 'catalog' } 'inventory-svc' { 'inventory' } 'pricing-svc' { 'pricing' } 'promotions-svc' { 'promotions' } }
    $table = switch ($service) { 'catalog-svc' { 'outbox_delivery' } 'inventory-svc' { 'outbox_delivery' } 'pricing-svc' { 'outbox_delivery' } 'promotions-svc' { 'h5_coupon_outbox' } }
    $role = switch ($service) { 'catalog-svc' { [string]$envMap.G6_EXPECTED_ROLE } 'inventory-svc' { 'inventory_app' } 'pricing-svc' { 'pricing_app' } 'promotions-svc' { 'po_promotions_dev_runtime' } }
    $password = [string]$envMap.PGPASSWORD
    $hostName = [string]$envMap.PGHOST
    $port = [string]$envMap.PGPORT
    $database = [string]$envMap.PGDATABASE
    $user = [string]$envMap.PGUSER
    if ($service -eq 'pricing-svc') {
      try {
        $dbUri = [uri][string]$envMap.DATABASE_URL
        $hostName = $dbUri.Host
        $port = if ($dbUri.IsDefaultPort) { '5432' } else { [string]$dbUri.Port }
        $database = [uri]::UnescapeDataString($dbUri.AbsolutePath.TrimStart('/'))
        $credentials = $dbUri.UserInfo.Split(':', 2)
        $user = [uri]::UnescapeDataString($credentials[0])
        $password = if ($credentials.Count -gt 1) { [uri]::UnescapeDataString($credentials[1]) } else { '' }
      } catch { Add-Result ($service + '-postgres-readonly-login') 'INVALID' 'DATABASE_URL could not be parsed; contents suppressed.'; continue }
    }
    $savedPg = @{}
    foreach ($name in @('PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','PGOPTIONS')) { $savedPg[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
      $env:PGHOST = $hostName
      if ($service -eq 'catalog-svc' -and $envMap.G6_CONNECT_HOST) { $env:PGHOSTADDR = [string]$envMap.G6_CONNECT_HOST }
      else { Remove-Item Env:PGHOSTADDR -ErrorAction SilentlyContinue }
      $env:PGPORT = $port; $env:PGDATABASE = $database; $env:PGUSER = $user
      $env:PGPASSWORD = $password; $env:PGSSLMODE = 'verify-full'; $env:PGSSLROOTCERT = $caPath
      $env:PGOPTIONS = '-c default_transaction_read_only=on'
      $probeOutput = & $psql.Source --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 --set "schema=$schema" --set "expected_role=$role" --set "h5_table=$table" --file (Join-Path $PSScriptRoot 'integration-readonly.sql') 2>$null
      if ($LASTEXITCODE -ne 0) { Add-Result ($service + '-postgres-readonly-login') 'FAIL' 'Connection/TLS/read-only SQL failed; stderr and endpoint details suppressed.'; continue }
      $diagnostic = ($probeOutput -join '').Trim() | ConvertFrom-Json
      $grantOk = $diagnostic.h5_table_select -and $diagnostic.h5_table_insert
      if ($service -ne 'catalog-svc') { $grantOk = $grantOk -and $diagnostic.h5_table_update }
      $roleOk = $diagnostic.expected_role_exists -and ($diagnostic.expected_role_inherited -or $diagnostic.login_role -eq $role)
      $dbOk = $diagnostic.ssl_in_use -and $diagnostic.schema_exists -and $diagnostic.schema_usage -and $diagnostic.h5_table_exists -and $roleOk -and $grantOk
      Add-Result ($service + '-postgres-readonly-login') $(if ($dbOk) { 'PASS' } else { 'FAIL' }) 'Read-only TLS, role, schema, H5 table and minimum table grants checked; identifiers suppressed.'
    } catch { Add-Result ($service + '-postgres-readonly-login') 'FAIL' 'Read-only SQL diagnostics failed; error details suppressed.' }
    finally {
      foreach ($name in $savedPg.Keys) {
        if ($null -eq $savedPg[$name]) { Remove-Item ('Env:' + $name) -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $savedPg[$name], 'Process') }
      }
    }
  }
}

$flagsOk =
  [string]$gateway.G6_SECURITY_MODE -ceq 'G7_AUTHENTICATED' -and
  [string]$gateway.GATEWAY_DEMO_NO_AUTH_ENABLED -ceq 'false' -and
  [string]$gateway.GATEWAY_PUBLIC_OPERATION_IDS -ceq '' -and
  [string]$runtime['pricing-svc'].PRICING_PRICE_CHANGED_PUBLISH_ENABLED -ceq 'false' -and
  [string]$promotion.PROMOTIONS_COUPON_RUNTIME_ENABLED -ceq 'false' -and
  [string]$promotion.PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED -ceq 'false' -and
  [string]$promotion.PROMOTIONS_H5_COUPON_COMMANDS_ENABLED -ceq 'false'
Add-Result 'first-bootstrap-closed-flags' $(if ($flagsOk) { 'PASS' } else { 'FAIL' }) 'Commercial H5, fan-out and demo/public bypasses remain closed.'

$packageCount = -1
if (Get-Command gh -ErrorAction SilentlyContinue) {
  try {
    $names = gh api '/orgs/Taller-SW-Web/packages?package_type=container&per_page=100' --jq '.[].name' 2>$null
    if ($LASTEXITCODE -eq 0) { $packageCount = @($names | Where-Object { $_ }).Count }
  } catch { }
}
Add-Result 'ghcr-five-release-packages' $(if ($packageCount -lt 0) { 'UNAVAILABLE' } elseif ($packageCount -eq 0) { 'NOT_PUBLISHED' } else { 'VERIFY_REQUIRED' }) $(if ($packageCount -ge 0) { "Organization container package count=$packageCount; token value suppressed." } else { 'Read-only GitHub Packages query failed.' })
$registryUsername = [string](Get-ParameterValue $manifest 'registryUsername')
$ghcrCredential = -not [string]::IsNullOrWhiteSpace($registryUsername)
foreach ($service in $services) { if (-not (Get-AppSecret $manifest $service 'ghcr-pull')) { $ghcrCredential = $false } }
Add-Result 'ghcr-pull-least-privilege-credential' $(if ($ghcrCredential) { 'AVAILABLE' } else { 'EXTERNAL_DEPENDENCY' }) 'Only a dedicated read:packages credential is acceptable for the runtime parameter.'

try {
  $appsOutput = az containerapp list --resource-group rg-g6-sb-h5-int-fork -o json 2>$null | Out-String
  if ($LASTEXITCODE -eq 0) { $apps = @($appsOutput | ConvertFrom-Json); Add-Result 'azure-isolated-container-apps' 'READ_ONLY_CHECKED' ("Count=$($apps.Count); no writes performed.") }
  else { Add-Result 'azure-isolated-container-apps' 'UNAVAILABLE' 'Read-only resource query failed.' }
} catch { Add-Result 'azure-isolated-container-apps' 'UNAVAILABLE' 'Azure CLI query failed; no writes performed.' }

try {
  $namespaceOutput = az servicebus namespace list --resource-group rg-g6-sb-h5-int-fork -o json 2>$null | Out-String
  $identityOutput = az identity show --resource-group rg-g6-sb-h5-int-fork --name g6-h5-int-promotions -o json 2>$null | Out-String
  if ($LASTEXITCODE -eq 0) {
    $targetHost = [string]$promotion.SERVICE_BUS_NAMESPACE_FQDN
    $namespaces = @($namespaceOutput | ConvertFrom-Json)
    $matching = $null
    foreach ($item in $namespaces) {
      try {
        $details = az servicebus namespace show --resource-group rg-g6-sb-h5-int-fork --name $item.name -o json 2>$null | ConvertFrom-Json
        if (([uri]$details.serviceBusEndpoint).Host -ceq $targetHost) { $matching = $details; break }
      } catch { }
    }
    $identity = $identityOutput | ConvertFrom-Json
    $paramsOk = $matching -and $matching.sku.name -ceq 'Basic' -and $identity.id -ceq [string]$manifest.parameters.promotionsIdentityResourceId.value -and $identity.clientId -ceq [string]$manifest.parameters.promotionsIdentityClientId.value
    if ($paramsOk) {
      $roleOutput = az role assignment list --scope $matching.id --include-inherited -o json 2>$null | Out-String
      $roles = @($roleOutput | ConvertFrom-Json | Where-Object { $_.principalId -eq $identity.principalId } | ForEach-Object { $_.roleDefinitionName })
      $hasSender = $roles -contains 'Azure Service Bus Data Sender'
      $hasReceiver = $roles -contains 'Azure Service Bus Data Receiver'
      Add-Result 'promotions-managed-identity-and-servicebus-parameters' 'PASS' 'Resource IDs, FQDN and Basic tier checked read-only.'
      Add-Result 'promotions-servicebus-data-plane-rbac' $(if ($hasSender -and $hasReceiver) { 'PASS' } elseif ($promotion.PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED -ceq 'false' -and $promotion.PROMOTIONS_H5_COUPON_COMMANDS_ENABLED -ceq 'false') { 'NOT_GRANTED_H5_DISABLED' } else { 'PENDING' }) 'Data Sender/Receiver grants were checked; no role assignments were changed.'
    } else { Add-Result 'promotions-managed-identity-and-servicebus-parameters' 'PENDING' 'Configured IDs/FQDN do not match the authorized Azure resources.' }
  } else { Add-Result 'promotions-managed-identity-and-servicebus-parameters' 'UNAVAILABLE' 'Read-only resource query failed.' }
} catch { Add-Result 'promotions-managed-identity-and-servicebus-parameters' 'UNAVAILABLE' 'Azure CLI metadata query failed; no writes performed.' }

$results | Format-Table -Wrap -AutoSize | Out-String | Write-Output
if (@($results | Where-Object { $_.Status -in @('FAIL','PENDING','EXTERNAL_DEPENDENCY','NOT_PUBLISHED','UNAVAILABLE') }).Count -gt 0) { exit 1 }
