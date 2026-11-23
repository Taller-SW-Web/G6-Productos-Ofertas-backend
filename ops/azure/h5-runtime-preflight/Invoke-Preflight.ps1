[CmdletBinding()]
param(
  [ValidateSet('STATIC','HTTP_BOOTSTRAP','H5_INTEGRATION')]
  [string]$Mode = 'STATIC',
  [string]$ManifestPath = (Join-Path $env:LOCALAPPDATA 'G6\h5-runtime-preflight\parameters.private.json'),
  [string]$BicepTemplatePath = (Join-Path $PSScriptRoot '..\container-apps\h5-isolated-five-apps.bicep'),
  [switch]$ProbePostgres,
  [switch]$ProbeG7Token,
  [switch]$ProbeGhcr,
  [switch]$SkipExternalProbes,
  [switch]$JsonOutput,
  [string]$EnvironmentDefaultDomain = '',
  [string]$PsqlPath = 'psql'
)

$ErrorActionPreference = 'Stop'
$coreModule = Join-Path $PSScriptRoot 'H5Preflight.Core.psm1'
Import-Module $coreModule -Force
$services = @('api-gateway', 'catalog-svc', 'inventory-svc', 'pricing-svc', 'promotions-svc')
$allowExternal = $Mode -ne 'STATIC' -and -not $SkipExternalProbes
$runPostgres = $allowExternal
$runGhcr = $allowExternal
$runG7Tokens = $Mode -eq 'H5_INTEGRATION' -and $allowExternal
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
function Write-FinalResult([string]$ReleaseSha) {
  $outcome = Get-H5PreflightOutcome $Mode @($results)
  $document = [pscustomobject]@{
    mode = $Mode
    overall_status = $outcome.OverallStatus
    exit_code = $outcome.ExitCode
    release_sha = $ReleaseSha
    deployment_authorized = $false
    required_checks = $outcome.RequiredChecks
    checks = @($results)
  }
  if ($JsonOutput) { $document | ConvertTo-Json -Depth 6 | Write-Output }
  else {
    Write-Output ("Mode={0} Overall={1} DeploymentAuthorized=false" -f $Mode,$outcome.OverallStatus)
    $results | Format-Table -Wrap -AutoSize | Out-String | Write-Output
  }
  exit $outcome.ExitCode
}

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  Add-Result 'private-manifest' 'PENDING' 'Run Initialize-PrivateManifest.ps1; provide authorized values outside Git.'
  Write-FinalResult ''
}
try { $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json }
catch {
  Add-Result 'private-manifest' 'INVALID' 'JSON could not be parsed; secret contents suppressed.'
  Write-FinalResult ''
}
Add-Result 'private-manifest' 'PASS' 'Bicep parameters are read locally; values are never printed.'

$manifestErrors = @(Test-H5ManifestEnvironment $manifest)
$manifestCompletenessErrors = @(Test-H5ManifestCompleteness $manifest)
$fatalManifestErrors = @($manifestErrors + @($manifestCompletenessErrors | Where-Object { $_ -match 'INVALID|MISMATCH|RESERVED|COLLISION' }))
$manifestValid = $manifestErrors.Count -eq 0 -and $manifestCompletenessErrors.Count -eq 0
$manifestStatus = if ($fatalManifestErrors.Count) { 'INVALID' } elseif ($manifestValid) { 'PASS' } else { 'PENDING' }
$manifestDetail = if ($fatalManifestErrors.Count) { $fatalManifestErrors -join ', ' } elseif ($manifestCompletenessErrors.Count) { $manifestCompletenessErrors -join ', ' } else { 'No reserved variables or collisions; manifest values meet parser and Bicep parameter requirements.' }
Add-Result 'h5-aca-effective-configuration' $manifestStatus $manifestDetail
$guardedValues = $null
if (Test-Path -LiteralPath $BicepTemplatePath -PathType Leaf) {
  $guardErrors = @(Test-H5GuardedEnvironment (Get-Content -LiteralPath $BicepTemplatePath -Raw))
  if ($guardErrors.Count -eq 0) { $guardedValues = Get-H5GuardedEnvironment (Get-Content -LiteralPath $BicepTemplatePath -Raw) }
  Add-Result 'official-bicep-guarded-env' $(if ($guardErrors.Count -eq 0) { 'PASS' } else { 'FAIL' }) $(if ($guardErrors.Count) { $guardErrors -join ', ' } else { 'Reserved values match the approved five-app template.' })
} else { Add-Result 'official-bicep-guarded-env' 'UNAVAILABLE' 'Official Bicep template is not present at the supplied local path; effective bootstrap cannot PASS.' }

$runtime = @{}
foreach ($service in $services) { $runtime[$service] = Get-AppEnvironment $manifest $service }
$sourceSha = [string](Get-ParameterValue $manifest 'sourceSha')
$digests = Get-ParameterValue $manifest 'imageDigests'
$releaseOk = $sourceSha -cmatch '^[a-f0-9]{40}$'
foreach ($service in $services) { if ([string]$digests.$service -cnotmatch '^sha256:[a-f0-9]{64}$') { $releaseOk = $false } }
Add-Result 'final-release-sha-and-five-digests' $(if ($releaseOk) { 'PASS' } else { 'PENDING' }) 'Requires official release SHA and immutable digests.'

$releaseProvenanceStatus = 'NOT_RUN'
$releaseProvenanceDetail = 'Public GitHub source and successful master push CI were not checked.'
if ($allowExternal -and $releaseOk) {
  try {
    $github = 'https://api.github.com/repos/Taller-SW-Web/G6-Productos-Ofertas-backend'
    $headers = @{ Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28' }
    $masterEvidence = Invoke-RestMethod -Uri "$github/commits/master" -Headers $headers -TimeoutSec 20
    $runEvidence = Invoke-RestMethod -Uri "$github/actions/runs?head_sha=$sourceSha&event=push&status=completed" -Headers $headers -TimeoutSec 20
    $validRun = @($runEvidence.workflow_runs | Where-Object { $_.path -ceq '.github/workflows/ci.yml' -and $_.head_sha -ceq $sourceSha -and $_.event -ceq 'push' -and $_.head_branch -ceq 'master' -and $_.status -ceq 'completed' -and $_.conclusion -ceq 'success' }).Count -gt 0
    if ($masterEvidence.sha -ceq $sourceSha -and $validRun) { $releaseProvenanceStatus='PASS'; $releaseProvenanceDetail='SHA is current official master and has successful CI push evidence.' }
    else { $releaseProvenanceStatus='INVALID'; $releaseProvenanceDetail='Release SHA is not current official master or lacks successful CI push evidence.' }
  } catch { $releaseProvenanceStatus='UNAVAILABLE'; $releaseProvenanceDetail='Public GitHub provenance could not be verified.' }
}
Add-Result 'release-source-provenance' $releaseProvenanceStatus $releaseProvenanceDetail

$gateway = $runtime['api-gateway']
$promotion = $runtime['promotions-svc']
$issuer = [string]$gateway.AUTH_ISSUER
$discoveryUrl = 'https://g7-auth-service.onrender.com/api/v1/auth/.well-known/openid-configuration'
$jwksUrl = [string]$gateway.AUTH_JWKS_URL
$g7Config = @(
  @([string]$gateway.AUTH_ISSUER,[string]$gateway.AUTH_JWKS_URL),
  @([string]$runtime['catalog-svc'].SECURITY_ISSUER,[string]$runtime['catalog-svc'].SECURITY_JWKS_URL),
  @([string]$runtime['inventory-svc'].G7_JWT_ISSUER,[string]$runtime['inventory-svc'].G7_JWT_JWKS_URL),
  @([string]$runtime['pricing-svc'].AUTH_ISSUER,[string]$runtime['pricing-svc'].AUTH_JWKS_URL),
  @([string]$promotion.AUTH_ISSUER,[string]$promotion.AUTH_JWKS_URL)
)
$g7ParserConfigOk = $true
foreach ($pair in $g7Config) { if ($pair[0] -cne 'https://g7-auth-service.onrender.com/api/v1/auth' -or $pair[1] -cne 'https://g7-auth-service.onrender.com/api/v1/auth/.well-known/jwks.json') { $g7ParserConfigOk = $false } }
Add-Result 'g7-five-service-parser-configuration' $(if ($g7ParserConfigOk) { 'PASS' } else { 'INVALID' }) 'Issuer/JWKS values checked against the recognized parser keys for all five services.'
$discoveryOk = $false
$jwksOk = $false
try {
  if ($allowExternal -and (Is-HttpsUrl $discoveryUrl) -and (Is-HttpsUrl $jwksUrl)) {
    $discovery = Invoke-RestMethod -Uri $discoveryUrl -Method Get -TimeoutSec 20
    $jwks = Invoke-RestMethod -Uri $jwksUrl -Method Get -TimeoutSec 20
    $discoveryOk = $discovery.issuer -ceq $issuer -and $discovery.jwks_uri -ceq $jwksUrl
    $jwksOk = @($jwks.keys).Count -gt 0
  }
} catch { }
Add-Result 'g7-discovery-issuer-and-jwks' $(if (-not $allowExternal) { 'NOT_RUN' } elseif ($discoveryOk -and $jwksOk) { 'PASS' } else { 'UNAVAILABLE' }) 'Public metadata only; no token or grant is inferred.'

$contractScopes = @()
$openApiText = ''
if (($Mode -eq 'H5_INTEGRATION' -or $ProbeG7Token) -and $allowExternal) {
  $docsRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\docs'))
  try {
    $openApiText = (git -C $docsRepo show 'origin/master:contratos/http/openapi.yaml' 2>$null) -join "`n"
    if ($LASTEXITCODE -eq 0) { $contractScopes = @(Get-H5ContractScopes $openApiText) }
  } catch { $contractScopes = @(); $openApiText = '' }
}

$promotionsSecret = Get-AppSecret $manifest 'promotions-svc' 'promotions-svc-client-secret'
$clientSecretAvailable = -not [string]::IsNullOrWhiteSpace($promotionsSecret)
Add-Result 'g7-promotions-svc-client-secret' $(if ($clientSecretAvailable) { 'AVAILABLE' } else { 'EXTERNAL_DEPENDENCY' }) 'Client ID is promotions-svc; api-productos and api-ventas tokens are evaluated separately.'
$requiredOperations = @(Get-H5PromotionsRequiredOperations)
$contractOperationScopes = Get-H5ContractOperationScopes $openApiText
$requiredScopes = @($requiredOperations | ForEach-Object scope | Sort-Object -Unique)
$missingContractScopes = @($requiredScopes | Where-Object { $_ -notin $contractScopes })
$knownRouteScopesOk = $true
foreach ($item in $requiredOperations | Where-Object { $_.contractOperationId }) {
  if ($contractOperationScopes[$item.contractOperationId] -cne $item.scope) { $knownRouteScopesOk = $false }
}
Add-Result 'promotions-required-scopes-contract' $(if (-not $allowExternal -or -not $openApiText) { 'NOT_RUN' } elseif (-not $knownRouteScopesOk) { 'INVALID' } elseif ($missingContractScopes.Count) { 'MISSING' } else { 'PASS' }) $(if ($missingContractScopes.Count) { 'Contract is missing operation scopes: ' + ($missingContractScopes -join ', ') } else { 'Scopes are mapped from Promotions internalOperations to current OpenAPI operationId/x-required-scope.' })
$scopeTokens = [System.Collections.Generic.List[object]]::new()
if ($runG7Tokens -and $discoveryOk -and $g7ParserConfigOk -and $openApiText) {
  foreach ($scopeGroup in @($requiredOperations | Group-Object audience,scope,credential)) {
    $entry = $scopeGroup.Group[0]
    $tokenSecret = Get-AppSecret $manifest 'promotions-svc' $entry.credential
    $tokenResult = [pscustomobject]@{ TokenStatus='NOT_RUN'; ScopeStatus='AUTHORIZATION_NOT_RUN'; Scopes=@(); Audience=$entry.audience; Scope=$entry.scope }
    if ($entry.scope -in $contractScopes -and -not [string]::IsNullOrWhiteSpace($tokenSecret)) {
      $tokenResponse = $null; $jwt = $null; $body = $null
      try {
        $body = @{ grant_type='client_credentials'; client_id='promotions-svc'; client_secret=$tokenSecret; scope=$entry.scope }
        $tokenResponse = Invoke-RestMethod -Uri 'https://g7-auth-service.onrender.com/api/v1/auth/token' -Method Post -ContentType 'application/x-www-form-urlencoded' -Body $body -TimeoutSec 20
        $jwt = [string]$tokenResponse.accessToken
        $tokenCheck = Test-H5JwtAuthenticity $jwt $jwks $issuer 'promotions-svc' $entry.audience
        $tokenResult.TokenStatus = if ($tokenResponse.tokenType -ceq 'Bearer') { $tokenCheck.Status } else { 'TOKEN_INVALID' }
        $responseScopes = @($tokenResponse.scopes | Where-Object { $_ -is [string] })
        $tokenResult.ScopeStatus = if ($responseScopes -contains $entry.scope -and $tokenCheck.Scopes -contains $entry.scope) { Test-H5JwtRequiredScopes $tokenResult.TokenStatus $tokenCheck.Scopes @($entry.scope) $contractScopes } else { 'REQUIRED_SCOPES_MISSING' }
        $tokenResult.Scopes = if ($tokenResult.ScopeStatus -eq 'REQUIRED_SCOPES_VERIFIED') { @($entry.scope) } else { @() }
      } catch { $tokenResult.TokenStatus='AUTHORIZATION_NOT_RUN'; $tokenResult.ScopeStatus='AUTHORIZATION_NOT_RUN' }
      finally { $tokenResponse=$null; $jwt=$null; if ($body) { $body.client_secret=$null }; $body=$null; $tokenSecret=$null }
    }
    $scopeTokens.Add($tokenResult)
  }
}
$productRequiredScopes = @($requiredOperations | Where-Object audience -eq 'api-productos' | ForEach-Object scope | Sort-Object -Unique)
$salesRequiredScopes = @($requiredOperations | Where-Object audience -eq 'api-ventas' | ForEach-Object scope | Sort-Object -Unique)
$productTokenRows = @($scopeTokens | Where-Object Audience -eq 'api-productos')
$salesTokenRows = @($scopeTokens | Where-Object Audience -eq 'api-ventas')
$productTokenStatus = if ($productTokenRows.Count -gt 0 -and @($productTokenRows | Where-Object TokenStatus -ne 'TOKEN_VALID').Count -eq 0) { 'TOKEN_VALID' } elseif (@($productTokenRows | Where-Object TokenStatus -eq 'TOKEN_INVALID').Count -gt 0) { 'TOKEN_INVALID' } else { 'AUTHORIZATION_NOT_RUN' }
$salesTokenStatus = if ($salesTokenRows.Count -gt 0 -and @($salesTokenRows | Where-Object TokenStatus -ne 'TOKEN_VALID').Count -eq 0) { 'TOKEN_VALID' } elseif (@($salesTokenRows | Where-Object TokenStatus -eq 'TOKEN_INVALID').Count -gt 0) { 'TOKEN_INVALID' } else { 'AUTHORIZATION_NOT_RUN' }
$productAuth = if ($runG7Tokens) { Get-H5ScopeAuthorizationStatus $productTokenRows $productRequiredScopes $contractScopes } else { 'AUTHORIZATION_NOT_RUN' }
$salesAuth = if ($runG7Tokens) { Get-H5ScopeAuthorizationStatus $salesTokenRows $salesRequiredScopes $contractScopes } else { 'AUTHORIZATION_NOT_RUN' }
Add-Result 'promotions-token-api-productos' $productTokenStatus 'JWT signature, issuer, expiry, audience and client are checked; token suppressed.'
Add-Result 'promotions-required-scopes-api-productos' $productAuth 'All required api-productos operation scopes must be present in verified operation token results and current OpenAPI.'
Add-Result 'promotions-token-api-ventas' $salesTokenStatus 'Dedicated api-ventas audience/client token is checked independently; token suppressed.'
Add-Result 'promotions-required-scopes-api-ventas' $salesAuth 'Ventas scope is checked independently; api-productos token is never substituted.'

$gatewayUpstreams = @('GATEWAY_CATALOG_SVC_URL','GATEWAY_INVENTORY_SVC_URL','GATEWAY_PRICING_SVC_URL','GATEWAY_PROMOTIONS_SVC_URL')
$environmentDomainStatus = 'NOT_RUN'
if (-not $EnvironmentDefaultDomain -and $allowExternal) {
  try {
    $environmentName = [string](Get-ParameterValue $manifest 'environmentName')
    $environmentOutput = az containerapp env show --resource-group rg-g6-sb-h5-int-fork --name $environmentName -o json 2>$null | Out-String
    if ($LASTEXITCODE -eq 0) { $EnvironmentDefaultDomain = [string](($environmentOutput | ConvertFrom-Json).properties.defaultDomain); $environmentDomainStatus = if ($EnvironmentDefaultDomain) { 'PASS' } else { 'UNAVAILABLE' } }
    else { $environmentDomainStatus = 'UNAVAILABLE' }
  } catch { $environmentDomainStatus = 'UNAVAILABLE' }
} elseif ($EnvironmentDefaultDomain) { $environmentDomainStatus = 'CONFIGURED' }
Add-Result 'azure-environment-private-domain' $environmentDomainStatus 'Default domain retrieved from the existing managed environment; value suppressed.'
$upstreamStatus = 'PASS'
foreach ($index in 0..($gatewayUpstreams.Count - 1)) {
  $name = $gatewayUpstreams[$index]
  $value = [string]$gateway[$name]
  $target = @('catalog-svc','inventory-svc','pricing-svc','promotions-svc')[$index]
  $expected = if ($EnvironmentDefaultDomain) { "https://${target}.internal.${EnvironmentDefaultDomain}" } else { '' }
  if (-not (Is-HttpsUrl $value) -or ([uri]$value).AbsolutePath -ne '/' -or -not $expected -or $value -cne $expected) {
    if ($environmentDomainStatus -eq 'UNAVAILABLE' -or -not $expected) { $upstreamStatus = 'UNAVAILABLE' }
    elseif ([string]::IsNullOrWhiteSpace($value)) { $upstreamStatus = 'PENDING' }
    else { $upstreamStatus = 'INVALID' }
  }
}
Add-Result 'gateway-four-private-https-upstreams' $upstreamStatus 'All four configured values must exactly match https://<app>.internal.<environment-default-domain>; endpoints were not contacted.'
$pricingCatalogExpected = if ($EnvironmentDefaultDomain) { "https://catalog-svc.internal.${EnvironmentDefaultDomain}" } else { '' }
$pricingCatalogValue = [string]$runtime['pricing-svc'].PRICING_CATALOG_URL
Add-Result 'pricing-private-catalog-dependency' $(if ($pricingCatalogExpected -and $pricingCatalogValue -ceq $pricingCatalogExpected) { 'PASS' } elseif ($environmentDomainStatus -eq 'UNAVAILABLE' -or -not $pricingCatalogExpected) { 'UNAVAILABLE' } elseif ([string]::IsNullOrWhiteSpace($pricingCatalogValue)) { 'PENDING' } else { 'INVALID' }) 'PRICING_CATALOG_URL must match the Catalog origin in the isolated ACA environment.'

foreach ($service in @('catalog-svc','inventory-svc','pricing-svc','promotions-svc')) {
  $dbOk = $false
  $sqlEnvironment = $null
  $envMap = $runtime[$service]
  $required = switch ($service) {
    'catalog-svc' { @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLROOTCERT','G6_EXPECTED_ROLE','G6_CONNECTION_MODE') }
    'inventory-svc' { @('PGHOST','PGDATABASE','PGUSER','PGPASSWORD','PGSSLROOTCERT') }
    'pricing-svc' { @('DATABASE_URL','PGSSLROOTCERT') }
    'promotions-svc' { @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLROOTCERT') }
  }
  $missing = @($required | Where-Object { -not (Has-Value $envMap $_) })
  $tlsOk = switch ($service) {
    'catalog-svc' { [string]$envMap.PGSSLMODE -ceq 'verify-full' }
    'inventory-svc' { [string]$envMap.PGSSLMODE -ceq 'verify-full' }
    'pricing-svc' { ([string]$envMap.DATABASE_URL -match '[?&]sslmode=verify-full(?:&|$)') -and [string]$envMap.PGSSLMODE -ceq 'verify-full' }
    'promotions-svc' { [string]$envMap.PGSSLMODE -ceq 'verify-full' }
  }
  $caPath = [string]$envMap.PGSSLROOTCERT
  $caPem = Get-AppSecret $manifest $service 'postgres-ca'
  $caOk = $caPath -ceq '/etc/ssl/postgres/ca.crt' -and (Test-H5PemCertificate $caPem)
  $configStatus = if ($missing.Count -gt 0) { 'PENDING' } elseif (-not $tlsOk -or ($caPem -and -not (Test-H5PemCertificate $caPem))) { 'INVALID' } elseif (-not $caOk) { 'PENDING' } else { 'READY_TO_PROBE' }
  $detail = if ($missing.Count) { 'Missing: ' + ($missing -join ', ') } elseif (-not $tlsOk) { 'TLS must be verify-full with the mounted CA path.' } elseif ($caPem -and -not (Test-H5PemCertificate $caPem)) { 'Private postgres-ca must be a valid X.509 certificate.' } elseif (-not $caOk) { 'Mounted ACA CA path or private X.509 postgres-ca secret is absent.' } else { 'Private PEM validated; local connection still requires verify-full probe.' }
  Add-Result ($service + '-postgres-configuration') $configStatus $detail

  if ($runPostgres -and $configStatus -eq 'READY_TO_PROBE') {
    $psql = Get-Command $PsqlPath -ErrorAction SilentlyContinue
    if (-not (Test-H5PsqlAvailable $PsqlPath)) {
      Add-Result ($service + '-postgres-readonly-login') 'NOT_RUN' 'psql is not installed; no database connection attempted.'
      if ($Mode -eq 'H5_INTEGRATION') { Add-Result ($service + '-h5-storage') 'NOT_RUN' 'psql unavailable; H5 migration and grant checks were not executed.' }
      continue
    }
    $schema = switch ($service) { 'catalog-svc' { 'catalog' } 'inventory-svc' { 'inventory' } 'pricing-svc' { 'pricing' } 'promotions-svc' { 'promotions' } }
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
      } catch { Add-Result ($service + '-postgres-readonly-login') 'INVALID' 'DATABASE_URL could not be parsed; contents suppressed.'; if ($Mode -eq 'H5_INTEGRATION') { Add-Result ($service + '-h5-storage') 'NOT_RUN' 'Invalid database URL blocked H5 migration/grant checks.' }; continue }
    }
    try {
      $psqlPath = if ($psql.Source) { $psql.Source } else { $psql.Path }
      $sqlEnvironment = @{ PGHOST=$hostName; PGHOSTADDR=[string]$envMap.G6_CONNECT_HOST; PGPORT=$port; PGDATABASE=$database; PGUSER=$user; PGPASSWORD=$password }
      $baseArgs = @('--no-psqlrc','--quiet','--tuples-only','--no-align','--set','ON_ERROR_STOP=1','--set',"schema=$schema",'--set',"expected_role=$role",'--set',"service=$service",'--file',(Join-Path $PSScriptRoot 'integration-readonly.sql'))
      $baseProbe = Invoke-H5ReadOnlySql $caPem $psqlPath $baseArgs $sqlEnvironment
      if ($baseProbe.ExitCode -ne 0) { Add-Result ($service + '-postgres-readonly-login') $baseProbe.Status 'Connection/TLS/read-only SQL failed; stderr and endpoint details suppressed.'; if ($Mode -eq 'H5_INTEGRATION') { Add-Result ($service + '-h5-storage') 'NOT_RUN' 'PostgreSQL login failed; H5 migration/grant checks were not executed.' }; continue }
      $diagnostic = ($baseProbe.Output -join '').Trim() | ConvertFrom-Json
      $roleOk = $diagnostic.expected_role_exists -and ($diagnostic.expected_role_inherited -or $diagnostic.login_role -eq $role)
      $dbOk = $diagnostic.ssl_in_use -and $diagnostic.database_connect -and $diagnostic.schema_exists -and $diagnostic.schema_usage -and $diagnostic.required_table_privileges -and $roleOk
      Add-Result ($service + '-postgres-readonly-login') $(if ($dbOk) { 'PASS' } elseif (-not $diagnostic.ssl_in_use) { 'FAIL' } else { 'MISSING' }) 'Read-only TLS, effective runtime role, database CONNECT, schema USAGE and service-required SELECT privileges checked; H5-specific tables are not included in HTTP bootstrap.'
      if ($Mode -eq 'H5_INTEGRATION') {
        if ($dbOk) {
          $storageProbe = Invoke-H5ReadOnlySql $caPem $psqlPath @('--no-psqlrc','--quiet','--tuples-only','--no-align','--set','ON_ERROR_STOP=1','--set',"service=$service",'--file',(Join-Path $PSScriptRoot 'h5-storage-readonly.sql')) $sqlEnvironment
          if ($storageProbe.ExitCode -eq 0) {
            $storage = ($storageProbe.Output -join '').Trim() | ConvertFrom-Json
            Add-Result ($service + '-h5-storage') $(if ($storage.ready) { 'PASS' } else { 'MISSING' }) 'Candidate migration relations and effective runtime SELECT/INSERT/UPDATE grants checked read-only.'
          } else { Add-Result ($service + '-h5-storage') $storageProbe.Status 'Read-only H5 storage/grant probe failed; details suppressed.' }
        } else { Add-Result ($service + '-h5-storage') 'NOT_RUN' 'PostgreSQL role/schema/privileges did not pass; H5 migration/grant checks were not executed.' }
      }
      if ($dbOk -and $service -in @('catalog-svc','inventory-svc','pricing-svc')) {
        $readinessFile = switch ($service) { 'catalog-svc' { 'catalog-http-readiness.sql' } 'inventory-svc' { 'inventory-http-readiness.sql' } 'pricing-svc' { 'pricing-http-readiness.sql' } }
        $readinessProbe = Invoke-H5ReadOnlySql $caPem $psqlPath @('--no-psqlrc','--quiet','--tuples-only','--no-align','--set','ON_ERROR_STOP=1','--file',(Join-Path $PSScriptRoot $readinessFile)) $sqlEnvironment
        if ($readinessProbe.ExitCode -eq 0) {
          $readiness = ($readinessProbe.Output -join '').Trim() | ConvertFrom-Json
          Add-Result ($service + '-http-readiness-schema') $(if ($readiness.ready) { 'PASS' } else { 'MISSING' }) 'Checks only the service HTTP runtime readiness relations/columns/constraints.'
        } else { Add-Result ($service + '-http-readiness-schema') $readinessProbe.Status 'Read-only HTTP schema check failed; details suppressed.' }
      } elseif ($dbOk) { Add-Result ($service + '-http-readiness-schema') 'NOT_RUN' 'No additional always-on relation contract is enforced by the Promotions HTTP bootstrap.' }
    } catch { Add-Result ($service + '-postgres-readonly-login') 'FAIL' 'Read-only SQL diagnostics failed; error details suppressed.' }
    finally { $password = $null; if ($sqlEnvironment) { $sqlEnvironment.PGPASSWORD = $null } }
  } elseif ($runPostgres) {
    Add-Result ($service + '-postgres-readonly-login') 'NOT_RUN' 'PostgreSQL connection was blocked by incomplete or invalid runtime configuration.'
    if ($service -in @('catalog-svc','inventory-svc','pricing-svc')) { Add-Result ($service + '-http-readiness-schema') 'NOT_RUN' 'Readiness SQL was not executed because PostgreSQL login was not verified.' }
  } else {
    Add-Result ($service + '-postgres-readonly-login') 'NOT_RUN' 'PostgreSQL connection probe was not requested.'
    if ($service -in @('catalog-svc','inventory-svc','pricing-svc')) { Add-Result ($service + '-http-readiness-schema') 'NOT_RUN' 'Readiness SQL was not executed.' }
  }
  $h5Table = switch ($service) { 'catalog-svc' { 'catalog.outbox_delivery + taxonomy reply trigger' } 'inventory-svc' { 'inventory.outbox_delivery' } 'pricing-svc' { 'pricing.outbox_delivery' } 'promotions-svc' { 'promotions.h5_coupon_operations + h5_coupon_outbox' } }
  $h5Active = switch ($service) {
    'catalog-svc' { [string]$envMap.MESSAGING_PROVIDER -ceq 'AZURE_SERVICE_BUS' }
    'inventory-svc' { [string]$envMap.MESSAGING_PROVIDER -ceq 'AZURE_SERVICE_BUS' }
    'pricing-svc' { [string]$guardedValues['pricing-svc'].PRICING_PRICE_CHANGED_PUBLISH_ENABLED -ceq 'true' }
    'promotions-svc' { [string]$guardedValues['promotions-svc'].PROMOTIONS_H5_COUPON_COMMANDS_ENABLED -ceq 'true' -or [string]$guardedValues['promotions-svc'].PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED -ceq 'true' }
  }
  if ($Mode -eq 'H5_INTEGRATION') {
    if (@($results | Where-Object Check -eq ($service + '-h5-storage')).Count -eq 0) { Add-Result ($service + '-h5-storage') 'NOT_RUN' 'H5 migration and grant checks require a verified PostgreSQL runtime login.' }
  } else {
    Add-Result ($service + '-h5-storage') (Test-H5OptionalMessagingTable $service ([bool]$h5Active) $false) $(if ($h5Active) { "Requires separate exact runtime/migration check: $h5Table." } else { "Not required for HTTP-only bootstrap: $h5Table." })
  }
}

$flagsOk = $null -ne $guardedValues -and
  [string]$guardedValues['api-gateway'].G6_SECURITY_MODE -ceq 'G7_AUTHENTICATED' -and
  [string]$guardedValues['api-gateway'].GATEWAY_DEMO_NO_AUTH_ENABLED -ceq 'false' -and
  [string]$gateway.GATEWAY_PUBLIC_OPERATION_IDS -ceq '' -and
  [string]$guardedValues['pricing-svc'].PRICING_PRICE_CHANGED_PUBLISH_ENABLED -ceq 'false' -and
  [string]$guardedValues['promotions-svc'].PROMOTIONS_COUPON_RUNTIME_ENABLED -ceq 'false' -and
  [string]$guardedValues['promotions-svc'].PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED -ceq 'false' -and
  [string]$guardedValues['promotions-svc'].PROMOTIONS_H5_COUPON_COMMANDS_ENABLED -ceq 'false' -and
  [string]$runtime['inventory-svc'].INVENTORY_PUBLIC_OPERATION_IDS -ceq '' -and
  [string]$runtime['pricing-svc'].PRICING_PUBLIC_OPERATION_IDS -ceq '' -and
  [string]$promotion.PROMOTIONS_DEPENDENCY_PROBES_ENABLED -ceq 'false'
Add-Result 'first-bootstrap-closed-flags' $(if (-not $flagsOk) { 'FAIL' } elseif (-not $manifestValid) { 'PENDING' } else { 'PASS' }) 'Commercial H5, fan-out and demo/public bypasses remain closed; PASS requires a complete #263-compatible manifest.'

$messageVariables = @{
  'catalog-svc' = @('MESSAGING_PROVIDER','SERVICE_BUS_NAMESPACE_FQDN','AZURE_CLIENT_ID','G6_SECURITY_MODE','G6_SERVICE_BUS_PRODUCTION_ENABLED')
  'inventory-svc' = @('MESSAGING_PROVIDER','SERVICE_BUS_NAMESPACE_FQDN','AZURE_CLIENT_ID','G6_SECURITY_MODE','G6_SERVICE_BUS_PILOT_ENABLED','G6_SERVICE_BUS_PRODUCTION_ENABLED','INVENTORY_SERVICE_BUS_PUBLISH_ENABLED','INVENTORY_SERVICE_BUS_CONSUME_ENABLED')
  'pricing-svc' = @('MESSAGING_PROVIDER','SERVICE_BUS_NAMESPACE_FQDN','AZURE_CLIENT_ID','G6_SECURITY_MODE','G6_SERVICE_BUS_PILOT_ENABLED','G6_SERVICE_BUS_PRODUCTION_ENABLED','PRICING_PRICE_CHANGED_PUBLISH_ENABLED')
  'promotions-svc' = @('MESSAGING_PROVIDER','SERVICE_BUS_NAMESPACE_FQDN','AZURE_CLIENT_ID','G6_SECURITY_MODE','G6_SERVICE_BUS_PRODUCTION_ENABLED','PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED','PROMOTIONS_H5_COUPON_COMMANDS_ENABLED')
}
$messagingMissing = [System.Collections.Generic.List[string]]::new()
$messagingInvalid = [System.Collections.Generic.List[string]]::new()
foreach ($service in $messageVariables.Keys) {
  $effective = @{}
  foreach ($name in $runtime[$service].Keys) { $effective[$name] = [string]$runtime[$service][$name] }
  $guardedService = if ($null -ne $guardedValues -and $guardedValues.ContainsKey($service)) { $guardedValues[$service] } else { @{} }
  foreach ($name in $guardedService.Keys) { $effective[$name] = [string]$guardedService[$name] }
  foreach ($name in $messageVariables[$service]) {
    $expectedValue = switch ($name) {
      'MESSAGING_PROVIDER' { 'AZURE_SERVICE_BUS' }
      'SERVICE_BUS_NAMESPACE_FQDN' { if ($null -ne $guardedValues) { [string]$guardedValues['promotions-svc'].SERVICE_BUS_NAMESPACE_FQDN } else { '' } }
      'AZURE_CLIENT_ID' { [string]$manifest.parameters.promotionsIdentityClientId.value }
      'G6_SECURITY_MODE' { 'G7_AUTHENTICATED' }
      'G6_SERVICE_BUS_PILOT_ENABLED' { 'true' }
      'G6_SERVICE_BUS_PRODUCTION_ENABLED' { 'true' }
      'INVENTORY_SERVICE_BUS_PUBLISH_ENABLED' { 'true' }
      'INVENTORY_SERVICE_BUS_CONSUME_ENABLED' { 'true' }
      'PRICING_PRICE_CHANGED_PUBLISH_ENABLED' { 'true' }
      'PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED' { 'true' }
      'PROMOTIONS_H5_COUPON_COMMANDS_ENABLED' { 'true' }
    }
    if (-not $effective.ContainsKey($name) -or [string]::IsNullOrWhiteSpace([string]$effective[$name])) { $messagingMissing.Add("$service.$name") }
    elseif ([string]$effective[$name] -cne $expectedValue) { $messagingInvalid.Add("$service.$name") }
  }
  if ($runtime[$service].ContainsKey('RABBITMQ_URL') -or $runtime[$service].ContainsKey('CATALOG_AMQP_ENABLED')) { $messagingInvalid.Add("$service.incompatible-broker") }
}
$messagingStatus = if ($messagingInvalid.Count) { 'INVALID' } elseif ($messagingMissing.Count) { 'PENDING' } else { 'PASS' }
$messagingDetail = if ($messagingInvalid.Count) { 'Unexpected runtime messaging configuration: ' + ($messagingInvalid -join ', ') } elseif ($messagingMissing.Count) { 'Required H5 parser variables are absent or not enabled: ' + ($messagingMissing -join ', ') } else { 'All four service messaging parsers are configured for the approved Azure Service Bus namespace and runtime identity.' }
Add-Result 'h5-messaging-runtime-configuration' $messagingStatus $messagingDetail

$registryUsername = [string](Get-ParameterValue $manifest 'registryUsername')
$ghcrComplete = $true
foreach ($service in $services) { if (-not (Get-AppSecret $manifest $service 'ghcr-pull')) { $ghcrComplete = $false } }
Add-Result 'ghcr-pull-least-privilege-credential' $(if ($ghcrComplete -and $registryUsername) { 'AVAILABLE' } else { 'NOT_RUN' }) 'Only a dedicated read-only read:packages credential may be used; gh CLI credentials are never reused.'
$sourceSha = [string](Get-ParameterValue $manifest 'sourceSha')
$digests = Get-ParameterValue $manifest 'imageDigests'
foreach ($service in $services) {
  $state = 'NOT_RUN'; $detail = 'Supply a final release SHA/digest and dedicated ghcr-pull credential to verify this package.'
if ($runGhcr -and $ghcrComplete -and $registryUsername) {
    $digest = [string]$digests.$service
    $registryToken = $null; $credential = $null
    try {
      $repository = "taller-sw-web/g6-productos-ofertas-backend/$service"
      $credential = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($registryUsername + ':' + (Get-AppSecret $manifest $service 'ghcr-pull')))
      $tokenResponse = Invoke-WebRequest -Uri "https://ghcr.io/token?scope=repository:${repository}:pull" -Headers @{ Authorization="Basic $credential" } -Method Get -TimeoutSec 20 -SkipHttpErrorCheck
      if ($tokenResponse.StatusCode -in @(401,403,404)) { $state='NO_VISIBILITY' }
      elseif ($tokenResponse.StatusCode -ne 200) { $state='UNAVAILABLE' }
      else {
        $registryToken = ($tokenResponse.Content | ConvertFrom-Json).token
        if ($sourceSha -notmatch '^[a-f0-9]{40}$' -or $digest -notmatch '^sha256:[a-f0-9]{64}$') {
          $state = Get-H5GhcrReleaseStatus 'VISIBLE' $sourceSha '' $false
          $detail = 'Registry grants pull visibility; exact official release SHA/digest are not available.'
        } else {
          $manifestResponse = Invoke-WebRequest -Uri "https://ghcr.io/v2/${repository}/manifests/${digest}" -Headers @{ Authorization="Bearer $registryToken"; Accept='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' } -Method Get -TimeoutSec 20 -SkipHttpErrorCheck
          if ($manifestResponse.StatusCode -eq 404) { $state='MISSING_FOR_RELEASE_SHA' }
          elseif ($manifestResponse.StatusCode -in @(401,403)) { $state='NO_VISIBILITY' }
          elseif ($manifestResponse.StatusCode -ne 200) { $state='UNAVAILABLE' }
          else {
            $actualDigest = [string]$manifestResponse.Headers['docker-content-digest']
            $imageManifest = $manifestResponse.Content | ConvertFrom-Json
            $configResponse = Invoke-WebRequest -Uri "https://ghcr.io/v2/${repository}/blobs/$($imageManifest.config.digest)" -Headers @{ Authorization="Bearer $registryToken" } -Method Get -TimeoutSec 20 -SkipHttpErrorCheck
            $packageSha = ''
            $digestVerified = $actualDigest -ceq $digest -and $configResponse.StatusCode -eq 200
            if ($digestVerified) {
              $labels = ($configResponse.Content | ConvertFrom-Json).config.Labels
              $packageSha = [string]$labels.'org.opencontainers.image.revision'
              $digestVerified = $packageSha -ceq $sourceSha -and $labels.'org.opencontainers.image.source' -ceq 'https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend' -and $labels.'org.opencontainers.image.title' -ceq $service
            }
            $state = Get-H5GhcrReleaseStatus 'VISIBLE' $sourceSha $packageSha $digestVerified
          }
        }
      }
    } catch { $state='UNAVAILABLE' }
    finally { $registryToken = $null; $credential = $null }
  }
  Add-Result ("ghcr-$service") $state $detail
}

if (-not $allowExternal) {
  Add-Result 'azure-isolated-container-apps' 'NOT_RUN' 'Network probes disabled for tests.'
  Add-Result 'promotions-managed-identity-and-servicebus-parameters' 'NOT_RUN' 'Network probes disabled for tests.'
  Add-Result 'promotions-servicebus-queue-rbac' 'NOT_RUN' 'Queue scope was not queried.'
} else {
  try {
    $appsOutput = az containerapp list --resource-group rg-g6-sb-h5-int-fork -o json 2>$null | Out-String
    if ($LASTEXITCODE -eq 0) { $apps = @($appsOutput | ConvertFrom-Json); Add-Result 'azure-isolated-container-apps' 'READ_ONLY_CHECKED' ("Count=$($apps.Count); no writes performed.") }
    else { Add-Result 'azure-isolated-container-apps' 'UNAVAILABLE' 'Read-only resource query failed.' }
  } catch { Add-Result 'azure-isolated-container-apps' 'UNAVAILABLE' 'Azure CLI query failed; no writes performed.' }
  try {
    $queueOutput = az servicebus queue show --resource-group rg-g6-sb-h5-int-fork --namespace-name g6-sb-h5-int-32cdqgbnlk7ow --name g6.promotions.commands -o json 2>$null | Out-String
    $queueExit = $LASTEXITCODE
    if ($queueExit -eq 0) {
      $queue = $queueOutput | ConvertFrom-Json
      $namespaceOutput = az servicebus namespace show --resource-group rg-g6-sb-h5-int-fork --name g6-sb-h5-int-32cdqgbnlk7ow -o json 2>$null | Out-String
      $namespaceExit = $LASTEXITCODE
      $identityOutput = az identity show --resource-group rg-g6-sb-h5-int-fork --name g6-h5-int-promotions -o json 2>$null | Out-String
      $identityExit = $LASTEXITCODE
      if ($namespaceExit -ne 0 -or $identityExit -ne 0) { throw 'Azure metadata unavailable' }
      $namespace = $namespaceOutput | ConvertFrom-Json; $identity = $identityOutput | ConvertFrom-Json
      $namespaceHost = ([uri]$namespace.serviceBusEndpoint).Host
      $expectedHost = [string]$guardedValues['promotions-svc'].SERVICE_BUS_NAMESPACE_FQDN
      $paramsOk = $namespace.sku.name -ceq 'Basic' -and $namespaceHost -ceq $expectedHost -and $identity.id -ceq [string]$manifest.parameters.promotionsIdentityResourceId.value -and $identity.clientId -ceq [string]$manifest.parameters.promotionsIdentityClientId.value -and $queue.id -match '/queues/g6\.promotions\.commands$'
      Add-Result 'promotions-managed-identity-and-servicebus-parameters' $(if ($paramsOk -and $queue.status -ceq 'Active') { 'PASS' } else { 'FAIL' }) 'Existing identity and exact active queue metadata checked read-only.'
      $roleOutput = az role assignment list --scope $queue.id --include-inherited -o json 2>$null | Out-String
      if ($LASTEXITCODE -eq 0) {
        $roles = @(($roleOutput | ConvertFrom-Json | Where-Object { $_.principalId -ceq $identity.principalId }).roleDefinitionName)
        $rbacState = Get-H5QueueRbacStatus 'PASS' $roles
        Add-Result 'promotions-servicebus-queue-rbac' $rbacState 'Data Sender and Data Receiver checked on the exact queue scope, including inherited assignments.'
      } else { Add-Result 'promotions-servicebus-queue-rbac' (Get-H5QueueRbacStatus 'UNAVAILABLE' @()) 'Queue-scope assignment query failed; no absence is inferred.' }
    } else {
      Add-Result 'promotions-managed-identity-and-servicebus-parameters' 'UNAVAILABLE' 'Read-only identity or queue lookup failed.'
      Add-Result 'promotions-servicebus-queue-rbac' (Get-H5QueueRbacStatus 'UNAVAILABLE' @()) 'Queue ID could not be obtained; no absence is inferred.'
    }
  } catch {
    Add-Result 'promotions-managed-identity-and-servicebus-parameters' 'UNAVAILABLE' 'Azure identity/queue metadata failed; no writes performed.'
    Add-Result 'promotions-servicebus-queue-rbac' (Get-H5QueueRbacStatus 'UNAVAILABLE' @()) 'Queue RBAC query unavailable; no absence is inferred.'
  }
}

Write-FinalResult $sourceSha
