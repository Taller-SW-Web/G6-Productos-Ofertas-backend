param(
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$SourceSha,
  [string]$EvidenceDirectory = (Join-Path $env:LOCALAPPDATA 'G6-H5\evidence\2026-11-23\n01')
)

$ErrorActionPreference = 'Stop'
$supportModule = Join-Path $PSScriptRoot 'n01-runner-support.psm1'
Import-Module $supportModule -Force
$whatIfModule = Join-Path $PSScriptRoot '..\azure-whatif-validation.psm1'
Import-Module $whatIfModule -Force
$resourceGroup = 'rg-g6-sb-h5-int-fork'
$templatePath = Join-Path $PSScriptRoot 'n01-restoration-smoke.bicep'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$sourceSha = $SourceSha.ToLowerInvariant()
$masterSha = (gh api repos/Taller-SW-Web/G6-Productos-Ofertas-backend/commits/master --jq .sha).Trim()
if ($LASTEXITCODE -ne 0) { throw 'N01_SOURCE_MASTER_LOOKUP_FAILED' }
$ciQuery = "repos/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs?head_sha=$sourceSha"
$ciRunsJson = gh api $ciQuery --jq '{workflow_runs: [.workflow_runs[] | {path,event,head_branch,head_sha,status,conclusion}]}'
if ($LASTEXITCODE -ne 0) { throw 'N01_SOURCE_CI_LOOKUP_FAILED' }
try { Assert-H5SourceEvidence -RepositoryFullName 'Taller-SW-Web/G6-Productos-Ofertas-backend' -SelectedSha $sourceSha -MasterSha $masterSha -WorkflowRunsJson ($ciRunsJson | Out-String) | Out-Null }
catch { throw "N01_$($_.Exception.Message)" }

$namespace = 'g6-sb-h5-int-32cdqgbnlk7ow'
$queue = 'g6.promotions.commands'
$identityName = 'g6-h5-int-promotions'
$queueResourceId = az servicebus queue show --name $queue --namespace-name $namespace --resource-group $resourceGroup --query id -o tsv
$identity = az identity show --name $identityName --resource-group $resourceGroup -o json | ConvertFrom-Json
$queueCounts = az servicebus queue show --name $queue --namespace-name $namespace --resource-group $resourceGroup --query countDetails -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'N01_AZURE_PREFLIGHT_FAILED' }
if ($queueCounts.activeMessageCount -ne 0 -or $queueCounts.deadLetterMessageCount -ne 0) {
  throw 'N01_QUEUE_NOT_EMPTY_NO_MESSAGES_SENT'
}

$assignments = az role assignment list --scope $queueResourceId --include-inherited --query "[?principalId=='$($identity.principalId)'].roleDefinitionName" -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or
    $assignments -notcontains 'Azure Service Bus Data Sender' -or
    $assignments -notcontains 'Azure Service Bus Data Receiver') {
  throw 'N01_PROMOTIONS_QUEUE_RBAC_NOT_VERIFIED'
}

$null = New-Item -ItemType Directory -Path $EvidenceDirectory -Force
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$containerGroupName = "h5-n01-$stamp-$suffix"
$groups = az container list --resource-group $resourceGroup --query '[].name' -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'N01_TEMPORARY_ACI_STATE_QUERY_FAILED' }
if (@($groups | Where-Object { $_ -ceq $containerGroupName }).Count -ne 0) { throw 'N01_TEMPORARY_ACI_ALREADY_EXISTS' }
$deploymentName = "n01-smoke-$stamp-$suffix"
$databaseName = "g6_h5_azure_smoke_$suffix"
$postgresPassword = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$postgresUrl = "postgresql://postgres:$postgresPassword@127.0.0.1:5432/$databaseName"
$tempDirectory = Join-Path $env:TEMP $deploymentName
$null = New-Item -ItemType Directory -Path $tempDirectory -Force
$parametersPath = Join-Path $tempDirectory 'parameters.private.json'
$armPath = Join-Path $tempDirectory 'template.json'
$whatIfPath = Join-Path $tempDirectory 'what-if.private.json'
$whatIfErrorPath = Join-Path $tempDirectory 'what-if.private.stderr'
$runnerLog = Join-Path $EvidenceDirectory 'runner.log'
$postgresLog = Join-Path $EvidenceDirectory 'postgres.log'
$containerDeploymentAttempted = $false
$runError = $null
$cleanupErrors = @()

try {
  $parameters = @{
    '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
    contentVersion = '1.0.0.0'
    parameters = @{
      containerGroupName = @{ value = $containerGroupName }
      location = @{ value = 'brazilsouth' }
      sourceSha = @{ value = $sourceSha }
      promotionsIdentityResourceId = @{ value = $identity.id }
      promotionsClientId = @{ value = $identity.clientId }
      postgresPassword = @{ value = $postgresPassword }
      postgresUrl = @{ value = $postgresUrl }
      databaseName = @{ value = $databaseName }
    }
  }
  $parameters | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $parametersPath -Encoding utf8

  az bicep build --file $templatePath --outfile $armPath --no-restore
  if ($LASTEXITCODE -ne 0) { throw 'N01_BICEP_BUILD_FAILED' }

  az deployment group what-if --no-pretty-print --name $deploymentName --resource-group $resourceGroup --template-file $templatePath --parameters "@$parametersPath" --output json 1> $whatIfPath 2> $whatIfErrorPath
  if ($LASTEXITCODE -ne 0) { throw 'N01_AZURE_WHAT_IF_FAILED' }
  $groupId = az group show --name $resourceGroup --query id --output tsv
  if ($LASTEXITCODE -ne 0) { throw 'N01_RESOURCE_GROUP_LOOKUP_FAILED' }
  $expectedAciId = "$groupId/providers/Microsoft.ContainerInstance/containerGroups/$containerGroupName"
  Assert-N01WhatIfScope -Json (Get-Content -Raw -LiteralPath $whatIfPath) -ExpectedResourceId $expectedAciId -ContainerGroupName $containerGroupName | Out-Null

  $containerDeploymentAttempted = $true
  az deployment group create --name $deploymentName --resource-group $resourceGroup --template-file $templatePath --parameters "@$parametersPath" --output none
  if ($LASTEXITCODE -ne 0) { throw 'N01_ACI_DEPLOYMENT_FAILED' }

  $deadline = (Get-Date).AddMinutes(35)
  $runnerExitCode = $null
  $postgresExitCode = $null
  while ((Get-Date) -lt $deadline) {
    $group = az container show --name $containerGroupName --resource-group $resourceGroup -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'N01_ACI_STATE_QUERY_FAILED' }
    $runner = $group.containers | Where-Object name -eq 'runner'
    $postgres = $group.containers | Where-Object name -eq 'postgres'
    $runnerState = $runner.instanceView.currentState.state
    $runnerExitCode = $runner.instanceView.currentState.exitCode
    $postgresState = $postgres.instanceView.currentState.state
    $postgresExitCode = $postgres.instanceView.currentState.exitCode
    if ($runnerState -eq 'Terminated' -and $null -ne $runnerExitCode -and
        $postgresState -eq 'Terminated' -and $null -ne $postgresExitCode) { break }
    Start-Sleep -Seconds 10
  }

  az container logs --name $containerGroupName --resource-group $resourceGroup --container-name runner *> $runnerLog
  $runnerLogsCode = $LASTEXITCODE
  az container logs --name $containerGroupName --resource-group $resourceGroup --container-name postgres *> $postgresLog
  $postgresLogsCode = $LASTEXITCODE
  if ($runnerLogsCode -ne 0 -or $postgresLogsCode -ne 0) { throw 'N01_ACI_LOG_CAPTURE_FAILED' }
  if ($runnerExitCode -ne 0 -or $postgresExitCode -ne 0) { throw 'N01_ACI_CONTAINER_EXIT_FAILED' }

  $jsonEvents = foreach ($line in Get-Content -LiteralPath $runnerLog) {
    try { $line | ConvertFrom-Json -ErrorAction Stop } catch { }
  }
  $summary = @($jsonEvents | Where-Object step -eq 'result' | Select-Object -Last 1)[0]
  $sql = @($jsonEvents | Where-Object step -eq 'sql-verification' | Select-Object -Last 1)[0]
  $settlements = @($jsonEvents | Where-Object step -eq 'settlement')
  $terminal = @($settlements | Select-Object -Last 1)[0]
  Assert-N01EvidenceBinding -TerminalEvent $terminal -SqlEvent $sql -ExpectedSha $sourceSha | Out-Null
  if ($summary.status -ne 'PASS' -or $terminal.terminal -ne 'REJECTED' -or
      $terminal.result_code -ne 'COUPON_IDENTITY_MISMATCH' -or
      $summary.settled -ne 2 -or $summary.inbox_rows -ne 1 -or
      $summary.receipt_rows -ne 1 -or $summary.coupon_effects -ne 0 -or
      $settlements.Count -ne 2 -or $sql.inbox_rows -ne 1 -or
      $sql.receipt_rows -ne 1 -or $sql.coupon_effects -ne 0 -or
      $sql.outbox_attempts -ne 1 -or -not $sql.outbox_sent) {
    throw 'N01_SMOKE_RESULT_ASSERTIONS_FAILED'
  }

  $afterCounts = az servicebus queue show --name $queue --namespace-name $namespace --resource-group $resourceGroup --query countDetails -o json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $afterCounts.activeMessageCount -ne 0 -or $afterCounts.deadLetterMessageCount -ne 0) {
    throw 'N01_QUEUE_NOT_DRAINED_OR_DLQ_NONEMPTY'
  }

  [pscustomobject]@{
    status = 'PASS'
    sourceSha = $sourceSha
    namespace = $namespace
    queue = $queue
    identity = $identityName
    containerGroupName = $containerGroupName
    deploymentName = $deploymentName
    runnerImage = 'node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d'
    postgresImage = 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
    messageId = $summary.message_id
    correlationId = $summary.correlation_id
    operationId = $summary.operation_id
    terminal = $terminal.terminal
    resultCode = $terminal.result_code
    deliveries = $summary.settled
    runtimeRestarts = $summary.runtime_restarts
    outboxAttempts = $sql.outbox_attempts
    outboxSent = $sql.outbox_sent
    inboxRows = $sql.inbox_rows
    receiptRows = $sql.receipt_rows
    couponEffects = $sql.coupon_effects
    dlqBefore = $queueCounts.deadLetterMessageCount
    dlqAfter = $afterCounts.deadLetterMessageCount
    activeAfter = $afterCounts.activeMessageCount
    runnerExitCode = $runnerExitCode
    postgresExitCode = $postgresExitCode
    runnerLog = $runnerLog
    postgresLog = $postgresLog
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'summary.json') -Encoding utf8
} catch {
  $runError = $_
} finally {
  try {
    $temporaryPaths = @($parametersPath, $armPath, $whatIfPath, $tempDirectory)
    $cleanup = Invoke-N01Cleanup -ResourceGroup $resourceGroup `
      -ContainerGroupName $containerGroupName `
      -ContainerDeploymentAttempted $containerDeploymentAttempted `
      -TemporaryPaths $temporaryPaths
    $cleanupErrors = @($cleanup.Errors)
  } catch {
    $cleanupErrors = @('N01_CLEANUP_HELPER_FAILED')
  }
}

Complete-N01RunOutcome -OriginalError $runError -CleanupErrors $cleanupErrors
Get-Content -Raw -LiteralPath (Join-Path $EvidenceDirectory 'summary.json')
