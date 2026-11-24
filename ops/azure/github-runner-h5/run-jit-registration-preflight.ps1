param(
    [string]$Organization = 'Taller-SW-Web',
    [string]$Repository = 'Taller-SW-Web/G6-Productos-Ofertas-backend',
    [ValidateSet('brazil-isolated','chile-shared')][string]$Destination = 'brazil-isolated',
    [string]$ResourceGroup,
    [string]$EnvironmentName,
    [string]$Region,
    [string]$JobName,
    [int]$RunnerGroupId = 3,
    [int]$OnlineTimeoutSeconds = 180,
    [ValidateSet('Diagnostic','Smoke')][string]$Mode = 'Diagnostic',
    [long]$WorkflowRunId = 0,
    [int]$JobCompletionTimeoutSeconds = 1800
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'deployment-targets.ps1')
$deploymentTargets = Get-H5DeploymentTargets
$destinationTarget = Resolve-H5DeploymentTarget -Destination $Destination
if ($RunnerGroupId -ne $destinationTarget.RunnerGroupId) { throw 'RunnerGroupId override does not match the destination configuration.' }
foreach ($override in @(@{Name='ResourceGroup';Value=$ResourceGroup;Expected=$destinationTarget.ResourceGroup},@{Name='EnvironmentName';Value=$EnvironmentName;Expected=$destinationTarget.AcaEnvironment},@{Name='Region';Value=$Region;Expected=$destinationTarget.Region},@{Name='JobName';Value=$JobName;Expected=$destinationTarget.JobName})) {
    if ($override.Value -and $override.Value -cne $override.Expected) { throw "$($override.Name) override no coincide con el destino $Destination." }
}
$ResourceGroup = $destinationTarget.ResourceGroup
$EnvironmentName = $destinationTarget.AcaEnvironment
$Region = $destinationTarget.Location
$JobName = $destinationTarget.JobName
$RunnerGroupId = $destinationTarget.RunnerGroupId
$SmokeLabel = $destinationTarget.SmokeLabel
$GitHubEnvironment = $destinationTarget.GitHubEnvironment
$diagnosticLabel = 'h5-runner-preflight-only'
$workflowPath = "$Repository/.github/workflows/cd-services-azure.yml"
$expectedWorkflow = "$workflowPath@refs/heads/master"
$jitRunnerId = $null
$jitRunnerName = $null
$jitRegistrationAccepted = $false
$jobExecutionName = $null
$jitConfig = $null
$templateFile = $null
$subscriptionId = $null
$jobSecretInstalled = $false
$jobPatchOutcomeAmbiguous = $false
$jobSecretName = 'h5jit'
$registrationOnline = $false
$jitSecretTouched = $false
$cleanupWasRun = $false
$jobStartAttempted = $false
$stage = 'initialization'
$expectedImage = $null
$expectedEnvironmentId = $null
$armUri = $null
$armToken = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$executionNamesBefore = @()
$executionCorrelationFailed = $false
$cleanupMarker = Join-Path (Join-Path $env:LOCALAPPDATA 'G6\azure-h5-smoke') 'CLEANUP_INCOMPLETE.json'
$attemptRecordPath = Join-Path (Split-Path -Parent $cleanupMarker) 'JIT_ATTEMPT.json'
$jitRegistrationAttempted = $false
$jitRunnerAbsenceVerified = $false

. (Join-Path $PSScriptRoot 'aca-job-secret-patch.ps1')
. (Join-Path $PSScriptRoot 'jit-runner-operations.ps1')

function Invoke-GhJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & gh @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "GitHub API call failed: $($Arguments[0]) (exit $LASTEXITCODE)." }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $effectiveArguments = @($Arguments)
    if ($subscriptionId -and $effectiveArguments -notcontains '--subscription') { $effectiveArguments += @('--subscription',$subscriptionId) }
    $output = & az @effectiveArguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI call failed: $($Arguments[0]) (exit $LASTEXITCODE). $($output -join ' ')" }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Get-ArmRequestContext {
    if ([string]::IsNullOrWhiteSpace($subscriptionId)) {
        $script:subscriptionId = [string](& az account show --query id --output tsv 2>$null)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($subscriptionId)) { throw 'Could not resolve the active Azure subscription for the protected JIT secret operation.' }
    }
    $tokenOutput = & az account get-access-token --resource https://management.azure.com/ --subscription $subscriptionId --query accessToken --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($tokenOutput -join ''))) { throw 'Could not obtain an Azure management token for the protected JIT secret operation.' }
    $uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.App/jobs/${JobName}?api-version=2025-07-01"
    return [pscustomobject]@{Token=($tokenOutput -join '');Uri=$uri}
}

function Set-TemporaryJobSecret {
    param([Parameter(Mandatory)][string]$Value)
    try {
        $null = Add-AcaJobSecret -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage -SecretName $jobSecretName -SecretValue $Value
        $script:jobSecretInstalled = $true
    } catch {
        $patchFailure = $_.Exception.Message
        if ($script:AcaLastPatchOutcome -eq 'Ambiguous') { $script:jobPatchOutcomeAmbiguous = $true }
        try {
            $verification = Get-AcaJobSnapshot -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage
            $script:jobSecretInstalled = @($verification.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name -eq $jobSecretName }).Count -gt 0
            Write-AcaPatchJournalEvent -EventType Readback -ReadbackResult $(if($script:jobSecretInstalled){'VerifiedPresent'}else{'VerifiedAbsent'})
        } catch {
            try { Write-AcaPatchJournalEvent -EventType Readback -ReadbackResult 'Unverified' } catch { }
            $script:jobSecretInstalled = $true
            Write-Warning "CLEANUP REQUIRED: could not verify whether temporary Job secret '$jobSecretName' persisted."
        }
        throw $patchFailure
    }
}

function Remove-TemporaryJobSecret {
    if (-not $jobSecretInstalled -and -not $jitSecretTouched) { return }
    try {
        if ($jobPatchOutcomeAmbiguous) { throw 'ARM_PATCH_OUTCOME_AMBIGUOUS: previous Job secret PATCH must be reconciled before another PATCH.' }
        if (-not $armUri -or -not $armToken -or -not $expectedEnvironmentId -or -not $expectedImage) {
            $context = Get-ArmRequestContext
            $script:armUri = $context.Uri
            $script:armToken = $context.Token
        }
        $null = Remove-AcaJobSecret -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage -SecretName $jobSecretName
        $script:jobSecretInstalled = $false
        $script:jitSecretTouched = $false
        $script:jobPatchOutcomeAmbiguous = $false
        Write-Output 'PASS no temporary JIT secret remained in Azure.'
    } catch {
        if ($script:AcaLastPatchOutcome -eq 'Ambiguous') { $script:jobPatchOutcomeAmbiguous = $true }
        $script:cleanupFailures.Add('temporary Job secret absent check failed')
        Write-Warning "CLEANUP_INCOMPLETE: temporary Job secret absence could not be confirmed. $($_.Exception.Message)"
    }
}

function New-RestrictedTemplateFile {
    param([Parameter(Mandatory)][string]$Content)
    if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.yaml')
        [System.IO.File]::WriteAllText($path, $Content, [System.Text.UTF8Encoding]::new($false))
        & chmod 600 -- $path
        if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $path -Force; throw 'Could not restrict temporary JIT template permissions.' }
        return $path
    }
    if (-not $env:USERPROFILE) { throw 'Could not establish a protected temporary directory for JIT configuration.' }
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.yaml')
    $null = [System.IO.File]::Create($path).Dispose()
    $acl = Get-Acl -LiteralPath $path
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $path -AclObject $acl
    [System.IO.File]::WriteAllText($path, $Content, [System.Text.UTF8Encoding]::new($false))
    return $path
}

function Remove-JitRegistration {
    $script:cleanupFailures.Clear()
    $script:cleanupWasRun = $true
    $executionState = [pscustomobject]@{State='Unknown';Status=''}
    if (-not $jobExecutionName -and $jobStartAttempted) { $script:cleanupFailures.Add('CLEANUP_INCOMPLETE: Azure start was attempted but its execution ID was not correlated unequivocally') }
    if ($jitRegistrationAttempted -and $jitRunnerName) {
        try {
            $groupRunners = Invoke-GhJson @('api',"orgs/$Organization/actions/runner-groups/$RunnerGroupId/runners?per_page=100")
            $reconciliation = Resolve-JitRunnerRegistration -RunnerName $jitRunnerName -QuerySucceeded $true -Runners @($groupRunners.runners)
            if ($reconciliation.State -eq 'Found') { $script:jitRunnerId = [int]$reconciliation.RunnerId }
            elseif ($reconciliation.State -eq 'Ambiguous') { $script:cleanupFailures.Add("multiple JIT registrations named $jitRunnerName cannot be cleaned safely") }
            elseif ($reconciliation.State -eq 'Absent') { $script:jitRunnerAbsenceVerified = $true }
            else { $script:cleanupFailures.Add('JIT registration absence could not be verified from the authorized runner group') }
        } catch { $script:cleanupFailures.Add('JIT registration attempt could not be reconciled by exact name in the authorized runner group') }
    }
    if ($jitRunnerId) {
        $null = & gh api --method DELETE "orgs/$Organization/actions/runners/$jitRunnerId" 2>$null
        $runnerAbsent = $false
        for ($attempt = 0; $attempt -lt 6; $attempt++) {
            try {
                $groupRunners = Invoke-GhJson @('api',"orgs/$Organization/actions/runner-groups/$RunnerGroupId/runners?per_page=100")
                if (@($groupRunners.runners | Where-Object { [int]$_.id -eq $jitRunnerId }).Count -eq 0) { $runnerAbsent = $true; break }
            } catch { }
            Start-Sleep -Seconds 5
        }
        if (-not $runnerAbsent) { $script:cleanupFailures.Add("GitHub runner $jitRunnerId absence not verified") }
        else { Write-Output "PASS JIT runner $jitRunnerId no longer exists in the authorized runner group." }
    }
    if ($jobExecutionName) {
        try {
            $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$jobExecutionName,'--output','json')
            $executionState = Get-AcaExecutionState -Status ([string]$execution.properties.status)
            if ($executionState.State -eq 'Active') {
                $null = Invoke-AzJson @('containerapp','job','stop','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$jobExecutionName,'--output','json')
                $deadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
                do {
                    Start-Sleep -Seconds 5
                    $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$jobExecutionName,'--output','json')
                    $executionState = Get-AcaExecutionState -Status ([string]$execution.properties.status)
                } while ($executionState.State -eq 'Active' -and [DateTimeOffset]::UtcNow -lt $deadline)
            }
            if ($executionState.State -ne 'Terminal') { $script:cleanupFailures.Add("Job execution $jobExecutionName is not verifiably terminal (state=$($executionState.State), status='$($executionState.Status)')") }
        } catch {
            $script:cleanupFailures.Add("Job execution $jobExecutionName could not be stopped/verified")
        }
    }
    $safeToRemoveSecret = -not $jobStartAttempted -or ($jobExecutionName -and $executionState.State -eq 'Terminal')
    if ($jobStartAttempted -or $jitSecretTouched) {
        try {
            $remaining = @(Invoke-AzJson @('containerapp','job','execution','list','--name',$JobName,'--resource-group',$ResourceGroup,'--output','json'))
            $executionSafety = Test-AcaExecutionsSafeForSecretCleanup -Executions $remaining
            if (-not $executionSafety.Safe) { $safeToRemoveSecret = $false; $script:cleanupFailures.Add("ACA executions are not all verifiably terminal; temporary secret retained ($($executionSafety.Reason))") }
        } catch { $safeToRemoveSecret = $false; $script:cleanupFailures.Add('active ACA Job executions could not be checked; temporary secret retained') }
    }
    if (($jitSecretTouched -or $jitRunnerId -or $jobExecutionName) -and $safeToRemoveSecret) { Remove-TemporaryJobSecret }
    if ($templateFile -and (Test-Path -LiteralPath $templateFile)) {
        try {
            Remove-Item -LiteralPath $templateFile -Force
        } catch {
            $script:cleanupFailures.Add('protected temporary execution template could not be removed')
        }
    }
    if ($jitRegistrationAttempted -and -not ($jitRunnerId -or $jitRunnerAbsenceVerified)) { $script:cleanupFailures.Add('JIT registration absence was not independently verified in the authorized group') }
    if ($script:cleanupFailures.Count -gt 0) {
        $parent = Split-Path -Parent $cleanupMarker
        $null = New-Item -ItemType Directory -Path $parent -Force
        $patchOutcome = if ($jobPatchOutcomeAmbiguous) { 'Ambiguous' } else { $script:AcaLastPatchOutcome }
        $marker = @{ createdAt=[DateTimeOffset]::UtcNow.ToString('o'); runnerName=$jitRunnerName; runnerId=$jitRunnerId; executionName=$jobExecutionName; patchOutcome=$patchOutcome; failures=@($script:cleanupFailures) } | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($cleanupMarker,$marker,[System.Text.UTF8Encoding]::new($false))
        throw "CLEANUP_INCOMPLETE: $($script:cleanupFailures -join '; '). New JIT attempts are blocked by $cleanupMarker."
    }
    if ($jitRegistrationAttempted -or $jobExecutionName -or $jitSecretTouched) {
        Write-Output "CLEANUP_VERIFIED: runner absent=$([bool]($jitRunnerAbsenceVerified -or $jitRunnerId)), execution terminal=$([bool](-not $jobStartAttempted -or ($jobExecutionName -and $executionState.State -eq 'Terminal'))), secret absent=$(-not $jobSecretInstalled)."
    }
    if (Test-Path -LiteralPath $attemptRecordPath) { Remove-Item -LiteralPath $attemptRecordPath -Force }
    $script:jitConfig = $null
    $script:armToken = $null
    $script:jitRegistrationAccepted = $false
    $script:jitRunnerName = $null
}

function Get-ApprovedSmokeMatrix {
    param([Parameter(Mandatory)][long]$WorkflowId)
    if ($Mode -ne 'Smoke') { return $null }
    if ($WorkflowRunId -le 0) { throw 'SMOKE_RUN_ID_REQUIRED: Mode Smoke requires one official CD workflow run ID.' }
    $run = Invoke-GhJson @('api',"repos/$Repository/actions/runs/$WorkflowRunId")
    $master = Invoke-GhJson @('api',"repos/$Repository/commits/master")
    if ($run.path -ne '.github/workflows/cd-services-azure.yml' -or $run.event -ne 'workflow_dispatch' -or $run.head_branch -cne 'master' -or $run.head_sha -cne $master.sha -or $run.status -ne 'in_progress') {
        throw 'SMOKE_RUN_NOT_AUTHORIZED: expected the active official workflow_dispatch from the current master SHA.'
    }
    foreach ($status in @('queued','in_progress')) {
        $runs = Invoke-GhJson @('api',"repos/$Repository/actions/workflows/$WorkflowId/runs?status=$status&per_page=100")
        $rivalRuns = @($runs.workflow_runs | Where-Object { [long]$_.id -ne $WorkflowRunId })
        if ($rivalRuns.Count -gt 0) { throw "CD_RIVAL_RUN: another official CD run is $status; refusing the smoke runner." }
        if ($status -eq 'queued' -and $runs.total_count -gt 0) { throw 'CD_RUN_QUEUED: queued CD work exists; refusing the smoke runner.' }
        if ($status -eq 'in_progress' -and @($runs.workflow_runs | Where-Object { [long]$_.id -eq $WorkflowRunId }).Count -ne 1) {
            throw 'SMOKE_RUN_NOT_ACTIVE: requested official CD run is absent from in-progress runs.'
        }
    }
    $jobs = Invoke-GhJson @('api',"repos/$Repository/actions/runs/$WorkflowRunId/jobs?per_page=100")
    $prepare = @($jobs.jobs | Where-Object { $_.name -eq 'Validar procedencia y servicios' })
    $deployJobs = @($jobs.jobs | Where-Object { $_.name -like 'Desplegar *' })
    if ($prepare.Count -ne 1 -or $prepare[0].conclusion -ne 'success') {
        throw 'SMOKE_DEPLOYMENT_NOT_APPROVED: prepare and every deploy matrix job must have completed successfully.'
    }
    $plan = Get-SmokeMatrixPlan -Jobs $jobs.jobs
    Assert-H5SmokeRunBinding -Run $run -Target $destinationTarget -MasterSha ([string]$master.sha)
    $deployments = Invoke-GhJson @('api',"repos/$Repository/deployments?ref=$($run.head_sha)&environment=$GitHubEnvironment&per_page=100")
    $runCreatedAt = [DateTimeOffset]::Parse([string]$run.created_at)
    $matching = @($deployments | Where-Object {
        $_.environment -ceq $GitHubEnvironment -and $_.sha -ceq $run.head_sha -and
        [DateTimeOffset]::Parse([string]$_.created_at) -ge $runCreatedAt
    })
    if ($matching.Count -lt $deployJobs.Count) { throw "SMOKE_ENVIRONMENT_NOT_VERIFIED: deployment objects do not cover every selected job in $GitHubEnvironment after this run began." }
    foreach ($deployment in $matching) {
        $statuses = Invoke-GhJson @('api',"repos/$Repository/deployments/$($deployment.id)/statuses?per_page=1")
        if (@($statuses).Count -eq 0 -or $statuses[0].state -ne 'success') { throw "SMOKE_ENVIRONMENT_DEPLOYMENT_NOT_SUCCESSFUL: a matched $GitHubEnvironment deployment lacks a successful latest status." }
    }
    $completedSmoke = @($plan.Services | Where-Object { $_ -notin (Get-PendingSmokeServices -SmokeJobs $plan.SmokeJobs) })
    return [pscustomobject]@{Run=$run;Plan=$plan;Completed=$completedSmoke}
}

function Get-AzureJobExecutions {
    return @(Invoke-AzJson @('containerapp','job','execution','list','--name',$JobName,'--resource-group',$ResourceGroup,'--output','json'))
}

function Start-JitCycle {
    param([Parameter(Mandatory)][ValidateSet('Diagnostic','Smoke')][string]$CycleMode)
    $script:cleanupWasRun = $false
    $script:jobStartAttempted = $false
    $script:executionCorrelationFailed = $false
    $cycleRunnerName = (($CycleMode -eq 'Smoke' ? 'h5-jit-smoke-' : 'h5-jit-preflight-') + [guid]::NewGuid().ToString('N').Substring(0,10)).ToLowerInvariant()
    $script:jitRunnerName = $cycleRunnerName
    $requestJson = New-GitHubJitRequestJson -Mode $CycleMode -Name $cycleRunnerName -RunnerGroupId $RunnerGroupId -DiagnosticLabel $diagnosticLabel -SmokeLabel $SmokeLabel
    Write-Information "JIT_REQUEST_JSON: $requestJson" -InformationAction Continue
    $attemptRecord = @{ attemptedAt=[DateTimeOffset]::UtcNow.ToString('o'); organization=$Organization; runnerGroupId=$RunnerGroupId; runnerName=$cycleRunnerName; mode=$CycleMode } | ConvertTo-Json -Compress
    $parent = Split-Path -Parent $attemptRecordPath
    $null = New-Item -ItemType Directory -Path $parent -Force
    [System.IO.File]::WriteAllText($attemptRecordPath,$attemptRecord,[System.Text.UTF8Encoding]::new($false))
    $script:jitRegistrationAttempted = $true
    $jitProcess = Invoke-GhJitConfigRequest -GhExecutable ((Get-Command gh).Source) -Organization $Organization -RequestJson $requestJson
    $jitResponse = Get-GitHubJitResponseFields -ResponseText ([string]$jitProcess.Stdout)
    if ($jitResponse.StatusCode -ne 201 -or $jitProcess.ExitCode -ne 0 -or -not $jitResponse.Json) {
        $safeErrors = @($jitResponse.Errors | ForEach-Object { "$($_.field):$($_.code):$($_.resource)" }) -join ','
        $safeStatus = if ($jitResponse.StatusCode) { $jitResponse.StatusCode } else { [regex]::Match([string]$jitProcess.Stderr,'HTTP\s+(\d{3})').Groups[1].Value }
        throw "GITHUB_JIT_REJECTED: HTTP $safeStatus; message=$($jitResponse.Message); validations=$safeErrors; gh-exit=$($jitProcess.ExitCode). stderr captured separately; response secrets suppressed."
    }
    $script:jitRegistrationAccepted = $true
    $jit = $jitResponse.Json
    $script:jitRunnerId = [int]$jit.runner.id
    $script:jitConfig = [string]$jit.encoded_jit_config
    if (-not $script:jitRunnerId -or [string]::IsNullOrWhiteSpace($script:jitConfig)) { throw 'GitHub JIT response lacked runner ID/config.' }
    $actualLabels = @($jit.runner.labels | ForEach-Object name)
    if ($CycleMode -eq 'Diagnostic' -and ($actualLabels -notcontains $diagnosticLabel -or $actualLabels -contains 'azure-h5-smoke' -or $actualLabels -contains 'azure-h5-smoke-chile')) { throw 'JIT diagnostic labels are unsafe; registration will be removed.' }
    if ($CycleMode -eq 'Smoke' -and ($actualLabels -notcontains 'linux' -or $actualLabels -notcontains $SmokeLabel)) { throw 'JIT smoke labels do not match the official workflow selector.' }
    $groupRunners = Invoke-GhJson @('api',"orgs/$Organization/actions/runner-groups/$RunnerGroupId/runners?per_page=100")
    if ($groupRunners.total_count -ne 1 -or @($groupRunners.runners | Where-Object { [int]$_.id -eq $script:jitRunnerId }).Count -ne 1) { throw 'RUNNER_GROUP_NOT_EXCLUSIVE: JIT creation did not produce exactly this one registered runner.' }

    $beforeSnapshot = Get-AcaJobSnapshot -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage
    $beforeSecrets = @($beforeSnapshot.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name })
    if ($beforeSecrets.Count -ne 0) { throw 'JOB_SECRET_COLLECTION_NOT_EMPTY: refusing to alter an existing secret.' }
    $beforeExecutions = Get-AzureJobExecutions
    if (@($beforeExecutions | Where-Object { $_.properties.status -in @('Running','Processing','Starting') }).Count -ne 0) { throw 'JOB_NOT_EXCLUSIVE: an ACA execution is active and ARM supplied no ETag.' }
    $script:executionNamesBefore = @($beforeExecutions | ForEach-Object { [string]$_.name })

    $script:jitSecretTouched = $true
    $stage = 'temporary Job secret PATCH'
    Set-TemporaryJobSecret -Value $script:jitConfig
    $afterPatch = Get-AcaJobSnapshot -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage
    $patchedSecrets = @($afterPatch.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name })
    if ($patchedSecrets.Count -ne 1 -or $patchedSecrets[0].name -cne $jobSecretName) { throw 'JOB_SECRET_EXCLUSIVITY_FAILED: post-PATCH readback found unexpected secret names.' }

    $templateJson = $job.properties.template | ConvertTo-Json -Depth 100 -Compress
    $rendered = $templateJson | & python (Join-Path $PSScriptRoot 'render-execution-template.py') --set-secret "H5_RUNNER_JIT_CONFIG=$jobSecretName" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $rendered) { throw 'Could not render the one-execution JIT template.' }
    $script:templateFile = New-RestrictedTemplateFile -Content ($rendered -join "`n")
    $script:startedAt = [DateTimeOffset]::UtcNow
    $script:jobStartAttempted = $true
    $startOutput = & az containerapp job start --name $JobName --resource-group $ResourceGroup --subscription $subscriptionId --yaml $script:templateFile --only-show-errors --output json 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Azure Container Apps Job start failed (exit $LASTEXITCODE); response body suppressed." }
    $startResult = (($startOutput -join "`n") | ConvertFrom-Json -ErrorAction SilentlyContinue)
    $script:jobExecutionName = if ($startResult -and $startResult.name) { [string]$startResult.name } else { $null }
    if (-not $script:jobExecutionName) {
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
        do {
            Start-Sleep -Seconds 3
            $afterExecutions = Get-AzureJobExecutions
            try { $script:jobExecutionName = Resolve-NewAzureExecutionId -BeforeNames $script:executionNamesBefore -AfterExecutions $afterExecutions; break } catch {
                if ($_.Exception.Message -notmatch 'found 0') { $script:executionCorrelationFailed = $true; throw }
            }
        } while ([DateTimeOffset]::UtcNow -lt $deadline)
    }
    if (-not $script:jobExecutionName) { $script:executionCorrelationFailed = $true; throw 'AZURE_EXECUTION_CORRELATION_FAILED: start response omitted execution ID and no unique new execution appeared.' }
    $null = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$script:jobExecutionName,'--output','json')

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($OnlineTimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $runnerRecord = Invoke-GhJson @('api',"orgs/$Organization/actions/runners/$script:jitRunnerId")
        if ($runnerRecord.status -eq 'online') {
            $onlineLabels = @($runnerRecord.labels | ForEach-Object name)
            if ($CycleMode -eq 'Smoke' -and ($runnerRecord.os -ne 'linux' -or $onlineLabels -notcontains 'self-hosted' -or $onlineLabels -notcontains 'linux' -or $onlineLabels -notcontains $SmokeLabel)) {
                throw "JIT_RUNNER_LABELS_INVALID: online runner lacks self-hosted/linux/$SmokeLabel or Linux OS."
            }
            if ($CycleMode -eq 'Diagnostic' -and ($onlineLabels -contains 'azure-h5-smoke' -or $onlineLabels -contains 'azure-h5-smoke-chile')) { throw 'JIT_DIAGNOSTIC_LABEL_LEAK: diagnostic runner unexpectedly has a smoke label.' }
            return [pscustomobject]@{Id=$script:jitRunnerId;ExecutionName=$script:jobExecutionName;Mode=$CycleMode}
        }
        Start-Sleep -Seconds 5
    }
    throw "JIT runner $script:jitRunnerId did not become online within $OnlineTimeoutSeconds seconds."
}

function Wait-AssignedSmokeJob {
    param([Parameter(Mandatory)]$Runner,[Parameter(Mandatory)][string[]]$PendingServices)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($OnlineTimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $jobs = Invoke-GhJson @('api',"repos/$Repository/actions/runs/$WorkflowRunId/jobs?per_page=100")
        $assignment = Get-SmokeJobAssignedToRunner -Jobs $jobs.jobs -RunnerId ([int]$Runner.Id) -PendingServices $PendingServices
        if ($assignment) { return $assignment }
        Start-Sleep -Seconds 5
    }
    throw "SMOKE_JOB_ASSIGNMENT_TIMEOUT: runner $($Runner.Id) was not assigned a pending matrix job."
}

function Wait-SmokeJobSuccess {
    param([Parameter(Mandatory)]$Runner,[Parameter(Mandatory)]$Assignment)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($JobCompletionTimeoutSeconds)
    do {
        $jobState = Invoke-GhJson @('api',"repos/$Repository/actions/jobs/$($Assignment.Job.id)")
        if ($jobState.runner_id -and [int]$jobState.runner_id -ne [int]$Runner.Id) { throw 'SMOKE_RUNNER_ASSIGNMENT_CHANGED: GitHub job runner ID differs from the JIT runner.' }
        if ($jobState.status -eq 'completed') { return [string]$jobState.conclusion }
        Start-Sleep -Seconds 5
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "SMOKE_JOB_TIMEOUT: job $($Assignment.Job.id) did not complete."
}

function Wait-AzureExecutionSuccess {
    param([Parameter(Mandatory)]$Runner)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(180)
    do {
        $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$Runner.ExecutionName,'--output','json')
        $state = Get-AcaExecutionState -Status ([string]$execution.properties.status)
        if ($state.State -eq 'Terminal') {
            if ($state.Status -ne 'Succeeded') { throw "JIT_JOB_EXECUTION_FAILED: Azure execution $($Runner.ExecutionName) concluded '$($state.Status)'." }
            return $state.Status
        }
        if ($state.State -eq 'Unknown') { throw "JIT_JOB_EXECUTION_STATUS_UNKNOWN: Azure execution $($Runner.ExecutionName) reported '$($state.Status)'; cleanup is blocked." }
        Start-Sleep -Seconds 5
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "JIT_JOB_EXECUTION_TIMEOUT: Azure execution $($Runner.ExecutionName) is still active."
}

function Stop-DiagnosticExecutionAfterHandshake {
    param([Parameter(Mandatory)]$Runner)
    $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$Runner.ExecutionName,'--output','json')
    $state = Get-AcaExecutionState -Status ([string]$execution.properties.status)
    if ($state.State -eq 'Unknown') { throw "DIAGNOSTIC_EXECUTION_STATUS_UNKNOWN: exact execution $($Runner.ExecutionName) reported '$($state.Status)'; cleanup is blocked." }
    if ($state.State -eq 'Active') {
        $null = Invoke-AzJson @('containerapp','job','stop','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$Runner.ExecutionName,'--output','json')
    }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
    do {
        Start-Sleep -Seconds 3
        $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$Runner.ExecutionName,'--output','json')
        $state = Get-AcaExecutionState -Status ([string]$execution.properties.status)
        if ($state.State -eq 'Unknown') { throw "DIAGNOSTIC_EXECUTION_STATUS_UNKNOWN: exact execution $($Runner.ExecutionName) reported '$($state.Status)'; cleanup is blocked." }
    } while ($state.State -eq 'Active' -and [DateTimeOffset]::UtcNow -lt $deadline)
    if ($state.State -ne 'Terminal') { throw "DIAGNOSTIC_STOP_TIMEOUT: exact execution $($Runner.ExecutionName) remains active." }
    Write-Output "DIAGNOSTIC_EXECUTION_TERMINAL: $($Runner.ExecutionName) status=$($state.Status); runner handshake observed and execution stopped/terminalized before cleanup."
}

function Reset-JitCycleState {
    $script:jitRunnerId = $null
    $script:jitRunnerName = $null
    $script:jitRegistrationAccepted = $false
    $script:jitRegistrationAttempted = $false
    $script:jitRunnerAbsenceVerified = $false
    $script:jobExecutionName = $null
    $script:jitConfig = $null
    $script:templateFile = $null
    $script:jobSecretInstalled = $false
    $script:jobPatchOutcomeAmbiguous = $false
    $script:jitSecretTouched = $false
    $script:jobStartAttempted = $false
    $script:executionNamesBefore = @()
    $script:executionCorrelationFailed = $false
    $script:cleanupWasRun = $false
}

try {
    foreach ($tool in @('gh','az')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required CLI not found: $tool" }
    }
    if (Test-Path -LiteralPath $cleanupMarker) { throw "CLEANUP_INCOMPLETE: marker exists at $cleanupMarker; verify runner, Job execution and secret absence before clearing it manually." }
    if (Test-Path -LiteralPath $attemptRecordPath) { throw "CLEANUP_INCOMPLETE: unresolved JIT attempt record exists at $attemptRecordPath; reconcile it before another request." }
    $stage = 'local ARM PATCH/LRO journal check'
    Assert-AcaPatchJournalReady
    $account = Invoke-AzJson @('account','show','--output','json')
    $script:subscriptionId = [string]$account.id
    if ([string]::IsNullOrWhiteSpace($subscriptionId)) { throw 'Azure CLI has no active subscription.' }
    if ($subscriptionId -cne $destinationTarget.SubscriptionId) { throw 'Azure CLI subscription does not match the selected destination.' }

    $stage = 'runner-group authorization check'
    $group = Invoke-GhJson @('api',"orgs/$Organization/actions/runner-groups/$RunnerGroupId")
    if ($group.restricted_to_workflows -ne $true -or @($group.selected_workflows).Count -ne 1 -or $group.selected_workflows[0] -cne $expectedWorkflow) {
        throw 'Runner group does not restrict exactly to the CD workflow on master; JIT registration was not requested.'
    }
    $selectedRepos = Invoke-GhJson @('api',"orgs/$Organization/actions/runner-groups/$RunnerGroupId/repositories")
    if (@($selectedRepos.repositories).Count -ne 1 -or $selectedRepos.repositories[0].full_name -cne $Repository) {
        throw 'Runner group repository allowlist is not exactly the G6 backend repository.'
    }

    $stage = 'CD queue check'
    $workflow = Invoke-GhJson @('api',"repos/$Repository/actions/workflows/cd-services-azure.yml")
    if (-not $workflow.id) { throw 'Could not resolve the official CD workflow ID; refusing diagnostic registration.' }
    if ($Mode -eq 'Diagnostic') {
        foreach ($status in @('queued','in_progress')) {
            $runs = Invoke-GhJson @('api',"repos/$Repository/actions/workflows/$($workflow.id)/runs?status=$status&per_page=100")
            if ($runs.total_count -gt 0) { throw "CD workflow has $status runs; refusing diagnostic registration to avoid taking a release job." }
        }
    } else {
        $approvedSmoke = Get-ApprovedSmokeMatrix -WorkflowId ([long]$workflow.id)
    }

    $stage = "$GitHubEnvironment protection check"
    $environment = Invoke-GhJson @('api',"repos/$Repository/environments/$GitHubEnvironment")
    $hasReviewer = @($environment.protection_rules | Where-Object { $_.type -eq 'required_reviewers' -and $_.prevent_self_review -eq $true -and @($_.reviewers).Count -gt 0 }).Count -gt 0
    $hasMasterOnly = $environment.deployment_branch_policy.custom_branch_policies -eq $true -and $environment.deployment_branch_policy.protected_branches -eq $false
    if ($environment.can_admins_bypass -ne $false -or -not $hasReviewer -or -not $hasMasterOnly) {
        throw "$GitHubEnvironment protections failed verification; JIT registration was not requested."
    }
    $branchPolicies = Invoke-GhJson @('api',"repos/$Repository/environments/$GitHubEnvironment/deployment-branch-policies?per_page=100")
    if ($branchPolicies.total_count -ne 1 -or @($branchPolicies.branch_policies | Where-Object { $_.type -eq 'branch' -and $_.name -ceq 'master' }).Count -ne 1) {
        throw "$GitHubEnvironment deployment branch policies are not exactly branch master; JIT registration was not requested."
    }

    $stage = 'Container Apps Job template check'
    $job = Invoke-AzJson @('containerapp','job','show','--name',$JobName,'--resource-group',$ResourceGroup,'--output','json')
    if (-not $job.id -or $job.properties.template.containers.Count -ne 1) {
        throw 'Existing Container Apps Job is absent or its template shape differs; no JIT runner was requested.'
    }
    $container = @($job.properties.template.containers | Where-Object { $_.name -eq 'runner' }) | Select-Object -First 1
    if (-not $container -or $container.image -notmatch '^ghcr\.io/actions/actions-runner@sha256:[0-9a-f]{64}$') {
        throw 'Job image is not a digest-pinned official actions-runner image.'
    }
    if ((@($container.command) -join ' ') -ne '/bin/bash -c' -or (@($container.args) -join ' ') -notmatch 'run\.sh --jitconfig') {
        throw 'Job command does not use the configured run.sh --jitconfig entry point.'
    }
    $containerEnv = if ($container.PSObject.Properties.Name -contains 'env') { @($container.env) } else { @() }
    if (@($containerEnv | Where-Object name -eq 'H5_RUNNER_JIT_CONFIG').Count -gt 0) {
        throw 'Persistent job template already defines the JIT variable; refusing to override unexpected state.'
    }
    $expectedImage = [string]$container.image
    $expectedEnvironmentId = [string]$job.properties.environmentId
    $managedEnvironment = Invoke-AzJson @('containerapp','env','show','--name',$EnvironmentName,'--resource-group',$ResourceGroup,'--output','json')
    Assert-H5AcaJobBinding -Job $job -ManagedEnvironment $managedEnvironment -Target $destinationTarget
    $armContext = Get-ArmRequestContext
    $script:armUri = $armContext.Uri
    $script:armToken = $armContext.Token
    $jobSnapshot = Get-AcaJobSnapshot -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage
    $existingJobSecrets = @($jobSnapshot.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name })
    if ($existingJobSecrets.Count -ne 0) { throw 'JOB_SECRET_COLLECTION_NOT_EMPTY: no secret will be overwritten or removed; resolve existing secrets manually.' }
    $existingExecutions = @(Invoke-AzJson @('containerapp','job','execution','list','--name',$JobName,'--resource-group',$ResourceGroup,'--output','json'))
    $executionSafety = Test-AcaExecutionsSafeForSecretCleanup -Executions $existingExecutions
    if (-not $executionSafety.Safe) { throw "JOB_NOT_EXCLUSIVE: refusing JIT secret update without ETag; $($executionSafety.Reason)." }
    $groupRunnersBeforeJit = Invoke-GhJson @('api',"orgs/$Organization/actions/runner-groups/$RunnerGroupId/runners?per_page=100")
    if ($groupRunnersBeforeJit.total_count -ne 0) { throw 'RUNNER_GROUP_NOT_EXCLUSIVE: existing runner registrations are present; refusing no-ETag secret update.' }

    if ($Mode -eq 'Diagnostic') {
        $stage = 'diagnostic JIT cycle'
        $diagnosticRunner = Start-JitCycle -CycleMode Diagnostic
        $script:registrationOnline = $true
        Write-Output "PASS JIT registration: temporary runner ID $($diagnosticRunner.Id) became online in group $RunnerGroupId with diagnostic-only label $diagnosticLabel."
        Stop-DiagnosticExecutionAfterHandshake -Runner $diagnosticRunner
        Remove-JitRegistration
    } else {
        $stage = 'sequential official smoke matrix'
        $pendingServices = @(Get-PendingSmokeServices -SmokeJobs $approvedSmoke.Plan.SmokeJobs)
        if ($pendingServices.Count -eq 0) { throw 'SMOKE_MATRIX_ALREADY_COMPLETE: no pending jobs remain for a fresh runner.' }
        $null = Invoke-SmokeMatrixSequential -Services $pendingServices -RegisterRunner {
            param($pending)
            $null = $pending
            Start-JitCycle -CycleMode Smoke
        } -WaitForAssignment {
            param($runner,$pending)
            Wait-AssignedSmokeJob -Runner $runner -PendingServices $pending
        } -WaitForJob {
            param($runner,$assignment)
            Wait-SmokeJobSuccess -Runner $runner -Assignment $assignment
        } -WaitForExecution {
            param($runner,$assignment)
            $null = $assignment
            Wait-AzureExecutionSuccess -Runner $runner
        } -CleanupRunner {
            param($runner)
            $null = $runner
            Remove-JitRegistration
            Reset-JitCycleState
        }
        $finalJobs = Invoke-GhJson @('api',"repos/$Repository/actions/runs/$WorkflowRunId/jobs?per_page=100")
        $finalPlan = Get-SmokeMatrixPlan -Jobs $finalJobs.jobs
        $notSuccessful = @(Get-PendingSmokeServices -SmokeJobs $finalPlan.SmokeJobs)
        if ($notSuccessful.Count -gt 0) { throw 'SMOKE_MATRIX_INCOMPLETE: not all expected smoke matrix jobs are SUCCESS.' }
        Write-Output "PASS official smoke matrix: all $($finalPlan.Services.Count) services succeeded sequentially with distinct JIT runners."
    }
}
catch {
    $failure = $_.Exception.Message
    throw "JIT preflight failed during ${stage}: $failure"
}
finally {
    if (-not $cleanupWasRun -and ($jitRegistrationAttempted -or $jitRunnerId -or $jobExecutionName -or $templateFile -or $jitSecretTouched)) { Remove-JitRegistration }
}

if (-not $registrationOnline -and $Mode -eq 'Diagnostic') { throw 'JIT registration preflight did not complete.' }
Write-Output 'CLEANUP_VERIFIED: temporary GitHub JIT registration removed, correlated Job execution terminal, and temporary secret absent.'
