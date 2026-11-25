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
    foreach($line in [System.IO.File]::ReadAllLines($Path)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $event=$line|ConvertFrom-Json -ErrorAction Stop } catch { throw 'LEGACY_PATCH_JOURNAL_AMBIGUOUS: corrupt JSONL; preserve it and block both destinations.' }
        $attemptId=if($event.PSObject.Properties.Name -contains 'attemptId') {[string]$event.attemptId} else {''}
        $resourceId=if($event.PSObject.Properties.Name -contains 'resourceId') {[string]$event.resourceId} else {''}
        if ([string]::IsNullOrWhiteSpace($attemptId) -or [string]::IsNullOrWhiteSpace($resourceId) -or @($known|Where-Object{[string]::Equals($_,$resourceId,[System.StringComparison]::OrdinalIgnoreCase)}).Count -ne 1) {
            throw 'LEGACY_PATCH_JOURNAL_AMBIGUOUS: missing attemptId or unrecognized full Resource ID; preserve it and block both destinations.'
        }
        if ($latest.ContainsKey($attemptId) -and -not [string]::Equals([string]$latest[$attemptId].resourceId,$resourceId,[System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'LEGACY_PATCH_JOURNAL_AMBIGUOUS: one attemptId references multiple Resource IDs; preserve it and block both destinations.'
        }
        $latest[$attemptId]=$event
    }
    return @($latest.Values)
}

function Test-H5PatchOperationPending {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Operation)
    $terminalState=if($Operation.PSObject.Properties.Name -contains 'terminalState') {[string]$Operation.terminalState} else {$null}
    $readback=if($Operation.PSObject.Properties.Name -contains 'readbackResult') {[string]$Operation.readbackResult} else {$null}
    return ($terminalState -notin @('Succeeded','Failed','Canceled','Cancelled','Rejected') -or
        ($terminalState -in @('Succeeded','Failed','Canceled','Cancelled') -and $readback -notin @('VerifiedPresent','VerifiedAbsent')))
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
    foreach($operation in @(Get-H5LegacyJournalOperations -Path $StatePaths.LegacyPatchJournal)) {
        if ([string]::Equals([string]$operation.resourceId,$targetId,[System.StringComparison]::OrdinalIgnoreCase) -and (Test-H5PatchOperationPending -Operation $operation)) {
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
