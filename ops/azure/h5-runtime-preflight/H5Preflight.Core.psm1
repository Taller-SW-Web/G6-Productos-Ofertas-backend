$script:Services = @('api-gateway','catalog-svc','inventory-svc','pricing-svc','promotions-svc')
$script:RequiredEnv = @{
  'api-gateway' = @('AUTH_ISSUER','AUTH_JWKS_URL','GATEWAY_CATALOG_SVC_URL','GATEWAY_INVENTORY_SVC_URL','GATEWAY_PRICING_SVC_URL','GATEWAY_PROMOTIONS_SVC_URL')
  'catalog-svc' = @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','G6_DATABASE_SCHEMA','G6_EXPECTED_ROLE','G6_CONNECTION_MODE','SECURITY_ISSUER','SECURITY_DISCOVERY_URL','SECURITY_JWKS_URL')
  'inventory-svc' = @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','G7_JWT_ISSUER','G7_JWT_JWKS_URL')
  'pricing-svc' = @('DATABASE_URL','PGSSLROOTCERT','AUTH_ISSUER','AUTH_JWKS_URL','PRICING_CATALOG_URL')
  'promotions-svc' = @('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT','G6_DATABASE_SCHEMA','G6_CONNECTION_MODE','AUTH_ISSUER','AUTH_JWKS_URL')
}
$script:ExpectedGuardedEnv = @{
  'api-gateway' = [ordered]@{ NODE_ENV='production'; API_GATEWAY_PORT='3000'; G6_SECURITY_MODE='G7_AUTHENTICATED'; GATEWAY_DEMO_NO_AUTH_ENABLED='false'; GATEWAY_G5_H5_ENABLED='false' }
  'catalog-svc' = [ordered]@{ NODE_ENV='production'; CATALOG_SVC_PORT='3001' }
  'inventory-svc' = [ordered]@{ NODE_ENV='production'; INVENTORY_SVC_PORT='3005'; G6_SECURITY_MODE='G7_AUTHENTICATED'; INVENTORY_DEMO_NO_AUTH_ENABLED='false'; INVENTORY_CATALOG_SKU_DEACTIVATION_ENABLED='false' }
  'pricing-svc' = [ordered]@{ NODE_ENV='production'; PRICING_SVC_PORT='3002'; G6_SECURITY_MODE='G7_AUTHENTICATED'; PRICING_PRICE_CHANGED_PUBLISH_ENABLED='false' }
  'promotions-svc' = [ordered]@{ NODE_ENV='production'; PROMOTIONS_SVC_PORT='3004'; G6_SECURITY_MODE='G7_AUTHENTICATED'; PROMOTIONS_COUPON_RUNTIME_ENABLED='false'; PROMOTIONS_H5_COUPON_COMMANDS_ENABLED='false'; MESSAGING_PROVIDER='AZURE_SERVICE_BUS'; SERVICE_BUS_NAMESPACE_FQDN='g6-sb-h5-int-32cdqgbnlk7ow.servicebus.windows.net'; PROMOTIONS_SERVICE_BUS_EVENTS_ENABLED='false'; G6_SERVICE_BUS_PRODUCTION_ENABLED='true'; AZURE_CLIENT_ID='promotionsIdentityClientId'; GATEWAY_DEMO_NO_AUTH_ENABLED='false' }
}

function Get-H5ReservedEnvironment {
  $all = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($service in $script:Services) { foreach ($name in $script:ExpectedGuardedEnv[$service].Keys) { [void]$all.Add($name) } }
  return $all
}

function Get-H5ObjectKeys($Object) {
  if ($null -eq $Object) { return @() }
  if ($Object -is [System.Collections.IDictionary]) { return @($Object.Keys | ForEach-Object { [string]$_ }) }
  return @($Object.PSObject.Properties.Name)
}

function Test-H5ManifestEnvironment($Document) {
  $errors = [System.Collections.Generic.List[string]]::new()
  $apps = $Document.parameters.appConfiguration.value
  if (-not $apps) { return @('APP_CONFIGURATION_MISSING') }
  $actualServices = @(Get-H5ObjectKeys $apps | Sort-Object)
  $expectedServices = @($script:Services | Sort-Object)
  if (Compare-Object $expectedServices $actualServices) { $errors.Add('SERVICE_SET_CONFIGURATION') }
  $reserved = Get-H5ReservedEnvironment
  foreach ($service in $script:Services) {
    $app = $apps.$service
    if (-not $app -or $null -eq $app.env -or $null -eq $app.secrets) { $errors.Add("SERVICE_CONFIGURATION_MISSING_$service"); continue }
    $appKeys = @(Get-H5ObjectKeys $app | Sort-Object)
    if (Compare-Object @('env','secrets') $appKeys) { $errors.Add("CONFIGURATION_KEYS_INVALID_$service") }
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $secretNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($secret in $app.secrets) {
      $secretKeys = @(Get-H5ObjectKeys $secret | Sort-Object)
      if ((Compare-Object @('name','value') $secretKeys) -or [string]$secret.name -notmatch '^[a-z][a-z0-9-]{0,62}$' -or [string]$secret.name -ieq 'edge-config') { $errors.Add("SECRET_INVALID_$service") }
      if (-not $secretNames.Add([string]$secret.name)) { $errors.Add("SECRET_NAME_DUPLICATE_$service") }
    }
    foreach ($entry in $app.env) {
      $entryKeys = @(Get-H5ObjectKeys $entry | Sort-Object)
      $valueEntry = $entryKeys.Count -eq 2 -and (Compare-Object @('name','value') $entryKeys).Count -eq 0
      $secretEntry = $entryKeys.Count -eq 2 -and (Compare-Object @('name','secretRef') $entryKeys).Count -eq 0
      if (-not ($valueEntry -or $secretEntry) -or [string]$entry.name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { $errors.Add("ENVIRONMENT_INVALID_$service") }
      if ($reserved.Contains([string]$entry.name)) { $errors.Add("ENVIRONMENT_RESERVED_$service.$($entry.name)") }
      if (-not $seen.Add([string]$entry.name)) { $errors.Add("ENVIRONMENT_COLLISION_$service.$($entry.name)") }
      if ($secretEntry -and -not $secretNames.Contains([string]$entry.secretRef)) { $errors.Add("SECRET_REFERENCE_INVALID_$service") }
    }
    foreach ($name in $script:RequiredEnv[$service]) {
      if (-not $seen.Contains($name)) { $errors.Add("EFFECTIVE_CONFIGURATION_MISSING_$service.$name") }
    }
    foreach ($entry in $app.env) {
      if ($entry.name -ceq 'PGSSLROOTCERT' -and $entry.value -cne '/etc/ssl/postgres/ca.crt') { $errors.Add("ACA_CA_PATH_INVALID_$service") }
    }
    if ($service -ne 'api-gateway' -and -not (@($app.secrets | Where-Object { $_.name -ceq 'postgres-ca' }).Count -eq 1)) { $errors.Add("POSTGRES_CA_SECRET_MISSING_$service") }
    foreach ($entry in $app.env) {
      if ($entry.secretRef -and -not (@($app.secrets | Where-Object { $_.name -ceq $entry.secretRef }).Count)) { $errors.Add("SECRET_REFERENCE_MISSING_$service.$($entry.name)") }
    }
  }
  return @($errors)
}

function Test-H5ManifestCompleteness($Document) {
  $errors = [System.Collections.Generic.List[string]]::new()
  $emptyAllowed = @('GATEWAY_PUBLIC_OPERATION_IDS','INVENTORY_PUBLIC_OPERATION_IDS','PRICING_PUBLIC_OPERATION_IDS')
  $parameters = $Document.parameters
  if ([string]$parameters.sourceSha.value -notmatch '^[a-fA-F0-9]{40}$') { $errors.Add('SOURCE_SHA_PENDING') }
  foreach ($service in $script:Services) { if ([string]$parameters.imageDigests.value.$service -notmatch '^sha256:[a-f0-9]{64}$') { $errors.Add("IMAGE_DIGEST_PENDING_$service") } }
  foreach ($name in @('environmentLocation','promotionsIdentityResourceId','promotionsIdentityClientId','registryUsername')) { if ([string]::IsNullOrWhiteSpace([string]$parameters.$name.value)) { $errors.Add("PARAMETER_MISSING_$name") } }
  $apps = $parameters.appConfiguration.value
  foreach ($service in $script:Services) {
    $app = $apps.$service
    $secretNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($secret in $app.secrets) {
      if ([string]::IsNullOrWhiteSpace([string]$secret.value)) { $errors.Add("SECRET_VALUE_MISSING_$service.$($secret.name)") }
      [void]$secretNames.Add([string]$secret.name)
    }
    foreach ($entry in $app.env) {
      $value = if ($entry.secretRef) { @($app.secrets | Where-Object { $_.name -ieq $entry.secretRef } | Select-Object -First 1).value } else { [string]$entry.value }
      if ([string]::IsNullOrWhiteSpace([string]$value) -and $entry.name -notin $emptyAllowed) { $errors.Add("ENVIRONMENT_VALUE_MISSING_$service.$($entry.name)") }
    }
    $values = @{}
    foreach ($entry in $app.env) { $values[$entry.name] = if ($entry.secretRef) { [string](@($app.secrets | Where-Object { $_.name -ieq $entry.secretRef } | Select-Object -First 1).value) } else { [string]$entry.value } }
    if ($service -eq 'catalog-svc') {
      if ($values.G6_DATABASE_SCHEMA -cne 'catalog' -or $values.G6_EXPECTED_ROLE -notin @('catalog_app','catalog_dev_login') -or $values.G6_CONNECTION_MODE -notin @('session','direct')) { $errors.Add('CATALOG_POSTGRES_PARSER_VALUES_INVALID') }
      if ($values.PGUSER -and $values.G6_EXPECTED_ROLE -and $values.PGUSER.Split('.')[0] -cne $values.G6_EXPECTED_ROLE) { $errors.Add('CATALOG_RUNTIME_LOGIN_ROLE_MISMATCH') }
    }
    if ($service -eq 'inventory-svc' -and $values.PGSSLMODE -cne 'verify-full') { $errors.Add('INVENTORY_TLS_MODE_INVALID') }
    if ($service -eq 'pricing-svc') {
      if ($values.PGSSLMODE -cne 'verify-full' -or $values.PGSSLROOTCERT -cne '/etc/ssl/postgres/ca.crt') { $errors.Add('PRICING_TLS_CONFIGURATION_INVALID') }
      try { $dbUri = [uri]$values.DATABASE_URL; $dbQuery = $dbUri.Query.TrimStart('?'); if ($dbUri.Scheme -notin @('postgres','postgresql') -or $dbQuery -notmatch '(^|&)sslmode=verify-full(&|$)') { $errors.Add('PRICING_DATABASE_URL_TLS_INVALID') } } catch { $errors.Add('PRICING_DATABASE_URL_INVALID') }
    }
    if ($service -eq 'promotions-svc' -and ($values.PGSSLMODE -cne 'verify-full' -or $values.G6_DATABASE_SCHEMA -cne 'promotions' -or $values.G6_CONNECTION_MODE -cne 'session')) { $errors.Add('PROMOTIONS_POSTGRES_PARSER_VALUES_INVALID') }
    foreach ($pair in @(
      @('AUTH_ISSUER','https://g7-auth-service.onrender.com/api/v1/auth'),
      @('AUTH_JWKS_URL','https://g7-auth-service.onrender.com/api/v1/auth/.well-known/jwks.json'),
      @('SECURITY_ISSUER','https://g7-auth-service.onrender.com/api/v1/auth'),
      @('SECURITY_DISCOVERY_URL','https://g7-auth-service.onrender.com/api/v1/auth/.well-known/openid-configuration'),
      @('SECURITY_JWKS_URL','https://g7-auth-service.onrender.com/api/v1/auth/.well-known/jwks.json'),
      @('G7_JWT_ISSUER','https://g7-auth-service.onrender.com/api/v1/auth'),
      @('G7_JWT_JWKS_URL','https://g7-auth-service.onrender.com/api/v1/auth/.well-known/jwks.json'))
    ) { if ($values.ContainsKey($pair[0]) -and $values[$pair[0]] -and $values[$pair[0]] -cne $pair[1]) { $errors.Add("G7_PARSER_VALUE_INVALID_$service.$($pair[0])") } }
    if (-not $secretNames.Contains('ghcr-pull')) { $errors.Add("GHCR_SECRET_MISSING_$service") }
    if ($service -ne 'api-gateway') {
      $ca = @($app.secrets | Where-Object { $_.name -ieq 'postgres-ca' } | Select-Object -First 1).value
      if ([string]::IsNullOrWhiteSpace([string]$ca)) { $errors.Add("POSTGRES_CA_MISSING_$service") }
      elseif (-not (Test-H5PemCertificate ([string]$ca))) { $errors.Add("POSTGRES_CA_INVALID_$service") }
    }
  }
  return @($errors)
}

function Get-H5GuardedEnvironment([string]$BicepText) {
  $sectionMatch = [regex]::Match($BicepText, '(?s)var guardedEnv\s*=\s*\[(.*?)\]\s*var images')
  if (-not $sectionMatch.Success) { throw 'GUARDED_ENV_BLOCK_UNAVAILABLE' }
  $groups = [regex]::Matches($sectionMatch.Groups[1].Value, '(?ms)^\s{2}\[(.*?)^\s{2}\]')
  if ($groups.Count -ne $script:Services.Count) { throw 'GUARDED_ENV_SERVICE_COUNT_INVALID' }
  $result = @{}
  for ($i = 0; $i -lt $groups.Count; $i++) {
    $values = [ordered]@{}
    $entries = [regex]::Matches($groups[$i].Groups[1].Value, "\{\s*name:\s*'([^']+)',\s*value:\s*([^}\r\n]+)\s*\}")
    foreach ($entry in $entries) {
      $name = $entry.Groups[1].Value
      $raw = $entry.Groups[2].Value.Trim()
      if ($raw.StartsWith("'") -and $raw.EndsWith("'")) { $raw = $raw.Substring(1, $raw.Length - 2) }
      if ($values.Contains($name)) { throw "GUARDED_ENV_DUPLICATE_$($script:Services[$i]).$name" }
      $values[$name] = $raw
    }
    $result[$script:Services[$i]] = $values
  }
  return $result
}

function Test-H5GuardedEnvironment([string]$BicepText) {
  $errors = [System.Collections.Generic.List[string]]::new()
  try { $actual = Get-H5GuardedEnvironment $BicepText }
  catch { return @($_.Exception.Message) }
  foreach ($service in $script:Services) {
    $expected = $script:ExpectedGuardedEnv[$service]
    $found = $actual[$service]
    if ($found.Count -ne $expected.Count) { $errors.Add("GUARDED_ENV_KEYS_INVALID_$service"); continue }
    foreach ($name in $expected.Keys) {
      if (-not $found.Contains($name) -or [string]$found[$name] -cne [string]$expected[$name]) { $errors.Add("GUARDED_ENV_VALUE_INVALID_$service.$name") }
    }
  }
  return @($errors)
}

function Get-H5QueueRbacStatus([string]$QueryState, [string[]]$Roles) {
  if ($QueryState -eq 'NOT_RUN') { return 'NOT_RUN' }
  if ($QueryState -ne 'PASS') { return 'UNAVAILABLE' }
  if (($Roles -contains 'Azure Service Bus Data Sender') -and ($Roles -contains 'Azure Service Bus Data Receiver')) { return 'PASS' }
  return 'MISSING'
}

function Test-H5PsqlAvailable([string]$CommandName) {
  return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Get-H5GhcrReleaseStatus([string]$Visibility, [string]$ExpectedSha, [string]$PackageSha, [bool]$DigestVerified) {
  if ($Visibility -ne 'VISIBLE') { return 'NO_VISIBILITY' }
  if ($ExpectedSha -notmatch '^[a-f0-9]{40}$' -or $PackageSha -cne $ExpectedSha -or -not $DigestVerified) { return 'MISSING_FOR_RELEASE_SHA' }
  return 'VERIFIED'
}

function Get-H5ContractScopes([string]$OpenApiText) {
  return @([regex]::Matches($OpenApiText,'(?m)^\s*x-required-scope:\s*["'']?([A-Za-z0-9:_-]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
}

function Get-H5ContractOperationScopes([string]$OpenApiText) {
  $result = @{}
  $paths = [regex]::Matches($OpenApiText, '(?ms)^  (?<path>/[^\r\n]+):\r?\n(?<body>.*?)(?=^  /|\z)')
  foreach ($path in $paths) {
    $operations = [regex]::Matches($path.Groups['body'].Value, '(?ms)^    (?<method>get|post|put|patch|delete|options|head):\r?\n(?<body>.*?)(?=^    (?:get|post|put|patch|delete|options|head):|\z)')
    foreach ($operation in $operations) {
      $id = [regex]::Match($operation.Groups['body'].Value, '(?m)^      operationId:\s*["'']?([A-Za-z0-9_-]+)')
      $scope = [regex]::Match($operation.Groups['body'].Value, '(?m)^      x-required-scope:\s*["'']?([A-Za-z0-9:_-]+)')
      if ($id.Success -and $scope.Success) { $result[$id.Groups[1].Value] = $scope.Groups[1].Value }
    }
  }
  return $result
}

function Get-H5PromotionsRequiredOperations {
  return @(
    [pscustomobject]@{ operation='obtenerProducto'; contractOperationId='obtenerProducto'; audience='api-productos'; scope='catalogo:leer'; credential='promotions-service-client-secret' },
    [pscustomobject]@{ operation='obtenerContextoSku'; contractOperationId='obtenerContextoSku'; audience='api-productos'; scope='catalogo:leer'; credential='promotions-service-client-secret' },
    [pscustomobject]@{ operation='obtenerPrecioSku'; contractOperationId='obtenerPrecioSku'; audience='api-productos'; scope='precios:leer'; credential='promotions-service-client-secret' },
    [pscustomobject]@{ operation='consultarDisponibilidadComercial'; contractOperationId='consultarDisponibilidadComercial'; audience='api-productos'; scope='inventario:disponibilidad:leer'; credential='promotions-service-client-secret' },
    [pscustomobject]@{ operation='obtenerEvidenciaReservaCuponInterno'; contractOperationId='obtenerEvidenciaReservaCuponInterno'; audience='api-productos'; scope='inventario:reservas:estado:leer'; credential='promotions-svc-client-secret' },
    [pscustomobject]@{ operation='obtenerSnapshotCuponG5'; contractOperationId=''; audience='api-ventas'; scope='ventas:pedidos:evidencia-cupon:leer'; credential='promotions-svc-client-secret' },
    [pscustomobject]@{ operation='obtenerCategoriaAdmin'; contractOperationId='obtenerCategoriaAdmin'; audience='api-productos'; scope='catalogo:leer'; credential='promotions-service-client-secret' }
  )
}

function Test-H5JwtRequiredScopes([string]$TokenStatus, [string[]]$TokenScopes, [string[]]$RequiredScopes, [string[]]$ContractScopes) {
  if ($TokenStatus -ne 'TOKEN_VALID') { return 'AUTHORIZATION_NOT_RUN' }
  if (-not $RequiredScopes -or @($RequiredScopes | Where-Object { $_ -notin $ContractScopes }).Count -gt 0) { return 'AUTHORIZATION_NOT_RUN' }
  if (@($RequiredScopes | Where-Object { $_ -notin $TokenScopes }).Count -gt 0) { return 'REQUIRED_SCOPES_MISSING' }
  return 'REQUIRED_SCOPES_VERIFIED'
}

function Get-H5ScopeAuthorizationStatus([object[]]$TokenResults, [string[]]$RequiredScopes, [string[]]$ContractScopes) {
  if (@($RequiredScopes | Where-Object { $_ -notin $ContractScopes }).Count -gt 0) { return 'AUTHORIZATION_NOT_RUN' }
  if (-not $TokenResults -or @($TokenResults | Where-Object { $_.TokenStatus -ne 'TOKEN_VALID' }).Count -gt 0) { return 'AUTHORIZATION_NOT_RUN' }
  $verified = @($TokenResults | Where-Object { $_.ScopeStatus -eq 'REQUIRED_SCOPES_VERIFIED' } | ForEach-Object { $_.Scopes })
  if (@($RequiredScopes | Where-Object { $_ -notin $verified }).Count -gt 0) { return 'REQUIRED_SCOPES_MISSING' }
  return 'REQUIRED_SCOPES_VERIFIED'
}

function Test-H5OptionalMessagingTable([string]$Service, [bool]$MessagingEnabled, [bool]$TableExists) {
  if (-not $MessagingEnabled) { return 'NOT_REQUIRED_HTTP_BOOTSTRAP' }
  if ($TableExists) { return 'PASS' }
  return 'MISSING'
}

function Test-H5PemCertificate([string]$Pem) {
  if ([string]::IsNullOrWhiteSpace($Pem)) { return $false }
  try { $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($Pem); $cert.Dispose(); return $true }
  catch { return $false }
}

function New-H5ProtectedCaFile([string]$Pem) {
  if (-not (Test-H5PemCertificate $Pem)) { throw 'POSTGRES_CA_INVALID' }
  $path = Join-Path ([IO.Path]::GetTempPath()) ("g6-h5-ca-" + [guid]::NewGuid().ToString('N') + '.pem')
  [IO.File]::WriteAllText($path, $Pem, [Text.UTF8Encoding]::new($false))
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $path /inheritance:r /grant:r "${identity}:(F)" 'NT AUTHORITY\SYSTEM:(F)' *> $null
  if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue; throw 'POSTGRES_CA_ACL_FAILED' }
  return $path
}

function Invoke-H5ReadOnlySql([string]$Pem, [string]$PsqlPath, [string[]]$Arguments, [System.Collections.IDictionary]$Environment) {
  $saved = @{}
  $caPath = $null
  $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $Environment.Keys) { [void]$names.Add([string]$name) }
  [void]$names.Add('PGSSLROOTCERT'); [void]$names.Add('PGSSLMODE'); [void]$names.Add('PGOPTIONS')
  foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
  try {
    $caPath = New-H5ProtectedCaFile $Pem
    foreach ($name in $Environment.Keys) { [Environment]::SetEnvironmentVariable([string]$name,[string]$Environment[$name],'Process') }
    $env:PGSSLROOTCERT = $caPath; $env:PGSSLMODE = 'verify-full'; $env:PGOPTIONS = '-c default_transaction_read_only=on'
    $output = & $PsqlPath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $status = 'PASS'
    if ($exitCode -ne 0) {
      $message = ($output | ForEach-Object { [string]$_ }) -join "`n"
      $status = if ($message -match '(?i)could not translate host|connection timed out|timeout expired|network is unreachable|no route to host|could not connect to server') { 'UNAVAILABLE' } else { 'FAIL' }
      $output = @()
    }
    return [pscustomobject]@{ ExitCode=$exitCode; Status=$status; Output=@($output) }
  } finally {
    foreach ($name in $saved.Keys) {
      if ($null -eq $saved[$name]) { Remove-Item ('Env:' + $name) -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
    }
    if ($caPath -and (Test-Path -LiteralPath $caPath)) { Remove-Item -LiteralPath $caPath -Force -ErrorAction SilentlyContinue }
  }
}

function Test-H5JwtAuthenticity([string]$Jwt, $Jwks, [string]$Issuer, [string]$ExpectedClient, [string]$ExpectedAudience) {
  try {
    $parts = $Jwt.Split('.')
    if ($parts.Count -ne 3) { return $false }
    $decode = { param($value) $v=$value.Replace('-','+').Replace('_','/'); while ($v.Length % 4) { $v+='=' }; [Convert]::FromBase64String($v) }
    $header = [Text.Encoding]::UTF8.GetString((& $decode $parts[0])) | ConvertFrom-Json
    $claims = [Text.Encoding]::UTF8.GetString((& $decode $parts[1])) | ConvertFrom-Json
    $key = @($Jwks.keys | Where-Object { $_.kid -ceq $header.kid -and $_.use -ne 'enc' -and $_.alg -in @($null,$header.alg) }) | Select-Object -First 1
    if (-not $key) { return $false }
    $input = [Text.Encoding]::ASCII.GetBytes($parts[0] + '.' + $parts[1])
    $signature = & $decode $parts[2]
    $validSignature = $false
    if ($header.alg -eq 'RS256' -and $key.kty -eq 'RSA') {
      $rsa = [Security.Cryptography.RSA]::Create()
      try {
        $rsaParameters = [Security.Cryptography.RSAParameters]::new()
        $rsaParameters.Modulus = & $decode $key.n
        $rsaParameters.Exponent = & $decode $key.e
        $rsa.ImportParameters($rsaParameters)
        $validSignature = $rsa.VerifyData($input,$signature,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
      } finally { $rsa.Dispose() }
    } elseif ($header.alg -eq 'ES256' -and $key.kty -eq 'EC' -and $key.crv -eq 'P-256') {
      $ec = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve]::NamedCurves.nistP256)
      try {
        $ecParameters = [Security.Cryptography.ECParameters]::new()
        $ecParameters.Curve = [Security.Cryptography.ECCurve]::NamedCurves.nistP256
        $point = [Security.Cryptography.ECPoint]::new()
        $point.X = & $decode $key.x; $point.Y = & $decode $key.y
        $ecParameters.Q = $point
        $ec.ImportParameters($ecParameters)
        $validSignature = $ec.VerifyData($input,$signature,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.DSASignatureFormat]::IeeeP1363FixedFieldConcatenation)
      } finally { $ec.Dispose() }
    } else { return $false }
    $aud = @($claims.aud)
    $client = if ($claims.client_id) { [string]$claims.client_id } else { [string]$claims.sub }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $valid = $validSignature -and [string]$claims.iss -ceq $Issuer -and $aud -contains $ExpectedAudience -and $client -ceq $ExpectedClient -and [long]$claims.exp -gt $now -and (-not $claims.nbf -or [long]$claims.nbf -le $now)
    $scopeText = if ($claims.scope) { [string]$claims.scope } else { (@($claims.scp) -join ' ') }
    return [pscustomobject]@{ Status=$(if ($valid) { 'TOKEN_VALID' } else { 'TOKEN_INVALID' }); Scopes=@(($scopeText -split '\s+') | Where-Object { $_ }); Audience=$ExpectedAudience; Client=$client }
  } catch { return [pscustomobject]@{ Status='TOKEN_INVALID'; Scopes=@(); Audience=$ExpectedAudience; Client='' } }
}

function Get-H5PreflightOutcome([string]$Mode, [object[]]$Results) {
  $required = @{
    STATIC = @('private-manifest','h5-aca-effective-configuration','official-bicep-guarded-env','g7-five-service-parser-configuration','first-bootstrap-closed-flags')
    HTTP_BOOTSTRAP = @('private-manifest','h5-aca-effective-configuration','official-bicep-guarded-env','g7-five-service-parser-configuration','g7-discovery-issuer-and-jwks','azure-environment-private-domain','gateway-four-private-https-upstreams','pricing-private-catalog-dependency','first-bootstrap-closed-flags','release-source-provenance','catalog-svc-postgres-readonly-login','catalog-svc-http-readiness-schema','inventory-svc-postgres-readonly-login','inventory-svc-http-readiness-schema','pricing-svc-postgres-readonly-login','pricing-svc-http-readiness-schema','promotions-svc-postgres-readonly-login') + @('ghcr-api-gateway','ghcr-catalog-svc','ghcr-inventory-svc','ghcr-pricing-svc','ghcr-promotions-svc')
    H5_INTEGRATION = @('private-manifest','h5-aca-effective-configuration','official-bicep-guarded-env','g7-five-service-parser-configuration','g7-discovery-issuer-and-jwks','release-source-provenance','azure-environment-private-domain','gateway-four-private-https-upstreams','pricing-private-catalog-dependency','catalog-svc-postgres-readonly-login','catalog-svc-http-readiness-schema','inventory-svc-postgres-readonly-login','inventory-svc-http-readiness-schema','pricing-svc-postgres-readonly-login','pricing-svc-http-readiness-schema','promotions-svc-postgres-readonly-login','promotions-required-scopes-contract','promotions-token-api-productos','promotions-required-scopes-api-productos','promotions-token-api-ventas','promotions-required-scopes-api-ventas','h5-messaging-runtime-configuration','promotions-managed-identity-and-servicebus-parameters','promotions-servicebus-queue-rbac','catalog-svc-h5-storage','inventory-svc-h5-storage','pricing-svc-h5-storage','promotions-svc-h5-storage') + @('ghcr-api-gateway','ghcr-catalog-svc','ghcr-inventory-svc','ghcr-pricing-svc','ghcr-promotions-svc')
  }
  if (-not $required.ContainsKey($Mode)) { throw 'PREFLIGHT_MODE_INVALID' }
  $byName = @{}; foreach ($item in $Results) { $byName[$item.Check] = $item }
  $mandatory = foreach ($name in $required[$Mode]) {
    if ($byName.ContainsKey($name)) { $byName[$name] }
    else { [pscustomobject]@{ Check=$name; Status='NOT_RUN'; Detail='Mandatory check was not produced.' } }
  }
  $passedStates = @('PASS','TOKEN_VALID','REQUIRED_SCOPES_VERIFIED')
  $failedStates = @('FAIL','INVALID','MISSING','NO_VISIBILITY','MISSING_FOR_RELEASE_SHA','REQUIRED_SCOPES_MISSING','TOKEN_INVALID')
  $bad = @($mandatory | Where-Object { $_.Status -in $failedStates })
  $pending = @($mandatory | Where-Object { $_.Status -notin $passedStates -and $_.Status -notin $failedStates })
  $exitCode = if ($bad.Count) { 1 } elseif ($pending.Count) { 2 } else { 0 }
  $overall = if ($exitCode -eq 0) { 'PASS' } elseif ($exitCode -eq 1) { 'FAIL' } else { 'PENDING' }
  return [pscustomobject]@{ Mode=$Mode; OverallStatus=$overall; ExitCode=$exitCode; DeploymentAuthorized=$false; RequiredChecks=@($required[$Mode]); MandatoryResults=@($mandatory) }
}

Export-ModuleMember -Function Get-H5ReservedEnvironment,Test-H5ManifestEnvironment,Test-H5ManifestCompleteness,Get-H5GuardedEnvironment,Test-H5GuardedEnvironment,Get-H5QueueRbacStatus,Test-H5PsqlAvailable,Get-H5GhcrReleaseStatus,Get-H5ContractScopes,Get-H5ContractOperationScopes,Get-H5PromotionsRequiredOperations,Test-H5JwtRequiredScopes,Get-H5ScopeAuthorizationStatus,Test-H5OptionalMessagingTable,Test-H5PemCertificate,New-H5ProtectedCaFile,Invoke-H5ReadOnlySql,Test-H5JwtAuthenticity,Get-H5PreflightOutcome
