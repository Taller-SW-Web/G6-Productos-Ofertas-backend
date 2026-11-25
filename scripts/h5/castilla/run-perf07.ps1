param(
  [Parameter(Mandatory=$true)][ValidateSet('baseline','candidate')][string]$Target,
  [Parameter(Mandatory=$true)][ValidateSet('1vu-60s','5vu-3m','20vu-5m')][string]$Profile,
  [Parameter(Mandatory=$true)][string]$Endpoint,
  [Parameter(Mandatory=$true)][string]$Dataset,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$DatasetSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$RunId,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if ($env:H5_LIVE_APPROVED -ne 'true' -or $env:H5_LOAD_APPROVED -ne 'true' -or $env:H5_TEST_IDENTITY -ne 'true' -or $env:H5_DISCARDABLE_DATASET -ne 'true' -or $env:H5_DATASET_RESTORED -ne 'true') {
  throw 'Blocked: explicit approval, load/cost approval, test identity, discardable target and dataset restoration attestation are required.'
}
if (-not $env:H5_BULK_BEARER) { throw 'Blocked: set H5_BULK_BEARER to an authorized test identity; it is never printed.' }
$resolvedDataset = (Resolve-Path -LiteralPath $Dataset).Path
$actualHash = (Get-FileHash -LiteralPath $resolvedDataset -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $DatasetSha256) { throw 'Blocked: dataset SHA-256 does not match supplied manifest.' }
$destination = [Uri]$Endpoint
$allowed = @($env:H5_DESTINATION_ALLOWLIST -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($destination.Scheme -ne 'https' -or $allowed -notcontains $destination.GetLeftPart([UriPartial]::Authority)) { throw 'Blocked: exact HTTPS origin must match H5_DESTINATION_ALLOWLIST.' }
if ($destination.UserInfo -or $destination.Query -or $destination.Fragment) { throw 'Blocked: endpoint cannot contain credentials, query or fragment.' }
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$safeRunId = $RunId.ToLowerInvariant()
$env:H5_BULK_API_URL = $destination.AbsoluteUri
$env:H5_DATASET_PATH = $resolvedDataset
$env:H5_DATASET_SHA256 = $actualHash
$env:H5_RUN_ID = $safeRunId
$env:H5_PERF_PROFILE = $Profile
$env:H5_SUMMARY_PATH = Join-Path $OutputDirectory "perf07-$Target-$Profile-$safeRunId.json"
$env:H5_DATASET_RESTORED = 'true'
Push-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
try {
  & k6 run 'scripts/h5/castilla/perf07-k6.js'
  if ($LASTEXITCODE -ne 0) { throw "k6 exited with code $LASTEXITCODE" }
} finally { Pop-Location }
Write-Output "Run complete; verify artifact SHA and service CPU/RAM telemetry separately: $env:H5_SUMMARY_PATH"
