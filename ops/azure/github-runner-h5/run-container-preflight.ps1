param(
    [string]$Organization = 'Taller-SW-Web',
    [string]$Repository = 'Taller-SW-Web/G6-Productos-Ofertas-backend',
    [string]$ResourceGroup = 'rg-g6-sb-h5-int-fork',
    [string]$JobName = 'azure-h5-smoke',
    [string]$Ref = 'trabajo/castilla/h5-runner-privado-cd',
    [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
$executionName = $null
$templatePath = $null
$startedAt = [DateTimeOffset]::UtcNow

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & az @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: $($Arguments[0]) (exit $LASTEXITCODE). $($output -join ' ')" }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Invoke-GhJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & gh @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI call failed: $($Arguments[0]) (exit $LASTEXITCODE)." }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Write-ExecutionDiagnostics {
    param([Parameter(Mandatory)][string]$ExecutionName)
    $token = & az account get-access-token --resource https://management.azure.com/ --query accessToken --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $token) {
        Write-Output "BLOCKED_NO_EXECUTION_LOGS execution=$ExecutionName metadata=Azure-token-unavailable"
        return
    }
    $uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.App/jobs/$JobName/executions/$ExecutionName?api-version=2026-07-01"
    try {
        $headers = @{Authorization="Bearer $($token -join '')"}
        $detail = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
        $containers = @($detail.properties.detailedStatus.replicas | ForEach-Object { $_.containers } | ForEach-Object { $_ })
        $containerSummary = @($containers | ForEach-Object { "name=$($_.name),status=$($_.status),code=$($_.code),termination=$($_.additionalInformation)" }) -join ';'
        Write-Output "EXECUTION_DIAGNOSTIC execution=$ExecutionName status=$($detail.properties.status) reason=$($detail.properties.reason) message=$($detail.properties.message) containers=$containerSummary"
    } catch {
        Write-Output "BLOCKED_NO_EXECUTION_LOGS execution=$ExecutionName metadata=ARM-details-unavailable"
    }

    $extension = & az extension list --query "[?name=='containerapp'].version | [0]" --output tsv 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $extension) {
        Write-Output "BLOCKED_NO_EXECUTION_LOGS execution=$ExecutionName logExtension=containerapp-not-installed"
        return
    }
    $replicas = & az containerapp job replica list --name $JobName --resource-group $ResourceGroup --execution $ExecutionName --subscription $subscriptionId --output json 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Output "BLOCKED_NO_EXECUTION_LOGS execution=$ExecutionName replicaList=unavailable"
        return
    }
    $replicaRecords = @($replicas -join "`n" | ConvertFrom-Json)
    if ($replicaRecords.Count -eq 0) {
        Write-Output "BLOCKED_NO_EXECUTION_LOGS execution=$ExecutionName replicas=cleaned-or-unavailable"
        return
    }
    foreach ($replica in $replicaRecords) {
        $logOutput = & az containerapp job logs show --name $JobName --resource-group $ResourceGroup --execution $ExecutionName --replica $replica.name --container runner --tail 50 --subscription $subscriptionId --output json 2>&1
        if ($LASTEXITCODE -eq 0) {
            $logText = $logOutput -join "`n"
            $sha = [System.Security.Cryptography.SHA256]::Create()
            $digest = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($logText))).Replace('-','').ToLowerInvariant()
            $sha.Dispose()
            Write-Output "EXECUTION_LOGS_AVAILABLE execution=$ExecutionName replica=$($replica.name) lines=$(@($logOutput).Count) sha256=$digest"
        } else {
            $safeFailure = ($logOutput -join ' ') -replace '[\r\n]+',' '
            if ($safeFailure.Length -gt 200) { $safeFailure = $safeFailure.Substring(0,200) }
            Write-Output "BLOCKED_NO_EXECUTION_LOGS execution=$ExecutionName replica=$($replica.name) result=$safeFailure"
        }
    }
}

try {
    $subscription = Invoke-AzJson @('account','show','--output','json')
    $subscriptionId = [string]$subscription.id
    if (-not $subscriptionId) { throw 'Azure CLI has no active subscription.' }

    $group = Invoke-GhJson @('api',"orgs/$Organization/actions/runner-groups/3")
    $expectedWorkflow = "$Repository/.github/workflows/cd-services-azure.yml@refs/heads/master"
    if ($group.restricted_to_workflows -ne $true -or @($group.selected_workflows).Count -ne 1 -or $group.selected_workflows[0] -cne $expectedWorkflow) {
        throw 'Runner group allowlist is not the single approved CD workflow on master.'
    }

    $refPath = [System.Uri]::EscapeDataString($Ref)
    $commit = Invoke-GhJson @('api',"repos/$Repository/branches/$refPath")
    if (-not $commit.commit.sha) { throw 'Preflight source branch is absent from GitHub.' }
    $sha = [string]$commit.commit.sha

    $job = Invoke-AzJson @('containerapp','job','show','--name',$JobName,'--resource-group',$ResourceGroup,'--output','json','--subscription',$subscriptionId)
    if (-not $job.id -or @($job.properties.template.containers).Count -ne 1) { throw 'Existing Job missing or template shape unexpected.' }
    $container = @($job.properties.template.containers | Where-Object { $_.name -eq 'runner' }) | Select-Object -First 1
    if (-not $container -or $container.image -notmatch '^ghcr\.io/actions/actions-runner@sha256:[0-9a-f]{64}$') {
        throw 'Job image is not the pinned actions-runner image.'
    }
    if ((@($container.command) -join ' ') -ne '/bin/bash -c') { throw 'Job command differs from the approved bash entrypoint.' }
    $containerEnv = if ($container.PSObject.Properties.Name -contains 'env') { @($container.env) } else { @() }
    if (@($containerEnv | Where-Object name -eq 'H5_PREFLIGHT_REF').Count -gt 0) { throw 'Job execution already defines H5_PREFLIGHT_REF.' }

    $bootstrap = @'
set -Eeuo pipefail
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl --fail --silent --show-error --max-time 30 "https://raw.githubusercontent.com/__REPOSITORY__/__SHA__/ops/azure/github-runner-h5/preflight-runner-container.sh" -o "$work/preflight.sh"
cd "$work"
bash "$work/preflight.sh"
'@
    $bootstrap = $bootstrap.Replace('__REPOSITORY__',$Repository).Replace('__SHA__',$sha)
    $templateJson = $job.properties.template | ConvertTo-Json -Depth 100 -Compress
    $rendered = $templateJson | & python (Join-Path $PSScriptRoot 'render-execution-template.py') --set-env "H5_PREFLIGHT_REF=$Ref" --replace-args --set-arg $bootstrap 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $rendered) { throw 'Could not render the one-execution Container Apps template.' }
    $templatePath = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.yaml')
    [System.IO.File]::WriteAllText($templatePath,($rendered -join "`n"),[System.Text.UTF8Encoding]::new($false))

    $start = & az containerapp job start --name $JobName --resource-group $ResourceGroup --subscription $subscriptionId --yaml $templatePath --only-show-errors --output json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Container Apps Job start denied/failed: $($start -join ' ')" }
    $startedAt = [DateTimeOffset]::UtcNow
    $startJson = ($start -join "`n") | ConvertFrom-Json
    $executionName = [string]$startJson.name
    if (-not $executionName) {
        $runs = Invoke-AzJson @('containerapp','job','execution','list','--name',$JobName,'--resource-group',$ResourceGroup,'--subscription',$subscriptionId,'--output','json')
        $executionName = [string](@($runs | Where-Object { [DateTimeOffset]::Parse($_.properties.startTime) -ge $startedAt.AddMinutes(-1) } | Sort-Object { [DateTimeOffset]::Parse($_.properties.startTime) } -Descending | Select-Object -First 1).name)
    }
    if (-not $executionName) { throw 'Container Apps Job start did not return an execution name.' }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $execution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$executionName,'--subscription',$subscriptionId,'--output','json')
        if ($execution.properties.status -in @('Succeeded','Failed','Stopped')) { break }
        Start-Sleep -Seconds 10
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    if ($execution.properties.status -eq 'Succeeded') {
        Write-Output "PASS Container Apps Job preflight execution $executionName succeeded (image digest $($container.image))."
        Write-Output 'This verifies image tools, Git HTTPS clone, GitHub DNS/TLS, and smoke-service fail-closed behavior; it does not execute the Actions checkout action or make HTTP requests to ACA targets.'
    } elseif ($execution.properties.status -eq 'Running') {
        throw "Preflight execution $executionName exceeded timeout $TimeoutSeconds seconds."
    } else {
        Write-ExecutionDiagnostics -ExecutionName $executionName
        throw "BLOCKED_NO_EXECUTION_LOGS: preflight execution $executionName ended '$($execution.properties.status)'; inspect its structured diagnostic above."
    }
}
finally {
    if ($executionName) {
        try {
            $finalExecution = Invoke-AzJson @('containerapp','job','execution','show','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$executionName,'--subscription',$subscriptionId,'--output','json')
            if ($finalExecution.properties.status -in @('Running','Processing','Starting')) {
                $null = Invoke-AzJson @('containerapp','job','stop','--name',$JobName,'--resource-group',$ResourceGroup,'--job-execution-name',$executionName,'--subscription',$subscriptionId,'--output','json')
            }
        } catch {
            Write-Warning "CLEANUP REQUIRED: check/stop Container Apps Job execution $executionName manually."
        }
    }
    if ($templatePath -and (Test-Path -LiteralPath $templatePath)) { Remove-Item -LiteralPath $templatePath -Force -ErrorAction SilentlyContinue }
}
