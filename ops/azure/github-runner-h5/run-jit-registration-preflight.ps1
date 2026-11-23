param(
    [string]$Organization = 'Taller-SW-Web',
    [string]$Repository = 'Taller-SW-Web/G6-Productos-Ofertas-backend',
    [string]$ResourceGroup = 'rg-g6-sb-h5-int-fork',
    [string]$JobName = 'azure-h5-smoke',
    [int]$RunnerGroupId = 3,
    [int]$OnlineTimeoutSeconds = 180,
    [ValidateSet('Diagnostic','Smoke')][string]$Mode = 'Diagnostic',
    [long]$WorkflowRunId = 0,
    [int]$JobCompletionTimeoutSeconds = 1800
)

$ErrorActionPreference = 'Stop'
$runnerPrefix = if ($Mode -eq 'Smoke') { 'h5-jit-smoke-' } else { 'h5-jit-preflight-' }
$runnerName = ($runnerPrefix + [guid]::NewGuid().ToString('N').Substring(0, 10)).ToLowerInvariant()
$diagnosticLabel = 'h5-runner-preflight-only'
$workflowPath = "$Repository/.github/workflows/cd-services-azure.yml"
$expectedWorkflow = "$workflowPath@refs/heads/master"
$jitRunnerId = $null
$jobExecutionName = $null
$jitConfig = $null
$templateFile = $null
$subscriptionId = $null
$jobSecretInstalled = $false
$jobSecretName = 'h5jit'
$startedAt = [DateTimeOffset]::UtcNow
$registrationOnline = $false
$smokeJobId = $null
$smokeJobConclusion = $null
$jitSecretTouched = $false
$cleanupWasRun = $false
$jobStartAttempted = $false
$stage = 'initialization'
$expectedImage = $null
$expectedEnvironmentId = $null
$armUri = $null
$armToken = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$cleanupMarker = Join-Path (Join-Path $env:LOCALAPPDATA 'G6\azure-h5-smoke') 'CLEANUP_INCOMPLETE.json'

. (Join-Path $PSScriptRoot 'aca-job-secret-patch.ps1')

function Invoke-GhJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & gh @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "GitHub API call failed: $($Arguments[0]) (exit $LASTEXITCODE)." }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & az @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI call failed: $($Arguments[0]) (exit $LASTEXITCODE). $($output -join ' ')" }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Get-ArmRequestContext {
    if ([string]::IsNullOrWhiteSpace($subscriptionId)) {
        $script:subscriptionId = [string](& az account show --query id --output tsv 2>$null)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($subscriptionId)) { throw 'Could not resolve the active Azure subscription for the protected JIT secret operation.' }
    }
    $tokenOutput = & az account get-access-token --resource https://management.azure.com/ --query accessToken --output tsv 2>$null
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
        try {
            $verification = Get-AcaJobSnapshot -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage
            $script:jobSecretInstalled = @($verification.Resource.properties.configuration.secrets | Where-Object { $_.name -eq $jobSecretName }).Count -gt 0
        } catch {
            $script:jobSecretInstalled = $true
            Write-Warning "CLEANUP REQUIRED: could not verify whether temporary Job secret '$jobSecretName' persisted."
        }
        throw $patchFailure
    }
}

function Remove-TemporaryJobSecret {
    if (-not $jobSecretInstalled -and -not $jitSecretTouched) { return }
    try {
        if (-not $armUri -or -not $armToken -or -not $expectedEnvironmentId -or -not $expectedImage) {
            $context = Get-ArmRequestContext
            $script:armUri = $context.Uri
            $script:armToken = $context.Token
        }
        $null = Remove-AcaJobSecret -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage -SecretName $jobSecretName
        $script:jobSecretInstalled = $false
        $script:jitSecretTouched = $false
        Write-Output 'PASS no temporary JIT secret remained in Azure.'
    } catch {
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
    if (-not $jobExecutionName -and $jitRunnerId -and $jobStartAttempted) {
        try {
            $runs = Invoke-AzJson @('containerapp','job','execution','list','--name',$JobName,'--resource-group',$ResourceGroup,'--output','json')
            $recent = @($runs | Where-Object { $_.properties.startTime -and [DateTimeOffset]::Parse($_.properties.startTime) -ge $startedAt.AddMinutes(-1) } | Sort-Object { [DateTimeOffset]::Parse($_.properties.startTime) } -Descending | Select-Object -First 1)
            if ($recent.Count -gt 0) { $script:jobExecutionName = [string]$recent[0].name }
        } catch { $script:cleanupFailures.Add('new Job execution state could not be inspected') }
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
            if ($execution.properties.status -in @('Running','Processing','Starting')) {
                $null = Invoke-AzJson @('containerapp','job','stop','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$jobExecutionName,'--output','json')
                $deadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
                do {
                    Start-Sleep -Seconds 5
                    $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$jobExecutionName,'--output','json')
                } while ($execution.properties.status -in @('Running','Processing','Starting') -and [DateTimeOffset]::UtcNow -lt $deadline)
            }
            if ($execution.properties.status -in @('Running','Processing','Starting')) { $script:cleanupFailures.Add("Job execution $jobExecutionName is still active") }
        } catch {
            $script:cleanupFailures.Add("Job execution $jobExecutionName could not be stopped/verified")
        }
    }
    if ($jitSecretTouched -or $jitRunnerId -or $jobExecutionName) { Remove-TemporaryJobSecret }
    if ($templateFile -and (Test-Path -LiteralPath $templateFile)) {
        try {
            Remove-Item -LiteralPath $templateFile -Force
        } catch {
            $script:cleanupFailures.Add('protected temporary execution template could not be removed')
        }
    }
    if ($script:cleanupFailures.Count -gt 0) {
        $parent = Split-Path -Parent $cleanupMarker
        $null = New-Item -ItemType Directory -Path $parent -Force
        $marker = @{ createdAt=[DateTimeOffset]::UtcNow.ToString('o'); runnerId=$jitRunnerId; executionName=$jobExecutionName; failures=@($script:cleanupFailures) } | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($cleanupMarker,$marker,[System.Text.UTF8Encoding]::new($false))
        throw "CLEANUP_INCOMPLETE: $($script:cleanupFailures -join '; '). New JIT attempts are blocked by $cleanupMarker."
    }
    if ($jitRunnerId -or $jobExecutionName -or $jitSecretTouched) {
        Write-Output "CLEANUP_VERIFIED: runner absent=$([bool]$jitRunnerId), execution inactive=$([bool]$jobExecutionName), secret absent=$(-not $jobSecretInstalled)."
    }
    $script:jitConfig = $null
    $script:armToken = $null
}

function Get-ApprovedSmokeJob {
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
    $smokeJobs = @($jobs.jobs | Where-Object { $_.name -like 'Smoke HTTPS posterior al despliegue*' })
    if ($prepare.Count -ne 1 -or $prepare[0].conclusion -ne 'success' -or $deployJobs.Count -eq 0 -or @($deployJobs | Where-Object conclusion -ne 'success').Count -gt 0) {
        throw 'SMOKE_DEPLOYMENT_NOT_APPROVED: prepare and every deploy matrix job must have completed successfully.'
    }
    if ($smokeJobs.Count -ne 1 -or $smokeJobs[0].status -ne 'queued') {
        throw 'SMOKE_JOB_NOT_QUEUED: require exactly one smoke job queued after deployment and Environment approval.'
    }
    $deployments = Invoke-GhJson @('api',"repos/$Repository/deployments?ref=$($run.head_sha)&environment=azure-h5&per_page=100")
    $matching = @($deployments | Where-Object { [long]$_.payload.run_id -eq $WorkflowRunId -and $_.environment -ceq 'azure-h5' })
    if ($matching.Count -eq 0) { throw 'SMOKE_ENVIRONMENT_NOT_VERIFIED: no deployment from this run targets protected azure-h5.' }
    return [pscustomobject]@{Run=$run;Job=$smokeJobs[0]}
}

try {
    foreach ($tool in @('gh','az')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required CLI not found: $tool" }
    }
    if (Test-Path -LiteralPath $cleanupMarker) { throw "CLEANUP_INCOMPLETE: marker exists at $cleanupMarker; verify runner, Job execution and secret absence before clearing it manually." }

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
        $approvedSmoke = Get-ApprovedSmokeJob -WorkflowId ([long]$workflow.id)
    }

    $stage = 'azure-h5 protection check'
    $environment = Invoke-GhJson @('api',"repos/$Repository/environments/azure-h5")
    $hasReviewer = @($environment.protection_rules | Where-Object { $_.type -eq 'required_reviewers' -and $_.prevent_self_review -eq $true -and @($_.reviewers).Count -gt 0 }).Count -gt 0
    $hasMasterOnly = $environment.deployment_branch_policy.custom_branch_policies -eq $true -and $environment.deployment_branch_policy.protected_branches -eq $false
    if ($environment.can_admins_bypass -ne $false -or -not $hasReviewer -or -not $hasMasterOnly) {
        throw 'azure-h5 protections failed verification; JIT registration was not requested.'
    }

    $stage = 'Container Apps Job template check'
    $job = Invoke-AzJson @('containerapp','job','show','--name',$JobName,'--resource-group',$ResourceGroup,'--output','json')
    if (-not $job.id -or $job.location -ne 'Brazil South' -or $job.properties.template.containers.Count -ne 1) {
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
    $managedEnvironment = Invoke-AzJson @('containerapp','env','show','--name','env-g6-h5-int','--resource-group',$ResourceGroup,'--output','json')
    if (-not $expectedEnvironmentId -or $expectedEnvironmentId -ine [string]$managedEnvironment.id) {
        throw 'Existing Job is not attached to env-g6-h5-int; JIT registration was not requested.'
    }
    $armContext = Get-ArmRequestContext
    $script:armUri = $armContext.Uri
    $script:armToken = $armContext.Token
    $null = Get-AcaJobSnapshot -Uri $armUri -Token $armToken -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $expectedEnvironmentId -ExpectedImage $expectedImage

    # Diagnostic label cannot match CD. Smoke mode requires the active official
    # workflow run, successful deploy, and its single queued smoke job.
    $stage = 'GitHub JIT generation'
    $jitLabels = if ($Mode -eq 'Smoke') { @('linux','azure-h5-smoke') } else { @($diagnosticLabel) }
    $request = @{
        name = $runnerName
        runner_group_id = $RunnerGroupId
        labels = $jitLabels
        work_folder = '_work'
    } | ConvertTo-Json -Compress
    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $response = $request | & gh api --method POST "orgs/$Organization/actions/runners/generate-jitconfig" --input - 2>&1
    $jitRequestExitCode = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorActionPreference
    if ($jitRequestExitCode -ne 0) {
        $safeHttpStatus = [regex]::Match(($response -join ' '), 'HTTP\s+(\d{3})').Groups[1].Value
        $safeGithubCode = ''
        $safeGithubMessage = ''
        $responseJson = (($response | Where-Object { $_ -is [string] }) -join "`n") | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($responseJson.message) {
            $safeGithubMessage = [string]$responseJson.message -replace '[\r\n]+',' '
            if ($safeGithubMessage.Length -gt 240) { $safeGithubMessage = $safeGithubMessage.Substring(0,240) }
        }
        if ($responseJson -and $responseJson.PSObject.Properties.Name -contains 'errors' -and $responseJson.errors) {
            $safeGithubCode = (@($responseJson.errors | ForEach-Object { if($_.code){$_.code}else{$_.field} }) -join ',')
        }
        throw "GitHub generate-jitconfig failed with exit $jitRequestExitCode$(if($safeHttpStatus){", HTTP $safeHttpStatus"})$(if($safeGithubCode){", code=$safeGithubCode"})$(if($safeGithubMessage){", message=$safeGithubMessage"}); response body suppressed."
    }
    $jit = ($response -join "`n") | ConvertFrom-Json
    $jitRunnerId = [int]$jit.runner.id
    $jitConfig = [string]$jit.encoded_jit_config
    if (-not $jitRunnerId -or [string]::IsNullOrWhiteSpace($jitConfig)) { throw 'GitHub JIT response lacked runner ID/config.' }
    $labels = @($jit.runner.labels | ForEach-Object name)
    if ($Mode -eq 'Diagnostic' -and ($labels -notcontains $diagnosticLabel -or $labels -contains 'azure-h5-smoke')) {
        throw 'JIT labels are not diagnostic-only; deleting runner without starting the Azure Job.'
    }
    if ($Mode -eq 'Smoke' -and ($labels -notcontains 'linux' -or $labels -notcontains 'azure-h5-smoke')) {
        throw 'JIT labels do not match the official CD smoke selector; deleting runner without starting the Azure Job.'
    }
    $authorizedRunners = Invoke-GhJson @('api',"orgs/$Organization/actions/runner-groups/$RunnerGroupId/runners?per_page=100")
    if (@($authorizedRunners.runners | Where-Object { $_.status -eq 'online' -or $_.busy -eq $true }).Count -gt 0) {
        throw 'RUNNER_RACE: another online or busy runner exists in the protected group.'
    }

    $script:jitSecretTouched = $true
    $stage = 'temporary Job secret PATCH'
    Set-TemporaryJobSecret -Value $jitConfig
    $templateJson = $job.properties.template | ConvertTo-Json -Depth 100 -Compress
    $rendered = $templateJson | & python (Join-Path $PSScriptRoot 'render-execution-template.py') --set-secret "H5_RUNNER_JIT_CONFIG=$jobSecretName" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $rendered) { throw 'Could not render the one-execution JIT template.' }
    $templateFile = New-RestrictedTemplateFile -Content ($rendered -join "`n")
    $startedAt = [DateTimeOffset]::UtcNow
    $script:jobStartAttempted = $true
    $stage = 'Container Apps JIT execution start'
    $startOutput = Invoke-AcaJitStartWithCleanup -StartAction {
        $output = & az containerapp job start --name $JobName --resource-group $ResourceGroup --yaml $templateFile --only-show-errors --output json 2>&1
        if ($LASTEXITCODE -ne 0) {
            $safeError = $output -join ' '
            if ($jitConfig) { $safeError = $safeError.Replace($jitConfig, '[REDACTED]') }
            throw "Azure Job start denied/failed: $safeError"
        }
        return $output
    } -CleanupAction {
        Remove-JitRegistration
    }
    $startResult = ($startOutput -join "`n") | ConvertFrom-Json
    $jobExecutionName = [string]$startResult.name
    if (-not $jobExecutionName) {
        $jobRuns = Invoke-AzJson @('containerapp','job','execution','list','--name',$JobName,'--resource-group',$ResourceGroup,'--output','json')
        $jobExecutionName = [string](@($jobRuns | Where-Object { [DateTimeOffset]::Parse($_.properties.startTime) -ge $startedAt.AddMinutes(-1) } | Sort-Object { [DateTimeOffset]::Parse($_.properties.startTime) } -Descending | Select-Object -First 1).name)
    }
    if (-not $jobExecutionName) { throw 'Job start returned without an execution name; cleanup will remove the JIT runner.' }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($OnlineTimeoutSeconds)
    $stage = 'GitHub JIT runner online poll'
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $runner = & gh api "orgs/$Organization/actions/runners/$jitRunnerId" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $runnerRecord = ($runner -join "`n") | ConvertFrom-Json
            if ($runnerRecord.status -eq 'online') { $registrationOnline = $true; break }
        }
        Start-Sleep -Seconds 5
    }
    if (-not $registrationOnline) { throw "JIT runner $jitRunnerId did not become online within $OnlineTimeoutSeconds seconds." }

    Write-Output "PASS JIT registration: temporary runner ID $jitRunnerId became online in group $RunnerGroupId using mode $Mode."
    if ($Mode -eq 'Diagnostic') {
        Write-Output 'The required azure-h5-smoke label was intentionally absent, so no CD job could match this diagnostic runner.'
    } else {
        $stage = 'official smoke job completion'
        $jobDeadline = [DateTimeOffset]::UtcNow.AddSeconds($JobCompletionTimeoutSeconds)
        do {
            $liveJob = Invoke-GhJson @('api',"repos/$Repository/actions/jobs/$($approvedSmoke.Job.id)")
            if ($liveJob.status -eq 'completed') { $smokeJobConclusion = [string]$liveJob.conclusion; break }
            Start-Sleep -Seconds 5
        } while ([DateTimeOffset]::UtcNow -lt $jobDeadline)
        if (-not $smokeJobConclusion) { throw "SMOKE_JOB_TIMEOUT: job $($approvedSmoke.Job.id) did not complete within $JobCompletionTimeoutSeconds seconds." }
        if ($smokeJobConclusion -ne 'success') { throw "SMOKE_JOB_FAILED: official smoke job $($approvedSmoke.Job.id) concluded '$smokeJobConclusion'." }
        Write-Output "PASS official smoke job $($approvedSmoke.Job.id) completed successfully for workflow run $WorkflowRunId."
        $executionDeadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
        do {
            $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$jobExecutionName,'--output','json')
            if ($execution.properties.status -notin @('Running','Processing','Starting')) { break }
            Start-Sleep -Seconds 5
        } while ([DateTimeOffset]::UtcNow -lt $executionDeadline)
        if ($execution.properties.status -ne 'Succeeded') {
            $executionStatus = ([string]$execution.properties.status).ToUpperInvariant()
            throw "JIT_JOB_EXECUTION_$executionStatus`: Azure execution $jobExecutionName did not finish successfully."
        }
    }
}
catch {
    $failure = $_.Exception.Message
    throw "JIT preflight failed during ${stage}: $failure"
}
finally {
    if (-not $cleanupWasRun -and ($jitRunnerId -or $jobExecutionName -or $templateFile)) { Remove-JitRegistration }
}

if (-not $registrationOnline) { throw 'JIT registration preflight did not complete.' }
Write-Output 'CLEANUP_VERIFIED: temporary GitHub JIT registration removed, Job execution terminal, and temporary secret absent.'
