$ErrorActionPreference = 'Stop'
$wrapper = Join-Path $PSScriptRoot 'run-h5-five-apps-whatif.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('h5-aca-gate-test-' + [guid]::NewGuid().ToString('N'))
$fakeBin = Join-Path $tempRoot 'bin'
$parameterFile = Join-Path $tempRoot 'invalid-parameters.json'
$callLog = Join-Path $tempRoot 'azure-command-was-called.txt'
New-Item -ItemType Directory -Path $fakeBin -Force | Out-Null
@'
@echo off
echo called>>"%AZ_H5_FAKE_AZ_LOG%"
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $fakeBin 'az.cmd') -Encoding ascii
@'
{"parameters":{"sourceSha":{"value":"not-authorized"}}}
'@ | Set-Content -LiteralPath $parameterFile -Encoding ascii

$oldPath = $env:PATH
$oldLog = $env:AZ_H5_FAKE_AZ_LOG
$azureCalled = $false
try {
  $env:PATH = "$fakeBin;$oldPath"
  $env:AZ_H5_FAKE_AZ_LOG = $callLog
  & pwsh -NoProfile -File $wrapper -ParametersFile $parameterFile *> $null
  $exitCode = $LASTEXITCODE
} finally {
  $azureCalled = Test-Path -LiteralPath $callLog
  $env:PATH = $oldPath
  if ($null -eq $oldLog) { Remove-Item Env:AZ_H5_FAKE_AZ_LOG -ErrorAction SilentlyContinue }
  else { $env:AZ_H5_FAKE_AZ_LOG = $oldLog }
  Remove-Item -LiteralPath $tempRoot -Force -Recurse -ErrorAction SilentlyContinue
}

if ($exitCode -eq 0) { throw 'TEST_INVALID_PARAMETERS_ACCEPTED' }
if ($azureCalled) { throw 'TEST_AZURE_WHAT_IF_RAN_BEFORE_VALIDATION' }
Write-Output 'H5_ACA_WHAT_IF_GATE_TEST_PASS'
