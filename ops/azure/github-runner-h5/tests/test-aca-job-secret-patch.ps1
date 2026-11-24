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

Set-AcaArmRequestOverride {
    param($Method, $Uri, $Token, $Headers, $Body)
    $script:requestLog.Add([pscustomobject]@{Method=$Method;Uri=$Uri;Headers=$Headers;Body=$Body})
    if ($Uri -like '*operation-test*') {
        $state = 'Succeeded'
        if ($script:operationReplies.Count -gt 0) { $state = $script:operationReplies.Dequeue() }
        if ($script:patchMode -eq 'provisioning-state') { return [pscustomobject]@{StatusCode=200;Headers=@{};Content=(@{properties=@{provisioningState=$state}}|ConvertTo-Json -Compress)} }
        if ($script:patchMode -eq 'no-state-200') { return [pscustomobject]@{StatusCode=200;Headers=@{};Content='{}'} }
        return [pscustomobject]@{StatusCode=200;Headers=@{};Content=(@{status=$state}|ConvertTo-Json -Compress)}
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
    $patch = @($script:requestLog | Where-Object Method -eq 'PATCH')[0]
    if (($patch.Body.properties.PSObject.Properties.Name -contains 'template') -or $patch.Body.properties.configuration.secrets[0].name -ne 'h5jit' -or $patch.Headers['If-Match'] -ne '"etag-test"') { throw '200 case did not send a minimal ETag-guarded PATCH.' }
    if (-not (Remove-AcaJobSecret @common -Sleep $noSleep)) { throw 'cleanup did not remove the temporary secret.' }
    if ($script:secretName) { throw 'cleanup left the temporary secret present.' }

    # The live ARM API can omit ETag; continue only with the isolated merge-patch body.
    $script:emitEtag=$false; $script:patchMode='success'; $script:secretName=$null; $script:requestLog.Clear()
    Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep | Out-Null
    $unguardedPatch = @($script:requestLog | Where-Object Method -eq 'PATCH')[0]
    if ($unguardedPatch.Headers.ContainsKey('If-Match') -or $unguardedPatch.Body.properties.configuration.secrets[0].name -ne 'h5jit') { throw 'No-ETag case did not omit If-Match or send the bounded patch.' }
    $script:emitEtag=$true
    if (-not (Remove-AcaJobSecret @common -Sleep $noSleep)) { throw 'No-ETag case cleanup did not remove the secret.' }

    # 202 async operation: poll Running then Succeeded, then verify readback.
    $script:patchMode='async'; $script:secretName=$null; $script:requestLog.Clear(); $script:operationReplies.Clear()
    Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep | Out-Null
    if (@($script:requestLog | Where-Object Uri -like '*operation-test*').Count -ne 2) { throw '202 case did not poll to completion.' }
    $script:patchMode='provisioning-state';$script:secretName=$null;$script:operationReplies.Clear()
    Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep | Out-Null
    if (-not (Remove-AcaJobSecret @common -Sleep $noSleep)) { throw 'provisioningState response cleanup failed.' }
    $script:patchMode='no-state-200';$script:secretName='h5jit'
    Wait-AcaOperation -OperationUri 'https://management.azure.com/operation-test' -Token $script:testToken -TimeoutSeconds 10 -Sleep $noSleep

    # ETag conflict and 400 expose only structured error fields; never body/token/secret.
    $script:patchMode='conflict'; $script:secretName=$null
    try { Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep; throw '412 case unexpectedly succeeded.' }
    catch { if ($_.Exception.Message -notmatch 'HTTP 412.*PreconditionFailed.*conflict-req') { throw } }
    $script:patchMode='bad-request'; $script:secretName=$null
    try { Add-AcaJobSecret @common -SecretValue $script:testSecret -Sleep $noSleep; throw '400 case unexpectedly succeeded.' }
    catch {
        $message = $_.Exception.Message
        if ($message -notmatch 'HTTP 400.*InvalidSecret.*bad-req' -or $message.Contains($script:testSecret) -or $message.Contains($script:testToken)) { throw '400 error was not structured/redacted.' }
    }

    # Async timeout and cleanup after a failed Job start.
    $script:patchMode='timeout'; $script:secretName=$null; $script:operationReplies.Clear()
    try { Add-AcaJobSecret @common -SecretValue $script:testSecret -TimeoutSeconds 0 -Sleep $noSleep; throw 'timeout case unexpectedly succeeded.' }
    catch { if ($_.Exception.Message -notmatch 'ARM_OPERATION_TIMEOUT') { throw } }
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

    $allOutput = 'PATCH tests completed'
    if ($allOutput.Contains($script:testSecret) -or $allOutput.Contains($script:testToken)) { throw 'test output includes a credential marker.' }
    Write-Output 'PASS ACA Job secret PATCH: 200, 202 polling, ETag conflict, 400 redaction, timeout and start-failure cleanup.'
} finally {
    Clear-AcaArmRequestOverride
}
