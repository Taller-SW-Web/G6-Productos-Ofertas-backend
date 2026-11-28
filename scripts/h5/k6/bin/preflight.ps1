Set-StrictMode -Version Latest

$script:K6DemoRoot = Split-Path -Parent $PSScriptRoot
$script:K6DemoProfiles = @{
    'demo-smoke'   = @{ Vus = 1; Seconds = 60; Ceiling = 5 }
    'demo-normal'  = @{ Vus = 5; Seconds = 180; Ceiling = 10 }
    'formal-carga' = @{ Vus = 20; Seconds = 300; Ceiling = 20 }
}
$script:K6DemoCases = @{
    'PERF-01' = @{ Script = 'catalogo-lectura.k6.js'; Operation = 'listarProductos' }
    'PERF-02' = @{ Script = 'pricing-lectura.k6.js'; Operation = 'obtenerPrecioSku' }
    'PERF-03' = @{ Script = 'inventario-lectura.k6.js'; Operation = 'consultarDisponibilidadComercial' }
}

function Invoke-K6DemoChild {
    param([string]$Executable, [string[]]$Arguments, [hashtable]$ChildEnvironment = @{},
        [int]$TimeoutSeconds = 15)
    $process = [Diagnostics.Process]::new()
    try {
        $start = $process.StartInfo
        $start.FileName = $Executable
        $start.WorkingDirectory = $script:K6DemoRoot
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        if ($start.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
        } else {
            # Windows PowerShell 5.1 usa la cadena de argumentos de CreateProcess.
            $start.Arguments = ($Arguments | ForEach-Object {
                '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
            }) -join ' '
        }
        $start.EnvironmentVariables.Clear()
        foreach ($key in @('PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP')) {
            $value = [Environment]::GetEnvironmentVariable($key, 'Process')
            if ($value) { $start.EnvironmentVariables[$key] = $value }
        }
        $start.EnvironmentVariables['K6_NO_USAGE_REPORT'] = 'true'
        foreach ($key in $ChildEnvironment.Keys) {
            $start.EnvironmentVariables[$key] = [string]$ChildEnvironment[$key]
        }
        if (-not $process.Start()) { throw 'K6_CLI_NO_INICIO' }
        $output = $process.StandardOutput.ReadToEndAsync()
        $diagnostic = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            return @{ Code = 124; Output = ''; Diagnostic = '' }
        }
        # Drena ambos pipes. No se imprime stderr ni stdout de una corrida.
        $message = $diagnostic.GetAwaiter().GetResult().Trim()
        $safeDiagnostic = if ($message -cmatch '^(PREFLIGHT|EVIDENCIA)_[A-Z0-9_]+$') { $message } else { '' }
        return @{ Code = $process.ExitCode; Output = $output.GetAwaiter().GetResult(); Diagnostic = $safeDiagnostic }
    } finally {
        $process.Dispose()
    }
}

function Read-K6DemoJson {
    param([string]$Path, [string]$Failure)
    try {
        $json = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
            return ConvertFrom-Json -InputObject $json -DateKind String
        }
        return ConvertFrom-Json -InputObject $json
    } catch { throw $Failure }
}

function Get-K6DemoFile {
    param([string]$Path, [string]$Failure)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw $Failure }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Get-K6Provenance {
    param([string]$Action, [string]$Argument)
    $output = node (Join-Path $script:K6DemoRoot 'bin/provenance.mjs') $Action $Argument
    if ($LASTEXITCODE -ne 0) {
        if ($output -cmatch '^EVIDENCIA_[A-Z0-9_]+$') { throw $output }
        throw 'EVIDENCIA_GIT_NO_VERIFICABLE'
    }
    return $output | ConvertFrom-Json
}

function Get-K6DemoContext {
    param(
        [string]$Config, [string]$Dataset, [string]$Manifest, [string]$ComparisonContext, [string]$Authorization,
        [string]$Profile, [string]$K6Path, [string]$Subject, [int]$Repetition, [switch]$Negative401
    )
    $configPath = Get-K6DemoFile $Config 'PREFLIGHT_CONFIG_AUSENTE'
    $dataPath = Get-K6DemoFile $Dataset 'PREFLIGHT_DATASET_AUSENTE'
    $settings = Read-K6DemoJson $configPath 'PREFLIGHT_CONFIG_JSON_INVALIDO'
    $null = Read-K6DemoJson $dataPath 'PREFLIGHT_DATASET_JSON_INVALIDO'
    $caseId = [string]$settings.case_id
    $environment = [string]$settings.environment
    $channel = [string]$settings.channel
    if ($caseId -cnotin @('PERF-01', 'PERF-02', 'PERF-03') -or
        -not $script:K6DemoProfiles.ContainsKey($Profile) -or
        $Profile -cnotin @($settings.profiles) -or
        $channel -cnotin @('MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS') -or
        ($caseId -ceq 'PERF-03' -and $channel -ceq 'VENTAS')) { throw 'PREFLIGHT_CASO_CANAL_O_PERFIL_NO_AUTORIZADO' }
    $definition = $script:K6DemoProfiles[$Profile]
    $rps = $settings.max_rps
    if (($rps -isnot [int] -and $rps -isnot [long]) -or $rps -lt 1 -or $rps -gt $definition.Ceiling) {
        throw 'PREFLIGHT_TASA_INVALIDA'
    }
    try {
        $start = [DateTimeOffset]::ParseExact($settings.window_start_utc, "yyyy-MM-ddTHH:mm:ss'Z'",
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        $end = [DateTimeOffset]::ParseExact($settings.window_end_utc, "yyyy-MM-ddTHH:mm:ss'Z'",
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
    } catch { throw 'PREFLIGHT_VENTANA_UTC_INVALIDA' }
    $now = [DateTimeOffset]::UtcNow
    if ($now -lt $start -or $now.AddSeconds($definition.Seconds + 50) -ge $end) {
        throw 'PREFLIGHT_FUERA_DE_VENTANA'
    }
    $target = $env:G6_K6_TARGET
    $token = $env:G6_K6_TEST_TOKEN
    $permitId = ''
    $revisionHeader = ''
    $revision = ''
    $provenance = $null
    if ($environment -cin @('ISOLATED', 'LOCAL_SERVICE')) {
        if (($environment -ceq 'ISOLATED' -and $caseId -cne 'PERF-01') -or $Profile -cne 'demo-smoke' -or
            $target -cnotmatch '^http://127\.0\.0\.1:[1-9]\d{0,4}$' -or $rps -gt 2) { throw 'PREFLIGHT_LOOPBACK_INVALIDO' }
    } elseif ($environment -ceq 'STAGING_APIM') {
        if (-not $target -or $target -cnotmatch '^https://[a-z0-9][a-z0-9.-]+(?::\d{1,5})?$') {
            throw 'PREFLIGHT_ORIGEN_NO_AUTORIZADO'
        }
        if ($token -cnotmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') {
            throw 'PREFLIGHT_FORMATO_TOKEN_INVALIDO'
        }
        $manifestPath = Get-K6DemoFile $Manifest 'PREFLIGHT_MANIFEST_RELEASE_AUSENTE'
        $null = Read-K6DemoJson $manifestPath 'PREFLIGHT_MANIFEST_RELEASE_INVALIDO'
        $comparisonPath = Get-K6DemoFile $ComparisonContext 'PREFLIGHT_CONTEXTO_COMPARACION_AUSENTE'
        $null = Read-K6DemoJson $comparisonPath 'PREFLIGHT_CONTEXTO_COMPARACION_INVALIDO'
        if ((Get-FileHash -LiteralPath $manifestPath).Hash -ine $settings.release_manifest_sha256 -or
            (Get-FileHash -LiteralPath $comparisonPath).Hash -ine $settings.comparison_context_sha256 -or
            $settings.subject_digest -cnotmatch '^sha256:[0-9a-f]{64}$') {
            throw 'PREFLIGHT_MANIFEST_O_SUJETO_INVALIDO'
        }
    } else { throw 'PREFLIGHT_AMBIENTE_NO_AUTORIZADO' }
    if (-not $token -or $token -cnotmatch '^[A-Za-z0-9_.~-]{1,8192}$') { throw 'PREFLIGHT_TOKEN_DE_PRUEBA_AUSENTE_O_INVALIDO' }
    if ($Negative401 -and $settings.allow_negative_401 -ne $true) { throw 'PREFLIGHT_NEGATIVA_NO_AUTORIZADA' }
    foreach ($field in @('backend_sha', 'frontend_sha', 'docs_sha')) {
        if ($settings.$field -cnotmatch '^[0-9a-f]{40}$') { throw 'PREFLIGHT_SHA_INVALIDO' }
    }
    foreach ($field in @('approval_ref', 'revision')) {
        if ($settings.$field -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' -or
            $settings.$field -ieq 'PENDIENTE') { throw 'PREFLIGHT_APROBACION_O_REVISION_INVALIDA' }
    }
    $hash = (Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -cne $settings.dataset_sha256) { throw 'PREFLIGHT_HASH_DATASET_INVALIDO' }
    if ($environment -ceq 'STAGING_APIM') {
        $permitPath = Get-K6DemoFile $Authorization 'PREFLIGHT_PERMISO_STAGING_AUSENTE'
        $provenance = Get-K6Provenance 'require-clean' $caseId
        $digest = [Security.Cryptography.SHA256]::Create()
        try { $tokenHash = ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::ASCII.GetBytes($token)))).Replace('-', '').ToLowerInvariant() }
        finally { $digest.Dispose() }
        $expected = @{
            environment = $environment; origin = $target; method = 'GET'; case_id = $caseId
            operation_id = $script:K6DemoCases[$caseId].Operation; channel = $channel
            profile = $Profile; vus = $definition.Vus; duration_seconds = $definition.Seconds
            max_rps = $rps; subject = $Subject; repetition = $Repetition
            window_start_utc = $settings.window_start_utc; window_end_utc = $settings.window_end_utc
            infra_approval_ref = $settings.approval_ref; revision = $settings.revision
            backend_sha = $settings.backend_sha; subject_digest = $settings.subject_digest
            release_manifest_sha256 = $settings.release_manifest_sha256
            comparison_context_sha256 = $settings.comparison_context_sha256
            dataset_sha256 = $hash; negative_401 = $Negative401.IsPresent; token_sha256 = $tokenHash
            harness_commit = $provenance.harness_commit
        }
        $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { throw 'PREFLIGHT_NODE_AUSENTE' }
        $permit = Invoke-K6DemoChild $node.Source @(
            (Join-Path $script:K6DemoRoot 'bin/staging-permit.mjs'), $permitPath
        ) @{ G6_K6_PERMIT_EXPECTED = ($expected | ConvertTo-Json -Compress) }
        if ($permit.Code -ne 0) {
            if ($permit.Output -cmatch '^PREFLIGHT_[A-Z0-9_]+$') { throw $permit.Output }
            throw 'PREFLIGHT_PERMISO_STAGING_NO_VERIFICADO'
        }
        $verifiedPermit = $permit.Output | ConvertFrom-Json
        $permitId = $verifiedPermit.permit_sha256
        $revisionHeader = $verifiedPermit.revision_header
        $revision = $verifiedPermit.revision
    }
    if (-not $K6Path) {
        $application = Get-Command k6 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $application) { throw 'PREFLIGHT_K6_CLI_AUSENTE' }
        $K6Path = $application.Source
    }
    $executable = Get-K6DemoFile $K6Path 'PREFLIGHT_K6_CLI_AUSENTE'
    $cli = Invoke-K6DemoChild $executable @('version')
    if ($cli.Code -ne 0 -or $cli.Output -notmatch '\bk6(?:\.exe)? v(\d+\.\d+\.\d+)(?=[\s(]|$)') {
        throw 'PREFLIGHT_K6_VERSION_NO_VERIFICADA'
    }
    $version = $Matches[1]
    return @{
        Settings = $settings; Case = $script:K6DemoCases[$caseId]; Definition = $definition
        Path = $executable; Version = $version; DashboardAvailable = [version]$version -ge [version]'0.49.0'
        PermitSha256 = $permitId; Provenance = $provenance
        Environment = @{
            G6_K6_TARGET = $target; G6_K6_PERMIT_SHA256 = $permitId
            G6_K6_REVISION_HEADER = $revisionHeader; G6_K6_EFFECTIVE_REVISION = $revision
            G6_K6_TEST_TOKEN = $token; G6_K6_END_EPOCH = $end.ToUnixTimeMilliseconds()
            G6_K6_ENVIRONMENT = $environment; G6_K6_PROFILE = $Profile; G6_K6_CHANNEL = $channel
            G6_K6_MAX_RPS = $rps; G6_K6_DATASET = $dataPath; G6_K6_DATASET_SHA256 = $hash
            G6_K6_NEGATIVE_401 = [int]$Negative401.IsPresent
        }
    }
}
