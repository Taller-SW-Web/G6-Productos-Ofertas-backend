[CmdletBinding()]
param(
    [ValidateSet('brazil-isolated','chile-shared')][string]$Destination = 'brazil-isolated',
    [string]$SubscriptionId,
    [string]$ResourceGroup,
    [string]$EnvironmentName,
    [string]$JobName
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deployment-targets.ps1')
. (Join-Path $PSScriptRoot 'aca-job-secret-patch.ps1')
. (Join-Path $PSScriptRoot 'jit-local-state.ps1')

$target=Resolve-H5DeploymentTarget -Destination $Destination
foreach($override in @(@{Name='SubscriptionId';Value=$SubscriptionId;Expected=$target.SubscriptionId},@{Name='ResourceGroup';Value=$ResourceGroup;Expected=$target.ResourceGroup},@{Name='EnvironmentName';Value=$EnvironmentName;Expected=$target.AcaEnvironment},@{Name='JobName';Value=$JobName;Expected=$target.JobName})) {
    if(-not [string]::IsNullOrWhiteSpace([string]$override.Value)) { Assert-H5DestinationOverride -Name $override.Name -Value $override.Value -Expected $override.Expected }
}
$targetResourceId=Get-H5JitResourceId -Target $target
$statePaths=Get-H5JitLocalStatePaths -Target $target
foreach($entry in @(@{Path=$statePaths.LegacyCleanupMarker;Type='CLEANUP_INCOMPLETE'},@{Path=$statePaths.LegacyAttemptRecord;Type='JIT_ATTEMPT'})) {
    if(Test-Path -LiteralPath $entry.Path) { $null=Get-H5LegacyRecordResourceId -Path $entry.Path -RecordType $entry.Type }
}

# Validate both complete local journals before any ARM reads. Exact prior legacy
# reconciliations are idempotently excluded; observations remain pending.
$legacyOperations=@(Get-H5LegacyJournalOperations -Path $statePaths.LegacyPatchJournal)
$resolutions=@(Get-H5LegacyJournalResolutions -Path $statePaths.PatchJournal -ResourceId $targetResourceId)
$legacyPending=@(Get-H5LegacyPendingOperations -Operations $legacyOperations -Resolutions $resolutions -ResourceId $targetResourceId)
$scopedPending=@(Get-AcaPatchJournalPendingOperations -ResourceId $targetResourceId -Path $statePaths.PatchJournal)
$work=@()
if($legacyPending.Count -gt 0) { $work+=@([pscustomobject]@{Operations=$legacyPending;LegacySource=$true}) }
if($scopedPending.Count -gt 0) { $work+=@([pscustomobject]@{Operations=$scopedPending;LegacySource=$false}) }
if($work.Count -eq 0) {
    [pscustomobject]@{destination=$Destination;resourceId=$targetResourceId;state='NO_PENDING_LOCAL_PATCH_OPERATIONS'}
    return
}

$account=az account show --subscription $target.SubscriptionId --output json | ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or [string]$account.id -cne [string]$target.SubscriptionId) { throw 'PATCH_JOURNAL_SUBSCRIPTION_MISMATCH: Azure CLI context does not match the selected destination.' }
$resource=az containerapp job show --subscription $target.SubscriptionId --resource-group $target.ResourceGroup --name $target.JobName --output json | ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or [string]$resource.id -ine $targetResourceId) { throw 'PATCH_JOURNAL_JOB_READ_FAILED: exact destination Job resource could not be verified.' }
$managed=az containerapp env show --subscription $target.SubscriptionId --resource-group $target.ResourceGroup --name $target.AcaEnvironment --output json | ConvertFrom-Json
if($LASTEXITCODE -ne 0) { throw 'PATCH_JOURNAL_ENVIRONMENT_READ_FAILED: destination Environment could not be read.' }
Assert-H5AcaJobBinding -Job $resource -ManagedEnvironment $managed -Target $target
$containers=@($resource.properties.template.containers)
if($containers.Count -ne 1 -or [string]$containers[0].image -notmatch '^ghcr\.io/actions/actions-runner@sha256:[0-9a-f]{64}$') { throw 'PATCH_JOURNAL_JOB_TEMPLATE_REJECTED: expected one digest-pinned official runner container.' }
if((@($containers[0].command)-join ' ') -cne '/bin/bash -c' -or (@($containers[0].args)-join ' ') -notmatch 'run\.sh --jitconfig') { throw 'PATCH_JOURNAL_JOB_TEMPLATE_REJECTED: expected the official run.sh --jitconfig entry point.' }
$image=[string]$containers[0].image

$tokenResponse=az account get-access-token --subscription $target.SubscriptionId --resource https://management.azure.com/ --output json | ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$tokenResponse.accessToken)) { throw 'PATCH_JOURNAL_TOKEN_UNAVAILABLE: Azure CLI could not provide an ARM token.' }
$uri="https://management.azure.com${targetResourceId}?api-version=2025-07-01"
try {
    foreach($journal in $work) {
        $sourcePath=if($journal.LegacySource){$statePaths.LegacyPatchJournal}else{$statePaths.PatchJournal}
        $results=@(Resolve-AcaPatchJournalOperations -Token ([string]$tokenResponse.accessToken) -Uri $uri -JobName $target.JobName -ResourceGroup $target.ResourceGroup -EnvironmentId ([string]$resource.properties.environmentId) -ExpectedImage $image -ResourceId $targetResourceId -EvidenceJournalPath $statePaths.PatchJournal -SourceJournalPath $sourcePath -Operations @($journal.Operations) -LegacySource:$journal.LegacySource)
        foreach($result in $results) { [pscustomobject]@{destination=$Destination;resourceId=$targetResourceId;attemptId=$result.AttemptId;state=$result.State;readback=$result.Readback;error=$result.Error} }
    }
} finally {
    $tokenResponse=$null
    Set-AcaPatchJournalPathOverride $statePaths.PatchJournal
}
