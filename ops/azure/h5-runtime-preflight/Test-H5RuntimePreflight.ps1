[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Import-Module (Join-Path $root 'H5Preflight.Core.psm1') -Force
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("g6-h5-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$passed = 0
function Assert([bool]$Condition,[string]$Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:passed++; Write-Output "PASS $Name" }
function B64Url([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
try {
  $sha = '51f8441a2adb2e0484b2a2d3072617908f9672dc'
  $bicep = git show "${sha}:ops/azure/container-apps/h5-isolated-five-apps.bicep"
  if ($LASTEXITCODE -ne 0) { throw 'Could not load the pinned #263 Bicep template.' }
  Assert ((@(Test-H5GuardedEnvironment ($bicep -join "`n"))).Count -eq 0) 'official guardedEnv values match the reviewed safe values'

  $manifest = Get-Content (Join-Path $root 'parameters.private.example.json') -Raw | ConvertFrom-Json
  Assert ((@(Test-H5ManifestEnvironment $manifest)).Count -eq 0) 'example manifest has required nonreserved vars and no collisions'
  $reservedManifest = $manifest | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $reservedManifest.parameters.appConfiguration.value.'api-gateway'.env += [pscustomobject]@{name='NODE_ENV';value='production'}
  Assert ((@(Test-H5ManifestEnvironment $reservedManifest) | Where-Object { $_ -like 'ENVIRONMENT_RESERVED*' }).Count -gt 0) 'reserved variables are rejected'
  $collisionManifest = $manifest | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $upstream = $collisionManifest.parameters.appConfiguration.value.'api-gateway'.env | Where-Object name -eq 'GATEWAY_CATALOG_SVC_URL' | Select-Object -First 1
  $collisionManifest.parameters.appConfiguration.value.'api-gateway'.env += $upstream
  Assert ((@(Test-H5ManifestEnvironment $collisionManifest) | Where-Object { $_ -like 'ENVIRONMENT_COLLISION*' }).Count -gt 0) 'duplicate environment names are rejected'

  Assert (-not (Test-H5PemCertificate '')) 'missing postgres CA is rejected'
  Assert (-not (Test-H5PemCertificate 'not a certificate')) 'invalid postgres CA is rejected'
  $certPath = Join-Path $testRoot 'ca.pem'; $keyPath = Join-Path $testRoot 'ca-key.pem'
  openssl req -x509 -newkey rsa:2048 -keyout $keyPath -out $certPath -days 2 -nodes -subj '/CN=h5-preflight-test' -addext 'basicConstraints=critical,CA:TRUE' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate a disposable test certificate.' }
  $pem = Get-Content $certPath -Raw
  Assert (Test-H5PemCertificate $pem) 'synthetic X.509 CA parses'
  $caPath = New-H5ProtectedCaFile $pem
  Assert ((Test-Path $caPath) -and (Test-H5PemCertificate (Get-Content $caPath -Raw))) 'temporary protected CA file contains the validated PEM'
  Remove-Item -LiteralPath $caPath -Force

  Assert ((Get-H5QueueRbacStatus 'PASS' @('Azure Service Bus Data Sender','Azure Service Bus Data Receiver')) -eq 'PASS') 'queue RBAC accepts both required roles'
  Assert ((Get-H5QueueRbacStatus 'PASS' @('Azure Service Bus Data Sender')) -eq 'MISSING') 'queue RBAC reports a missing role'
  Assert ((Get-H5QueueRbacStatus 'UNAVAILABLE' @()) -eq 'UNAVAILABLE') 'denied/unavailable queue query is not reported as missing'
  Assert ((Get-H5QueueRbacStatus 'NOT_RUN' @()) -eq 'NOT_RUN') 'unrun queue query remains NOT_RUN'

  Assert ((Get-H5GhcrReleaseStatus 'UNKNOWN' '' '' $false) -eq 'NO_VISIBILITY') 'GHCR access without visibility is not treated as unpublished'
  Assert ((Get-H5GhcrReleaseStatus 'VISIBLE' ('a'*40) '' $false) -eq 'MISSING_FOR_RELEASE_SHA') 'visible package without release digest is distinguished'
  Assert ((Get-H5GhcrReleaseStatus 'VISIBLE' ('a'*40) ('a'*40) $true) -eq 'VERIFIED') 'visible package with verified release digest is accepted'

  Assert ((Test-H5OptionalMessagingTable 'pricing-svc' $false $false) -eq 'NOT_REQUIRED_HTTP_BOOTSTRAP') 'Pricing H5 delivery table is optional while publication is off'
  Assert ((Test-H5OptionalMessagingTable 'pricing-svc' $true $false) -eq 'MISSING') 'enabled H5 delivery reports missing storage'

  $synthetic = Get-Content (Join-Path $root 'parameters.private.example.json') -Raw | ConvertFrom-Json -AsHashtable
  $synthetic.parameters.promotionsIdentityResourceId.value = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/promotions'
  $synthetic.parameters.promotionsIdentityClientId.value = '00000000-0000-0000-0000-000000000002'
  $synthetic.parameters.registryUsername.value = 'synthetic-user'
  $synthetic.parameters.sourceSha.value = 'a' * 40
  foreach ($service in @('api-gateway','catalog-svc','inventory-svc','pricing-svc','promotions-svc')) { $synthetic.parameters.imageDigests.value[$service] = 'sha256:' + ('b' * 64) }
  $apps = $synthetic.parameters.appConfiguration.value
  foreach ($service in $apps.Keys) {
    $app = $apps[$service]
    foreach ($secret in $app.secrets) { $secret.value = if ($secret.name -eq 'postgres-ca') { $pem } else { 'synthetic-only-test-value' } }
    if ($service -eq 'pricing-svc') { ($app.secrets | Where-Object name -eq 'pricing-database-url').value = 'postgresql://pricing_app:synthetic@postgres.test:5432/pricing?sslmode=verify-full' }
    foreach ($entry in $app.env) {
      if ($entry.secretRef) { continue }
      switch ($entry.name) {
        'PGHOST' { $entry.value = 'postgres.test' }
        'PGDATABASE' { $entry.value = $service }
        'PGUSER' { $entry.value = switch ($service) { 'catalog-svc' {'catalog_app'} 'inventory-svc' {'inventory_app'} 'promotions-svc' {'promotions_app'} } }
        'GATEWAY_CATALOG_SVC_URL' { $entry.value = 'https://catalog-svc.internal.test' }
        'GATEWAY_INVENTORY_SVC_URL' { $entry.value = 'https://inventory-svc.internal.test' }
        'GATEWAY_PRICING_SVC_URL' { $entry.value = 'https://pricing-svc.internal.test' }
        'GATEWAY_PROMOTIONS_SVC_URL' { $entry.value = 'https://promotions-svc.internal.test' }
        'PRICING_CATALOG_URL' { $entry.value = 'https://catalog-svc.internal.test' }
        'DATABASE_URL' { $entry.value = 'postgresql://pricing_app:synthetic@postgres.test:5432/pricing?sslmode=verify-full' }
      }
    }
  }
  $syntheticManifest = Join-Path $testRoot 'synthetic-parameters.json'
  $syntheticBicep = Join-Path $testRoot 'h5-isolated-five-apps.bicep'
  $synthetic | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $syntheticManifest -Encoding utf8
  Set-Content -LiteralPath $syntheticBicep -Value ($bicep -join "`n") -Encoding utf8
  $invokeOutput = & pwsh -NoProfile -File (Join-Path $root 'Invoke-Preflight.ps1') -ManifestPath $syntheticManifest -BicepTemplatePath $syntheticBicep -EnvironmentDefaultDomain 'test' -SkipExternalProbes 2>&1 | Out-String
  Assert ($LASTEXITCODE -eq 0 -and $invokeOutput -match 'h5-aca-effective-configuration\s+PASS' -and $invokeOutput -match 'official-bicep-guarded-env\s+PASS' -and $invokeOutput -match 'first-bootstrap-closed-flags\s+PASS') 'completed fixture passes live configuration preflight against #263 guardedEnv without network probes'

  $env:PGSSLROOTCERT = 'restore-me'; $env:PGSSLMODE = 'prefer'; $env:PGOPTIONS = 'caller-options'; $env:PGHOST = 'before.test'; $env:TEST_PSQL_CA_LOG = Join-Path $testRoot 'ca-path.log'
  $fakePsql = Join-Path $testRoot 'psql.cmd'
  @'
@echo off
if not exist "%PGSSLROOTCERT%" exit /b 31
if not "%PGSSLMODE%"=="verify-full" exit /b 32
echo %PGSSLROOTCERT%>>"%TEST_PSQL_CA_LOG%"
echo {"ssl_in_use":true}
exit /b 0
'@ | Set-Content -LiteralPath $fakePsql -Encoding ascii
  $sqlResult = Invoke-H5ReadOnlySql $pem $fakePsql @('--no-psqlrc') @{PGHOST='inside.test';PGPASSWORD='synthetic-only'}
  Assert ($sqlResult.ExitCode -eq 0) 'psql receives a verified-TLS temporary CA file'
  $observedPath = (Get-Content $env:TEST_PSQL_CA_LOG -Raw).Trim()
  Assert (-not (Test-Path $observedPath)) 'temporary CA file is deleted after psql returns'
  Assert ($env:PGSSLROOTCERT -eq 'restore-me' -and $env:PGSSLMODE -eq 'prefer' -and $env:PGOPTIONS -eq 'caller-options' -and $env:PGHOST -eq 'before.test') 'process PostgreSQL variables are restored in cleanup'

  $rsa = [Security.Cryptography.RSA]::Create(2048)
  try {
    $parameters = $rsa.ExportParameters($false)
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $head = B64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"RS256","kid":"test-key"}'))
    $payload = B64Url ([Text.Encoding]::UTF8.GetBytes((@{iss='https://g7-auth-service.onrender.com/api/v1/auth';aud=@('api-productos');client_id='promotions-svc';exp=$now+300;scope='promociones:leer'} | ConvertTo-Json -Compress)))
    $signingInput = [Text.Encoding]::ASCII.GetBytes("$head.$payload")
    $signature = $rsa.SignData($signingInput,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $jwt = "$head.$payload.$(B64Url $signature)"
    $jwks = @{ keys=@(@{kid='test-key';kty='RSA';alg='RS256';use='sig';n=(B64Url $parameters.Modulus);e=(B64Url $parameters.Exponent)}) }
    $apiProductsScopes = @('promociones:leer')
    Assert (Test-H5JwtSignatureAndClaims $jwt $jwks 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' $apiProductsScopes) 'G7 verifier accepts a signed api-productos promotions-svc token with documented scope'
    $jwtParts = $jwt.Split('.'); $tamperedSignature = if ($jwtParts[2][0] -eq 'A') { 'B' + $jwtParts[2].Substring(1) } else { 'A' + $jwtParts[2].Substring(1) }
    Assert (-not (Test-H5JwtSignatureAndClaims ("$($jwtParts[0]).$($jwtParts[1]).$tamperedSignature") $jwks 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' $apiProductsScopes)) 'G7 verifier rejects a tampered token signature'
    $salesPayload = B64Url ([Text.Encoding]::UTF8.GetBytes((@{iss='https://g7-auth-service.onrender.com/api/v1/auth';aud=@('api-ventas');client_id='modulo-ventas';exp=$now+300;scope='ventas:pedidos:evidencia-cupon:leer'} | ConvertTo-Json -Compress)))
    $salesInput = [Text.Encoding]::ASCII.GetBytes("$head.$salesPayload")
    $salesJwt = "$head.$salesPayload.$(B64Url ($rsa.SignData($salesInput,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)))"
    Assert (-not (Test-H5JwtSignatureAndClaims $salesJwt $jwks 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' $apiProductsScopes)) 'api-ventas audience/scope cannot pass as an api-productos grant'
    $unknownPayload = B64Url ([Text.Encoding]::UTF8.GetBytes((@{iss='https://g7-auth-service.onrender.com/api/v1/auth';aud=@('api-productos');client_id='promotions-svc';exp=$now+300;scope='scope:no-registrado'} | ConvertTo-Json -Compress)))
    $unknownInput = [Text.Encoding]::ASCII.GetBytes("$head.$unknownPayload")
    $unknownJwt = "$head.$unknownPayload.$(B64Url ($rsa.SignData($unknownInput,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)))"
    Assert (-not (Test-H5JwtSignatureAndClaims $unknownJwt $jwks 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' $apiProductsScopes)) 'G7 verifier rejects scopes absent from the current OpenAPI contract'
  } finally { $rsa.Dispose() }
  Write-Output "Completed $passed PowerShell assertions."
} finally {
  foreach ($name in @('PGSSLROOTCERT','PGSSLMODE','PGOPTIONS','PGHOST','PGPASSWORD','TEST_PSQL_CA_LOG')) { Remove-Item ('Env:'+$name) -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
