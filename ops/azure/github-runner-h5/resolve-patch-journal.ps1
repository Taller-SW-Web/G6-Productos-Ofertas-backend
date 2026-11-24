[CmdletBinding()]
param(
    [string]$SubscriptionId = 'fef42188-accd-4470-ae88-78f583eb4906',
    [string]$ResourceGroup = 'rg-g6-sb-h5-int-fork',
    [string]$JobName = 'azure-h5-smoke'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'aca-job-secret-patch.ps1')

$expectedSubscription = 'fef42188-accd-4470-ae88-78f583eb4906'
$expectedGroup = 'rg-g6-sb-h5-int-fork'
$expectedJob = 'azure-h5-smoke'
if ($SubscriptionId -cne $expectedSubscription -or $ResourceGroup -cne $expectedGroup -or $JobName -cne $expectedJob) {
    throw 'PATCH_JOURNAL_TARGET_REJECTED: recovery is limited to the authorized H5 Job and subscription.'
}

$account = az account show --subscription $SubscriptionId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or [string]$account.id -cne $SubscriptionId) {
    throw 'PATCH_JOURNAL_SUBSCRIPTION_MISMATCH: Azure CLI context is not the authorized subscription.'
}
$resource = az containerapp job show --subscription $SubscriptionId --resource-group $ResourceGroup --name $JobName --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'PATCH_JOURNAL_JOB_READ_FAILED: could not read the authorized Job.' }
$environmentId = [string]$resource.properties.environmentId
$containers = @($resource.properties.template.containers)
if ($containers.Count -ne 1) { throw 'PATCH_JOURNAL_JOB_TEMPLATE_REJECTED: expected one runner container.' }
$image = [string]$containers[0].image
$tokenResponse = az account get-access-token --subscription $SubscriptionId --resource https://management.azure.com/ --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$tokenResponse.accessToken)) {
    throw 'PATCH_JOURNAL_TOKEN_UNAVAILABLE: Azure CLI could not provide an ARM token.'
}
$uri = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.App/jobs/$JobName?api-version=2025-07-01"
try {
    $results = @(Resolve-AcaPatchJournalOperations -Token ([string]$tokenResponse.accessToken) -Uri $uri -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $environmentId -ExpectedImage $image)
    foreach ($result in $results) {
        [pscustomobject]@{attemptId=$result.AttemptId;state=$result.State;readback=$result.Readback;error=$result.Error}
    }
    if ($results.Count -eq 0) { [pscustomobject]@{state='NO_PENDING_LOCAL_PATCH_OPERATIONS'} }
} finally {
    $tokenResponse = $null
}
