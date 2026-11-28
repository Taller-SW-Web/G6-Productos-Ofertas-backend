[CmdletBinding()]
param([Parameter(Mandatory)][string]$K6Path)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'bin/preflight.ps1')
$powershell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$local = Join-Path $root ('.local/autoprueba-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $local

function Save-AutopruebaJson {
    param([string]$Path, $Document)
    $Document | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $Path
    return (Get-FileHash -LiteralPath $Path).Hash.ToLowerInvariant()
}

$dataset = Join-Path $root 'config/dataset.example.json'
$datasetHash = (Get-FileHash -LiteralPath $dataset).Hash.ToLowerInvariant()
$config = Join-Path $local 'config-inerte.json'
$manifest = Join-Path $local 'manifest-inerte.json'
$comparisonContext = Join-Path $local 'contexto-inerte.json'
$envelope = Join-Path $local 'permiso-no-confiable.json'
$manifestHash = Save-AutopruebaJson $manifest @{ autoprueba = $true }
$contextHash = Save-AutopruebaJson $comparisonContext @{ autoprueba = $true }
$null = Save-AutopruebaJson $envelope @{
    payload_base64 = 'e30='
    signatures = @(@{ key_id = 'FIXTURE-INFRA'; signature_base64 = 'eA==' },
        @{ key_id = 'FIXTURE-G7'; signature_base64 = 'eA==' })
}
$sha = 'a' * 40
$inert = @{
    environment = 'STAGING_APIM'; case_id = 'PERF-02'; channel = 'MARKETPLACE'
    profiles = @('demo-normal'); max_rps = 2
    window_start_utc = [DateTime]::UtcNow.AddMinutes(-1).ToString('yyyy-MM-ddTHH:mm:ssZ')
    window_end_utc = [DateTime]::UtcNow.AddMinutes(20).ToString('yyyy-MM-ddTHH:mm:ssZ')
    approval_ref = 'AUTOPRUEBA_SIN_TRAFICO'; revision = 'AUTOPRUEBA'; allow_negative_401 = $false
    backend_sha = $sha; frontend_sha = $sha; docs_sha = $sha
    subject_digest = 'sha256:' + ('a' * 64); dataset_sha256 = $datasetHash
    release_manifest_sha256 = $manifestHash; comparison_context_sha256 = $contextHash
}
$null = Save-AutopruebaJson $config $inert
$command = @('-NoProfile', '-File', (Join-Path $root 'bin/ejecutar-demo.ps1'), '-Config', $config,
    '-Dataset', $dataset, '-Manifest', $manifest, '-ComparisonContext', $comparisonContext,
    '-Profile', 'demo-normal', '-K6Path', $K6Path, '-SoloValidar')
$stageEnv = @{
    G6_K6_TARGET = 'https://example.invalid'
    G6_K6_APPROVED_ORIGIN = 'https://example.invalid'
    G6_K6_TEST_TOKEN = 'inert.fixture.input'
}
# Permite al wrapper comprobar Git en worktrees con ownership distinto.
Get-ChildItem Env: | Where-Object Name -Match '^(GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|PATHEXT|HOME|USERPROFILE|HOMEPATH|HOMEDRIVE)$' |
    ForEach-Object { $stageEnv[$_.Name] = $_.Value }
$unsigned = Invoke-K6DemoChild $powershell $command $stageEnv
$selfSigned = Invoke-K6DemoChild $powershell ($command + @('-Authorization', $envelope)) $stageEnv
# El wrapper escribe su rechazo por stderr. Para comprobar códigos explícitos, se
# usa el registrador de stderr saneado del wrapper desde el proceso de prueba.
if ($unsigned.Code -ne 2 -or $selfSigned.Code -ne 2 -or
    $unsigned.Diagnostic.Trim() -cne 'PREFLIGHT_PERMISO_STAGING_AUSENTE' -or
    $selfSigned.Diagnostic.Trim() -cne 'PREFLIGHT_AUTORIDAD_NO_CONFIABLE') {
    throw 'AUTORIZACION_STAGING_NEGATIVA_FALLO'
}
Write-Output 'STAGING_SIN_PERMISO Y STAGING_AUTORIDAD_NO_CONFIABLE OK (sin tráfico)'

foreach ($test in @(
    @{ Name = 'PERF-02'; Script = 'pricing-lectura.k6.js'; Profile = 'demo-normal'; Vus = 5; Duration = '3m0s' },
    @{ Name = 'PERF-03'; Script = 'inventario-lectura.k6.js'; Profile = 'formal-carga'; Vus = 20; Duration = '5m0s' }
)) {
    $result = Invoke-K6DemoChild $K6Path @(
        'inspect', '--config', (Join-Path $root 'config/k6-options.json'), '--include-system-env-vars=true',
        (Join-Path $root ('scripts/' + $test.Script))
    ) @{
        G6_K6_TARGET = 'https://example.invalid'; G6_K6_ENVIRONMENT = 'INSPECT_OFFLINE'
        G6_K6_END_EPOCH = [DateTimeOffset]::UtcNow.AddMinutes(20).ToUnixTimeMilliseconds()
        G6_K6_TEST_TOKEN = 'inert.fixture.input'; G6_K6_CHANNEL = 'MARKETPLACE'
        G6_K6_PROFILE = $test.Profile; G6_K6_MAX_RPS = 2; G6_K6_DATASET = $dataset
        G6_K6_DATASET_SHA256 = $datasetHash
    }
    if ($result.Code -ne 0) { throw "INSPECT_FALLO $($test.Name)" }
    $scenario = ($result.Output | ConvertFrom-Json).scenarios.medicion
    if ($scenario.vus -ne $test.Vus -or $scenario.duration -ne $test.Duration) { throw 'INSPECT_PERFIL_DISTINTO' }
    Write-Output "INSPECT $($test.Name) / $($test.Profile) OK (sin tráfico)"
}

# Solo fixtures del comparador, nunca evidencia de H5.
$telemetryDir = Join-Path $local 'telemetria-inerte'
$null = New-Item -ItemType Directory -Path $telemetryDir
$baselinePaths = @()
$candidatePaths = @()
$syntheticTime = [DateTime]::UtcNow.AddHours(-1)
$source = Get-K6Provenance 'require-clean' 'PERF-01'

function Save-ComparisonFixture {
    param([string]$Path, $Run, [hashtable]$Overrides = @{})
    $checksum = Save-AutopruebaJson $Path $Run
    "$checksum  summary.json" | Set-Content -Encoding ASCII -LiteralPath (Join-Path (Split-Path -Parent $Path) 'summary.sha256')
    $observation = @{
        schema_version = 1; summary_sha256 = $checksum; subject = $Run.subject; revision = $Run.revision
        backend_sha = $Run.backend_sha; subject_digest = $Run.subject_digest; environment = $Run.environment
        case_id = $Run.case_id; profile = $Run.profile
        interval_start_utc = $Run.metrics.measurement_started_utc; interval_end_utc = $Run.metrics.measurement_ended_utc
        warmup_seconds = 10; cpu_peak_pct = 22; memory_peak_mb = 70; db_connections_peak = 3
    }
    foreach ($key in $Overrides.Keys) { $observation[$key] = $Overrides[$key] }
    $raw = $observation | ConvertTo-Json -Depth 4
    $temp = Join-Path $local 'telemetria-temporal.json'
    $raw | Set-Content -Encoding UTF8 -LiteralPath $temp
    $hash = (Get-FileHash -LiteralPath $temp).Hash.ToLowerInvariant()
    $artifact = Join-Path $telemetryDir "$hash.artifact.json"
    Copy-Item -LiteralPath $temp -Destination $artifact
    $null = Save-AutopruebaJson (Join-Path $telemetryDir "$checksum.json") @{ summary_sha256 = $checksum; telemetry_sha256 = $hash }
    return $artifact
}

foreach ($repetition in 1..3) {
    foreach ($subject in @('baseline', 'candidato')) {
        $isBaseline = $subject -eq 'baseline'
        $letter = if ($isBaseline) { 'b' } else { 'c' }
        $directory = New-Item -ItemType Directory -Path (Join-Path $local "$subject-$repetition")
        $path = Join-Path $directory.FullName 'summary.json'
        $summary = @{
            schema_version = 2; case_id = 'PERF-01'; operation_id = 'listarProductos'
            scope = 'L2_STAGING_APIM'; environment = 'STAGING_APIM'; profile = 'demo-smoke'
            subject = $subject; repetition = $repetition; status = 'PASS'; k6_exit_code = 0
            timestamp_utc = $syntheticTime.ToString('o')
            channel = 'MARKETPLACE'; max_rps = 5; k6_version = '2.4.0'
            docs_sha = $sha; harness_commit = $source.harness_commit; harness_dirty = $false
            harness_tree = $source.harness_tree; harness_files_sha256 = $source.harness_files_sha256
            staging_permit_sha256 = 'e' * 64
            frontend_sha = $sha; backend_sha = $letter * 40; revision = "INERTE-$letter"
            subject_digest = 'sha256:' + ($letter * 64); release_manifest_sha256 = $letter * 64
            comparison_context_sha256 = $contextHash; dataset_sha256 = $datasetHash
            metrics = @{
                observed_max_vus = 1; configured_seconds = 60; elapsed_seconds = 62; iterations = 120
                measurement_started_utc = $syntheticTime.AddSeconds(1).ToString('o')
                measurement_ended_utc = $syntheticTime.AddSeconds(61).ToString('o')
                measured_seconds = 60; valid_2xx = 120; offered_requests = 120
                rps_configured_cap = 5; rps_offered = 2; rps_valid_2xx = 2; client_cap_near = $false
                p50_ms = 30; p95_ms = 50 + $repetition; p99_ms = 60
                negative_401 = 0; critical_checks = 1; unexpected_error_rate = 0
            }
        }
        $null = Save-ComparisonFixture $path $summary
        if ($isBaseline) { $baselinePaths += $path } else { $candidatePaths += $path }
        $syntheticTime = $syntheticTime.AddMinutes(2)
    }
}

function Assert-Comparison {
    param([int]$Code, [string]$Verdict, [string]$Block = '', [string]$Directory = $telemetryDir)
    $result = & (Join-Path $root 'bin/comparar-corridas.ps1') -Baseline $baselinePaths -Candidato $candidatePaths -Telemetria $Directory | ConvertFrom-Json
    if ($LASTEXITCODE -ne $Code -or $result.veredicto -ne $Verdict -or ($Block -and $result.bloqueo -ne $Block)) {
        throw "COMPARADOR_FALLO $Verdict $Block [$($result | ConvertTo-Json -Compress)]"
    }
    return $result
}

$pass = Assert-Comparison 0 'PASS'
if ($pass.baseline_p95_ms -ne 52) { throw 'COMPARADOR_MEDIANA_FALLO' }
$null = Assert-Comparison 3 'INCONCLUSIVE' 'TELEMETRIA_AUSENTE' $local

$single = $baselinePaths[0]
$singleRun = Read-K6DemoJson $single 'AUTOPRUEBA_JSON_INVALIDO'
$actual = Save-ComparisonFixture $single $singleRun
$original = [IO.File]::ReadAllBytes($actual)
[IO.File]::WriteAllBytes($actual, [byte[]]($original + 32))
$null = Assert-Comparison 3 'INCONCLUSIVE' 'TELEMETRIA_HASH_ORIGINAL_DISTINTO'
[IO.File]::WriteAllBytes($actual, $original)
$null = Save-ComparisonFixture $single $singleRun @{ subject = 'candidato' }
$null = Assert-Comparison 3 'INCONCLUSIVE' 'TELEMETRIA_SUJETO_DISTINTO'
$null = Save-ComparisonFixture $single $singleRun @{ interval_end_utc = $singleRun.metrics.measurement_started_utc }
$null = Assert-Comparison 3 'INCONCLUSIVE' 'TELEMETRIA_INTERVALO_NO_CORRESPONDE'
$null = Save-ComparisonFixture $single $singleRun
Write-Output 'COMPARADOR_MEDIANA, TELEMETRIA_AUSENTE, ALTERADA, SUJETO E INTERVALO OK'

foreach ($path in ($baselinePaths + $candidatePaths)) {
    $changed = Read-K6DemoJson $path 'AUTOPRUEBA_JSON_INVALIDO'
    $changed.max_rps = 2
    $changed.metrics.rps_configured_cap = 2
    $changed.metrics.client_cap_near = $true
    $null = Save-ComparisonFixture $path $changed
}
$null = Assert-Comparison 3 'INCONCLUSIVE' 'RPS_CERCA_DEL_LIMITE_CLIENTE'
foreach ($path in $candidatePaths) {
    $changed = Read-K6DemoJson $path 'AUTOPRUEBA_JSON_INVALIDO'
    $changed.metrics.p95_ms = 80
    $changed.metrics.p99_ms = 85
    $null = Save-ComparisonFixture $path $changed
}
$regression = Assert-Comparison 1 'FAIL'
if ($regression.candidato_p95_ms -ne 80) { throw 'COMPARADOR_REGRESION_FALLO' }
Write-Output 'COMPARADOR_TECHO_CLIENTE Y REGRESION_P95 OK'
exit 0
