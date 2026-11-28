[CmdletBinding()]
param(
    [ValidateSet('demo-rate-limit', 'aislamiento', 'cuota', 'concurrencia')][string]$Profile = 'demo-rate-limit',
    [Parameter(Mandatory)][ValidateSet('local', 'remote')][string]$Mode,
    [Parameter(Mandatory)][string]$Config,
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$Parameters,
    [Parameter(Mandatory)][string]$Policy,
    [string]$Permit,
    [string]$K6Path,
    [switch]$Dashboard,
    [switch]$SoloValidar
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$k6Root = Join-Path $repo 'scripts/h5/k6'
$resolvedConfig = (Resolve-Path -LiteralPath $Config).Path
$resolvedManifest = (Resolve-Path -LiteralPath $Manifest).Path
$resolvedParameters = (Resolve-Path -LiteralPath $Parameters).Path
$resolvedPolicy = (Resolve-Path -LiteralPath $Policy).Path
if ($Mode -eq 'remote' -and -not $Permit) { throw 'PREFLIGHT_PERMISO_STAGING_AUSENTE' }
$resolvedPermit = if ($Permit) { (Resolve-Path -LiteralPath $Permit).Path } else { '' }
if (-not $K6Path) {
    $k6Command = Get-Command k6 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($k6Command) { $K6Path = $k6Command.Source }
    else { $K6Path = Join-Path $repo '.h5-toolchain/k6/k6.exe' }
}
$K6Path = (Resolve-Path -LiteralPath $K6Path).Path
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$preflight = Join-Path $repo 'ops/azure/apim/tests/apim-rl-preflight.mjs'
$scriptFile = Join-Path $repo 'ops/azure/apim/tests/apim-rl-k6.js'
$optionsFile = Join-Path $k6Root 'config/k6-options.json'
$configData = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedConfig | ConvertFrom-Json
$runId = [guid]::NewGuid().ToString()
$runKey = $runId.Replace('-', '')
$runDir = Join-Path $k6Root ('.local/apim-rate-limit/' + $runKey)
$null = New-Item -ItemType Directory -Path $runDir -Force
$preflightPath = Join-Path $runDir 'preflight.json'
$k6SummaryPath = Join-Path $runDir 'k6-summary.json'
$k6LogPath = Join-Path $runDir 'execution.log'
$finalSummaryPath = Join-Path $runDir 'summary.json'
$dashboardPath = Join-Path $runDir 'dashboard.html'
$indexPath = Join-Path $runDir 'evidence-index.json'
$indexHashPath = Join-Path $runDir 'evidence-index.sha256'
$childEnvironment = @{}
$previousEnvironment = @{}
$exitCode = 0
function Format-PowerShellArgument([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
$exactCommand = "& $(Format-PowerShellArgument (Join-Path $PSScriptRoot 'ejecutar-rate-limit.ps1')) -Profile $(Format-PowerShellArgument $Profile) -Mode $(Format-PowerShellArgument $Mode) -Config $(Format-PowerShellArgument $resolvedConfig) -Manifest $(Format-PowerShellArgument $resolvedManifest) -Parameters $(Format-PowerShellArgument $resolvedParameters) -Policy $(Format-PowerShellArgument $resolvedPolicy) -K6Path $(Format-PowerShellArgument $K6Path)"
if ($resolvedPermit) { $exactCommand += " -Permit $(Format-PowerShellArgument $resolvedPermit)" }
if ($Dashboard) { $exactCommand += ' -Dashboard' }
if ($SoloValidar) { $exactCommand += ' -SoloValidar' }

function Write-Utf8Json([string]$Path, $Value) {
    $json = ($Value | ConvertTo-Json -Depth 20) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($Path, $json + "`n", [Text.UTF8Encoding]::new($false))
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Get-JsonMetricProperty($Object, [string]$Name) {
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Invoke-CapturedProcess([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds) {
    $process = [Diagnostics.Process]::new()
    try {
        $start = $process.StartInfo
        $start.FileName = $Executable
        $start.WorkingDirectory = $repo
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        if ($start.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
        } else {
            $start.Arguments = ($Arguments | ForEach-Object {
                '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
            }) -join ' '
        }
        try {
            if (-not $process.Start()) { throw 'PREFLIGHT_PROCESO_NO_INICIO' }
        } catch {
            $startError = $_.Exception.GetBaseException().Message -replace '[^A-Za-z0-9 ]', ''
            $startCode = ('PREFLIGHT_PROCESO_NO_INICIO_' + [IO.Path]::GetFileName($Executable) + '_' + ($startError -replace '\s+', '_')).ToUpperInvariant() -replace '[^A-Z0-9_]', ''
            throw $startCode
        }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            return @{ Code = 124; Output = ''; Diagnostic = 'PREFLIGHT_EJECUCION_TIMEOUT' }
        }
        return @{
            Code = $process.ExitCode
            Output = $stdout.GetAwaiter().GetResult()
            Diagnostic = $stderr.GetAwaiter().GetResult()
        }
    } finally {
        try { if ($process -and -not $process.HasExited) { $process.Kill() } } catch { }
        try { $process.Dispose() } catch { }
    }
}

try {
    $preflightArgs = @($preflight, $Mode, $Profile, $resolvedConfig, $resolvedManifest, $resolvedParameters, $resolvedPolicy, $resolvedPermit)
    $preflightRun = Invoke-CapturedProcess -Executable $node -Arguments $preflightArgs -TimeoutSeconds 20
    if ($preflightRun.Code -ne 0) {
        $message = $preflightRun.Diagnostic.Trim()
        if ($message -notmatch '^PREFLIGHT_[A-Z0-9_]+$') { $message = 'PREFLIGHT_RATE_LIMIT_RECHAZADO' }
        throw $message
    }
    try { $effective = $preflightRun.Output | ConvertFrom-Json }
    catch { throw 'PREFLIGHT_RESULTADO_INVALIDO' }
    Write-Utf8Json $preflightPath $effective
    $childEnvironment = @{
        APIM_RL_PROFILE = $Profile
        APIM_RL_MODE = $Mode
        APIM_RL_LOCAL_SIMULATION = if ($Mode -eq 'local') { '1' } else { '0' }
        APIM_BASE_URL = $effective.base_url
        APIM_EFFECTIVE_MANIFEST_PATH = $resolvedManifest
        APIM_EFFECTIVE_PARAMETERS_PATH = $resolvedParameters
        APIM_EFFECTIVE_POLICY_PATH = $resolvedPolicy
        APIM_EFFECTIVE_MANIFEST_SHA256 = $effective.effective_manifest_sha256
        APIM_EFFECTIVE_PARAMETERS_SHA256 = $effective.effective_parameters_sha256
        APIM_OPERATION_SET_SHA256 = $effective.operation_set_sha256
        APIM_FILTERED_OPENAPI_SHA256 = $effective.filtered_openapi_sha256
        APIM_POLICY_HASH = $effective.policy_hash
        APIM_REVISION = $effective.revision
        APIM_RL_EXPECTED_REVISION = $effective.revision
        APIM_RL_REVISION_HEADER = $effective.revision_header
        APIM_RL_OPERATION_ID = $effective.operation_id
        APIM_RL_OPERATION_PATH = $effective.operation_path
        APIM_RL_RATE_PROFILE = $effective.rate_profile
        APIM_RL_IDENTITY = $effective.identity
        APIM_RL_BURST_CALLS = [string]$effective.burst_calls
        APIM_RL_BURST_WINDOW_SECONDS = [string]$effective.burst_window_seconds
        APIM_RL_MAX_REQUESTS = [string]$effective.max_requests
        APIM_RL_AUTHORIZED_MAX_REQUESTS = [string]$effective.max_requests
        APIM_RL_MAX_CONCURRENCY = [string]$effective.max_concurrency
        APIM_RL_AUTHORIZED_CONCURRENCY = [string]$effective.max_concurrency
        APIM_RL_VUS = [string]$effective.vus
        APIM_RL_AUTHORIZED_VUS = [string]$effective.vus
        APIM_RL_MAX_RPS = [string]$effective.max_rps
        APIM_RL_AUTHORIZED_RPS = [string]$effective.max_rps
        APIM_RL_MAX_DURATION_SECONDS = [string]$effective.max_duration_seconds
        APIM_RL_AUTHORIZED_DURATION_SECONDS = [string]$effective.max_duration_seconds
        APIM_RL_MAX_RETRY_AFTER_SECONDS = [string]$effective.max_retry_after_seconds
        APIM_RL_BACKEND_SHA = $effective.backend_sha
        APIM_RL_SOURCE_WORKTREE_CLEAN = ([bool]$effective.source_worktree_clean).ToString().ToLowerInvariant()
        APIM_RL_RUN_ID = $runId
        APIM_RL_SUMMARY_PATH = $k6SummaryPath
        APIM_RL_VERIFIED_PERMIT_SHA256 = if ($effective.permit_sha256) { $effective.permit_sha256 } else { '' }
        K6_WEB_DASHBOARD_EXPORT = $dashboardPath
        K6_WEB_DASHBOARD = 'true'
        K6_WEB_DASHBOARD_HOST = '127.0.0.1'
        K6_WEB_DASHBOARD_PORT = if ($Dashboard) { '5665' } else { '-1' }
        K6_WEB_DASHBOARD_PERIOD = '1s'
        K6_NO_USAGE_REPORT = 'true'
    }
    if ($Mode -eq 'local') {
        $childEnvironment.NO_PROXY = '127.0.0.1,localhost,::1'
        $childEnvironment.APIM_RL_TEST_TOKEN = 'local-synthetic-token'
        if ($Profile -eq 'aislamiento') {
            $childEnvironment.APIM_RL_IDENTITY_B = $configData.identity_b
            $childEnvironment.APIM_RL_TEST_TOKEN_B = 'local-synthetic-token-b'
        }
    } else {
        if (-not $env:APIM_RL_TEST_TOKEN) { throw 'PREFLIGHT_CREDENCIAL_APIM_AUSENTE' }
        $childEnvironment.APIM_RL_TEST_TOKEN = $env:APIM_RL_TEST_TOKEN
        if ($Profile -eq 'aislamiento') {
            if (-not $env:APIM_RL_TEST_TOKEN_B) { throw 'PREFLIGHT_CREDENCIAL_CLIENTE_B_AUSENTE' }
            $childEnvironment.APIM_RL_TEST_TOKEN_B = $env:APIM_RL_TEST_TOKEN_B
            $childEnvironment.APIM_RL_IDENTITY_B = $effective.identity_b
        }
    }

    if ($Profile -eq 'cuota') {
        $childEnvironment.APIM_RL_QUOTA_CALLS = [string]$effective.quota_calls
        $childEnvironment.APIM_RL_QUOTA_WINDOW_SECONDS = [string]$effective.quota_window_seconds
        $childEnvironment.APIM_RL_QUOTA_ERROR_CODE = [string]$effective.quota_error_code
    } elseif ($Profile -eq 'concurrencia') {
        $childEnvironment.APIM_RL_POLICY_CONCURRENCY_LIMIT = [string]$effective.policy_concurrency_limit
        $childEnvironment.APIM_RL_CONCURRENCY_CALLS = [string]$effective.concurrency_calls
    }

    foreach ($entry in $childEnvironment.GetEnumerator()) {
        $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
    }
    if ($Dashboard) { Write-Output 'Dashboard nativo k6: http://127.0.0.1:5665' }
    Write-Output "Ejecutando $Profile | $Mode | límite $($effective.max_requests) solicitudes | $($effective.vus) VU | .local/apim-rate-limit/$runKey/"
    $inspect = Invoke-CapturedProcess -Executable $K6Path -Arguments @('inspect', '--config', $optionsFile, '--include-system-env-vars=true', $scriptFile) -TimeoutSeconds 30
    if ($inspect.Code -ne 0) {
        $k6Diagnostic = ($inspect.Diagnostic + "`n" + $inspect.Output)
        foreach ($secretName in @('APIM_RL_TEST_TOKEN', 'APIM_RL_TEST_TOKEN_B')) {
            $secretValue = [Environment]::GetEnvironmentVariable($secretName, 'Process')
            if ($secretValue) { $k6Diagnostic = $k6Diagnostic.Replace($secretValue, '<redacted>') }
        }
        $detail = ($k6Diagnostic -split "`r?`n" | Where-Object { $_ -match '(?i)(error|failed|invalid|cannot|could not|unexpected)' } | Select-Object -First 3) -join ' '
        if ($detail) { [Console]::Error.WriteLine($detail) }
        throw 'PREFLIGHT_K6_INSPECT_RECHAZADO'
    }
    $inspected = $inspect.Output | ConvertFrom-Json
    $scenario = $inspected.scenarios.PSObject.Properties[$Profile].Value
    $scenarioValid = if ($Profile -eq 'concurrencia') {
        $scenario.executor -eq 'per-vu-iterations' -and $scenario.vus -eq $effective.vus -and
        $scenario.iterations -eq 1 -and $scenario.maxDuration -eq "$($effective.max_duration_seconds)s"
    } else {
        $scenario.executor -eq 'per-vu-iterations' -and $scenario.vus -eq 1 -and
        $scenario.iterations -eq 1 -and $scenario.maxDuration -eq "$($effective.max_duration_seconds)s"
    }
    if (-not $scenarioValid) {
        throw 'PREFLIGHT_PERFIL_K6_NO_COINCIDE'
    }
    if ($SoloValidar) {
        $validated = [ordered]@{
            schema_version = 1; backend_sha = $effective.backend_sha; source_worktree_clean = [bool]$effective.source_worktree_clean; case_id = if ($Profile -eq 'aislamiento') { 'RL-04' } elseif ($Profile -eq 'concurrencia') { 'RL-06' } elseif ($Profile -eq 'cuota') { 'APIM-QUOTA' } else { 'RL-01-RL-03' }
            profile = $Profile; mode = $Mode; status = 'NOT_RUN'; scope = if ($Mode -eq 'local') { 'L1_LOCAL_POLICY_SIMULATION' } else { 'L2_STAGING_APIM' }
            verified_permit_sha256 = $effective.permit_sha256; operation_id = $effective.operation_id
            operation_path = $effective.operation_path; revision = $effective.revision
            manifest_sha256 = $effective.effective_manifest_sha256; parameters_sha256 = $effective.effective_parameters_sha256
            policy_sha256 = $effective.policy_hash; max_requests = $effective.max_requests
            max_rps = $effective.max_rps; max_concurrency = $effective.max_concurrency; vus = $effective.vus
            duration_limit_seconds = $effective.max_duration_seconds; exact_command = $exactCommand
        }
        Write-Utf8Json $finalSummaryPath $validated
        $validationArtifacts = foreach ($path in @($finalSummaryPath, $preflightPath) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) {
            $file = Get-Item -LiteralPath $path
            [ordered]@{ file = $file.Name; bytes = $file.Length; sha256 = Get-Sha256 $path }
        }
        Write-Utf8Json $indexPath ([ordered]@{ schema_version = 1; run_id = $runId; status = 'NOT_RUN'; artifacts = @($validationArtifacts) })
        $indexHash = Get-Sha256 $indexPath
        [IO.File]::WriteAllText($indexHashPath, "$indexHash  evidence-index.json`n", [Text.Encoding]::ASCII)
        Write-Output "NO_EJECUTADO | $Profile | $Mode | .local/apim-rate-limit/$runKey/summary.json"
        return
    }

    $run = Invoke-CapturedProcess -Executable $K6Path -Arguments @('run', '--quiet', '--config', $optionsFile, '--include-system-env-vars=true', $scriptFile) -TimeoutSeconds ($effective.max_duration_seconds + 60)
    if ($run.Code -eq 124) { throw 'EJECUCION_K6_TIMEOUT' }
    $safeK6Output = $run.Output + "`n" + $run.Diagnostic
    foreach ($secretName in @('APIM_RL_TEST_TOKEN', 'APIM_RL_TEST_TOKEN_B')) {
        $secretValue = [Environment]::GetEnvironmentVariable($secretName, 'Process')
        if ($secretValue) { $safeK6Output = $safeK6Output.Replace($secretValue, '<redacted>') }
    }
    [IO.File]::WriteAllText($k6LogPath, $safeK6Output, [Text.UTF8Encoding]::new($false))
    $eventLine = $safeK6Output -split "`r?`n" | Where-Object { $_.Contains('APIM_RL_EVENT_JSON=') } | Select-Object -Last 1
    $event = $null
    if ($eventLine) {
        $eventStart = $eventLine.IndexOf('APIM_RL_EVENT_JSON=') + 'APIM_RL_EVENT_JSON='.Length
        $eventEnd = $eventLine.LastIndexOf('" source=console')
        if ($eventEnd -lt $eventStart) { $eventEnd = $eventLine.Length }
        $eventJson = $eventLine.Substring($eventStart, $eventEnd - $eventStart).Replace('\"', '"')
        try { $event = $eventJson | ConvertFrom-Json } catch { $event = $null }
    }
    $k6Summary = if (Test-Path -LiteralPath $k6SummaryPath -PathType Leaf) {
        Get-Content -Raw -Encoding UTF8 -LiteralPath $k6SummaryPath | ConvertFrom-Json
    } else { [pscustomobject]@{ metrics = [pscustomobject]@{}; scope = if ($Mode -eq 'local') { 'L1_LOCAL_POLICY_SIMULATION' } else { 'L2_STAGING_APIM' } } }
    if (-not $event -and $k6Summary.demo_event) { $event = $k6Summary.demo_event }
    $resultStatus = if ($run.Code -ne 0) { 'FAIL' } elseif (-not $event -or $event.status -ne 'PASS') { 'FAIL' } elseif (-not (Test-Path -LiteralPath $dashboardPath -PathType Leaf)) { 'INCONCLUSIVE' } else { 'PASS' }
    $assessment = if ($event) { $event.requirements } else { @{ 'RL-01' = 'NOT_RUN'; 'RL-02' = 'NOT_RUN'; 'RL-03' = 'NOT_RUN'; 'RL-04' = 'NOT_RUN'; 'RL-05' = 'INCONCLUSIVE'; 'RL-06' = 'NOT_RUN' } }
    $latency = $k6Summary.metrics.raw_k6_http_req_duration
    $httpReqs = $k6Summary.metrics.raw_k6_http_reqs
    $final = [ordered]@{
        schema_version = 1; backend_sha = $effective.backend_sha; source_worktree_clean = [bool]$effective.source_worktree_clean; case_id = if ($Profile -eq 'aislamiento') { 'RL-04' } elseif ($Profile -eq 'concurrencia') { 'RL-06' } elseif ($Profile -eq 'cuota') { 'APIM-QUOTA' } else { 'RL-01-RL-03' }
        profile = $Profile; mode = $Mode; environment = $k6Summary.scope; status = $resultStatus
        overall_certification = 'INCONCLUSIVE'; timestamp_utc = [DateTimeOffset]::UtcNow.ToString('o')
        operation = @{ operation_id = $effective.operation_id; method = 'GET'; path = $effective.operation_path; revision = $effective.revision }
        policy = @{ sha256 = $effective.policy_hash; revision_header = $effective.revision_header }
        hashes = @{ manifest = $effective.effective_manifest_sha256; parameters = $effective.effective_parameters_sha256; permit = $effective.permit_sha256 }
        limits = @{ requests = $effective.max_requests; rps = $effective.max_rps; concurrency = $effective.max_concurrency; vus = $effective.vus; duration_seconds = $effective.max_duration_seconds }
        requirements = $assessment; demo_event = $event; k6_summary = $k6Summary
        latency_ms = if ($latency) { @{ p50 = $latency.med; p95 = (Get-JsonMetricProperty $latency 'p(95)'); p99 = (Get-JsonMetricProperty $latency 'p(99)'); min = $latency.min; max = $latency.max } } else { $null }
        requests_per_second = if ($httpReqs) { $httpReqs.rate } else { $null }
        raw_http_req_failed = $k6Summary.metrics.raw_k6_http_req_failed
        unexpected_errors = if ($k6Summary.metrics.unexpected) { $k6Summary.metrics.unexpected } else { @{ count = 0 } }
        exact_command = $exactCommand
        limitations = @('RL-05 requiere telemetría correlacionada APIM/Gateway/backend; RL-06 requiere además evidencia de idempotencia cuando aplique.')
    }
    Write-Utf8Json $finalSummaryPath $final
    $artifactPaths = @($finalSummaryPath, $k6SummaryPath, $dashboardPath, $preflightPath, $k6LogPath) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    $artifacts = foreach ($path in $artifactPaths) {
        $file = Get-Item -LiteralPath $path
        [ordered]@{ file = $file.Name; bytes = $file.Length; sha256 = Get-Sha256 $path }
    }
    Write-Utf8Json $indexPath ([ordered]@{ schema_version = 1; run_id = $runId; status = $resultStatus; artifacts = @($artifacts) })
    $indexHash = Get-Sha256 $indexPath
    [IO.File]::WriteAllText($indexHashPath, "$indexHash  evidence-index.json`n", [Text.Encoding]::ASCII)
    Write-Output "$resultStatus | $Profile | k6=$($run.Code) | .local/apim-rate-limit/$runKey/summary.json"
    Write-Output "Evidencia SHA-256: .local/apim-rate-limit/$runKey/evidence-index.json"
    if ($run.Code -ne 0) { $exitCode = $run.Code }
    elseif ($resultStatus -ne 'PASS') { $exitCode = 4 }
} catch {
    $message = $_.Exception.Message
    if ($message -notmatch '^(PREFLIGHT|EJECUCION|EVIDENCIA)_[A-Z0-9_]+$') {
        $detail = $_.Exception.GetBaseException().Message
        foreach ($secretName in @('APIM_RL_TEST_TOKEN', 'APIM_RL_TEST_TOKEN_B')) {
            $secretValue = [Environment]::GetEnvironmentVariable($secretName, 'Process')
            if ($secretValue) { $detail = $detail.Replace($secretValue, '<redacted>') }
        }
        $detailCode = ($detail -replace '[^A-Za-z0-9 ]', '' -replace '\s+', '_').ToUpperInvariant()
        $message = 'EJECUCION_RATE_LIMIT_ERROR_INTERNO_LINEA_' + $_.InvocationInfo.ScriptLineNumber + '_' + $detailCode
    }
    [Console]::Error.WriteLine($message)
    $exitCode = 2
} finally {
    foreach ($key in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process')
    }
}
if ($exitCode -ne 0) { exit $exitCode }
