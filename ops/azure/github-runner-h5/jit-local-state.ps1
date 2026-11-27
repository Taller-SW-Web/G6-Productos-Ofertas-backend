Set-StrictMode -Version Latest

function Get-H5JitResourceId {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Target)

    $config = Get-H5DeploymentTargets
    $destination = [string]$Target.Destination
    if ($destination -notin @('brazil-isolated','chile-shared')) {
        throw 'JIT_STATE_DESTINATION_INVALID: destination is not an approved isolated target.'
    }
    $expected = Resolve-H5DeploymentTarget -Destination $destination
    foreach ($field in @('SubscriptionId','ResourceGroup','AcaEnvironment','JobName','GitHubEnvironment','SmokeLabel')) {
        if ([string]$Target.$field -cne [string]$expected.$field) {
            throw "JIT_STATE_TARGET_MISMATCH: $field does not match the approved destination map."
        }
    }
    $resourceId = "/subscriptions/$($config.subscriptionId)/resourceGroups/$($expected.ResourceGroup)/providers/Microsoft.App/jobs/$($expected.JobName)"
    return $resourceId
}

function Assert-H5RunnerGroupRestriction {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Group,[Parameter(Mandatory)]$Repositories,[Parameter(Mandatory)][string]$Repository,[Parameter(Mandatory)][string]$ExpectedWorkflow)
    if ($Group.restricted_to_workflows -ne $true -or @($Group.selected_workflows).Count -ne 1 -or [string]$Group.selected_workflows[0] -cne $ExpectedWorkflow) {
        throw 'RUNNER_GROUP_WORKFLOW_SCOPE_INVALID: JIT registration requires exactly the official master CD workflow.'
    }
    if (@($Repositories.repositories).Count -ne 1 -or [string]$Repositories.repositories[0].full_name -cne $Repository) {
        throw 'RUNNER_GROUP_REPOSITORY_SCOPE_INVALID: JIT registration requires exactly the authorized repository.'
    }
}

function Get-H5JitKnownResourceIds {
    [CmdletBinding()]
    param()
    foreach ($destination in @('brazil-isolated','chile-shared')) {
        $target = Resolve-H5DeploymentTarget -Destination $destination
        [pscustomobject]@{ Destination=$destination; ResourceId=(Get-H5JitResourceId -Target $target) }
    }
}

function Get-H5JitLocalStatePaths {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Target)

    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'JIT_STATE_LOCAL_STORAGE_UNAVAILABLE: LOCALAPPDATA is not set.' }
    $resourceId = Get-H5JitResourceId -Target $Target
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($resourceId.ToLowerInvariant()))).Replace('-','').ToLowerInvariant()
    } finally { $sha.Dispose() }
    $root = Join-Path (Join-Path $env:LOCALAPPDATA 'G6\azure-h5-smoke') (Join-Path 'destinations' (Join-Path ([string]$Target.Destination) $hash))
    return [pscustomobject]@{
        Destination=[string]$Target.Destination
        ResourceId=$resourceId
        Root=$root
        CleanupMarker=(Join-Path $root 'CLEANUP_INCOMPLETE.json')
        AttemptRecord=(Join-Path $root 'JIT_ATTEMPT.json')
        PatchJournal=(Join-Path (Join-Path $root 'patch-lro-tracking') 'operations.jsonl')
        LegacyRoot=(Join-Path $env:LOCALAPPDATA 'G6\azure-h5-smoke')
        LegacyCleanupMarker=(Join-Path (Join-Path $env:LOCALAPPDATA 'G6\azure-h5-smoke') 'CLEANUP_INCOMPLETE.json')
        LegacyAttemptRecord=(Join-Path (Join-Path $env:LOCALAPPDATA 'G6\azure-h5-smoke') 'JIT_ATTEMPT.json')
        LegacyPatchJournal=(Join-Path (Join-Path $env:LOCALAPPDATA 'G6\azure-h5-smoke\patch-lro-tracking') 'operations.jsonl')
    }
}

function Protect-H5JitLocalStateDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { $null=New-Item -ItemType Directory -Path $Path -Force }
    Protect-AcaPatchJournalPath -Path $Path -Directory $true
}

function Write-H5JitLocalStateRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)]$Record)
    $directory=Split-Path -Parent $Path
    Protect-H5JitLocalStateDirectory -Path $directory
    if (Test-Path -LiteralPath $Path) { throw 'JIT_STATE_RECORD_ALREADY_EXISTS: refusing to overwrite an unresolved local record.' }
    $json=$Record | ConvertTo-Json -Depth 10 -Compress
    $bytes=[System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream=[System.IO.FileStream]::new($Path,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::Read)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Protect-AcaPatchJournalPath -Path $Path -Directory $false
}

function Get-H5LegacyRecordResourceId {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$RecordType)
    try { $record=Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop } catch { throw "LEGACY_JIT_STATE_AMBIGUOUS: $RecordType cannot be parsed; preserve it and block both destinations." }
    $resourceId=if($record.PSObject.Properties.Name -contains 'resourceId') {[string]$record.resourceId} else {''}
    $known=@(Get-H5JitKnownResourceIds)
    $matches=@($known|Where-Object{[string]::Equals($_.ResourceId,$resourceId,[System.StringComparison]::OrdinalIgnoreCase)})
    if ([string]::IsNullOrWhiteSpace($resourceId) -or $matches.Count -ne 1) {
        throw "LEGACY_JIT_STATE_AMBIGUOUS: $RecordType has no exact approved Resource ID; preserve it and block both destinations."
    }
    $target=Resolve-H5DeploymentTarget -Destination $matches[0].Destination
    foreach($field in @(@{Name='destination';Expected=$matches[0].Destination},@{Name='subscriptionId';Expected=$target.SubscriptionId},@{Name='resourceGroup';Expected=$target.ResourceGroup},@{Name='acaEnvironment';Expected=$target.AcaEnvironment},@{Name='jobName';Expected=$target.JobName})) {
        if($record.PSObject.Properties.Name -contains $field.Name -and -not [string]::IsNullOrWhiteSpace([string]$record.($field.Name)) -and [string]$record.($field.Name) -cne [string]$field.Expected) {
            throw "LEGACY_JIT_STATE_AMBIGUOUS: $RecordType disagrees with the approved $($field.Name) for its exact Resource ID."
        }
    }
    return $resourceId
}

function Get-H5LegacyJournalOperations {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $known=@(Get-H5JitKnownResourceIds | ForEach-Object ResourceId)
    $latest=@{}
    try { $events=@(Get-AcaPatchJournalEvents -Path $Path -AllowedResourceIds $known) } catch { throw "LEGACY_PATCH_JOURNAL_AMBIGUOUS: $($_.Exception.Message); preserve it and block both destinations." }
    foreach($event in $events) {
        if ([string]$event.event -in @('LegacyReconciliation','LegacyResolutionObserved')) { throw 'LEGACY_PATCH_JOURNAL_AMBIGUOUS: a legacy journal contains a non-source reconciliation event; preserve it and block both destinations.' }
        $attemptId=[string]$event.attemptId
        $resourceId=[string]$event.resourceId
        if ($latest.ContainsKey($attemptId) -and -not [string]::Equals([string]$latest[$attemptId].resourceId,$resourceId,[System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'LEGACY_PATCH_JOURNAL_AMBIGUOUS: one attemptId references multiple Resource IDs; preserve it and block both destinations.'
        }
        $latest[$attemptId]=$event
    }
    return @($latest.Values)
}

function Get-H5LegacyJournalResolutions {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$ResourceId)
    $events=@(Get-AcaPatchJournalEvents -Path $Path -AllowedResourceIds @($ResourceId))
    return @($events | Where-Object { [string]$_.event -ceq 'LegacyReconciliation' })
}

function Test-H5PatchOperationPending {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Operation)
    return -not (Test-AcaPatchOperationResolved -Record $Operation)
}

function Test-H5LegacyOperationReconciled {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Operation,[Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Resolutions)
    try { $expectedReadback=Get-AcaPatchExpectedReadback -Operation ([string]$Operation.operation) } catch { return $false }
    $recordedSecretName=if($Operation.PSObject.Properties.Name -contains 'expectedSecretName'){[string]$Operation.expectedSecretName}else{''}
    $expectedSecretName=Get-AcaPatchExpectedJitSecretName -Operation ([string]$Operation.operation) -RecordedName $recordedSecretName
    $matches=@($Resolutions | Where-Object {
        [string]$_.sourceAttemptId -ceq [string]$Operation.attemptId -and
        [string]::Equals([string]$_.resourceId,[string]$Operation.resourceId,[System.StringComparison]::OrdinalIgnoreCase) -and
        [string]$_.operation -ceq [string]$Operation.operation -and
        [string]$_.lroReference -ceq [string]$Operation.lroReference -and
        [string]$_.expectedSecretName -ceq $expectedSecretName -and
        [string]$_.readbackResult -ceq $expectedReadback -and
        [string]$_.terminalState -in @('Succeeded','Failed','Canceled','Cancelled')
    })
    return $matches.Count -eq 1
}

function Get-H5LegacyPendingOperations {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Operations,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Resolutions,
        [Parameter(Mandatory)][string]$ResourceId
    )
    $pending=@()
    foreach($operation in $Operations) {
        if (-not [string]::Equals([string]$operation.resourceId,$ResourceId,[System.StringComparison]::OrdinalIgnoreCase)) { continue }
        if (-not (Test-H5PatchOperationPending -Operation $operation)) { continue }
        if (Test-H5LegacyOperationReconciled -Operation $operation -Resolutions $Resolutions) { continue }
        $pending+=@($operation)
    }
    return @($pending)
}

function Assert-H5LegacyJitStateSafe {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Target,[Parameter(Mandatory)]$StatePaths)
    $targetId=Get-H5JitResourceId -Target $Target
    foreach($entry in @(@{Path=$StatePaths.LegacyCleanupMarker;Type='CLEANUP_INCOMPLETE'},@{Path=$StatePaths.LegacyAttemptRecord;Type='JIT_ATTEMPT'})) {
        if (-not (Test-Path -LiteralPath $entry.Path)) { continue }
        $legacyId=Get-H5LegacyRecordResourceId -Path $entry.Path -RecordType $entry.Type
        if ([string]::Equals($legacyId,$targetId,[System.StringComparison]::OrdinalIgnoreCase)) {
            throw "LEGACY_JIT_STATE_BLOCKED: $($entry.Type) belongs to the selected Resource ID; preserve and reconcile it."
        }
    }
    $legacyOperations=@(Get-H5LegacyJournalOperations -Path $StatePaths.LegacyPatchJournal)
    $resolutions=@(Get-H5LegacyJournalResolutions -Path $StatePaths.PatchJournal -ResourceId $targetId)
    foreach($operation in $legacyOperations) {
        $isTarget=[string]::Equals([string]$operation.resourceId,$targetId,[System.StringComparison]::OrdinalIgnoreCase)
        $resolved=if($isTarget) { Test-H5LegacyOperationReconciled -Operation $operation -Resolutions $resolutions } else { $false }
        if ($isTarget -and (Test-H5PatchOperationPending -Operation $operation) -and -not $resolved) {
            throw "LEGACY_PATCH_JOURNAL_BLOCKED: unresolved attempt $($operation.attemptId) belongs to the selected Resource ID; use the destination-scoped resolver."
        }
    }
    $manifestPath=Join-Path $PSScriptRoot 'historical-jit-blocks.json'
    try { $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { throw 'HISTORICAL_JIT_BLOCK_MANIFEST_INVALID: refusing registration because the reviewed historical block manifest cannot be read.' }
    if ([int]$manifest.schemaVersion -ne 1) { throw 'HISTORICAL_JIT_BLOCK_MANIFEST_INVALID: unsupported schema version.' }
    foreach($block in @($manifest.blocks)) {
        $blockId=[string]$block.resourceId
        if ([string]::IsNullOrWhiteSpace($blockId) -or @((Get-H5JitKnownResourceIds)|Where-Object{[string]::Equals($_.ResourceId,$blockId,[System.StringComparison]::OrdinalIgnoreCase)}).Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$block.state)) {
            throw 'HISTORICAL_JIT_BLOCK_MANIFEST_INVALID: a block lacks an exact approved Resource ID or state; refusing all registrations.'
        }
        if ([string]::Equals($blockId,$targetId,[System.StringComparison]::OrdinalIgnoreCase) -and [string]$block.state -ne 'Resolved') {
            throw "HISTORICAL_LRO_UNVERIFIABLE: selected Resource ID is blocked by reviewed historical state $($block.state); preserve evidence and obtain operator disposition."
        }
    }
}

function Assert-H5DestinationJitStateClear {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Target,[Parameter(Mandatory)]$StatePaths)
    $targetId=Get-H5JitResourceId -Target $Target
    if (Test-Path -LiteralPath $StatePaths.CleanupMarker) { throw 'CLEANUP_INCOMPLETE: destination-scoped cleanup marker exists; reconcile it without deleting it.' }
    if (Test-Path -LiteralPath $StatePaths.AttemptRecord) { throw 'CLEANUP_INCOMPLETE: destination-scoped JIT_ATTEMPT exists; reconcile it before another request.' }
    $pending=@(Get-AcaPatchJournalPendingOperations -ResourceId $targetId)
    if($pending.Count -gt 0) { throw "ARM_PATCH_JOURNAL_BLOCKED: unresolved destination-scoped attempt(s) $(@($pending|ForEach-Object{$_.attemptId}) -join ','); reconcile before another request." }
}
