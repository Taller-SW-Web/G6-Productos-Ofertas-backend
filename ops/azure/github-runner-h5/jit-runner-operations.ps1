Set-StrictMode -Version Latest

function Assert-H5EnvironmentApprovalPolicy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Environment,
        [Parameter(Mandatory)]$BranchPolicies,
        [Parameter(Mandatory)][ValidateSet('brazil-isolated','chile-shared')][string]$Destination,
        [Parameter(Mandatory)][string]$ExpectedEnvironment
    )

    $environmentByDestination=@{'brazil-isolated'='azure-h5';'chile-shared'='azure-h5-chile'}
    $expected=[string]$environmentByDestination[$Destination]
    if ($ExpectedEnvironment -cne $expected -or [string]$Environment.name -cne $expected) {
        throw 'ENVIRONMENT_APPROVAL_DESTINATION_MISMATCH: Environment name does not match its exact destination.'
    }
    if ($Environment.can_admins_bypass -ne $false) {
        throw 'ENVIRONMENT_ADMIN_BYPASS_REJECTED: administrators must not bypass the Environment protection.'
    }
    if ($Environment.deployment_branch_policy.custom_branch_policies -ne $true -or
        $Environment.deployment_branch_policy.protected_branches -ne $false) {
        throw 'ENVIRONMENT_BRANCH_POLICY_REJECTED: only the explicit custom master branch policy is allowed.'
    }
    $branchItems=@($BranchPolicies.branch_policies)
    if ($BranchPolicies.total_count -ne 1 -or $branchItems.Count -ne 1 -or
        [string]$branchItems[0].type -cne 'branch' -or [string]$branchItems[0].name -cne 'master') {
        throw 'ENVIRONMENT_BRANCH_POLICY_REJECTED: exactly branch master must be allowed.'
    }
    $reviewRules=@($Environment.protection_rules | Where-Object { [string]$_.type -ceq 'required_reviewers' })
    if ($reviewRules.Count -ne 1) { throw 'ENVIRONMENT_REVIEWER_REQUIRED: exactly one Required Reviewers rule must remain active.' }
    $rule=$reviewRules[0]
    $reviewers=@($rule.reviewers)
    if ($Destination -ceq 'chile-shared') {
        $approved=@((Get-H5DeploymentTargets).destinations.'chile-shared'.approvedReviewers.id | Sort-Object)
        $actual=@($reviewers | Where-Object { [string]$_.type -ceq 'User' } |
            ForEach-Object { [long]$_.reviewer.id } | Sort-Object)
        if ($rule.prevent_self_review -ne $false -or $reviewers.Count -ne 2 -or
            $actual.Count -ne 2 -or (Compare-Object $approved $actual)) {
            throw 'CHILE_REVIEW_POLICY_REJECTED: require exactly mrcastilla8 and AXL031 and prevent_self_review=false.'
        }
    } elseif ($rule.prevent_self_review -ne $true -or $reviewers.Count -lt 1) {
        throw 'BRAZIL_REVIEW_POLICY_REJECTED: Brazil requires reviewers and prevent_self_review=true.'
    }
}

function Get-AcaExecutionState {
    [CmdletBinding()]
    param([AllowNull()][string]$Status)

    # ACA JobExecutionRunningState: Running/Processing can still use the
    # execution secret; only the explicitly terminal values below permit cleanup.
    $active = @('Starting','Running','Processing')
    $terminal = @('Succeeded','Failed','Stopped')
    if ([string]::IsNullOrWhiteSpace($Status)) {
        return [pscustomobject]@{State='Unknown';Status=''}
    }
    if ($Status -cin $active) { return [pscustomobject]@{State='Active';Status=$Status} }
    if ($Status -cin $terminal) { return [pscustomobject]@{State='Terminal';Status=$Status} }
    return [pscustomobject]@{State='Unknown';Status=$Status}
}

function Test-AcaExecutionsSafeForSecretCleanup {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Executions)

    foreach ($execution in $Executions) {
        if ($null -eq $execution) { return [pscustomobject]@{Safe=$false;Reason='execution inventory contains an unverifiable null item'} }
        $state = Get-AcaExecutionState -Status ([string]$execution.properties.status)
        if ($state.State -ne 'Terminal') {
            return [pscustomobject]@{Safe=$false;Reason="execution '$($execution.name)' has $($state.State) status '$($state.Status)'"}
        }
    }
    return [pscustomobject]@{Safe=$true;Reason='all listed executions have recognized terminal states'}
}

function Resolve-JitRunnerRegistration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RunnerName,
        [Parameter(Mandatory)][bool]$QuerySucceeded,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Runners
    )

    if (-not $QuerySucceeded) { return [pscustomobject]@{State='Unknown';RunnerId=$null} }
    $matches = @($Runners | Where-Object { [string]$_.name -ceq $RunnerName })
    if ($matches.Count -eq 0) { return [pscustomobject]@{State='Absent';RunnerId=$null} }
    if ($matches.Count -gt 1) { return [pscustomobject]@{State='Ambiguous';RunnerId=$null} }
    if (-not $matches[0].id -or [int]$matches[0].id -le 0) { return [pscustomobject]@{State='Unknown';RunnerId=$null} }
    return [pscustomobject]@{State='Found';RunnerId=[int]$matches[0].id}
}

function New-GitHubJitRequestJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('Diagnostic','Smoke')][string]$Mode,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][int]$RunnerGroupId,
        [string]$DiagnosticLabel = 'h5-runner-preflight-only',
        [ValidateSet('azure-h5-smoke','azure-h5-smoke-chile')][string]$SmokeLabel = 'azure-h5-smoke'
    )

    [string[]]$jitLabels = if ($Mode -eq 'Smoke') {
        @('self-hosted', 'linux', $SmokeLabel)
    } else {
        @($DiagnosticLabel)
    }
    $request = @{
        name = [string]$Name
        runner_group_id = [int]$RunnerGroupId
        labels = @($jitLabels)
        work_folder = [string]'_work'
    }
    $json = $request | ConvertTo-Json -Compress
    $document = [System.Text.Json.JsonDocument]::Parse($json)
    try {
        $root = $document.RootElement
        if ($root.GetProperty('labels').ValueKind -ne [System.Text.Json.JsonValueKind]::Array) {
            throw 'JIT_REQUEST_INVALID: labels did not serialize as a JSON array.'
        }
        if ($root.GetProperty('runner_group_id').ValueKind -ne [System.Text.Json.JsonValueKind]::Number -or
            $root.GetProperty('name').ValueKind -ne [System.Text.Json.JsonValueKind]::String -or
            $root.GetProperty('work_folder').ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
            throw 'JIT_REQUEST_INVALID: JIT request field JSON types do not match the GitHub API contract.'
        }
        if ($Mode -eq 'Diagnostic' -and ($jitLabels -contains 'azure-h5-smoke' -or $jitLabels -contains 'azure-h5-smoke-chile')) {
            throw 'JIT_REQUEST_INVALID: diagnostic registration cannot carry the smoke label.'
        }
    } finally {
        $document.Dispose()
    }
    return $json
}

function Get-GitHubJitResponseFields {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ResponseText)

    $body = $ResponseText
    $statusCode = 0
    $httpMatches = [regex]::Matches($ResponseText, '(?m)^HTTP/[^\s]+\s+(\d{3})')
    $httpMatch = if ($httpMatches.Count -gt 0) { $httpMatches[$httpMatches.Count - 1] } else { $null }
    if ($httpMatch -and $httpMatch.Success) {
        $statusCode = [int]$httpMatch.Groups[1].Value
        $separator = [regex]::Match($ResponseText, "`r?`n`r?`n")
        if ($separator.Success) { $body = $ResponseText.Substring($separator.Index + $separator.Length) }
    }
    $json = $null
    try { $json = $body | ConvertFrom-Json -ErrorAction Stop } catch { }
    $safeMessage = ''
    $safeErrors = @()
    if ($json) {
        if ($json.PSObject.Properties.Name -contains 'message' -and $json.message) {
            $safeMessage = [string]$json.message -replace '[\r\n]+',' '
            if ($safeMessage.Length -gt 240) { $safeMessage = $safeMessage.Substring(0,240) }
        }
        if ($json.PSObject.Properties.Name -contains 'errors') {
            $safeErrors = @($json.errors | ForEach-Object {
                $field = if ($_.field) { [string]$_.field } else { '' }
                $code = if ($_.code) { [string]$_.code } else { '' }
                $resource = if ($_.resource) { [string]$_.resource } else { '' }
                [pscustomobject]@{field=$field;code=$code;resource=$resource}
            })
        }
    }
    return [pscustomobject]@{StatusCode=$statusCode;Message=$safeMessage;Errors=$safeErrors;Json=$json}
}

function Invoke-GhJitConfigRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$GhExecutable,
        [Parameter(Mandatory)][string]$Organization,
        [Parameter(Mandatory)][string]$RequestJson
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $GhExecutable
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('api','--include','--method','POST',"orgs/$Organization/actions/runners/generate-jitconfig",'--input','-')) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'GITHUB_JIT_PROCESS_START_FAILED: gh process did not start.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($RequestJson)
        $process.StandardInput.Close()
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = [int]$process.ExitCode
            Stdout = $stdoutTask.GetAwaiter().GetResult()
            Stderr = $stderrTask.GetAwaiter().GetResult()
        }
    } finally {
        $process.Dispose()
    }
}

function Get-SmokeServiceFromJobName {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$JobName)
    if ($JobName -notmatch '^Smoke HTTPS posterior al despliegue \((?<service>[a-z0-9-]+)\)$') {
        throw "SMOKE_JOB_NAME_UNRECOGNIZED: cannot identify the matrix service in '$JobName'."
    }
    return [string]$Matches.service
}

function Get-SmokeMatrixPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object[]]$Jobs)

    $deployJobs = @($Jobs | Where-Object { [string]$_.name -like 'Desplegar * en Azure*' })
    $smokeJobs = @($Jobs | Where-Object { [string]$_.name -like 'Smoke HTTPS posterior al despliegue*' })
    if ($deployJobs.Count -eq 0 -or $smokeJobs.Count -eq 0) {
        throw 'SMOKE_MATRIX_MISSING: deployment and smoke matrix jobs must both be present.'
    }
    if (@($deployJobs | Where-Object { $_.status -ne 'completed' -or $_.conclusion -ne 'success' }).Count -gt 0) {
        throw 'SMOKE_DEPLOYMENTS_NOT_SUCCESSFUL: every selected deployment matrix job must be successful.'
    }
    $deployServices = @($deployJobs | ForEach-Object {
        if ([string]$_.name -notmatch '^Desplegar (?<service>[a-z0-9-]+) en Azure(?: \(.+\))?$') {
            throw "DEPLOY_JOB_NAME_UNRECOGNIZED: cannot identify service in '$($_.name)'."
        }
        [string]$Matches.service
    } | Sort-Object -Unique)
    $smokeServices = @($smokeJobs | ForEach-Object { Get-SmokeServiceFromJobName -JobName ([string]$_.name) } | Sort-Object -Unique)
    if ($deployServices.Count -ne $deployJobs.Count -or $smokeServices.Count -ne $smokeJobs.Count -or
        (Compare-Object $deployServices $smokeServices)) {
        throw 'SMOKE_MATRIX_MISMATCH: successful deploy and smoke matrices do not cover the same unique services.'
    }
    $allowed = @('api-gateway','bulk-svc','catalog-svc','combos-svc','inventory-svc','price-audit-svc','pricing-svc','promotions-svc','taxonomy-svc')
    if (@($smokeServices | Where-Object { $_ -notin $allowed }).Count -gt 0) {
        throw 'SMOKE_MATRIX_UNAUTHORIZED_SERVICE: matrix includes a service outside the official CD allowlist.'
    }
    return [pscustomobject]@{Services=$smokeServices;SmokeJobs=$smokeJobs}
}

function Get-PendingSmokeServices {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object[]]$SmokeJobs)
    $pending = [System.Collections.Generic.List[string]]::new()
    foreach ($job in $SmokeJobs) {
        $service = Get-SmokeServiceFromJobName -JobName ([string]$job.name)
        if ($job.status -eq 'completed') {
            if ($job.conclusion -ne 'success') { throw "SMOKE_MATRIX_FAILED: '$service' concluded '$($job.conclusion)'; stop and recover through the official workflow." }
            continue
        }
        if ($job.status -ne 'queued') {
            throw "SMOKE_MATRIX_NOT_QUEUED: '$service' is '$($job.status)' before a JIT cycle; refusing duplicate or concurrent execution."
        }
        $pending.Add($service)
    }
    return $pending.ToArray()
}

function Get-SmokeJobAssignedToRunner {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object[]]$Jobs,
        [Parameter(Mandatory)][int]$RunnerId,
        [Parameter(Mandatory)][string[]]$PendingServices
    )
    $smokeJobs = @($Jobs | Where-Object { [string]$_.name -like 'Smoke HTTPS posterior al despliegue*' })
    $assigned = @($smokeJobs | Where-Object { $_.runner_id -and [int]$_.runner_id -eq $RunnerId })
    if ($assigned.Count -gt 1) { throw "SMOKE_RUNNER_ASSIGNMENT_AMBIGUOUS: runner $RunnerId was assigned to multiple jobs." }
    if ($assigned.Count -eq 0) { return $null }
    $service = Get-SmokeServiceFromJobName -JobName ([string]$assigned[0].name)
    if ($service -notin $PendingServices) { throw "SMOKE_RUNNER_ASSIGNMENT_UNEXPECTED: runner $RunnerId received service '$service' outside pending services." }
    if ($assigned[0].status -notin @('in_progress','completed')) { throw "SMOKE_RUNNER_ASSIGNMENT_STATE_INVALID: assigned job '$($assigned[0].name)' has status '$($assigned[0].status)'." }
    return [pscustomobject]@{Job=$assigned[0];Service=$service}
}

function Resolve-NewAzureExecutionId {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]]$BeforeNames,[Parameter(Mandatory)][AllowEmptyCollection()][object[]]$AfterExecutions)
    $before = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $BeforeNames) { $null = $before.Add($name) }
    $newNames = @($AfterExecutions | ForEach-Object { [string]$_.name } | Where-Object { $_ -and -not $before.Contains($_) } | Sort-Object -Unique)
    if ($newNames.Count -ne 1) {
        throw "AZURE_EXECUTION_CORRELATION_FAILED: expected exactly one execution created after start; found $($newNames.Count)."
    }
    return [string]$newNames[0]
}

function Invoke-SmokeMatrixSequential {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string[]]$Services,
        [Parameter(Mandatory)][scriptblock]$RegisterRunner,
        [Parameter(Mandatory)][scriptblock]$WaitForAssignment,
        [Parameter(Mandatory)][scriptblock]$WaitForJob,
        [Parameter(Mandatory)][scriptblock]$WaitForExecution,
        [Parameter(Mandatory)][scriptblock]$CleanupRunner
    )
    $pending = [System.Collections.Generic.List[string]]::new()
    foreach ($service in $Services) {
        if ($pending.Contains($service)) { throw "SMOKE_MATRIX_DUPLICATE_SERVICE: '$service'." }
        $pending.Add($service)
    }
    $completed = [System.Collections.Generic.List[string]]::new()
    while ($pending.Count -gt 0) {
        $runner = & $RegisterRunner @($pending.ToArray())
        $cycleError = $null
        try {
            $assigned = & $WaitForAssignment $runner @($pending.ToArray())
            if (-not $assigned -or $assigned.Service -notin $pending) { throw 'SMOKE_RUNNER_ASSIGNMENT_UNEXPECTED: no valid pending matrix job was assigned.' }
            $jobResult = & $WaitForJob $runner $assigned
            if ($jobResult -ne 'success') { throw "SMOKE_JOB_FAILED: service '$($assigned.Service)' concluded '$jobResult'." }
            $executionResult = & $WaitForExecution $runner $assigned
            if ($executionResult -ne 'Succeeded') { throw "SMOKE_AZURE_EXECUTION_FAILED: service '$($assigned.Service)' ACA execution concluded '$executionResult'." }
            $null = $pending.Remove($assigned.Service)
            $completed.Add($assigned.Service)
        } catch {
            $cycleError = $_.Exception.Message
        } finally {
            try { & $CleanupRunner $runner }
            catch { throw "CLEANUP_INCOMPLETE: $($_.Exception.Message)" }
        }
        if ($cycleError) { throw $cycleError }
    }
    return $completed.ToArray()
}
