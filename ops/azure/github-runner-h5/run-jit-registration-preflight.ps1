param(
    [string]$Organization = 'Taller-SW-Web',
    [string]$Repository = 'Taller-SW-Web/G6-Productos-Ofertas-backend',
    [string]$ResourceGroup = 'rg-g6-sb-h5-int-fork',
    [string]$JobName = 'azure-h5-smoke',
    [int]$RunnerGroupId = 3,
    [int]$OnlineTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$runnerName = ('h5-jit-preflight-' + [guid]::NewGuid().ToString('N').Substring(0, 10)).ToLowerInvariant()
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
$stage = 'initialization'

function Invoke-GhJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & gh @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "GitHub API call failed: $($Arguments[0]) (exit $LASTEXITCODE)." }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI call failed: $($Arguments[0]) (exit $LASTEXITCODE). $($output -join ' ')" }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Get-ArmJob {
    $tokenOutput = & az account get-access-token --resource https://management.azure.com/ --query accessToken --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($tokenOutput -join ''))) { throw 'Could not obtain an Azure management token for the protected JIT secret operation.' }
    $headers = @{ Authorization = "Bearer $($tokenOutput -join '')" }
    $uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.App/jobs/$JobName?api-version=2025-07-01"
    $responseHeaders = $null
    $resource = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -ResponseHeadersVariable responseHeaders
    $etag = [string]$responseHeaders.ETag
    if ([string]::IsNullOrWhiteSpace($etag)) { throw 'ARM did not return an ETag; refusing an unguarded Job update.' }
    return [pscustomobject]@{Resource=$resource;Token=($tokenOutput -join '');Uri=$uri;ETag=$etag}
}

function Set-TemporaryJobSecret {
    param([Parameter(Mandatory)][string]$Value)
    $snapshot = Get-ArmJob
    $existingSecrets = @($snapshot.Resource.properties.configuration.secrets)
    if ($existingSecrets.Count -gt 0) { throw 'Job already has persistent secrets; refusing to rewrite its secret collection.' }
    $snapshot.Resource.properties.configuration.secrets = @(@{name=$jobSecretName;value=$Value})
    $body = @{
        location = $snapshot.Resource.location
        identity = $snapshot.Resource.identity
        tags = $snapshot.Resource.tags
        properties = @{
            environmentId = $snapshot.Resource.properties.environmentId
            configuration = $snapshot.Resource.properties.configuration
            template = $snapshot.Resource.properties.template
            workloadProfileName = $snapshot.Resource.properties.workloadProfileName
        }
    } | ConvertTo-Json -Depth 100 -Compress
    $headers = @{ Authorization = "Bearer $($snapshot.Token)"; 'If-Match' = $snapshot.ETag }
    try {
        $null = Invoke-RestMethod -Method Put -Uri $snapshot.Uri -Headers $headers -ContentType 'application/json' -Body $body
        $script:jobSecretInstalled = $true
    } catch {
        $putFailure = $_
        try {
            $verification = Get-ArmJob
            $script:jobSecretInstalled = @($verification.Resource.properties.configuration.secrets | Where-Object { $_.name -eq $jobSecretName }).Count -gt 0
        } catch {
            $script:jobSecretInstalled = $true
            Write-Warning "CLEANUP REQUIRED: could not verify whether temporary Job secret '$jobSecretName' persisted."
        }
        $statusCode = [int]$putFailure.Exception.Response.StatusCode
        $detail = [string]$putFailure.ErrorDetails.Message
        if (-not $detail -and $putFailure.Exception.Response.Content) {
            try { $detail = [string]$putFailure.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } catch { }
        }
        if ($Value) { $detail = $detail.Replace($Value, '[REDACTED]') }
        if ($detail.Length -gt 500) { $detail = $detail.Substring(0, 500) }
        throw "Temporary Job secret installation failed (HTTP $statusCode): $detail No secret value was logged."
    }
}

function Remove-TemporaryJobSecret {
    if (-not $jobSecretInstalled) { return }
    try {
        $snapshot = Get-ArmJob
        $temporarySecret = @($snapshot.Resource.properties.configuration.secrets | Where-Object { $_.name -eq $jobSecretName })
        if ($temporarySecret.Count -eq 0) {
            $script:jobSecretInstalled = $false
            Write-Output 'PASS no temporary JIT secret remained in Azure.'
            return
        }
        $secrets = @($snapshot.Resource.properties.configuration.secrets | Where-Object { $_.name -ne $jobSecretName })
        if ($secrets.Count -eq 0) { $snapshot.Resource.properties.configuration.secrets = $null }
        else { $snapshot.Resource.properties.configuration.secrets = $secrets }
        $body = @{
            location = $snapshot.Resource.location
            identity = $snapshot.Resource.identity
            tags = $snapshot.Resource.tags
            properties = @{
                environmentId = $snapshot.Resource.properties.environmentId
                configuration = $snapshot.Resource.properties.configuration
                template = $snapshot.Resource.properties.template
                workloadProfileName = $snapshot.Resource.properties.workloadProfileName
            }
        } | ConvertTo-Json -Depth 100 -Compress
        $headers = @{ Authorization = "Bearer $($snapshot.Token)"; 'If-Match' = $snapshot.ETag }
        $null = Invoke-RestMethod -Method Put -Uri $snapshot.Uri -Headers $headers -ContentType 'application/json' -Body $body
        $script:jobSecretInstalled = $false
        Write-Output 'PASS JIT config removed from the Azure Job secret store.'
    } catch {
        Write-Warning "CLEANUP REQUIRED: temporary Job secret '$jobSecretName' may remain; remove it from $ResourceGroup/$JobName after inspecting concurrent changes. Error: HTTP $([int]$_.Exception.Response.StatusCode)"
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
    if ($jitRunnerId) {
        $null = & gh api --method DELETE "orgs/$Organization/actions/runners/$jitRunnerId" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "CLEANUP REQUIRED: GitHub runner ID $jitRunnerId could not be deleted; remove it manually from the organization runner group."
        }
    }
    if ($jobExecutionName) {
        try {
            $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$jobExecutionName,'--output','json')
            if ($execution.properties.status -in @('Running','Processing','Starting')) {
                $null = Invoke-AzJson @('containerapp','job','stop','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$jobExecutionName,'--output','json')
            }
        } catch {
            Write-Warning "CLEANUP REQUIRED: check/stop Container Apps Job execution $jobExecutionName manually: $($_.Exception.Message)"
        }
    }
    Remove-TemporaryJobSecret
    if ($templateFile -and (Test-Path -LiteralPath $templateFile)) {
        try {
            Remove-Item -LiteralPath $templateFile -Force
        } catch {
            Write-Warning 'CLEANUP REQUIRED: remove the protected temporary JIT template file manually.'
        }
    }
    $script:jitConfig = $null
}

try {
    foreach ($tool in @('gh','az')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required CLI not found: $tool" }
    }

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
    foreach ($status in @('queued','in_progress')) {
        $runs = Invoke-GhJson @('api',"repos/$Repository/actions/workflows/$($workflow.id)/runs?status=$status&per_page=100")
        if ($runs.total_count -gt 0) { throw "CD workflow has $status runs; refusing diagnostic registration to avoid taking a release job." }
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
    if (@($container.env | Where-Object name -eq 'H5_RUNNER_JIT_CONFIG').Count -gt 0) {
        throw 'Persistent job template already defines the JIT variable; refusing to override unexpected state.'
    }

    # Deliberately omit azure-h5-smoke. This registration cannot match the CD
    # smoke job, which requires self-hosted + linux + azure-h5-smoke.
    $stage = 'GitHub JIT generation'
    $request = @{
        name = $runnerName
        runner_group_id = $RunnerGroupId
        labels = @($diagnosticLabel)
        work_folder = '_work'
    } | ConvertTo-Json -Compress
    $response = $request | & gh api --method POST "orgs/$Organization/actions/runners/generate-jitconfig" --input - 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub generate-jitconfig returned a failure; no JIT configuration was accepted.' }
    $jit = ($response -join "`n") | ConvertFrom-Json
    $jitRunnerId = [int]$jit.runner.id
    $jitConfig = [string]$jit.encoded_jit_config
    if (-not $jitRunnerId -or [string]::IsNullOrWhiteSpace($jitConfig)) { throw 'GitHub JIT response lacked runner ID/config.' }
    $labels = @($jit.runner.labels | ForEach-Object name)
    if ($labels -notcontains $diagnosticLabel -or $labels -contains 'azure-h5-smoke') {
        throw 'JIT labels are not diagnostic-only; deleting runner without starting the Azure Job.'
    }

    $stage = 'temporary Job secret install'
    Set-TemporaryJobSecret -Value $jitConfig
    $templateJson = $job.properties.template | ConvertTo-Json -Depth 100 -Compress
    $rendered = $templateJson | & python (Join-Path $PSScriptRoot 'render-execution-template.py') --set-secret "H5_RUNNER_JIT_CONFIG=$jobSecretName" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $rendered) { throw 'Could not render the one-execution JIT template.' }
    $templateFile = New-RestrictedTemplateFile -Content ($rendered -join "`n")
    $startedAt = [DateTimeOffset]::UtcNow
    $stage = 'Container Apps JIT execution start'
    $startOutput = & az containerapp job start --name $JobName --resource-group $ResourceGroup --yaml $templateFile --only-show-errors --output json 2>&1
    if ($LASTEXITCODE -ne 0) {
        $safeError = $startOutput -join ' '
        if ($jitConfig) { $safeError = $safeError.Replace($jitConfig, '[REDACTED]') }
        throw "Azure Job start denied/failed: $safeError"
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

    Write-Output "PASS JIT registration: temporary runner ID $jitRunnerId became online in group $RunnerGroupId with diagnostic-only label $diagnosticLabel."
    Write-Output 'The required azure-h5-smoke label was intentionally absent, so no CD job could match this diagnostic runner.'
}
catch {
    $failure = $_.Exception.Message
    throw "JIT preflight failed during ${stage}: $failure"
}
finally {
    if ($jitRunnerId -or $jobExecutionName -or $templateFile) { Remove-JitRegistration }
}

if (-not $registrationOnline) { throw 'JIT registration preflight did not complete.' }
Write-Output 'Cleanup requested: temporary GitHub JIT registration removed and any still-running Job execution stopped.'
