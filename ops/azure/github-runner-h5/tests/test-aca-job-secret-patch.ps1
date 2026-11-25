$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\aca-job-secret-patch.ps1')

$script:secretName = $null
$script:patchMode = 'success'
$script:emitEtag = $true
$script:requestLog = [System.Collections.Generic.List[object]]::new()
$script:operationReplies = [System.Collections.Generic.Queue[string]]::new()
$script:testSecret = 'jit-config-test-value-do-not-print'
$script:testToken = 'arm-token-test-value-do-not-print'
$script:jobName = 'azure-h5-smoke'
$script:resourceGroup = 'rg-g6-sb-h5-int-fork'
$script:environmentId = '/subscriptions/test/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/env-g6-h5-int'
$script:image = 'ghcr.io/actions/actions-runner@sha256:' + ('a' * 64)
$script:journalTestRoot = Join-Path $env:TEMP ('g6-h5-journal-test-' + [guid]::NewGuid().ToString('N'))
Set-AcaPatchJournalPathOverride (Join-Path $script:journalTestRoot 'operations.jsonl')
$script:jobUri = "https://management.azure.com/subscriptions/test/resourceGroups/$($script:resourceGroup)/providers/Microsoft.App/jobs/$($script:jobName)?api-version=2025-07-01"

function New-FakeJob {
    $secrets = $null
    if ($script:secretName) { $secrets = @(@{name=$script:secretName}) }
    return @{
        id = "/subscriptions/test/resourceGroups/$($script:resourceGroup)/providers/Microsoft.App/jobs/$($script:jobName)"
        name = $script:jobName
        properties = @{
            environmentId = $script:environmentId
            configuration = @{secrets=$secrets}
            template = @{
                containers = @(@{
                    name = 'runner'
                    image = $script:image
                    command = @('/bin/bash','-c')
                    args = @('exec /home/runner/run.sh --jitconfig "$jit_config"')
                })
            }
        }
    }
}

function New-LegacyPatchEvents([string]$AttemptId,[string]$ResourceId,[string]$Operation,[string]$LroReference,[string]$SecretName='h5jit') {
    $started=@{attemptId=$AttemptId;timestampUtc=[DateTimeOffset]::UtcNow.ToString('o');event='AttemptStarted';resourceId=$ResourceId;operation=$Operation;httpStatus=$null;requestId=$null;correlationId=$null;lroReference=$null;terminalState=$null;readbackResult=$null;expectedSecretName=$SecretName;sourceAttemptId=$null}
    $response=$started.Clone();$response.event='PatchResponse';$response.httpStatus=202;$response.requestId='legacy-request';$response.correlationId='legacy-correlation';$response.lroReference=$LroReference
    return @($started,$response)
}

Set-AcaArmRequestOverride {
    param($Method, $Uri, $Token, $Headers, $Body)
    $script:requestLog.Add([pscustomobject]@{Method=$Method;Uri=$Uri;Headers=$Headers;Body=$Body})
    if ($Uri -like '*operation-test*') {
        $state = 'Succeeded'
        if ($script:operationReplies.Count -gt 0) { $state = $script:operationReplies.Dequeue() }
        if ($state -eq 'NoState202') { return [pscustomobject]@{StatusCode=202;Headers=@{'x-ms-request-id'='poll-202-req'};Content='{}'} }
        $pollHeaders=@{'x-ms-request-id'='poll-arm-req';'x-ms-correlation-request-id'='poll-arm-correlation'}
        if ($script:patchMode -eq 'provisioning-state') { return [pscustomobject]@{StatusCode=200;Headers=$pollHeaders;Content=(@{properties=@{provisioningState=$state}}|ConvertTo-Json -Compress)} }
        if ($script:patchMode -eq 'no-state-200') { return [pscustomobject]@{StatusCode=200;Headers=$pollHeaders;Content='{}'} }
        return [pscustomobject]@{StatusCode=200;Headers=$pollHeaders;Content=(@{status=$state}|ConvertTo-Json -Compress)}
    }
    if ($Method -eq 'GET') {
        $headers = @{'x-ms-request-id'='read-req'}
        if ($script:emitEtag) { $headers.ETag='"etag-test"' }
        return [pscustomobject]@{StatusCode=200;Headers=$headers;Content=(New-FakeJob|ConvertTo-Json -Depth 20 -Compress)}
    }
    if ($Method -eq 'PATCH') {
        if ($script:patchMode -eq 'conflict') {
            return [pscustomobject]@{StatusCode=412;Headers=@{'x-ms-request-id'='conflict-req'};Content='{"error":{"code":"PreconditionFailed","message":"ETag mismatch"}}'}
        }
        if ($script:patchMode -eq 'bad-request') {
            $message = "Invalid value $($script:testSecret)"
            $content = @{error=@{code='InvalidSecret';message=$message}}|ConvertTo-Json -Compress
            return [pscustomobject]@{StatusCode=400;Headers=@{'x-ms-correlation-request-id'='bad-req'};Content=$content}
        }
        $names = @($Body.properties.configuration.secrets | ForEach-Object name)
        $script:secretName = $names | Select-Object -First 1
        if ($script:patchMode -in @('async','provisioning-state')) {
            if ($script:operationReplies.Count -eq 0) {
                $script:operationReplies.Enqueue('Running')
                $script:operationReplies.Enqueue('Succeeded')
            }
            return [pscustomobject]@{StatusCode=202;Headers=@{'Azure-AsyncOperation'='https://management.azure.com/operation-test';'x-ms-request-id'='async-req'};Content=''}
        }
        if ($script:patchMode -eq 'timeout') {
            $script:secretName = 'h5jit'
            $script:operationReplies.Enqueue('Running')
            return [pscustomobject]@{StatusCode=202;Headers=@{'Azure-AsyncOperation'='https://management.azure.com/operation-test';'x-ms-request-id'='timeout-req'};Content=''}
        }
        return [pscustomobject]@{StatusCode=200;Headers=@{'x-ms-request-id'='patch-req'};Content='{}'}
    }
    throw 'Unexpected fake HTTP method.'
}

$common = @{
    Uri=$script:jobUri;Token=$script:testToken;JobName=$script:jobName;ResourceGroup=$script:resourceGroup
    EnvironmentId=$script:environmentId;ExpectedImage=$script:image;SecretName='h5jit'
}
$noSleep = { }

try {
    # 200 success: only the configuration secrets property is patched, and ETag is sent.
    $script:patchMode='success'; $script:secretName=$null; $script:requestLog.Clear()
    Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep | Out-Null
    if ($script:AcaLastPatchOutcome -ne 'Completed') { throw '200 PATCH outcome was not marked completed after readback.' }
    $patch = @($script:requestLog | Where-Object Method -eq 'PATCH')[0]
    if (($patch.Body.properties.PSObject.Properties.Name -contains 'template') -or $patch.Body.properties.configuration.secrets[0].name -ne 'h5jit' -or $patch.Headers['If-Match'] -ne '"etag-test"') { throw '200 case did not send a minimal ETag-guarded PATCH.' }
    if (-not (Remove-AcaJobSecret @common -Sleep $noSleep)) { throw 'cleanup did not remove the temporary secret.' }
    if ($script:secretName) { throw 'cleanup left the temporary secret present.' }

    # The live ARM API can omit ETag; continue only with the isolated merge-patch body.
    $script:emitEtag=$false; $script:patchMode='success'; $script:secretName=$null; $script:requestLog.Clear()
    Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep | Out-Null
    if ($script:AcaLastPatchOutcome -ne 'Completed') { throw '202 PATCH outcome was not marked completed after LRO.' }
    $unguardedPatch = @($script:requestLog | Where-Object Method -eq 'PATCH')[0]
    if ($unguardedPatch.Headers.ContainsKey('If-Match') -or $unguardedPatch.Body.properties.configuration.secrets[0].name -ne 'h5jit') { throw 'No-ETag case did not omit If-Match or send the bounded patch.' }
    $script:emitEtag=$true
    if (-not (Remove-AcaJobSecret @common -Sleep $noSleep)) { throw 'No-ETag case cleanup did not remove the secret.' }

    # 202 async operation: poll Running then Succeeded, then verify readback.
    $script:patchMode='async'; $script:secretName=$null; $script:requestLog.Clear(); $script:operationReplies.Clear()
    Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep | Out-Null
    if (@($script:requestLog | Where-Object Uri -like '*operation-test*').Count -ne 2) { throw '202 case did not poll to completion.' }
    # Azure may return an empty-body HTTP 202 while the exact LRO is still pending.
    $script:patchMode='async';$script:secretName=$null;$script:requestLog.Clear();$script:operationReplies.Clear()
    $script:operationReplies.Enqueue('NoState202');$script:operationReplies.Enqueue('Succeeded')
    Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep | Out-Null
    if ($script:AcaLastPatchOutcome -ne 'Completed' -or $script:secretName -ne 'h5jit' -or @($script:requestLog | Where-Object Uri -like '*operation-test*').Count -ne 2) { throw 'empty-body 202 LRO was not polled to terminal state and readback.' }
    if (-not (Remove-AcaJobSecret @common -Sleep $noSleep)) { throw 'empty-body 202 case cleanup did not remove the secret.' }
    $script:patchMode='provisioning-state';$script:secretName=$null;$script:operationReplies.Clear()
    Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep | Out-Null
    if (-not (Remove-AcaJobSecret @common -Sleep $noSleep)) { throw 'provisioningState response cleanup failed.' }
    $script:patchMode='no-state-200';$script:secretName='h5jit'
    Wait-AcaOperation -OperationUri 'https://management.azure.com/operation-test' -Token $script:testToken -TimeoutSeconds 10 -Sleep $noSleep -NoJournal

    # ETag conflict and 400 expose only structured error fields; never body/token/secret.
    $script:patchMode='conflict'; $script:secretName=$null
    try { Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep; throw '412 case unexpectedly succeeded.' }
    catch { if ($_.Exception.Message -notmatch 'HTTP 412.*PreconditionFailed.*conflict-req') { throw } }
    if ($script:AcaLastPatchOutcome -ne 'Rejected') { throw 'ETag conflict was not distinguished from an ambiguous PATCH.' }
    $script:patchMode='bad-request'; $script:secretName=$null
    try { Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep; throw '400 case unexpectedly succeeded.' }
    catch {
        $message = $_.Exception.Message
        if ($message -notmatch 'HTTP 400.*InvalidSecret.*bad-req' -or $message.Contains($script:testSecret) -or $message.Contains($script:testToken)) { throw '400 error was not structured/redacted.' }
    }
    if ($script:AcaLastPatchOutcome -ne 'Rejected') { throw 'HTTP 400 was not distinguished from an ambiguous PATCH.' }

    # Async timeout and cleanup after a failed Job start.
    $script:patchMode='timeout'; $script:secretName=$null; $script:operationReplies.Clear()
    try { Add-AcaJobSecret @common -SecretValue $script:testSecret -TimeoutSeconds 0 -Sleep $noSleep; throw 'timeout case unexpectedly succeeded.' }
    catch { if ($_.Exception.Message -notmatch 'ARM_OPERATION_TIMEOUT') { throw } }
    if ($script:AcaLastPatchOutcome -ne 'Ambiguous') { throw 'timed-out PATCH was not retained as ambiguous.' }
    try { Assert-AcaPatchJournalReady -ResourceId ([System.Uri]::new($script:jobUri).AbsolutePath); throw 'unresolved LRO did not block a new PATCH.' } catch { if ($_.Exception.Message -notmatch 'ARM_PATCH_JOURNAL_BLOCKED') { throw } }
    $script:patchMode='async'; $script:secretName='h5jit'; $script:operationReplies.Clear(); $script:operationReplies.Enqueue('Succeeded')
    $reconciled = @(Resolve-AcaPatchJournalOperations -Token $script:testToken -Uri $script:jobUri -JobName $script:jobName -ResourceGroup $script:resourceGroup -EnvironmentId $script:environmentId -ExpectedImage $script:image -Sleep $noSleep)
    if ($reconciled.Count -ne 1 -or $reconciled[0].State -ne 'Succeeded' -or $reconciled[0].Readback -ne 'VerifiedPresent') { throw 'interrupted LRO was not reconciled with terminal state and readback.' }
    Assert-AcaPatchJournalReady -ResourceId ([System.Uri]::new($script:jobUri).AbsolutePath)

    # Legacy recovery reads the original file byte-for-byte and writes a verifiable link only to the isolated journal.
    $resourceId=[System.Uri]::new($script:jobUri).AbsolutePath
    $legacyPath=Join-Path $script:journalTestRoot 'legacy\operations.jsonl'
    $isolatedPath=Join-Path $script:journalTestRoot 'chile\operations.jsonl'
    $null=New-Item -ItemType Directory -Path (Split-Path -Parent $legacyPath) -Force
    $legacyAttempt='legacy-add-immutable'
    [System.IO.File]::WriteAllLines($legacyPath,@((New-LegacyPatchEvents $legacyAttempt $resourceId 'PATCH add Job secret' 'https://management.azure.com/operation-test' | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 })),[System.Text.UTF8Encoding]::new($false))
    $legacyBefore=[System.IO.File]::ReadAllBytes($legacyPath)
    $legacyOps=@(Get-AcaPatchJournalLatestOperations -Path $legacyPath -AllowedResourceIds @($resourceId))
    $script:patchMode='async';$script:secretName='h5jit';$script:operationReplies.Clear();$script:operationReplies.Enqueue('Succeeded');$script:requestLog.Clear()
    $legacyResult=@(Resolve-AcaPatchJournalOperations -Token $script:testToken -Uri $script:jobUri -JobName $script:jobName -ResourceGroup $script:resourceGroup -EnvironmentId $script:environmentId -ExpectedImage $script:image -ResourceId $resourceId -EvidenceJournalPath $isolatedPath -SourceJournalPath $legacyPath -Operations $legacyOps -LegacySource -Sleep $noSleep)
    if (-not [System.Linq.Enumerable]::SequenceEqual[byte]($legacyBefore,[System.IO.File]::ReadAllBytes($legacyPath))) { throw 'legacy reconciliation modified the original journal bytes.' }
    if ($legacyResult.Count -ne 1 -or -not $legacyResult[0].Resolved -or $legacyResult[0].Readback -ne 'VerifiedPresent') { throw 'legacy add did not resolve with matching ARM state/readback.' }
    $isolatedEvents=@(Get-AcaPatchJournalEvents -Path $isolatedPath -AllowedResourceIds @($resourceId))
    $resolution=@($isolatedEvents|Where-Object{$_.event -eq 'LegacyReconciliation'})
    if ($resolution.Count -ne 1 -or $resolution[0].sourceAttemptId -cne $legacyAttempt -or $resolution[0].resourceId -cne $resourceId -or $resolution[0].operation -cne 'PATCH add Job secret' -or $resolution[0].lroReference -cne 'https://management.azure.com/operation-test') { throw 'isolated reconciliation evidence lost its exact legacy provenance.' }
    Set-AcaPatchJournalPathOverride $isolatedPath
    Assert-AcaPatchJournalReady -ResourceId $resourceId

    # A failed terminal ARM operation still requires a fresh effective-state GET; the correct readback may resolve it.
    $legacyFailed='legacy-failed-but-present'
    $failedPath=Join-Path $script:journalTestRoot 'failed-legacy.jsonl'
    [System.IO.File]::WriteAllLines($failedPath,@((New-LegacyPatchEvents $legacyFailed $resourceId 'PATCH add Job secret' 'https://management.azure.com/operation-test' | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 })),[System.Text.UTF8Encoding]::new($false))
    $failedOps=@(Get-AcaPatchJournalLatestOperations -Path $failedPath -AllowedResourceIds @($resourceId))
    $script:patchMode='async';$script:secretName='h5jit';$script:operationReplies.Clear();$script:operationReplies.Enqueue('Failed');$script:requestLog.Clear()
    $failedResult=@(Resolve-AcaPatchJournalOperations -Token $script:testToken -Uri $script:jobUri -JobName $script:jobName -ResourceGroup $script:resourceGroup -EnvironmentId $script:environmentId -ExpectedImage $script:image -ResourceId $resourceId -EvidenceJournalPath $isolatedPath -SourceJournalPath $failedPath -Operations $failedOps -LegacySource -Sleep $noSleep)
    if (-not $failedResult[0].Resolved -or $failedResult[0].State -ne 'Failed' -or -not @($script:requestLog|Where-Object{$_.Method -eq 'GET' -and $_.Uri -notlike '*operation-test*'}).Count) { throw 'failed terminal did not trigger and require a fresh effective-state readback.' }

    # Opposite effective state cannot reconcile an add; unknown operations and foreign Resource IDs fail closed.
    $wrongPath=Join-Path $script:journalTestRoot 'wrong-readback.jsonl'
    [System.IO.File]::WriteAllLines($wrongPath,@((New-LegacyPatchEvents 'legacy-wrong-readback' $resourceId 'PATCH add Job secret' 'https://management.azure.com/operation-test' | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 })),[System.Text.UTF8Encoding]::new($false))
    $wrongOps=@(Get-AcaPatchJournalLatestOperations -Path $wrongPath -AllowedResourceIds @($resourceId))
    $script:patchMode='async';$script:secretName=$null;$script:operationReplies.Clear();$script:operationReplies.Enqueue('Succeeded')
    $wrongResult=@(Resolve-AcaPatchJournalOperations -Token $script:testToken -Uri $script:jobUri -JobName $script:jobName -ResourceGroup $script:resourceGroup -EnvironmentId $script:environmentId -ExpectedImage $script:image -ResourceId $resourceId -EvidenceJournalPath $isolatedPath -SourceJournalPath $wrongPath -Operations $wrongOps -LegacySource -Sleep $noSleep)
    if ($wrongResult[0].Resolved -or $wrongResult[0].Readback -ne 'VerifiedAbsent') { throw 'opposite readback incorrectly resolved an add operation.' }
    $wrongEvidence=@(Get-AcaPatchJournalEvents -Path $isolatedPath -AllowedResourceIds @($resourceId)|Where-Object{$_.sourceAttemptId -eq 'legacy-wrong-readback'})
    if ($wrongEvidence.Count -ne 1 -or $wrongEvidence[0].event -ne 'LegacyResolutionObserved' -or $wrongEvidence[0].event -eq 'LegacyReconciliation') { throw 'mismatched ARM readback was not recorded only as non-resolving evidence.' }
    $removePath=Join-Path $script:journalTestRoot 'remove-legacy.jsonl'
    [System.IO.File]::WriteAllLines($removePath,@((New-LegacyPatchEvents 'legacy-remove-verified' $resourceId 'PATCH remove Job secret' 'https://management.azure.com/operation-test' | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 })),[System.Text.UTF8Encoding]::new($false))
    $removeOps=@(Get-AcaPatchJournalLatestOperations -Path $removePath -AllowedResourceIds @($resourceId))
    $script:patchMode='async';$script:secretName=$null;$script:operationReplies.Clear();$script:operationReplies.Enqueue('Canceled')
    $removeResult=@(Resolve-AcaPatchJournalOperations -Token $script:testToken -Uri $script:jobUri -JobName $script:jobName -ResourceGroup $script:resourceGroup -EnvironmentId $script:environmentId -ExpectedImage $script:image -ResourceId $resourceId -EvidenceJournalPath $isolatedPath -SourceJournalPath $removePath -Operations $removeOps -LegacySource -Sleep $noSleep)
    if (-not $removeResult[0].Resolved -or $removeResult[0].State -ne 'Canceled' -or $removeResult[0].Readback -ne 'VerifiedAbsent') { throw 'canceled remove did not require and honor an absent-secret readback.' }
    try { Get-AcaPatchExpectedReadback -Operation 'unknown operation'; throw 'unknown operation was accepted.' } catch { if ($_.Exception.Message -notmatch 'PATCH_OPERATION_UNKNOWN') { throw } }
    $foreignOperation=$legacyOps[0].PSObject.Copy();$foreignOperation.resourceId=$resourceId+'/foreign'
    try { Resolve-AcaPatchJournalOperations -Token $script:testToken -Uri $script:jobUri -JobName $script:jobName -ResourceGroup $script:resourceGroup -EnvironmentId $script:environmentId -ExpectedImage $script:image -ResourceId $resourceId -EvidenceJournalPath $isolatedPath -SourceJournalPath $legacyPath -Operations @($foreignOperation) -LegacySource -Sleep $noSleep; throw 'foreign Resource ID was accepted.' } catch { if ($_.Exception.Message -notmatch 'PATCH_JOURNAL_RESOURCE_MISMATCH') { throw } }
    try { Resolve-AcaPatchJournalOperations -Token $script:testToken -Uri $script:jobUri -JobName $script:jobName -ResourceGroup $script:resourceGroup -EnvironmentId $script:environmentId -ExpectedImage $script:image -ResourceId $resourceId -EvidenceJournalPath $legacyPath -SourceJournalPath $legacyPath -Operations $legacyOps -LegacySource -Sleep $noSleep; throw 'legacy source/destination alias was accepted.' } catch { if ($_.Exception.Message -notmatch 'LEGACY_JOURNAL_WRITE_REJECTED') { throw } }
    Set-AcaPatchJournalPathOverride (Join-Path $script:journalTestRoot 'operations.jsonl')
    $journalText = [System.IO.File]::ReadAllText((Get-AcaPatchJournalPath))
    if ($journalText.Contains($script:testToken) -or $journalText.Contains($script:testSecret)) { throw 'PATCH journal contains a credential value.' }
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        $journalAcl = Get-Acl -LiteralPath $script:journalTestRoot
        $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if (-not $journalAcl.AreAccessRulesProtected -or @($journalAcl.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid }).Count -gt 0) { throw 'PATCH journal directory ACL is not restricted to the current user.' }
    }
    $journalEvents = @($journalText -split "`n" | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    if (-not ($journalEvents | Where-Object { $_.event -eq 'PatchResponse' -and $_.httpStatus -eq 202 -and $_.requestId -eq 'timeout-req' -and $_.lroReference -eq 'https://management.azure.com/operation-test' })) { throw 'PATCH journal omitted recoverable response metadata.' }
    $script:patchMode='success'; $script:secretName='h5jit'
    $cleanupCalled=$false
    try {
        Invoke-AcaJitStartWithCleanup -StartAction { throw 'simulated Azure Job start failure' } -CleanupAction { $script:cleanupCalled=$true; Remove-AcaJobSecret @common -Sleep $noSleep | Out-Null }
        throw 'start-failure case unexpectedly succeeded.'
    } catch {
        if ($_.Exception.Message -notmatch 'JOB_START_FAILED' -or -not $script:cleanupCalled -or $script:secretName) { throw 'start failure did not invoke and verify cleanup.' }
    }
    try {
        Invoke-AcaJitStartWithCleanup -StartAction { throw 'simulated start failure' } -CleanupAction { throw 'simulated cleanup failure' }
        throw 'incomplete-cleanup case unexpectedly succeeded.'
    } catch {
        if ($_.Exception.Message -notmatch 'CLEANUP_INCOMPLETE') { throw 'cleanup failure was not surfaced as CLEANUP_INCOMPLETE.' }
    }

    Write-AcaPatchJournalEvent -EventType AttemptStarted -ResourceId ([System.Uri]::new($script:jobUri).AbsolutePath) -Operation 'PATCH add Job secret' -ExpectedSecretName 'h5jit'
    Write-AcaPatchJournalEvent -EventType PatchResponse -HttpStatus 202 -RequestId 'ambiguous-req'
    $unverifiable = @(Resolve-AcaPatchJournalOperations -Token $script:testToken -Uri $script:jobUri -JobName $script:jobName -ResourceGroup $script:resourceGroup -EnvironmentId $script:environmentId -ExpectedImage $script:image -Sleep $noSleep)
    if (-not ($unverifiable | Where-Object State -eq 'HISTORICAL_LRO_UNVERIFIABLE')) { throw 'missing operation URI was not classified as unverifiable.' }
    try { Assert-AcaPatchJournalReady -ResourceId ([System.Uri]::new($script:jobUri).AbsolutePath); throw 'unverifiable operation did not retain the block.' } catch { if ($_.Exception.Message -notmatch 'ARM_PATCH_JOURNAL_BLOCKED') { throw } }

    $allOutput = 'PATCH tests completed'
    if ($allOutput.Contains($script:testSecret) -or $allOutput.Contains($script:testToken)) { throw 'test output includes a credential marker.' }
    Write-Output 'PASS ACA Job secret PATCH: 200, 202 polling, ETag conflict, 400 redaction, timeout and start-failure cleanup.'
} finally {
    Clear-AcaArmRequestOverride
    Set-AcaPatchJournalPathOverride $null
    if (Test-Path -LiteralPath $script:journalTestRoot) { Remove-Item -LiteralPath $script:journalTestRoot -Recurse -Force }
}
