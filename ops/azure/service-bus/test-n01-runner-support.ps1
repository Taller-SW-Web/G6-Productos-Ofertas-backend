$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'n01-runner-support.psm1') -Force

$sha = 'fcf3dd983f5436221670e8c6a113fdd15cb76de9'
$terminal = [pscustomobject]@{
  sha = $sha
  message_id = 'message-test'
  correlation_id = 'correlation-test'
  operation_id = 'operation-test'
  terminal = 'REJECTED'
  result_code = 'COUPON_IDENTITY_MISMATCH'
}
$sql = [pscustomobject]@{
  sha = $sha
  message_id = 'message-test'
  correlation_id = 'correlation-test'
  operation_id = 'operation-test'
  inbox_rows = 1
  receipt_rows = 1
  coupon_effects = 0
  outbox_attempts = 1
  outbox_sent = $true
}
if (-not (Assert-N01EvidenceBinding -TerminalEvent $terminal -SqlEvent $sql -ExpectedSha $sha)) {
  throw 'TEST_EVIDENCE_BINDING_VALID_FAILED'
}

foreach ($field in @('sha', 'message_id', 'correlation_id', 'operation_id')) {
  $mismatch = $sql.PSObject.Copy()
  $mismatch.$field = 'mismatch'
  $failed = $false
  try {
    Assert-N01EvidenceBinding -TerminalEvent $terminal -SqlEvent $mismatch -ExpectedSha $sha | Out-Null
  } catch {
    $failed = $_.Exception.Message -like 'N01_EVIDENCE_BINDING_MISMATCH*'
  }
  if (-not $failed) { throw "TEST_EVIDENCE_BINDING_MISMATCH_NOT_REJECTED_$field" }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('n01-cleanup-test-' + [guid]::NewGuid().ToString('N'))
$tempFile = Join-Path $tempRoot 'private-parameters.json'
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
Set-Content -LiteralPath $tempFile -Value 'private-test-data'

$state = [pscustomobject]@{ ListCalls = 0; DeleteCalls = 0 }
$azureFailsCleanup = {
  param([string[]] $Arguments)
  if ($Arguments[1] -eq 'list') {
    $state.ListCalls++
    $global:LASTEXITCODE = 1
    return ''
  }
  if ($Arguments[1] -eq 'delete') {
    $state.DeleteCalls++
    $global:LASTEXITCODE = 1
    return ''
  }
  throw 'TEST_UNEXPECTED_AZURE_COMMAND'
}
$cleanup = Invoke-N01Cleanup -ResourceGroup 'isolated-test' -ContainerGroupName 'temporary-test' `
  -ContainerDeploymentAttempted $true -TemporaryPaths @($tempFile, $tempRoot) `
  -AzureCommand $azureFailsCleanup
if ($cleanup.Succeeded -or $cleanup.Errors -notcontains 'N01_CLEANUP_STATE_QUERY_FAILED' -or
    $cleanup.Errors -notcontains 'N01_CLEANUP_ACI_DELETE_FAILED' -or
    $cleanup.Errors -notcontains 'N01_CLEANUP_VERIFY_FAILED') {
  throw 'TEST_AZURE_CLEANUP_ERRORS_NOT_REPORTED'
}
if (Test-Path -LiteralPath $tempRoot) { throw 'TEST_TEMPORARY_DATA_NOT_DELETED_AFTER_AZURE_FAILURE' }
if ($state.DeleteCalls -ne 1) { throw 'TEST_DELETE_NOT_ATTEMPTED_AFTER_LIST_FAILURE' }

$originalError = $null
try { throw 'N01_SIMULATED_PRIMARY_ERROR' } catch { $originalError = $_ }
$oldConsoleError = [Console]::Error
$errorOutput = [System.IO.StringWriter]::new()
$outcomeMessage = $null
$cleanupMessageOutput = ''
try {
  [Console]::SetError($errorOutput)
  Complete-N01RunOutcome -OriginalError $originalError -CleanupErrors @('N01_CLEANUP_ACI_DELETE_FAILED')
} catch {
  $outcomeMessage = $_.Exception.Message
} finally {
  [Console]::SetError($oldConsoleError)
  $cleanupMessageOutput = $errorOutput.ToString()
  $errorOutput.Dispose()
}
if ($outcomeMessage -ne 'N01_SIMULATED_PRIMARY_ERROR') {
  throw 'TEST_CLEANUP_ERROR_MASKED_ORIGINAL_ERROR'
}
if ($cleanupMessageOutput -notlike '*N01_CLEANUP_ACI_DELETE_FAILED*') {
  throw 'TEST_CLEANUP_ERROR_NOT_VISIBLE'
}

Write-Output 'N01_RUNNER_SUPPORT_TESTS_PASS'
