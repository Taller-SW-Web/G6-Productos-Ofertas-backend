$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\jit-runner-operations.ps1')

function Assert-True([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Get-RequestBody([string]$Json) { [System.Text.Json.JsonDocument]::Parse($Json) }

foreach ($mode in @('Diagnostic','Smoke')) {
    $json = New-GitHubJitRequestJson -Mode $mode -Name 'h5-jit-test' -RunnerGroupId 3
    $doc = Get-RequestBody $json
    try {
        $root = $doc.RootElement
        $labels = $root.GetProperty('labels')
        Assert-True ($labels.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) "$mode labels is not a JSON array"
        Assert-True ($root.GetProperty('runner_group_id').ValueKind -eq [System.Text.Json.JsonValueKind]::Number) 'runner_group_id is not an integer JSON number'
        Assert-True ($root.GetProperty('name').ValueKind -eq [System.Text.Json.JsonValueKind]::String) 'name is not JSON string'
        Assert-True ($root.GetProperty('work_folder').ValueKind -eq [System.Text.Json.JsonValueKind]::String) 'work_folder is not JSON string'
        $actualLabels = @($labels.EnumerateArray() | ForEach-Object GetString)
        if ($mode -eq 'Diagnostic') {
            Assert-True ($actualLabels.Count -eq 1 -and $actualLabels[0] -eq 'h5-runner-preflight-only' -and $actualLabels -notcontains 'azure-h5-smoke') 'Diagnostic labels incorrect or can match CD'
        } else {
            Assert-True ($actualLabels.Count -eq 2 -and $actualLabels -contains 'linux' -and $actualLabels -contains 'azure-h5-smoke') 'Smoke labels incorrect'
        }
    } finally { $doc.Dispose() }
}

$one = @(
    @{name='Desplegar catalog-svc en Azure (catalog-svc)';status='completed';conclusion='success'},
    @{name='Smoke HTTPS posterior al despliegue (catalog-svc)';status='queued';conclusion=$null}
)
$onePlan = Get-SmokeMatrixPlan -Jobs $one
Assert-True ($onePlan.Services.Count -eq 1 -and $onePlan.Services[0] -eq 'catalog-svc') 'one-service smoke plan failed'
Assert-True (@(Get-PendingSmokeServices -SmokeJobs $onePlan.SmokeJobs).Count -eq 1) 'one-service pending job was not selected'

$fiveServices = @('api-gateway','catalog-svc','inventory-svc','pricing-svc','promotions-svc')
$five = @()
foreach ($service in $fiveServices) {
    $five += @{name="Desplegar $service en Azure ($service)";status='completed';conclusion='success'}
    $five += @{name="Smoke HTTPS posterior al despliegue ($service)";status='queued';conclusion=$null}
}
$fivePlan = Get-SmokeMatrixPlan -Jobs $five
Assert-True ($fivePlan.Services.Count -eq 5) 'five-service smoke plan failed'
Assert-True ((Get-PendingSmokeServices -SmokeJobs $fivePlan.SmokeJobs).Count -eq 5) 'five-service pending matrix was not selected'

$jobAssignment = Get-SmokeJobAssignedToRunner -Jobs @(@{name='Smoke HTTPS posterior al despliegue (catalog-svc)';runner_id=77;status='in_progress'}) -RunnerId 77 -PendingServices @('catalog-svc')
Assert-True ($jobAssignment.Service -eq 'catalog-svc') 'runner assignment correlation failed'
try {
    $null = Get-SmokeJobAssignedToRunner -Jobs @(@{name='Smoke HTTPS posterior al despliegue (pricing-svc)';runner_id=77;status='in_progress'}) -RunnerId 77 -PendingServices @('catalog-svc')
    throw 'unexpected assignment accepted'
} catch { if ($_.Exception.Message -notmatch 'SMOKE_RUNNER_ASSIGNMENT_UNEXPECTED') { throw } }

$before=@('old-exec')
$new=Resolve-NewAzureExecutionId -BeforeNames $before -AfterExecutions @(@{name='old-exec'},@{name='new-exec'})
Assert-True ($new -eq 'new-exec') 'Azure execution ID correlation failed'
foreach ($after in @(@(),@(@{name='new-a'},@{name='new-b'}))) {
    try { $null=Resolve-NewAzureExecutionId -BeforeNames $before -AfterExecutions $after; throw 'ambiguous Azure execution accepted' }
    catch { if ($_.Exception.Message -notmatch 'AZURE_EXECUTION_CORRELATION_FAILED') { throw } }
}

$apiErrorJson = '{"message":"Validation Failed","errors":[{"resource":"Runner","field":"labels","code":"invalid"}]}'
$apiError = Get-GitHubJitResponseFields -ResponseText ('HTTP/2.0 422 Unprocessable Entity' + "`r`nContent-Type: application/json`r`n`r`n" + $apiErrorJson)
Assert-True ($apiError.StatusCode -eq 422 -and $apiError.Message -eq 'Validation Failed' -and $apiError.Errors[0].field -eq 'labels') 'JIT error response did not expose only structured safe fields'
$createdResponse = Get-GitHubJitResponseFields -ResponseText ('HTTP/2.0 201 Created' + "`r`nContent-Type: application/json`r`n`r`n" + '{"runner":{"id":123,"labels":[]},"encoded_jit_config":"never-print-this"}')
Assert-True ($createdResponse.StatusCode -eq 201 -and $createdResponse.Json.runner.id -eq 123) 'successful JIT response without error fields was not parsed safely'

$script:registerCount=0;$script:cleanupCount=0;$script:activeCycles=0;$script:maxActive=0
$oneCycle=@(Invoke-SmokeMatrixSequential -Services @('catalog-svc') -RegisterRunner { [pscustomobject]@{Id=1} } -WaitForAssignment { param($runner,$pending) [pscustomobject]@{Service=$pending[0]} } -WaitForJob { 'success' } -WaitForExecution { 'Succeeded' } -CleanupRunner { })
Assert-True ($oneCycle.Count -eq 1 -and $oneCycle[0] -eq 'catalog-svc') 'one-service sequential smoke cycle failed'
$result=Invoke-SmokeMatrixSequential -Services $fiveServices -RegisterRunner {
    $null=$script:registerCount++;$null=$script:activeCycles++;$null=$script:maxActive=[Math]::Max($script:maxActive,$script:activeCycles)
    [pscustomobject]@{Id=$script:registerCount}
} -WaitForAssignment {
    param($runner,$pending)
    $service=[string]$pending[-1] # Deliberately not the original matrix ordering.
    [pscustomobject]@{Service=$service;JobId=100+$runner.Id}
} -WaitForJob {
    param($runner,$assignment)
    'success'
} -WaitForExecution {
    param($runner,$assignment)
    'Succeeded'
} -CleanupRunner {
    param($runner)
    $null=$script:cleanupCount++;$null=$script:activeCycles--
}
Assert-True ($result.Count -eq 5 -and $script:cleanupCount -eq 5 -and $script:maxActive -eq 1 -and $script:activeCycles -eq 0) "five jobs did not run sequentially with cleanup: completed=$($result.Count), cleanup=$script:cleanupCount, maxActive=$script:maxActive, active=$script:activeCycles"

$script:registerCount=0;$script:cleanupCount=0
try {
    $null=Invoke-SmokeMatrixSequential -Services $fiveServices -RegisterRunner { $null=$script:registerCount++;[pscustomobject]@{Id=$script:registerCount} } -WaitForAssignment { param($runner,$pending) [pscustomobject]@{Service=$pending[-1]} } -WaitForJob { param($runner,$assignment) if($script:registerCount -eq 2){'failure'}else{'success'} } -WaitForExecution { 'Succeeded' } -CleanupRunner { $null=$script:cleanupCount++ }
    throw 'intermediate matrix failure was accepted'
} catch { if ($_.Exception.Message -notmatch 'SMOKE_JOB_FAILED' -or $script:registerCount -ne 2 -or $script:cleanupCount -ne 2) { throw } }

try {
    $null=Invoke-SmokeMatrixSequential -Services @('api-gateway') -RegisterRunner { [pscustomobject]@{Id=1} } -WaitForAssignment { param($runner,$pending) [pscustomobject]@{Service=$pending[0]} } -WaitForJob { 'success' } -WaitForExecution { 'Succeeded' } -CleanupRunner { throw 'simulated cleanup failure' }
    throw 'cleanup failure was accepted'
} catch { if ($_.Exception.Message -notmatch 'CLEANUP_INCOMPLETE') { throw } }

Write-Output 'PASS JIT operations: request JSON types, diagnostic/smoke labels, 1/5-service matrix, actual runner assignment, Azure execution correlation, fail-stop and cleanup-incomplete.'
