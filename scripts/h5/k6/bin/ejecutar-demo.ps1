[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Config,
    [Parameter(Mandatory)][string]$Dataset,
    [string]$Manifest,
    [string]$ComparisonContext,
    [string]$Authorization,
    [ValidateSet('demo-smoke', 'demo-normal', 'formal-carga')][string]$Profile = 'demo-smoke',
    [ValidateSet('constant', 'ramp', 'spike', 'recovery')][string]$Pattern,
    [ValidateSet('demo', 'baseline', 'candidato')][string]$Subject = 'demo',
    [ValidateRange(1, 3)][int]$Repetition = 1,
    [string]$K6Path,
    [switch]$Negative401,
    [switch]$Dashboard,
    [switch]$SoloValidar
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'preflight.ps1')

try {
    $context = Get-K6DemoContext -Config $Config -Dataset $Dataset -Manifest $Manifest -ComparisonContext $ComparisonContext -Authorization $Authorization -Profile $Profile -K6Path $K6Path -Subject $Subject -Repetition $Repetition -Negative401:$Negative401
    $resolvedConfig = (Resolve-Path -LiteralPath $Config).Path
    $resolvedDataset = (Resolve-Path -LiteralPath $Dataset).Path
    $settings = $context.Settings
    if ($Pattern) {
        if ($settings.environment -notin @('ISOLATED', 'LOCAL_SERVICE') -or $Profile -ne 'demo-smoke' -or $settings.max_rps -gt 2) {
            throw 'PREFLIGHT_PERFIL_PATRON_SOLO_LOOPBACK'
        }
        $context.Environment['G6_K6_PATTERN'] = $Pattern
    }
    if ($Subject -ne 'demo' -and $settings.environment -ne 'STAGING_APIM') { throw 'PREFLIGHT_SUJETO_FORMAL_REQUIERE_STAGING' }
    if ($Profile -eq 'formal-carga' -and $Subject -eq 'demo') { throw 'PREFLIGHT_CARGA_REQUIERE_SUJETO_FORMAL' }
    if ($Negative401 -and $Subject -ne 'demo') { throw 'PREFLIGHT_NEGATIVA_PERTENECE_A_DEMO' }
    if ($Dashboard -and -not $context.DashboardAvailable) { throw 'PREFLIGHT_DASHBOARD_NO_DISPONIBLE' }
    $scriptFile = Join-Path $script:K6DemoRoot ('scripts/' + $context.Case.Script)
    $optionsFile = Join-Path $script:K6DemoRoot 'config/k6-options.json'
    $runDir = Join-Path $script:K6DemoRoot ('.local/' + [guid]::NewGuid().ToString('N'))
    $context.Environment['G6_K6_RUNTIME_OUTPUT'] = Join-Path $runDir 'runtime.json'
    $inspectArgs = @('inspect', '--config', $optionsFile, '--include-system-env-vars=true', $scriptFile)
    $inspect = Invoke-K6DemoChild $context.Path $inspectArgs $context.Environment
    if ($inspect.Code -ne 0) { throw 'PREFLIGHT_K6_INSPECT_RECHAZADO (dataset, contrato o versión)' }
    $inspected = $inspect.Output | ConvertFrom-Json
    $scenario = $inspected.scenarios.medicion
    $scenarioValid = if (-not $Pattern) {
        $scenario.executor -eq 'constant-vus' -and $scenario.vus -eq $context.Definition.Vus -and
            $scenario.duration -in @(
                "$($context.Definition.Seconds)s",
                ([TimeSpan]::FromSeconds($context.Definition.Seconds).Minutes.ToString() + 'm0s')
            )
    } elseif ($Pattern -eq 'constant') {
        $scenario.executor -eq 'constant-vus' -and $scenario.vus -eq $context.Definition.Vus -and
            $scenario.duration -in @(
                "$($context.Definition.Seconds)s",
                ([TimeSpan]::FromSeconds($context.Definition.Seconds).Minutes.ToString() + 'm0s')
            )
    } else {
        $lowRate = [Math]::Max(1, [Math]::Floor($settings.max_rps / 2))
        $targets = switch ($Pattern) {
            'ramp' { @($settings.max_rps, $settings.max_rps, $lowRate) }
            'spike' { @($lowRate, $settings.max_rps, $lowRate) }
            'recovery' { @($lowRate, $settings.max_rps, $lowRate) }
        }
        $durations = switch ($Pattern) {
            'ramp' { @('20s', '20s', '20s') }
            'spike' { @('25s', '5s', '30s') }
            'recovery' { @('20s', '10s', '30s') }
        }
        $valid = $scenario.executor -eq 'ramping-arrival-rate' -and $scenario.startRate -eq $lowRate -and
            $scenario.timeUnit -eq '1s' -and $scenario.preAllocatedVUs -eq 1 -and $scenario.maxVUs -eq 1 -and
            $scenario.stages.Count -eq 3
        for ($index = 0; $valid -and $index -lt 3; $index++) {
            $valid = $scenario.stages[$index].duration -eq $durations[$index] -and
                $scenario.stages[$index].target -eq $targets[$index] -and $scenario.stages[$index].target -le $settings.max_rps
        }
        $valid
    }
    if (-not $scenarioValid -or $inspected.rps -ne $settings.max_rps) {
        throw 'PREFLIGHT_PERFIL_K6_NO_COINCIDE'
    }
    $null = New-Item -ItemType Directory -Path $runDir
    $timestamp = [DateTimeOffset]::UtcNow.ToString('o')
    $quoteArgument = { param([string]$Value) return "'" + $Value.Replace("'", "''") + "'" }
    $exactCommand = "& " + (& $quoteArgument '.\scripts\h5\k6\bin\ejecutar-demo.ps1') +
        " -Config " + (& $quoteArgument $resolvedConfig) +
        " -Dataset " + (& $quoteArgument $resolvedDataset) +
        " -K6Path " + (& $quoteArgument $context.Path) +
        " -Profile " + (& $quoteArgument $Profile)
    if ($Manifest) { $exactCommand += " -Manifest " + (& $quoteArgument (Resolve-Path -LiteralPath $Manifest).Path) }
    if ($ComparisonContext) { $exactCommand += " -ComparisonContext " + (& $quoteArgument (Resolve-Path -LiteralPath $ComparisonContext).Path) }
    if ($Authorization) { $exactCommand += " -Authorization " + (& $quoteArgument (Resolve-Path -LiteralPath $Authorization).Path) }
    if ($Pattern) { $exactCommand += " -Pattern " + (& $quoteArgument $Pattern) }
    if ($Dashboard) { $exactCommand += ' -Dashboard' }
    if ($Negative401) { $exactCommand += ' -Negative401' }
    if ($SoloValidar) { $exactCommand += ' -SoloValidar' }
    if ($SoloValidar) {
        $patternLabel = if ($Pattern) { $Pattern } else { 'constant_vus' }
        $validationScope = if ($settings.environment -eq 'ISOLATED') { 'L1_FIXTURE_SINTETICO' } else { 'L1_NEST_FIXTURES' }
        $validationProvenance = $context.Provenance
        if (-not $validationProvenance) { $validationProvenance = Get-K6Provenance 'snapshot' $settings.case_id }
        $validationSummary = [ordered]@{
            schema_version = 2; case_id = $settings.case_id; operation_id = $context.Case.Operation
            environment = $settings.environment; scope = $validationScope
            status = 'NOT_RUN'; reason = 'SOLO_VALIDAR'; timestamp_utc = $timestamp
            subject = $Subject; repetition = $Repetition; profile = $Profile; load_pattern = $patternLabel
            channel = $settings.channel; max_rps = $settings.max_rps; vus = $context.Definition.Vus
            duration_seconds = $context.Definition.Seconds; backend_sha = $settings.backend_sha
            frontend_sha = $settings.frontend_sha; docs_sha = $settings.docs_sha
            harness_commit = $validationProvenance.harness_commit; harness_tree = $validationProvenance.harness_tree
            dataset_sha256 = $settings.dataset_sha256; metrics = $null; exact_command = $exactCommand
        }
        $validationSummaryPath = Join-Path $runDir 'summary.json'
        $validationCanonical = (($validationSummary | ConvertTo-Json -Depth 8) -replace "\x0d\x0a", [string][char]10) + [char]10
        [IO.File]::WriteAllText($validationSummaryPath, $validationCanonical, [Text.UTF8Encoding]::new($false))
        $validationSummaryHash = (Get-FileHash -LiteralPath $validationSummaryPath).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText((Join-Path $runDir 'summary.sha256'), "$validationSummaryHash  summary.json" + [char]10, [Text.Encoding]::ASCII)
        $validationArtifacts = foreach ($path in @($validationSummaryPath, (Join-Path $runDir 'summary.sha256'))) {
            $file = Get-Item -LiteralPath $path
            [ordered]@{ file = $file.Name; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() }
        }
        $validationIndexPath = Join-Path $runDir 'evidence-index.json'
        $validationIndex = [ordered]@{ schema_version = 1; run_id = (Split-Path -Leaf $runDir); status = 'NOT_RUN'; artifacts = @($validationArtifacts) }
        $validationIndexCanonical = (($validationIndex | ConvertTo-Json -Depth 6) -replace "\x0d\x0a", [string][char]10) + [char]10
        [IO.File]::WriteAllText($validationIndexPath, $validationIndexCanonical, [Text.UTF8Encoding]::new($false))
        $validationIndexHash = (Get-FileHash -LiteralPath $validationIndexPath).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText((Join-Path $runDir 'evidence-index.sha256'), "$validationIndexHash  evidence-index.json" + [char]10, [Text.Encoding]::ASCII)
        Write-Output "NO_EJECUTADO | $($settings.case_id) | $Profile | patrón $patternLabel | k6 $($context.Version) | Dashboard $($context.DashboardAvailable)"
        Write-Output ".local/$(Split-Path -Leaf $runDir)/summary.json | evidence-index.json SHA-256 $validationIndexHash"
        exit 0
    }

    $source = $context.Provenance
    if (-not $source) { $source = Get-K6Provenance 'snapshot' $settings.case_id }
    if ($settings.environment -ne 'STAGING_APIM' -and $settings.backend_sha -cne $source.harness_commit) {
        throw 'EVIDENCIA_BACKEND_LOCAL_SHA_DISTINTO'
    }

    $context.Environment['K6_WEB_DASHBOARD_EXPORT'] = Join-Path $runDir 'dashboard.html'
    if ($context.DashboardAvailable) {
        $context.Environment['K6_WEB_DASHBOARD'] = 'true'
        $context.Environment['K6_WEB_DASHBOARD_HOST'] = '127.0.0.1'
        $context.Environment['K6_WEB_DASHBOARD_PORT'] = if ($Dashboard) { '5665' } else { '-1' }
        $context.Environment['K6_WEB_DASHBOARD_PERIOD'] = '5s'
    }
    if ($Dashboard) { Write-Output 'Dashboard local http://127.0.0.1:5665 (cerrar la pestaña al finalizar).' }
    Write-Output "Ejecutando $($settings.case_id) | $($settings.environment) | $Profile"
    $result = Invoke-K6DemoChild $context.Path @(
        'run', '--quiet', '--config', $optionsFile, '--include-system-env-vars=true', $scriptFile
    ) $context.Environment ($context.Definition.Seconds + 45)
    $executionLog = $result.Output + "`n" + $result.Diagnostic
    foreach ($secretName in @('G6_K6_TEST_TOKEN')) {
        $secretValue = $context.Environment[$secretName]
        if ($secretValue) { $executionLog = $executionLog.Replace($secretValue, '<redacted>') }
    }
    $targetValue = $context.Environment['G6_K6_TARGET']
    if ($targetValue) { $executionLog = $executionLog.Replace($targetValue, '<target>') }
    $executionLogPath = Join-Path $runDir 'k6-output.log'
    [IO.File]::WriteAllText($executionLogPath, $executionLog, [Text.UTF8Encoding]::new($false))
    $runtimePath = $context.Environment['G6_K6_RUNTIME_OUTPUT']
    $runtime = if (Test-Path -LiteralPath $runtimePath -PathType Leaf) {
        Read-K6DemoJson $runtimePath 'EVIDENCIA_RUNTIME_INVALIDA'
    } else { $null }
    $verified = $runtime -and $runtime.completed -and $runtime.iterations -gt 0 -and
        $runtime.valid_2xx -gt 0 -and $runtime.critical_checks -eq 1 -and
        $null -ne $runtime.unexpected_error_rate -and $runtime.unexpected_error_rate -lt 0.01 -and
        $runtime.observed_max_vus -eq $context.Definition.Vus -and
        $runtime.configured_seconds -eq $context.Definition.Seconds -and
        $runtime.elapsed_seconds -ge ($context.Definition.Seconds - 1) -and
        $runtime.measured_seconds -ge ($context.Definition.Seconds - 1) -and
        $runtime.offered_requests -ge $runtime.valid_2xx -and
        (!$Pattern -or $runtime.dropped_iterations -eq 0) -and
        $runtime.rps_configured_cap -eq $settings.max_rps -and
        $runtime.dataset_sha256 -ceq $settings.dataset_sha256 -and
        (!$Negative401 -or $runtime.negative_401 -eq 1)
    $status = if ($result.Code -ne 0) { 'FAIL' } elseif ($verified) { 'PASS' } else { 'INCONCLUSIVE' }
    if ($Pattern -and $runtime -and $runtime.dropped_iterations -gt 0 -and $runtime.unexpected_error_rate -lt 0.01) {
        $status = 'INCONCLUSIVE'
    }
    $reason = if ($result.Code -eq 124) { 'K6_TIMEOUT' } elseif ($result.Code -ne 0) {
        if ($Pattern -and $runtime -and $runtime.dropped_iterations -gt 0) { 'CLIENT_DROPPED_ITERATIONS' }
        elseif (!$runtime -or $runtime.iterations -eq 0) { 'PREFLIGHT_HTTP_O_EJECUCION_ABORTADA' }
        else { 'K6_ABORTO_O_UMBRAL_INCUMPLIDO' }
    } elseif (!$verified) { 'EVIDENCIA_DE_EJECUCION_INCOMPLETA' } else { $null }

    $completedSource = Get-K6Provenance 'snapshot' $settings.case_id
    if ($completedSource.harness_commit -cne $source.harness_commit -or
        ($settings.environment -eq 'STAGING_APIM' -and $completedSource.harness_dirty)) {
        throw 'EVIDENCIA_ARNES_CAMBIO_DURANTE_CORRIDA'
    }
    $optional = @{}
    foreach ($field in @('release_manifest_sha256', 'comparison_context_sha256', 'subject_digest')) {
        $property = $settings.PSObject.Properties[$field]
        $optional[$field] = if ($settings.environment -eq 'STAGING_APIM' -and $property) { $property.Value } else { $null }
    }
    $summary = [ordered]@{
        schema_version = 2; case_id = $settings.case_id; operation_id = $context.Case.Operation
        scope = switch ($settings.environment) {
            'ISOLATED' { 'L1_FIXTURE_SINTETICO' }
            'LOCAL_SERVICE' { 'L1_NEST_FIXTURES' }
            'STAGING_APIM' { 'L2_STAGING_APIM' }
        }
        official_h5_03 = 'NO_CERTIFICADO'; environment = $settings.environment; load_pattern = $(if ($Pattern) { $Pattern } else { 'constant_vus' })
        timestamp_utc = $timestamp; subject = $Subject; repetition = $Repetition; profile = $Profile
        channel = $settings.channel; max_rps = $settings.max_rps; k6_version = $context.Version
        approval_ref = $settings.approval_ref; revision = $settings.revision
        backend_sha = $settings.backend_sha; frontend_sha = $settings.frontend_sha; docs_sha = $settings.docs_sha
        harness_commit = $source.harness_commit; harness_tree = $source.harness_tree
        harness_dirty = ($source.harness_dirty -or $completedSource.harness_dirty)
        harness_files_sha256 = $source.harness_files_sha256
        staging_permit_sha256 = if ($context.PermitSha256) { $context.PermitSha256 } else { $null }
        dataset_sha256 = $settings.dataset_sha256; release_manifest_sha256 = $optional.release_manifest_sha256
        comparison_context_sha256 = $optional.comparison_context_sha256; subject_digest = $optional.subject_digest
        scenarios = @([ordered]@{ name = 'medicion'; load_pattern = $(if ($Pattern) { $Pattern } else { 'constant_vus' }); status = $status; metrics = $runtime })
        metrics = $runtime; k6_exit_code = $result.Code; status = $status; reason = $reason; exact_command = $exactCommand
    }
    $summaryPath = Join-Path $runDir 'summary.json'
    $canonical = (($summary | ConvertTo-Json -Depth 8) -replace "\x0d\x0a", [string][char]10) + [char]10
    [IO.File]::WriteAllText($summaryPath, $canonical, [Text.UTF8Encoding]::new($false))
    $reportHash = (Get-FileHash -LiteralPath $summaryPath).Hash.ToLowerInvariant()
    $summaryHashPath = Join-Path $runDir 'summary.sha256'
    [IO.File]::WriteAllText($summaryHashPath, "$reportHash  summary.json" + [char]10, [Text.Encoding]::ASCII)
    if ($runtime) {
        [pscustomobject]@{
            caso = $settings.case_id; perfil = $Profile; resultado = $status; vus = $runtime.observed_max_vus
            iteraciones = $runtime.iterations; rps_configurado = $runtime.rps_configured_cap
            rps_ofrecido = $runtime.rps_offered; rps_conseguido = $runtime.rps_valid_2xx
            cerca_del_limite_cliente = $runtime.client_cap_near
            p50_ms = $runtime.p50_ms; p95_ms = $runtime.p95_ms; p99_ms = $runtime.p99_ms
            inesperados = $runtime.unexpected_error_rate; estado_429 = $runtime.status_counts.'429'
        } | Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath (Join-Path $runDir 'metrics.csv')
    }
    Write-Output "$status | $($settings.case_id) | código k6=$($result.Code) | .local/$(Split-Path -Leaf $runDir)/summary.json"
    Write-Output "RPS=$($runtime.rps_valid_2xx) | p50=$($runtime.p50_ms) ms | p95=$($runtime.p95_ms) ms | p99=$($runtime.p99_ms) ms | errores=$($runtime.unexpected_error_rate) | HTTP=$($runtime.status_counts | ConvertTo-Json -Compress)"
    $artifactPaths = @($summaryPath, $summaryHashPath, $executionLogPath, $runtimePath, (Join-Path $runDir 'metrics.csv'), (Join-Path $runDir 'dashboard.html')) |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    $artifacts = foreach ($path in $artifactPaths) {
        $file = Get-Item -LiteralPath $path
        [ordered]@{ file = $file.Name; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() }
    }
    $indexPath = Join-Path $runDir 'evidence-index.json'
    $index = [ordered]@{ schema_version = 1; run_id = (Split-Path -Leaf $runDir); case_id = $settings.case_id; profile = $Profile; load_pattern = $(if ($Pattern) { $Pattern } else { 'constant_vus' }); status = $status; artifacts = @($artifacts) }
    $indexCanonical = (($index | ConvertTo-Json -Depth 8) -replace "\x0d\x0a", [string][char]10) + [char]10
    [IO.File]::WriteAllText($indexPath, $indexCanonical, [Text.UTF8Encoding]::new($false))
    $indexHash = (Get-FileHash -LiteralPath $indexPath).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $runDir 'evidence-index.sha256'), "$indexHash  evidence-index.json" + [char]10, [Text.Encoding]::ASCII)
    Write-Output "Índice de evidencia SHA-256: .local/$(Split-Path -Leaf $runDir)/evidence-index.json ($indexHash)"
    if ($result.Code -ne 0) { exit $result.Code }
    if (-not $verified) { exit 4 }
    exit 0
} catch {
    $message = $_.Exception.Message
    if ($message -notmatch '^(PREFLIGHT_|EVIDENCIA_)[A-Z0-9_]+(?: \([a-zA-Z, ó]+?\))?$') {
        $message = 'PREFLIGHT_O_EVIDENCIA_ERROR_INTERNO_' + $_.InvocationInfo.ScriptLineNumber
    }
    [Console]::Error.WriteLine($message)
    exit 2
}
