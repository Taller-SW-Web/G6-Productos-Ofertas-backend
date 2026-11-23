function Get-AzureWhatIfChanges {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Json)
  try { $document = $Json | ConvertFrom-Json -ErrorAction Stop } catch { throw 'AZURE_WHATIF_INVALID_JSON' }
  if ($document.status -ne 'Succeeded' -or $null -eq $document.properties -or $null -eq $document.properties.changes) {
    throw 'AZURE_WHATIF_INCOMPLETE_RESULT'
  }
  $changes = @($document.properties.changes)
  if ($changes.Count -eq 0) { throw 'AZURE_WHATIF_EMPTY_CHANGES' }
  foreach ($change in $changes) {
    if ($change.resourceId -isnot [string] -or [string]::IsNullOrWhiteSpace($change.resourceId) -or
        $change.changeType -isnot [string] -or $change.changeType -notin @('Create','Modify','Ignore','NoChange','Delete','Deploy','Unsupported')) {
      throw 'AZURE_WHATIF_CHANGE_INVALID'
    }
  }
  return $changes
}

function Assert-AcaWhatIfScope {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Json, [Parameter(Mandatory)][string[]]$ExpectedResourceIds,
    [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ExistingResourceIds)
  $changes = @(Get-AzureWhatIfChanges $Json)
  $badTypes = @($changes | Where-Object changeType -in @('Delete','Deploy','Unsupported'))
  if ($badTypes.Count) { throw 'H5_ACA_WHAT_IF_UNCERTIFIABLE_CHANGE_TYPE' }
  $unexpected = @($changes | Where-Object { $_.changeType -in @('Create','Modify') -and $_.resourceId -notin $ExpectedResourceIds })
  if ($unexpected.Count) { throw 'H5_ACA_WHAT_IF_RESOURCE_OUT_OF_SCOPE' }
  foreach ($resourceId in $ExpectedResourceIds) {
    $entry = @($changes | Where-Object resourceId -eq $resourceId)
    if ($entry.Count -ne 1) { throw 'H5_ACA_WHAT_IF_SERVICE_SET_INCOMPLETE' }
    if ($resourceId -in $ExistingResourceIds) {
      if ($entry[0].changeType -notin @('Ignore','NoChange')) { throw 'H5_ACA_WHAT_IF_EXISTING_APP_CHANGE_UNEXPECTED' }
    } elseif ($entry[0].changeType -ne 'Create') { throw 'H5_ACA_WHAT_IF_INITIAL_CREATE_SET_INVALID' }
  }
  $scope = @($ExpectedResourceIds)
  if (@($changes | Where-Object { $_.resourceId -notin $scope -and $_.changeType -notin @('Ignore','NoChange') }).Count) {
    throw 'H5_ACA_WHAT_IF_RESOURCE_OUT_OF_SCOPE'
  }
  return $true
}

function Assert-N01WhatIfScope {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Json, [Parameter(Mandatory)][string]$ExpectedResourceId, [Parameter(Mandatory)][string]$ContainerGroupName)
  if ($ContainerGroupName -notmatch '^h5-n01-[a-zA-Z0-9-]+$' -or $ExpectedResourceId -notmatch "/containerGroups/$([regex]::Escape($ContainerGroupName))$") {
    throw 'N01_WHAT_IF_EXPECTED_RESOURCE_INVALID'
  }
  $changes = @(Get-AzureWhatIfChanges $Json)
  if (@($changes | Where-Object changeType -in @('Delete','Deploy','Unsupported')).Count) { throw 'N01_WHAT_IF_CHANGE_TYPE_INVALID' }
  $targetChanges = @($changes | Where-Object resourceId -ceq $ExpectedResourceId)
  $creates = @($targetChanges | Where-Object changeType -eq 'Create')
  if ($targetChanges.Count -ne 1 -or $creates.Count -ne 1) { throw 'N01_WHAT_IF_UNEXPECTED_RESOURCE_CHANGE' }
  if (@($changes | Where-Object { $_.resourceId -cne $ExpectedResourceId -and $_.changeType -notin @('Ignore','NoChange') }).Count) {
    throw 'N01_WHAT_IF_RESOURCE_OUT_OF_SCOPE'
  }
  return $true
}

Export-ModuleMember -Function Get-AzureWhatIfChanges, Assert-AcaWhatIfScope, Assert-N01WhatIfScope
