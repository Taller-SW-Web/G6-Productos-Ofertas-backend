[CmdletBinding()]
param(
  [string]$Path = (Join-Path $env:LOCALAPPDATA 'G6\h5-runtime-preflight\parameters.private.json')
)

$ErrorActionPreference = 'Stop'
$example = Join-Path $PSScriptRoot 'parameters.private.example.json'
$resolvedPath = [System.IO.Path]::GetFullPath($Path)
$folder = [System.IO.Path]::GetDirectoryName($resolvedPath)
New-Item -ItemType Directory -Path $folder -Force | Out-Null
if (-not (Test-Path -LiteralPath $resolvedPath)) {
  Copy-Item -LiteralPath $example -Destination $resolvedPath
} else {
  $existing = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
  if ($null -ne $existing.parameters) {
    # Preserve a populated deployment-parameters file exactly as supplied.
  } elseif ($existing.formatVersion -eq 1) {
    $legacySecrets = @(
      $existing.ghcrPull.token,
      $existing.g7.promotionsSvcClientSecret,
      $existing.services.'catalog-svc'.PGPASSWORD,
      $existing.services.'inventory-svc'.PGPASSWORD,
      $existing.services.'pricing-svc'.DATABASE_URL,
      $existing.services.'promotions-svc'.PGPASSWORD,
      $existing.services.'promotions-svc'.PROMOTIONS_SERVICE_CLIENT_SECRET,
      $existing.services.'promotions-svc'.PROMOTIONS_H5_SERVICE_CLIENT_SECRET
    )
    if (@($legacySecrets | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
      throw 'Legacy private manifest contains values; preserved without modification. Migrate it manually in the private directory.'
    }
    Copy-Item -LiteralPath $example -Destination $resolvedPath -Force
  } else {
    throw 'Existing private manifest uses an unknown format; preserved without modification.'
  }
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $resolvedPath /inheritance:r /grant:r "${identity}:(F)" 'NT AUTHORITY\SYSTEM:(F)' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict private-manifest ACL; do not populate the file.' }
Write-Output "Private manifest ready: $resolvedPath"
Write-Output 'Template values are blank/placeholders; no credential was created or copied.'
