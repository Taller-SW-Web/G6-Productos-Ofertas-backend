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
  $guarded = Get-H5GuardedEnvironment ($bicep -join "`n")

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
  Assert (-not (Test-H5PsqlAvailable 'g6-h5-preflight-no-such-psql-executable')) 'psql absent is detected without attempting a database connection'

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
  $invokeOutput = & pwsh -NoProfile -File (Join-Path $root 'Invoke-Preflight.ps1') -Mode STATIC -JsonOutput -ManifestPath $syntheticManifest -BicepTemplatePath $syntheticBicep -SkipExternalProbes 2>&1 | Out-String
  $staticResult = $invokeOutput | ConvertFrom-Json
  Assert ($LASTEXITCODE -eq 0 -and $staticResult.overall_status -eq 'PASS' -and -not $staticResult.deployment_authorized -and $staticResult.mode -eq 'STATIC') 'STATIC pass validates configuration only and never authorizes deployment'

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
    $validToken = Test-H5JwtAuthenticity $jwt $jwks 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' 'api-productos'
    Assert ($validToken.Status -eq 'TOKEN_VALID') 'G7 authenticity verifier accepts a signed api-productos promotions-svc token'
    Assert ((Test-H5JwtRequiredScopes $validToken.Status $validToken.Scopes $apiProductsScopes @('promociones:leer')) -eq 'REQUIRED_SCOPES_VERIFIED') 'G7 authorization verifies inclusion of the required scope set'
    Assert ((Test-H5JwtRequiredScopes $validToken.Status $validToken.Scopes @('promociones:leer','cupones:validar') @('promociones:leer','cupones:validar')) -eq 'REQUIRED_SCOPES_MISSING') 'correctly signed JWT missing one required scope does not authorize the integration'
    $jwtParts = $jwt.Split('.'); $tamperedSignature = if ($jwtParts[2][0] -eq 'A') { 'B' + $jwtParts[2].Substring(1) } else { 'A' + $jwtParts[2].Substring(1) }
    Assert ((Test-H5JwtAuthenticity ("$($jwtParts[0]).$($jwtParts[1]).$tamperedSignature") $jwks 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' 'api-productos').Status -eq 'TOKEN_INVALID') 'G7 verifier rejects a tampered token signature'
    foreach ($invalidJwtCase in @(
      @{ name='malformed JWT'; token='not-a-jwt'; keys=$jwks },
      @{ name='unknown kid'; token=$jwt; keys=@{keys=@()} },
      @{ name='unsupported algorithm'; token=("$(B64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"none","kid":"test-key"}'))).$($jwtParts[1]).$($jwtParts[2])"); keys=$jwks }
    )) {
      $invalidTokenResult = Test-H5JwtAuthenticity $invalidJwtCase.token $invalidJwtCase.keys 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' 'api-productos'
      Assert ($invalidTokenResult -is [pscustomobject] -and $invalidTokenResult.Status -eq 'TOKEN_INVALID' -and $invalidTokenResult.Scopes -is [array]) "JWT $($invalidJwtCase.name) returns structured TOKEN_INVALID"
    }
    $salesPayload = B64Url ([Text.Encoding]::UTF8.GetBytes((@{iss='https://g7-auth-service.onrender.com/api/v1/auth';aud=@('api-ventas');client_id='modulo-ventas';exp=$now+300;scope='ventas:pedidos:evidencia-cupon:leer'} | ConvertTo-Json -Compress)))
    $salesInput = [Text.Encoding]::ASCII.GetBytes("$head.$salesPayload")
    $salesJwt = "$head.$salesPayload.$(B64Url ($rsa.SignData($salesInput,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)))"
    Assert ((Test-H5JwtAuthenticity $salesJwt $jwks 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' 'api-productos').Status -eq 'TOKEN_INVALID') 'api-ventas audience/scope cannot pass as an api-productos token'
    $unknownPayload = B64Url ([Text.Encoding]::UTF8.GetBytes((@{iss='https://g7-auth-service.onrender.com/api/v1/auth';aud=@('api-productos');client_id='promotions-svc';exp=$now+300;scope='scope:no-registrado'} | ConvertTo-Json -Compress)))
    $unknownInput = [Text.Encoding]::ASCII.GetBytes("$head.$unknownPayload")
    $unknownJwt = "$head.$unknownPayload.$(B64Url ($rsa.SignData($unknownInput,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)))"
    $unknownResult = Test-H5JwtAuthenticity $unknownJwt $jwks 'https://g7-auth-service.onrender.com/api/v1/auth' 'promotions-svc' 'api-productos'
    Assert ($unknownResult.Status -eq 'TOKEN_VALID' -and (Test-H5JwtRequiredScopes $unknownResult.Status $unknownResult.Scopes @('scope:no-registrado') $apiProductsScopes) -eq 'AUTHORIZATION_NOT_RUN') 'G7 token authenticity is not converted to authorization by uncontracted scopes'
  } finally { $rsa.Dispose() }

  $staticGate = Get-H5PreflightOutcome 'STATIC' @(
    [pscustomobject]@{Check='private-manifest';Status='PASS'}
    [pscustomobject]@{Check='h5-aca-effective-configuration';Status='PASS'}
    [pscustomobject]@{Check='official-bicep-guarded-env';Status='PASS'}
    [pscustomobject]@{Check='g7-five-service-parser-configuration';Status='PASS'}
    [pscustomobject]@{Check='first-bootstrap-closed-flags';Status='PASS'}
  )
  Assert ($staticGate.ExitCode -eq 0 -and -not $staticGate.DeploymentAuthorized) 'STATIC outcome is structurally separate from deployment authorization'
  $httpRequired = (Get-H5PreflightOutcome 'HTTP_BOOTSTRAP' @()).RequiredChecks
  $httpPassResults = @($httpRequired | ForEach-Object {
    $status = if ($_.StartsWith('ghcr-')) { Get-H5GhcrReleaseStatus 'VISIBLE' ('a'*40) ('a'*40) $true } else { Get-H5CheckSuccessStatus $_ }
    [pscustomobject]@{Check=$_;Status=$status}
  })
  Assert (@($httpPassResults | Where-Object { $_.Check -like 'ghcr-*' -and $_.Status -ne 'VERIFIED' }).Count -eq 0 -and (Get-H5PreflightOutcome 'HTTP_BOOTSTRAP' $httpPassResults).ExitCode -eq 0) 'five producer-verified GHCR images plus all required check-specific producer states yield HTTP_BOOTSTRAP PASS'
  $ghcrNotRun = @($httpPassResults | ForEach-Object { if ($_.Check -eq 'ghcr-pricing-svc') { [pscustomobject]@{Check=$_.Check;Status='NOT_RUN'} } else { $_ } })
  Assert ((Get-H5PreflightOutcome 'HTTP_BOOTSTRAP' $ghcrNotRun).ExitCode -eq 2) 'one GHCR image NOT_RUN keeps HTTP_BOOTSTRAP pending'
  $badGhcrDigestState = Get-H5GhcrReleaseStatus 'VISIBLE' ('a'*40) ('c'*40) $false
  $badGhcrDigest = @($httpPassResults | ForEach-Object { if ($_.Check -eq 'ghcr-pricing-svc') { [pscustomobject]@{Check=$_.Check;Status=$badGhcrDigestState} } else { $_ } })
  Assert ((Get-H5PreflightOutcome 'HTTP_BOOTSTRAP' $badGhcrDigest).ExitCode -eq 1) 'GHCR image digest mismatch fails HTTP_BOOTSTRAP'
  $ghcrWrongPositive = @($httpPassResults | ForEach-Object { if ($_.Check -eq 'ghcr-pricing-svc') { [pscustomobject]@{Check=$_.Check;Status='PASS'} } else { $_ } })
  Assert ((Get-H5PreflightOutcome 'HTTP_BOOTSTRAP' $ghcrWrongPositive).ExitCode -eq 1) 'GHCR PASS without producer VERIFIED cannot satisfy the gate'
  foreach ($case in @(
    @{name='psql absent';check='catalog-svc-postgres-readonly-login';status='NOT_RUN'},
    @{name='PostgreSQL not executed';check='inventory-svc-postgres-readonly-login';status='NOT_RUN'},
    @{name='GHCR not executed';check='ghcr-pricing-svc';status='NOT_RUN'},
    @{name='unavailable network';check='catalog-svc-postgres-readonly-login';status='UNAVAILABLE'}
  )) {
    $blocked = @($httpPassResults | ForEach-Object { if ($_.Check -eq $case.check) { [pscustomobject]@{Check=$_.Check;Status=$case.status} } else { $_ } })
    Assert ((Get-H5PreflightOutcome 'HTTP_BOOTSTRAP' $blocked).ExitCode -eq 2) "HTTP gate blocks when $($case.name)"
  }
  $invalidResults = @($httpPassResults | ForEach-Object { if ($_.Check -eq 'official-bicep-guarded-env') { [pscustomobject]@{Check=$_.Check;Status='INVALID'} } else { $_ } })
  Assert ((Get-H5PreflightOutcome 'HTTP_BOOTSTRAP' $invalidResults).ExitCode -eq 1) 'HTTP gate returns failure code 1 for INVALID'
  $noNetworkResults = @($httpPassResults | ForEach-Object { if ($_.Check -eq 'catalog-svc-postgres-readonly-login' -or $_.Check -eq 'ghcr-api-gateway') { [pscustomobject]@{Check=$_.Check;Status='NOT_RUN'} } else { $_ } })
  Assert ((Get-H5PreflightOutcome 'HTTP_BOOTSTRAP' $noNetworkResults).ExitCode -eq 2) 'complete manifest without network evidence cannot pass HTTP_BOOTSTRAP'
  $h5Required = (Get-H5PreflightOutcome 'H5_INTEGRATION' @()).RequiredChecks
  $h5PassResults = @($h5Required | ForEach-Object { [pscustomobject]@{Check=$_;Status=(Get-H5CheckSuccessStatus $_)} })
  $h5PreparationPass = Get-H5PreflightOutcome 'H5_INTEGRATION' $h5PassResults
  Assert ($h5PreparationPass.ExitCode -eq 0 -and -not $h5PreparationPass.DeploymentAuthorized) 'H5_INTEGRATION PASS represents dependency preparation only and never authorizes deployment'
  $h5TargetPending = @($h5PassResults | ForEach-Object { if ($_.Check -eq 'h5-integration-target-configuration') { [pscustomobject]@{Check=$_.Check;Status='PENDING'} } else { $_ } })
  Assert ((Get-H5PreflightOutcome 'H5_INTEGRATION' $h5TargetPending).ExitCode -eq 2) 'H5_INTEGRATION requires an approved target and returns pending without it'
  $h5JwtMissing = @($h5PassResults | ForEach-Object { if ($_.Check -eq 'promotions-token-api-productos') { [pscustomobject]@{Check=$_.Check;Status='AUTHORIZATION_NOT_RUN'} } else { $_ } })
  Assert ((Get-H5PreflightOutcome 'H5_INTEGRATION' $h5JwtMissing).ExitCode -eq 2) 'H5 integration is blocked when a required JWT authorization was not verified'

  $guardedParameters = [pscustomobject]@{parameters=[pscustomobject]@{promotionsIdentityClientId=[pscustomobject]@{value='00000000-0000-0000-0000-000000000002'}}}
  $resolvedGuarded = Resolve-H5GuardedEnvironmentReferences $guarded $guardedParameters
  Assert ($guarded['promotions-svc'].AZURE_CLIENT_ID -ceq 'promotionsIdentityClientId' -and $resolvedGuarded['promotions-svc'].AZURE_CLIENT_ID -ceq '00000000-0000-0000-0000-000000000002') 'Bicep promotionsIdentityClientId reference resolves to the supplied UUID'
  $syntheticTarget = Get-Content (Join-Path $root 'h5-integration-target.private.example.json') -Raw | ConvertFrom-Json -AsHashtable
  $syntheticTarget.approvalStatus = 'APPROVED'
  $syntheticTarget.approvalReference = 'test-approval-reference'
  foreach ($service in @('catalog-svc','inventory-svc','pricing-svc','promotions-svc')) {
    $serviceTarget = $syntheticTarget.services[$service]
    $clientId = switch ($service) {
      'catalog-svc' {'00000000-0000-0000-0000-000000000003'}
      'inventory-svc' {'00000000-0000-0000-0000-000000000004'}
      'pricing-svc' {'00000000-0000-0000-0000-000000000005'}
      'promotions-svc' {$guardedParameters.parameters.promotionsIdentityClientId.value}
    }
    $serviceTarget.identityResourceId = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/h5-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$service"
    $serviceTarget.identityClientId = $clientId
    $serviceTarget.env.AZURE_CLIENT_ID = $clientId
    $serviceTarget.queueGrants = @(@{queue="g6.test.$service";roles=@('Azure Service Bus Data Sender')})
  }
  $targetResult = Test-H5IntegrationTarget $syntheticTarget $resolvedGuarded $guardedParameters
  Assert ($targetResult.Status -eq 'PASS') 'approved synthetic H5 target passes with four distinct identities and per-service queue grants'
  Assert ((@(Test-H5GuardedEnvironment ($bicep -join "`n"))).Count -eq 0 -and $resolvedGuarded['promotions-svc'].PROMOTIONS_H5_COUPON_COMMANDS_ENABLED -ceq 'false' -and $resolvedGuarded['pricing-svc'].PRICING_PRICE_CHANGED_PUBLISH_ENABLED -ceq 'false') 'H5 preparation passes while official #263 guarded commercial flags remain closed'
  $missingApproval = $syntheticTarget | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable; $missingApproval.approvalStatus = 'PENDING_APPROVAL'; $missingApproval.approvalReference = ''
  Assert ((Test-H5IntegrationTarget $missingApproval $resolvedGuarded $guardedParameters).Status -eq 'PENDING') 'unapproved H5 commercial target stays pending'
  $reusedIdentity = $syntheticTarget | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable; $reusedIdentity.services['catalog-svc'].identityClientId = $reusedIdentity.services['inventory-svc'].identityClientId; $reusedIdentity.services['catalog-svc'].env.AZURE_CLIENT_ID = $reusedIdentity.services['inventory-svc'].identityClientId
  $reusedIdentityResult = Test-H5IntegrationTarget $reusedIdentity $resolvedGuarded $guardedParameters
  Assert (($reusedIdentityResult.Errors -join ',') -match 'IDENTITY_REUSED_inventory-svc') 'H5 target rejects reusing one managed identity across services'
  $unapprovedGrant = $syntheticTarget | ConvertTo-Json -Depth 30 | ConvertFrom-Json -AsHashtable; $unapprovedGrant.services['catalog-svc'].queueGrants[0].roles = @('Azure Service Bus Data Owner')
  Assert ((@((Test-H5IntegrationTarget $unapprovedGrant $resolvedGuarded $guardedParameters).Errors) -join ',') -match 'QUEUE_GRANT_INVALID_catalog-svc') 'H5 target rejects broad or unrecognized Service Bus roles'
  $docsRepo = [IO.Path]::GetFullPath((Join-Path $root '..\..\..\..\docs'))
  $openApiText = git -C $docsRepo show 'origin/master:contratos/http/openapi.yaml' | Out-String
  $contractOperationScopes = Get-H5ContractOperationScopes $openApiText
  $scopeOperationsValid = $true
  foreach ($operation in Get-H5PromotionsRequiredOperations | Where-Object contractOperationId) {
    if ($contractOperationScopes[$operation.contractOperationId] -cne $operation.scope) { $scopeOperationsValid = $false }
  }
  Assert $scopeOperationsValid 'Promotions required api-productos scopes map to concrete current OpenAPI operation IDs'
  Assert ('ventas:pedidos:evidencia-cupon:leer' -notin @(Get-H5ContractScopes $openApiText)) 'pending api-ventas scope is reported separately from api-productos contract grants'
  Write-Output "Completed $passed PowerShell assertions."
} finally {
  foreach ($name in @('PGSSLROOTCERT','PGSSLMODE','PGOPTIONS','PGHOST','PGPASSWORD','TEST_PSQL_CA_LOG')) { Remove-Item ('Env:'+$name) -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
