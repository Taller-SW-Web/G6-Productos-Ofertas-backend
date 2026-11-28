[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Config,
    [Parameter(Mandatory)][string]$Dataset,
    [string]$Manifest,
    [string]$ComparisonContext,
    [string]$Authorization,
    [ValidateSet('demo-smoke', 'demo-normal', 'formal-carga')][string]$Profile = 'demo-smoke',
    [ValidateSet('demo', 'baseline', 'candidato')][string]$Subject = 'demo',
    [ValidateRange(1, 3)][int]$Repetition = 1,
    [string]$K6Path,
    [switch]$Negative401,
    [switch]$Dashboard,
    [switch]$SoloValidar
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preflight.ps1')

try {
    $context = Get-K6DemoContext -Config $Config -Dataset $Dataset -Manifest $Manifest -ComparisonContext $ComparisonContext -Authorization $Authorization -Profile $Profile -K6Path $K6Path -Subject $Subject -Repetition $Repetition -Negative401:$Negative401
    $settings = $context.Settings
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
    if ($scenario.executor -ne 'constant-vus' -or $scenario.vus -ne $context.Definition.Vus -or
        $scenario.duration -notin @(
            "$($context.Definition.Seconds)s",
            ([TimeSpan]::FromSeconds($context.Definition.Seconds).Minutes.ToString() + 'm0s')
        ) -or $inspected.rps -ne $settings.max_rps) {
        throw 'PREFLIGHT_PERFIL_K6_NO_COINCIDE'
    }
    if ($SoloValidar) {
        Write-Output "NO_EJECUTADO | $($settings.case_id) | $Profile | k6 $($context.Version) | Dashboard $($context.DashboardAvailable)"
        exit 0
    }

    $source = $context.Provenance
    if (-not $source) { $source = Get-K6Provenance 'snapshot' $settings.case_id }
    if ($settings.environment -ne 'STAGING_APIM' -and $settings.backend_sha -cne $source.harness_commit) {
        throw 'EVIDENCIA_BACKEND_LOCAL_SHA_DISTINTO'
    }

    $null = New-Item -ItemType Directory -Path $runDir
    $context.Environment['K6_WEB_DASHBOARD_EXPORT'] = Join-Path $runDir 'dashboard.html'
    if ($context.DashboardAvailable) {
        $context.Environment['K6_WEB_DASHBOARD'] = 'true'
        $context.Environment['K6_WEB_DASHBOARD_HOST'] = '127.0.0.1'
        $context.Environment['K6_WEB_DASHBOARD_PORT'] = if ($Dashboard) { '5665' } else { '-1' }
        $context.Environment['K6_WEB_DASHBOARD_PERIOD'] = '5s'
    }
    if ($Dashboard) { Write-Output 'Dashboard local http://127.0.0.1:5665 (cerrar la pestaña al finalizar).' }
    Write-Output "Ejecutando $($settings.case_id) | $($settings.environment) | $Profile"
    $timestamp = [DateTimeOffset]::UtcNow.ToString('o')
    $result = Invoke-K6DemoChild $context.Path @(
        'run', '--quiet', '--config', $optionsFile, '--include-system-env-vars=true', $scriptFile
    ) $context.Environment ($context.Definition.Seconds + 45)
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
        $runtime.rps_configured_cap -eq $settings.max_rps -and
        $runtime.dataset_sha256 -ceq $settings.dataset_sha256 -and
        (!$Negative401 -or $runtime.negative_401 -eq 1)
    $status = if ($result.Code -ne 0) { 'FAIL' } elseif ($verified) { 'PASS' } else { 'INCONCLUSIVE' }
    $reason = if ($result.Code -eq 124) { 'K6_TIMEOUT' } elseif ($result.Code -ne 0) {
        if (!$runtime -or $runtime.iterations -eq 0) { 'PREFLIGHT_HTTP_O_EJECUCION_ABORTADA' }
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
        official_h5_03 = 'NO_CERTIFICADO'; environment = $settings.environment
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
        metrics = $runtime; k6_exit_code = $result.Code; status = $status; reason = $reason
    }
    $summaryPath = Join-Path $runDir 'summary.json'
    $canonical = (($summary | ConvertTo-Json -Depth 8) -replace "\x0d\x0a", [string][char]10) + [char]10
    [IO.File]::WriteAllText($summaryPath, $canonical, [Text.UTF8Encoding]::new($false))
    $reportHash = (Get-FileHash -LiteralPath $summaryPath).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $runDir 'summary.sha256'), "$reportHash  summary.json" + [char]10, [Text.Encoding]::ASCII)
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
