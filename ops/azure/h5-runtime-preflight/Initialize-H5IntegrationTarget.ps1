[CmdletBinding()]
param(
  [string]$Path = (Join-Path $env:LOCALAPPDATA 'G6\h5-runtime-preflight\h5-integration-target.private.json')
)

$ErrorActionPreference = 'Stop'
$example = Join-Path $PSScriptRoot 'h5-integration-target.private.example.json'
$resolvedPath = [System.IO.Path]::GetFullPath($Path)
$folder = [System.IO.Path]::GetDirectoryName($resolvedPath)
New-Item -ItemType Directory -Path $folder -Force | Out-Null
if (-not (Test-Path -LiteralPath $resolvedPath)) {
  Copy-Item -LiteralPath $example -Destination $resolvedPath
} else {
  $existing = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
  if ($null -eq $existing.services) { throw 'Existing H5 integration target has an unknown format; preserved without modification.' }
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $resolvedPath /inheritance:r /grant:r "${identity}:(F)" 'NT AUTHORITY\SYSTEM:(F)' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict H5 target ACL; do not populate the file.' }
Write-Output "Private H5 preparation target ready: $resolvedPath"
Write-Output 'The file contains placeholders and remains PENDING_APPROVAL until approved target values are supplied.'
