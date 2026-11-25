$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\deployment-targets.ps1')
. (Join-Path $PSScriptRoot '..\aca-job-secret-patch.ps1')
. (Join-Path $PSScriptRoot '..\jit-runner-operations.ps1')
. (Join-Path $PSScriptRoot '..\jit-local-state.ps1')

function Assert-True([bool]$Condition,[string]$Message) { if(-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action,[string]$Pattern,[string]$Message) {
    try { & $Action; throw "TEST_EXPECTED_REJECTION: $Message" } catch {
        if($_.Exception.Message -notmatch $Pattern) { throw }
    }
}
function Reset-TestState([string]$Root) {
    $base=Join-Path $Root 'G6\azure-h5-smoke'
    if(Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
    return $base
}
function Write-LegacyJournal([string]$Path,[object[]]$Events) {
    $dir=Split-Path -Parent $Path
    $null=New-Item -ItemType Directory -Path $dir -Force
    [System.IO.File]::WriteAllLines($Path,@($Events|ForEach-Object{$_|ConvertTo-Json -Compress -Depth 8}),[System.Text.UTF8Encoding]::new($false))
}

$testRoot=Join-Path $env:TEMP ('g6-jit-state-test-'+[guid]::NewGuid().ToString('N'))
$oldLocalAppData=$env:LOCALAPPDATA
$env:LOCALAPPDATA=$testRoot
$chile=Resolve-H5DeploymentTarget -Destination chile-shared
$brazil=Resolve-H5DeploymentTarget -Destination brazil-isolated
$chileId=Get-H5JitResourceId -Target $chile
$brazilId=Get-H5JitResourceId -Target $brazil
$chilePaths=Get-H5JitLocalStatePaths -Target $chile
$brazilPaths=Get-H5JitLocalStatePaths -Target $brazil

try {
    Assert-True ($chileId -ne $brazilId -and $chilePaths.Root -ne $brazilPaths.Root -and $chilePaths.PatchJournal -ne $brazilPaths.PatchJournal) 'destinations share a local state path or Resource ID'
    $base=Reset-TestState $testRoot
    Assert-H5LegacyJitStateSafe -Target $chile -StatePaths $chilePaths
    Assert-Throws { Assert-H5LegacyJitStateSafe -Target $brazil -StatePaths $brazilPaths } 'HISTORICAL_LRO_UNVERIFIABLE' 'Brazil historical LRO is no longer blocked'

    # An exact legacy Brazil marker stays untouched and blocks only its proven Resource ID.
    $legacyMarker=$chilePaths.LegacyCleanupMarker
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $legacyMarker) -Force
    $markerJson=@{resourceId=$brazilId;patchOutcome='Ambiguous';failures=@('historical')}|ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($legacyMarker,$markerJson,[System.Text.UTF8Encoding]::new($false))
    $before=[System.IO.File]::ReadAllText($legacyMarker)
    Assert-H5LegacyJitStateSafe -Target $chile -StatePaths $chilePaths
    Assert-True ((Test-Path -LiteralPath $legacyMarker) -and [System.IO.File]::ReadAllText($legacyMarker) -ceq $before) 'legacy Brazil marker was changed or deleted'
    Assert-Throws { Assert-H5LegacyJitStateSafe -Target $brazil -StatePaths $brazilPaths } 'LEGACY_JIT_STATE_BLOCKED' 'exact Brazil marker did not block Brazil'

    # Old marker formats without an exact Resource ID are ambiguous and block both targets.
    $base=Reset-TestState $testRoot
    $legacyMarker=$chilePaths.LegacyCleanupMarker
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $legacyMarker) -Force
    [System.IO.File]::WriteAllText($legacyMarker,'{"runnerName":"unknown"}',[System.Text.UTF8Encoding]::new($false))
    Assert-Throws { Assert-H5LegacyJitStateSafe -Target $chile -StatePaths $chilePaths } 'LEGACY_JIT_STATE_AMBIGUOUS' 'ambiguous legacy marker did not block Chile'

    # A failed/pending Brazil LRO is scoped to Brazil by full Resource ID and cannot be polled against Chile.
    $base=Reset-TestState $testRoot
    $legacyEvent=@{attemptId='brazil-pending';resourceId=$brazilId;event='PatchResponse';terminalState=$null;readbackResult=$null;lroReference='https://management.azure.com/exact-brazil-lro'}
    Write-LegacyJournal $chilePaths.LegacyPatchJournal @($legacyEvent)
    Assert-H5LegacyJitStateSafe -Target $chile -StatePaths $chilePaths
    Assert-Throws { Assert-H5LegacyJitStateSafe -Target $brazil -StatePaths $brazilPaths } 'LEGACY_PATCH_JOURNAL_BLOCKED' 'Brazil pending LRO was not blocked for Brazil'

    # Chile's own unresolved attempt blocks Chile.
    $base=Reset-TestState $testRoot
    Write-LegacyJournal $chilePaths.LegacyPatchJournal @(@{attemptId='chile-pending';resourceId=$chileId;event='PatchResponse';terminalState=$null;readbackResult=$null;lroReference='https://management.azure.com/exact-chile-lro'})
    Assert-Throws { Assert-H5LegacyJitStateSafe -Target $chile -StatePaths $chilePaths } 'LEGACY_PATCH_JOURNAL_BLOCKED' 'Chile unresolved LRO did not block Chile'

    # Unknown RG, reused attempt IDs across Resource IDs, corrupt JSONL and missing IDs fail closed.
    foreach($badEvents in @(
        @(@{attemptId='wrong-rg';resourceId='/subscriptions/fef42188-accd-4470-ae88-78f583eb4906/resourceGroups/other/providers/Microsoft.App/jobs/azure-h5-smoke';event='PatchResponse'}),
        @(@{attemptId='same';resourceId=$brazilId;event='AttemptStarted'},@{attemptId='same';resourceId=$chileId;event='Readback'}),
        @(@{resourceId=$chileId;event='PatchResponse'}))) {
        $base=Reset-TestState $testRoot
        Write-LegacyJournal $chilePaths.LegacyPatchJournal $badEvents
        Assert-Throws { Assert-H5LegacyJitStateSafe -Target $chile -StatePaths $chilePaths } 'LEGACY_PATCH_JOURNAL_AMBIGUOUS' 'untrusted legacy provenance was accepted'
    }
    $base=Reset-TestState $testRoot
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $chilePaths.LegacyPatchJournal) -Force
    [System.IO.File]::WriteAllText($chilePaths.LegacyPatchJournal,'{bad json',[System.Text.UTF8Encoding]::new($false))
    Assert-Throws { Assert-H5LegacyJitStateSafe -Target $chile -StatePaths $chilePaths } 'LEGACY_PATCH_JOURNAL_AMBIGUOUS' 'corrupt legacy journal was accepted'

    # No Chile operation is present, while a Chile-specific attempt/marker blocks only the matching state.
    $base=Reset-TestState $testRoot
    Assert-H5LegacyJitStateSafe -Target $chile -StatePaths $chilePaths
    Assert-H5DestinationJitStateClear -Target $chile -StatePaths $chilePaths
    Write-H5JitLocalStateRecord -Path $chilePaths.AttemptRecord -Record @{destination='chile-shared';resourceId=$chileId;jobName='azure-h5-smoke-chile'}
    Assert-Throws { Assert-H5DestinationJitStateClear -Target $chile -StatePaths $chilePaths } 'JIT_ATTEMPT exists' 'Chile own attempt did not block a second JIT'

    $base=Reset-TestState $testRoot
    Write-H5JitLocalStateRecord -Path $chilePaths.CleanupMarker -Record @{destination='chile-shared';resourceId=$chileId;jobName='azure-h5-smoke-chile';patchOutcome='Ambiguous'}
    $written=Get-Content -LiteralPath $chilePaths.CleanupMarker -Raw|ConvertFrom-Json
    Assert-True ($written.resourceId -ceq $chileId -and $written.destination -ceq 'chile-shared' -and -not (Test-Path -LiteralPath $brazilPaths.CleanupMarker)) 'cleanup failure marker was written to the wrong destination'

    # A destination journal rejects any Resource ID from another RG before another PATCH.
    $base=Reset-TestState $testRoot
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $chilePaths.PatchJournal) -Force
    [System.IO.File]::WriteAllText($chilePaths.PatchJournal,(@{attemptId='foreign';resourceId=$brazilId;event='PatchResponse'}|ConvertTo-Json -Compress),[System.Text.UTF8Encoding]::new($false))
    Set-AcaPatchJournalPathOverride $chilePaths.PatchJournal
    Assert-Throws { Assert-AcaPatchJournalReady -ResourceId $chileId } 'PATCH_JOURNAL_RESOURCE_MISMATCH' 'destination journal accepted another Job Resource ID'
    Set-AcaPatchJournalPathOverride $null

    # An unresolved attempt for the same destination prevents a second secret PATCH.
    $base=Reset-TestState $testRoot
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $chilePaths.PatchJournal) -Force
    [System.IO.File]::WriteAllText($chilePaths.PatchJournal,(@{attemptId='chile-second-patch-block';resourceId=$chileId;event='PatchResponse'}|ConvertTo-Json -Compress),[System.Text.UTF8Encoding]::new($false))
    Set-AcaPatchJournalPathOverride $chilePaths.PatchJournal
    Assert-Throws { Assert-AcaPatchJournalReady -ResourceId $chileId } 'ARM_PATCH_JOURNAL_BLOCKED' 'second PATCH was not blocked for unresolved Chile operation'
    Set-AcaPatchJournalPathOverride $null

    # JIT labels and runner group remain exclusive to the authorized Chile selector/workflow/repository.
    $jit=New-GitHubJitRequestJson -Mode Smoke -Name 'chile-smoke-test' -RunnerGroupId 3 -SmokeLabel $chile.SmokeLabel | ConvertFrom-Json
    Assert-True (@($jit.labels) -contains 'azure-h5-smoke-chile' -and @($jit.labels) -notcontains 'azure-h5-smoke') 'Chile JIT request can acquire Brazil labels'
    $expected='Taller-SW-Web/G6-Productos-Ofertas-backend/.github/workflows/cd-services-azure.yml@refs/heads/master'
    Assert-H5RunnerGroupRestriction -Group @{restricted_to_workflows=$true;selected_workflows=@($expected)} -Repositories @{repositories=@(@{full_name='Taller-SW-Web/G6-Productos-Ofertas-backend'})} -Repository 'Taller-SW-Web/G6-Productos-Ofertas-backend' -ExpectedWorkflow $expected
    Assert-Throws { Assert-H5RunnerGroupRestriction -Group @{restricted_to_workflows=$true;selected_workflows=@($expected,'other.yml')} -Repositories @{repositories=@(@{full_name='Taller-SW-Web/G6-Productos-Ofertas-backend'})} -Repository 'Taller-SW-Web/G6-Productos-Ofertas-backend' -ExpectedWorkflow $expected } 'RUNNER_GROUP_WORKFLOW_SCOPE_INVALID' 'extra workflow was accepted'
    Assert-Throws { Assert-H5RunnerGroupRestriction -Group @{restricted_to_workflows=$true;selected_workflows=@($expected)} -Repositories @{repositories=@(@{full_name='other/repo'})} -Repository 'Taller-SW-Web/G6-Productos-Ofertas-backend' -ExpectedWorkflow $expected } 'RUNNER_GROUP_REPOSITORY_SCOPE_INVALID' 'extra/different repository was accepted'

    Write-Output 'PASS JIT local state isolation: legacy provenance, destination journals, markers, labels and runner group are fail-closed.'
} finally {
    Set-AcaPatchJournalPathOverride $null
    $env:LOCALAPPDATA=$oldLocalAppData
    if(Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
