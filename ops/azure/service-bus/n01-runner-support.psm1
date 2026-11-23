function Assert-N01EvidenceBinding {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [object] $TerminalEvent,
    [Parameter(Mandatory)] [object] $SqlEvent,
    [Parameter(Mandatory)] [string] $ExpectedSha
  )

  $pairs = @(
    @($TerminalEvent.sha, $SqlEvent.sha, 'SHA'),
    @($TerminalEvent.message_id, $SqlEvent.message_id, 'MessageId'),
    @($TerminalEvent.correlation_id, $SqlEvent.correlation_id, 'CorrelationId'),
    @($TerminalEvent.operation_id, $SqlEvent.operation_id, 'OperationId')
  )
  foreach ($pair in $pairs) {
    if (-not $pair[0] -or -not $pair[1] -or $pair[0] -cne $pair[1]) {
      throw "N01_EVIDENCE_BINDING_MISMATCH_$($pair[2])"
    }
  }
  if ($TerminalEvent.sha -cne $ExpectedSha -or $SqlEvent.sha -cne $ExpectedSha) {
    throw 'N01_EVIDENCE_BINDING_MISMATCH_AUTHORIZED_SHA'
  }
  return $true
}

function Invoke-N01Cleanup {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string] $ResourceGroup,
    [Parameter(Mandatory)] [string] $ContainerGroupName,
    [Parameter(Mandatory)] [bool] $ContainerDeploymentAttempted,
    [Parameter(Mandatory)] [string[]] $TemporaryPaths,
    [Parameter()] [scriptblock] $AzureCommand = { param([string[]] $Arguments) & az @Arguments }
  )

  $cleanupErrors = [System.Collections.Generic.List[string]]::new()
  if ($ContainerDeploymentAttempted) {
    $initialQuerySucceeded = $false
    $containerExists = $false
    try {
      $listArguments = @('container', 'list', '--resource-group', $ResourceGroup, '--output', 'json')
      $listOutput = & $AzureCommand $listArguments | Out-String
      if ($LASTEXITCODE -ne 0) { throw 'AZURE_LIST_FAILED' }
      $initialQuerySucceeded = $true
      $groups = @($listOutput | ConvertFrom-Json -ErrorAction Stop)
      $containerExists = @($groups | Where-Object name -eq $ContainerGroupName).Count -gt 0
    } catch {
      $cleanupErrors.Add('N01_CLEANUP_STATE_QUERY_FAILED')
    }

    if ($containerExists -or -not $initialQuerySucceeded) {
      try {
        $deleteArguments = @('container', 'delete', '--name', $ContainerGroupName, '--resource-group', $ResourceGroup, '--yes', '--output', 'none')
        $null = & $AzureCommand $deleteArguments
        if ($LASTEXITCODE -ne 0) { throw 'AZURE_DELETE_FAILED' }
      } catch {
        $cleanupErrors.Add('N01_CLEANUP_ACI_DELETE_FAILED')
      }
    }

    try {
      $verifyArguments = @('container', 'list', '--resource-group', $ResourceGroup, '--output', 'json')
      $verifyOutput = & $AzureCommand $verifyArguments | Out-String
      if ($LASTEXITCODE -ne 0) { throw 'AZURE_VERIFY_FAILED' }
      $remaining = @($verifyOutput | ConvertFrom-Json -ErrorAction Stop)
      if (@($remaining | Where-Object name -eq $ContainerGroupName).Count -ne 0) {
        $cleanupErrors.Add('N01_CLEANUP_ACI_REMAINS')
      }
    } catch {
      $cleanupErrors.Add('N01_CLEANUP_VERIFY_FAILED')
    }
  }

  foreach ($path in $TemporaryPaths) {
    if (-not $path) { continue }
    try {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -Recurse -ErrorAction Stop
      }
    } catch {
      $cleanupErrors.Add('N01_CLEANUP_TEMPORARY_FILE_FAILED')
    }
  }

  [pscustomobject]@{
    Succeeded = $cleanupErrors.Count -eq 0
    Errors = @($cleanupErrors | Select-Object -Unique)
  }
}

function Complete-N01RunOutcome {
  [CmdletBinding()]
  param(
    [Parameter()] [System.Management.Automation.ErrorRecord] $OriginalError,
    [Parameter()] [string[]] $CleanupErrors = @()
  )

  if ($CleanupErrors.Count -gt 0) {
    $cleanupMessage = "N01_CLEANUP_ERRORS: $($CleanupErrors -join ',')"
    if ($OriginalError) {
      [Console]::Error.WriteLine($cleanupMessage)
      throw $OriginalError
    }
    throw $cleanupMessage
  }
  if ($OriginalError) { throw $OriginalError }
}

Export-ModuleMember -Function Assert-N01EvidenceBinding, Invoke-N01Cleanup, Complete-N01RunOutcome
