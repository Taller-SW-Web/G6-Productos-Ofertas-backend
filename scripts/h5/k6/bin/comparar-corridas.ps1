[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Baseline,
    [Parameter(Mandatory)][string[]]$Candidato,
    [Parameter(Mandatory)][string]$Telemetria,
    [ValidateRange(1, 300)][int]$PausaMinimaSegundos = 5
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preflight.ps1')

function Compare-K6Median {
    param([double[]]$Values)
    return ($Values | Sort-Object)[1]
}

function ConvertTo-K6Utc {
    param([string]$Value, [string]$Failure)
    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$') { throw $Failure }
    try { return [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture) }
    catch { throw $Failure }
}

function Read-K6Telemetry {
    param($Run, [string]$SummaryHash, [DateTimeOffset]$Started, [DateTimeOffset]$Ended)
    $link = Get-K6DemoFile (Join-Path $Telemetria "$SummaryHash.json") 'TELEMETRIA_AUSENTE'
    $index = Read-K6DemoJson $link 'TELEMETRIA_INDICE_INVALIDO'
    if ($index.summary_sha256 -cne $SummaryHash -or $index.telemetry_sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'TELEMETRIA_INDICE_INVALIDO'
    }
    $artifact = Get-K6DemoFile (Join-Path $Telemetria ($index.telemetry_sha256 + '.artifact.json')) 'TELEMETRIA_ORIGINAL_AUSENTE'
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash -ine $index.telemetry_sha256) {
        throw 'TELEMETRIA_HASH_ORIGINAL_DISTINTO'
    }
    $observations = Read-K6DemoJson $artifact 'TELEMETRIA_ORIGINAL_INVALIDA'
    if ($observations.schema_version -ne 1 -or $observations.summary_sha256 -cne $SummaryHash) {
        throw 'TELEMETRIA_SUJETO_DISTINTO'
    }
    foreach ($field in @('subject', 'revision', 'subject_digest', 'backend_sha', 'environment', 'case_id', 'profile')) {
        if ($observations.$field -cne $Run.$field) { throw 'TELEMETRIA_SUJETO_DISTINTO' }
    }
    $from = ConvertTo-K6Utc $observations.interval_start_utc 'TELEMETRIA_INTERVALO_INVALIDO'
    $to = ConvertTo-K6Utc $observations.interval_end_utc 'TELEMETRIA_INTERVALO_INVALIDO'
    # Se permite el desfase de muestreo en ambos extremos, sin aceptar
    # agregados de toda una sesión o de otra repetición.
    if ($from -gt $Started -or $to -lt $Ended -or
        ($Started - $from).TotalSeconds -gt 15 -or ($to - $Ended).TotalSeconds -gt 15) {
        throw 'TELEMETRIA_INTERVALO_NO_CORRESPONDE'
    }
    foreach ($field in @('warmup_seconds', 'cpu_peak_pct', 'memory_peak_mb', 'db_connections_peak')) {
        $value = $observations.$field
        if ($value -isnot [int] -and $value -isnot [long] -and $value -isnot [double]) {
            throw 'TELEMETRIA_INCOMPLETA'
        }
        if ([double]::IsNaN($value) -or [double]::IsInfinity($value) -or $value -lt 0) { throw 'TELEMETRIA_INCOMPLETA' }
    }
    if ($observations.warmup_seconds -le 0) { throw 'TELEMETRIA_INCOMPLETA' }
    return $index.telemetry_sha256
}

function Read-K6Comparable {
    param([string]$Path, [string]$Subject)
    $resolved = Get-K6DemoFile $Path 'RESUMEN_AUSENTE'
    $artifactHash = (Get-FileHash -LiteralPath $resolved).Hash.ToLowerInvariant()
    $checksumFile = Get-K6DemoFile (Join-Path (Split-Path -Parent $resolved) 'summary.sha256') 'HASH_RESUMEN_AUSENTE'
    if ((Get-Content -Raw -LiteralPath $checksumFile).Trim() -cne "$artifactHash  summary.json") {
        throw 'HASH_RESUMEN_DISTINTO'
    }
    $run = Read-K6DemoJson $resolved 'RESUMEN_INVALIDO'
    if ($run.schema_version -ne 2 -or $run.subject -cne $Subject -or $run.scope -cne 'L2_STAGING_APIM' -or
        $run.environment -cne 'STAGING_APIM' -or $run.harness_dirty -or $run.repetition -notin @(1, 2, 3) -or
        -not ($script:K6DemoCases.ContainsKey($run.case_id) -and $script:K6DemoProfiles.ContainsKey($run.profile)) -or
        $run.status -notin @('PASS', 'FAIL') -or $run.subject_digest -cnotmatch '^sha256:[a-f0-9]{64}$' -or
        $run.comparison_context_sha256 -cnotmatch '^[a-f0-9]{64}$' -or $run.release_manifest_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $run.dataset_sha256 -cnotmatch '^[a-f0-9]{64}$' -or $run.harness_commit -cnotmatch '^[a-f0-9]{40}$' -or
        $run.staging_permit_sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'SUJETO_O_PROCEDENCIA_NO_COMPARABLE'
    }
    $profile = $script:K6DemoProfiles[$run.profile]
    $source = Get-K6Provenance 'verify' $resolved
    $m = $run.metrics
    if (-not $m -or $m.observed_max_vus -ne $profile.Vus -or $m.configured_seconds -ne $profile.Seconds -or
        $m.elapsed_seconds -lt ($profile.Seconds - 1) -or $m.iterations -lt 1 -or
        $m.valid_2xx -lt 1 -or $null -eq $m.p50_ms -or $null -eq $m.p95_ms -or $null -eq $m.p99_ms -or
        $m.p50_ms -lt 0 -or $m.p95_ms -lt $m.p50_ms -or $m.p99_ms -lt $m.p95_ms -or
        $m.rps_valid_2xx -le 0 -or $m.negative_401 -ne 0 -or
        $null -eq $m.critical_checks -or $null -eq $m.unexpected_error_rate) {
        throw 'METRICAS_INCOMPLETAS'
    }
    $from = ConvertTo-K6Utc $m.measurement_started_utc 'MEDICION_INTERVALO_INVALIDO'
    $to = ConvertTo-K6Utc $m.measurement_ended_utc 'MEDICION_INTERVALO_INVALIDO'
    $launched = ConvertTo-K6Utc $run.timestamp_utc 'MEDICION_INTERVALO_INVALIDO'
    $seconds = ($to - $from).TotalSeconds
    if ($from -lt $launched -or $seconds -lt ($profile.Seconds - 1) -or $seconds -gt ($profile.Seconds + 5) -or
        [Math]::Abs($m.measured_seconds - $seconds) -gt 0.001 -or
        $to -gt $launched.AddSeconds($m.elapsed_seconds + 2)) { throw 'MEDICION_INTERVALO_NO_CORRESPONDE' }
    if ($m.rps_configured_cap -ne $run.max_rps -or $run.max_rps -lt 1 -or $run.max_rps -gt $profile.Ceiling -or
        $m.offered_requests -lt $m.valid_2xx -or $m.offered_requests -lt $m.iterations -or
        [Math]::Abs($m.rps_offered - $m.offered_requests / $seconds) -gt 0.001 -or
        [Math]::Abs($m.rps_valid_2xx - $m.valid_2xx / $seconds) -gt 0.001 -or
        $m.client_cap_near -ne ($m.rps_offered -ge 0.95 * $run.max_rps)) { throw 'RPS_MEDIDOS_NO_CORRESPONDEN' }
    $telemetryHash = Read-K6Telemetry $run $artifactHash $from $to
    return @{
        Run = $run; Hash = $artifactHash; Telemetry = $telemetryHash
        Started = $from; Ended = $to; Harness = $source.harness_tree
    }
}

try {
    if ($Baseline.Count -ne 3 -or $Candidato.Count -ne 3) { throw 'SE_REQUIEREN_TRES_CORRIDAS_POR_SUJETO' }
    $null = Get-K6Provenance 'require-clean' 'PERF-01'
    $baseRuns = @($Baseline | ForEach-Object { Read-K6Comparable $_ 'baseline' })
    $candidateRuns = @($Candidato | ForEach-Object { Read-K6Comparable $_ 'candidato' })
    $all = $baseRuns + $candidateRuns
    if (@($all.Hash | Sort-Object -Unique).Count -ne 6 -or
        @($baseRuns.Run.repetition | Sort-Object -Unique).Count -ne 3 -or
        @($candidateRuns.Run.repetition | Sort-Object -Unique).Count -ne 3) { throw 'REPETICIONES_DUPLICADAS' }
    if (@($all.Harness | Sort-Object -Unique).Count -ne 1) { throw 'ARCHIVOS_DE_ARNES_DISTINTOS' }
    $first = $baseRuns[0].Run
    $second = $candidateRuns[0].Run
    if ($first.revision -ceq $second.revision -or $first.subject_digest -ceq $second.subject_digest) {
        throw 'BASELINE_Y_CANDIDATO_DEBEN_SER_DISTINTOS'
    }
    foreach ($field in @('case_id', 'profile', 'operation_id', 'channel', 'max_rps', 'k6_version',
        'docs_sha', 'harness_commit', 'dataset_sha256', 'comparison_context_sha256')) {
        if (@($all.Run.$field | Sort-Object -Unique).Count -ne 1) { throw 'CONFIGURACIONES_NO_COMPARABLES' }
    }
    foreach ($group in @(@{ Rows = $baseRuns }, @{ Rows = $candidateRuns })) {
        foreach ($field in @('revision', 'subject_digest', 'backend_sha', 'frontend_sha', 'release_manifest_sha256')) {
            if (@($group.Rows.Run.$field | Sort-Object -Unique).Count -ne 1) { throw 'SUJETO_CAMBIO_ENTRE_REPETICIONES' }
        }
    }
    $orderedRuns = @($all | Sort-Object { $_.Started })
    for ($index = 1; $index -lt $orderedRuns.Count; $index++) {
        $previous = $orderedRuns[$index - 1]
        $next = $orderedRuns[$index]
        $ended = ([DateTimeOffset]$previous.Ended).AddSeconds($PausaMinimaSegundos)
        if ($next.Started -lt $ended) { throw 'SOLAPAMIENTO_O_PAUSA_INSUFICIENTE' }
    }

    $functionalFailure = @($all | Where-Object {
        $_.Run.status -ne 'PASS' -or $_.Run.k6_exit_code -ne 0 -or
        $_.Run.metrics.critical_checks -ne 1 -or $_.Run.metrics.unexpected_error_rate -ge 0.01
    }).Count -gt 0
    $baseP95 = Compare-K6Median $baseRuns.Run.metrics.p95_ms
    $candidateP95 = Compare-K6Median $candidateRuns.Run.metrics.p95_ms
    $baseRps = Compare-K6Median $baseRuns.Run.metrics.rps_valid_2xx
    $candidateRps = Compare-K6Median $candidateRuns.Run.metrics.rps_valid_2xx
    $clientBound = @($all | Where-Object { $_.Run.metrics.client_cap_near }).Count -gt 0
    $verdict = if ($functionalFailure -or $candidateP95 -gt 1.10 * $baseP95) { 'FAIL' }
        elseif ($clientBound) { 'INCONCLUSIVE' }
        elseif ($candidateRps -lt 0.90 * $baseRps) { 'FAIL' } else { 'PASS' }
    [ordered]@{
        case_id = $first.case_id; profile = $first.profile; veredicto = $verdict
        bloqueo = if ($verdict -eq 'INCONCLUSIVE') { 'RPS_CERCA_DEL_LIMITE_CLIENTE' } else { $null }
        baseline_p95_ms = $baseP95; candidato_p95_ms = $candidateP95
        baseline_rps = $baseRps; candidato_rps = $candidateRps; gate_funcional = -not $functionalFailure
        p95_corridas = $all.Run.metrics.p95_ms; rps_corridas = $all.Run.metrics.rps_valid_2xx
        techo_rps_cliente = $first.max_rps; rps_ofrecido_corridas = $all.Run.metrics.rps_offered
        gate_rps = if ($clientBound) { 'NO_EVALUABLE_CON_TECHO_CLIENTE' } elseif ($candidateRps -ge 0.90 * $baseRps) { 'PASS' } else { 'FAIL' }
        orden = $orderedRuns.Run.subject; hashes = $all.Hash; telemetry_sha256 = $all.Telemetry
        h5_03 = 'REVISION_DE_OWNERS_PENDIENTE'
    } | ConvertTo-Json -Depth 4
    if ($verdict -eq 'PASS') { exit 0 }
    if ($verdict -eq 'INCONCLUSIVE') { exit 3 }
    exit 1
} catch {
    $reason = $_.Exception.Message
    if ($reason -cnotmatch '^[A-Z0-9_]+$') { $reason = 'EVIDENCIA_INCOMPLETA_O_INVALIDA' }
    @{ veredicto = 'INCONCLUSIVE'; bloqueo = $reason } | ConvertTo-Json
    exit 3
}
