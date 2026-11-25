Set-StrictMode -Version Latest

$script:AcaArmRequestOverride = $null
$script:AcaLastPatchOutcome = 'NotStarted'
$script:AcaLastObservedLroState = $null
$script:AcaLastObservedLroRequestId = $null
$script:AcaLastObservedLroCorrelationId = $null
$script:AcaLastObservedLroHttpStatus = $null
$script:AcaPatchJournalPathOverride = $null
$script:AcaCurrentPatchAttempt = $null

function Set-AcaPatchJournalPathOverride {
    param([AllowNull()][string]$Path)
    $script:AcaPatchJournalPathOverride = $Path
}

function Get-AcaPatchJournalPath {
    if (-not [string]::IsNullOrWhiteSpace($script:AcaPatchJournalPathOverride)) { return $script:AcaPatchJournalPathOverride }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'PATCH_JOURNAL_LOCAL_STORAGE_UNAVAILABLE: LOCALAPPDATA is not set.' }
    return Join-Path (Join-Path $env:LOCALAPPDATA 'G6\azure-h5-smoke\patch-lro-tracking') 'operations.jsonl'
}

function Assert-AcaManagementLroReference {
    param([Parameter(Mandatory)][string]$Uri)
    $parsed=$null
    if (-not [System.Uri]::TryCreate($Uri,[System.UriKind]::Absolute,[ref]$parsed) -or $parsed.Scheme -cne 'https' -or $parsed.Host -cne 'management.azure.com' -or $parsed.Port -ne 443 -or -not [string]::IsNullOrEmpty($parsed.UserInfo) -or -not [string]::IsNullOrEmpty($parsed.Fragment)) {
        throw 'PATCH_JOURNAL_LRO_URI_REJECTED: LRO reference must be an HTTPS Azure Resource Manager URI.'
    }
}

function Protect-AcaPatchJournalPath {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][bool]$Directory)
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $grant = if ($Directory) { "*$($sid.Value):(OI)(CI)F" } else { "*$($sid.Value):F" }
        & icacls.exe $Path '/inheritance:r' '/grant:r' $grant | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'PATCH_JOURNAL_ACL_FAILED: could not restrict local journal permissions.' }
    } else {
        if ($Directory) { & chmod 700 -- $Path } else { & chmod 600 -- $Path }
        if ($LASTEXITCODE -ne 0) { throw 'PATCH_JOURNAL_ACL_FAILED: could not restrict local journal permissions.' }
    }
}

function Initialize-AcaPatchJournal {
    $path = Get-AcaPatchJournalPath
    $directory = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $directory)) { $null = New-Item -ItemType Directory -Path $directory -Force }
    Protect-AcaPatchJournalPath -Path $directory -Directory $true
    if (-not (Test-Path -LiteralPath $path)) { $null = [System.IO.File]::Create($path).Dispose() }
    Protect-AcaPatchJournalPath -Path $path -Directory $false
    return $path
}

function Get-AcaPatchJournalEvents {
    param([AllowEmptyString()][string]$Path,[Parameter(Mandatory)][string[]]$AllowedResourceIds)
    $path = if ([string]::IsNullOrWhiteSpace($Path)) { Get-AcaPatchJournalPath } else { $Path }
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    $latest = @{}
    $events = [System.Collections.Generic.List[object]]::new()
    $resolvedSourceAttempts = @{}
    $reconciliationAttemptIds = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $event = $line | ConvertFrom-Json -ErrorAction Stop } catch { throw 'PATCH_JOURNAL_CORRUPT: refusing PATCH because local operation history is not parseable.' }
        $propertyNames=@($event.PSObject.Properties | ForEach-Object Name)
        $attemptId=if($propertyNames -contains 'attemptId'){[string]$event.attemptId}else{''}
        $resourceId=if($propertyNames -contains 'resourceId'){[string]$event.resourceId}else{''}
        $operation=if($propertyNames -contains 'operation'){[string]$event.operation}else{''}
        if ([string]::IsNullOrWhiteSpace($attemptId) -or [string]::IsNullOrWhiteSpace($resourceId) -or [string]::IsNullOrWhiteSpace($operation)) { throw 'PATCH_JOURNAL_CORRUPT: operation history entry lacks attemptId, Resource ID or operation.' }
        if (@($AllowedResourceIds | Where-Object { [string]::Equals($_,$resourceId,[System.StringComparison]::OrdinalIgnoreCase) }).Count -ne 1) { throw 'PATCH_JOURNAL_RESOURCE_MISMATCH: journal contains an unauthorized or unknown Resource ID.' }
        $eventType=if($propertyNames -contains 'event'){[string]$event.event}else{''}
        if ($eventType -notin @('AttemptStarted','PatchResponse','LroPoll','OperationTerminal','Readback','LegacyReconciliation','LegacyResolutionObserved')) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: journal contains an unknown event type.' }
        if ($eventType -eq 'OperationTerminal' -and [string]$event.terminalState -notin @('Succeeded','Failed','Canceled','Cancelled','Rejected')) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: terminal event has an unknown state.' }
        if ($eventType -eq 'Readback' -and [string]$event.readbackResult -notin @('VerifiedPresent','VerifiedAbsent','Unverified','NotRequired')) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: readback event has an unknown result.' }
        if ($eventType -in @('LegacyReconciliation','LegacyResolutionObserved')) {
            $requiredEvidenceProperties=@('sourceAttemptId','lroReference','expectedSecretName','terminalState','readbackResult','armRequestId','armHttpStatus','readbackRequestId','readbackHttpStatus')
            if (@($requiredEvidenceProperties | Where-Object { $propertyNames -notcontains $_ }).Count -gt 0) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: legacy reconciliation evidence lacks required ARM/readback fields.' }
            if ([string]::IsNullOrWhiteSpace([string]$event.sourceAttemptId) -or [string]::IsNullOrWhiteSpace([string]$event.lroReference) -or [string]::IsNullOrWhiteSpace([string]$event.expectedSecretName) -or [string]$event.terminalState -notin @('Succeeded','Failed','Canceled','Cancelled') -or [string]$event.readbackResult -notin @('VerifiedPresent','VerifiedAbsent')) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: legacy reconciliation evidence is incomplete or unverified.' }
            if ([string]::IsNullOrWhiteSpace([string]$event.armRequestId) -or [int]$event.armHttpStatus -ne 200 -or [string]::IsNullOrWhiteSpace([string]$event.readbackRequestId) -or [int]$event.readbackHttpStatus -ne 200) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: reconciliation lacks successful ARM LRO and Job readback evidence.' }
            $null=Get-AcaPatchExpectedReadback -Operation ([string]$event.operation)
            if ($eventType -eq 'LegacyReconciliation' -and [string]$event.readbackResult -cne (Get-AcaPatchExpectedReadback -Operation ([string]$event.operation))) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: reconciliation readback contradicts its operation.' }
            if ($latest.ContainsKey($attemptId) -or $reconciliationAttemptIds.ContainsKey($attemptId) -or [string]$event.sourceAttemptId -ceq $attemptId) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: reconciliation record reuses its own or another attemptId.' }
            if ($eventType -eq 'LegacyReconciliation' -and $resolvedSourceAttempts.ContainsKey([string]$event.sourceAttemptId)) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: a source attempt has multiple reconciliation records.' }
            if ($eventType -eq 'LegacyReconciliation') { $resolvedSourceAttempts[[string]$event.sourceAttemptId]=$event }
            $reconciliationAttemptIds[$attemptId]=$event
            Assert-AcaManagementLroReference -Uri ([string]$event.lroReference)
            $events.Add($event)
            continue
        }
        if ($reconciliationAttemptIds.ContainsKey($attemptId)) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: a PATCH attempt reuses a reconciliation record identifier.' }
        if ($latest.ContainsKey($attemptId)) {
            $previous=$latest[$attemptId]
            if (-not [string]::Equals([string]$previous.resourceId,$resourceId,[System.StringComparison]::OrdinalIgnoreCase) -or [string]$previous.operation -cne $operation) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: one attemptId was reused for different resources or operations.' }
            $previousSecretName=if($previous.PSObject.Properties.Name -contains 'expectedSecretName'){[string]$previous.expectedSecretName}else{''}
            $eventSecretName=if($propertyNames -contains 'expectedSecretName'){[string]$event.expectedSecretName}else{''}
            if ($previousSecretName -cne $eventSecretName) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: expected secret name changed within one attempt.' }
            $allowedNext = switch ([string]$previous.event) {
                'AttemptStarted' { @('PatchResponse') }
                'PatchResponse' { @('LroPoll','OperationTerminal') }
                'LroPoll' { @('LroPoll','OperationTerminal','Readback') }
                'OperationTerminal' { @('Readback') }
                # A prior readback can be recorded while an LRO is still pending; later polling/reconciliation may append terminal evidence.
                'Readback' { @('LroPoll','OperationTerminal','Readback') }
                default { @() }
            }
            if ($eventType -notin $allowedNext) { throw "PATCH_JOURNAL_SEQUENCE_INVALID: $($previous.event) cannot be followed by $eventType for one attempt." }
            $previousLro=if($previous.PSObject.Properties.Name -contains 'lroReference'){[string]$previous.lroReference}else{''}
            $eventLro=if($propertyNames -contains 'lroReference'){[string]$event.lroReference}else{''}
            if ($previousLro -and $eventLro -and $previousLro -cne $eventLro) { throw 'PATCH_JOURNAL_SEQUENCE_INVALID: LRO reference changed within one attempt.' }
        } elseif ($eventType -cne 'AttemptStarted') {
            throw 'PATCH_JOURNAL_SEQUENCE_INVALID: attempt history does not begin with AttemptStarted.'
        }
        if ($propertyNames -contains 'lroReference' -and -not [string]::IsNullOrWhiteSpace([string]$event.lroReference)) { Assert-AcaManagementLroReference -Uri ([string]$event.lroReference) }
        $latest[$attemptId]=$event
        $events.Add($event)
    }
    return $events.ToArray()
}

function Get-AcaPatchJournalLatestOperations {
    param([string]$Path,[Parameter(Mandatory)][string[]]$AllowedResourceIds)
    $events=@(Get-AcaPatchJournalEvents -Path $Path -AllowedResourceIds $AllowedResourceIds)
    $latest=@{}
    foreach($event in $events) { $latest[[string]$event.attemptId]=$event }
    return @($latest.Values)
}

function Get-AcaPatchJournalPendingOperations {
    param([Parameter(Mandatory)][string]$ResourceId,[string]$Path)
    $latest = @(Get-AcaPatchJournalLatestOperations -Path $Path -AllowedResourceIds @($ResourceId))
    $pending = @($latest | Where-Object { -not (Test-AcaPatchOperationResolved -Record $_) })
    return $pending
}

function Get-AcaPatchExpectedReadback {
    param([Parameter(Mandatory)][string]$Operation)
    switch ($Operation) {
        'PATCH add Job secret' { return 'VerifiedPresent' }
        'PATCH remove Job secret' { return 'VerifiedAbsent' }
        default { throw 'PATCH_OPERATION_UNKNOWN: refusing to reconcile an operation whose intended secret state is unknown.' }
    }
}

function Test-AcaLegacyReconciliationVerified {
    param([Parameter(Mandatory)]$Record)
    try { $expected=Get-AcaPatchExpectedReadback -Operation ([string]$Record.operation) } catch { return $false }
    return ([string]$Record.event -ceq 'LegacyReconciliation' -and
        -not [string]::IsNullOrWhiteSpace([string]$Record.sourceAttemptId) -and
        -not [string]::IsNullOrWhiteSpace([string]$Record.resourceId) -and
        -not [string]::IsNullOrWhiteSpace([string]$Record.lroReference) -and
        -not [string]::IsNullOrWhiteSpace([string]$Record.expectedSecretName) -and
        [string]$Record.terminalState -in @('Succeeded','Failed','Canceled','Cancelled') -and
        [string]$Record.readbackResult -ceq $expected)
}

function Test-AcaPatchOperationResolved {
    param([Parameter(Mandatory)]$Record)
    if ([string]$Record.event -ceq 'LegacyReconciliation') { return Test-AcaLegacyReconciliationVerified -Record $Record }
    if ([string]$Record.event -ceq 'LegacyResolutionObserved') { return $true }
    if ([string]$Record.terminalState -ceq 'Rejected') { return ([int]$Record.httpStatus -ge 400 -and [int]$Record.httpStatus -lt 500 -and [string]$Record.readbackResult -ceq 'NotRequired') }
    try { $expected=Get-AcaPatchExpectedReadback -Operation ([string]$Record.operation) } catch { return $false }
    return ([string]$Record.event -ceq 'Readback' -and
        [string]$Record.terminalState -in @('Succeeded','Failed','Canceled','Cancelled') -and
        [string]$Record.readbackResult -ceq $expected)
}

function Get-AcaPatchExpectedJitSecretName {
    param([Parameter(Mandatory)][string]$Operation,[string]$RecordedName)
    $null=Get-AcaPatchExpectedReadback -Operation $Operation
    if ([string]::IsNullOrWhiteSpace($RecordedName)) { return 'h5jit' }
    if ($RecordedName -cne 'h5jit') { throw 'PATCH_SECRET_NAME_MISMATCH: JIT journal operation references an unexpected secret name.' }
    return $RecordedName
}

function Assert-AcaPatchJournalReady {
    param([Parameter(Mandatory)][string]$ResourceId)
    $pending = @(Get-AcaPatchJournalPendingOperations -ResourceId $ResourceId)
    if ($pending.Count -gt 0) {
        $ids = @($pending | ForEach-Object { [string]$_.attemptId }) -join ','
        throw "ARM_PATCH_JOURNAL_BLOCKED: unresolved local PATCH/LRO attempt(s) $ids; reconcile the stored operation reference and readback before another PATCH."
    }
}

function Write-AcaPatchJournalEvent {
    param(
        [Parameter(Mandatory)][ValidateSet('AttemptStarted','PatchResponse','LroPoll','OperationTerminal','Readback','LegacyReconciliation','LegacyResolutionObserved')][string]$EventType,
        [string]$ResourceId,
        [string]$Operation,
        [Nullable[int]]$HttpStatus,
        [string]$RequestId,
        [string]$CorrelationId,
        [string]$LroReference,
        [string]$TerminalState,
        [string]$ReadbackResult,
        [string]$SourceAttemptId,
        [string]$ExpectedSecretName,
        [string]$ArmRequestId,
        [string]$ArmCorrelationId,
        [Nullable[int]]$ArmHttpStatus,
        [string]$ReadbackRequestId,
        [Nullable[int]]$ReadbackHttpStatus
    )
    if ($EventType -eq 'AttemptStarted') {
        $script:AcaCurrentPatchAttempt = [pscustomobject]@{
            attemptId=[guid]::NewGuid().ToString('D'); startedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')
            resourceId=$ResourceId; operation=$Operation; httpStatus=$null; requestId=$null
            correlationId=$null; lroReference=$null; terminalState=$null; readbackResult=$null
            sourceAttemptId=$null; expectedSecretName=$null
            armRequestId=$null; armCorrelationId=$null; armHttpStatus=$null; readbackRequestId=$null; readbackHttpStatus=$null
        }
    }
    if (-not $script:AcaCurrentPatchAttempt) { throw 'PATCH_JOURNAL_STATE_INVALID: no current attempt exists for an operation event.' }
    $current = $script:AcaCurrentPatchAttempt
    if ($null -ne $HttpStatus) { $current.httpStatus=[int]$HttpStatus }
    if ($PSBoundParameters.ContainsKey('RequestId')) { $current.requestId=$RequestId }
    if ($PSBoundParameters.ContainsKey('CorrelationId')) { $current.correlationId=$CorrelationId }
    if ($PSBoundParameters.ContainsKey('LroReference')) { $current.lroReference=$LroReference }
    if ($PSBoundParameters.ContainsKey('TerminalState')) { $current.terminalState=$TerminalState }
    if ($PSBoundParameters.ContainsKey('ReadbackResult')) { $current.readbackResult=$ReadbackResult }
    if ($PSBoundParameters.ContainsKey('SourceAttemptId')) { $current.sourceAttemptId=$SourceAttemptId }
    if ($PSBoundParameters.ContainsKey('ExpectedSecretName')) { $current.expectedSecretName=$ExpectedSecretName }
    if ($PSBoundParameters.ContainsKey('ArmRequestId')) { $current.armRequestId=$ArmRequestId }
    if ($PSBoundParameters.ContainsKey('ArmCorrelationId')) { $current.armCorrelationId=$ArmCorrelationId }
    if ($PSBoundParameters.ContainsKey('ArmHttpStatus')) { $current.armHttpStatus=[int]$ArmHttpStatus }
    if ($PSBoundParameters.ContainsKey('ReadbackRequestId')) { $current.readbackRequestId=$ReadbackRequestId }
    if ($PSBoundParameters.ContainsKey('ReadbackHttpStatus')) { $current.readbackHttpStatus=[int]$ReadbackHttpStatus }
    $record = @{
        attemptId=$current.attemptId; timestampUtc=[DateTimeOffset]::UtcNow.ToString('o'); event=$EventType
        resourceId=$current.resourceId; operation=$current.operation; httpStatus=$current.httpStatus
        requestId=$current.requestId; correlationId=$current.correlationId; lroReference=$current.lroReference
        terminalState=$current.terminalState; readbackResult=$current.readbackResult
        sourceAttemptId=$current.sourceAttemptId; expectedSecretName=$current.expectedSecretName
        armRequestId=$current.armRequestId; armCorrelationId=$current.armCorrelationId; armHttpStatus=$current.armHttpStatus
        readbackRequestId=$current.readbackRequestId; readbackHttpStatus=$current.readbackHttpStatus
    } | ConvertTo-Json -Compress -Depth 5
    $path=Initialize-AcaPatchJournal
    $bytes=[System.Text.UTF8Encoding]::new($false).GetBytes($record + "`n")
    $stream=[System.IO.FileStream]::new($path,[System.IO.FileMode]::Append,[System.IO.FileAccess]::Write,[System.IO.FileShare]::ReadWrite)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Set-AcaArmRequestOverride {
    param([Parameter(Mandatory)][scriptblock]$Invoker)
    $script:AcaArmRequestOverride = $Invoker
}

function Clear-AcaArmRequestOverride {
    $script:AcaArmRequestOverride = $null
}

function Get-AcaHeaderValue {
    param($Headers, [Parameter(Mandatory)][string]$Name)
    if (-not $Headers) { return $null }
    foreach ($key in $Headers.Keys) {
        if ([string]$key -ieq $Name) { return [string](@($Headers[$key])[0]) }
    }
    return $null
}

function Invoke-AcaArmRequest {
    param(
        [Parameter(Mandatory)][ValidateSet('GET','PATCH')][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [hashtable]$Headers = @{},
        $Body
    )

    if ($script:AcaArmRequestOverride) {
        return & $script:AcaArmRequestOverride $Method $Uri $Token $Headers $Body
    }

    $client = [System.Net.Http.HttpClient]::new()
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token)
    foreach ($key in $Headers.Keys) {
        $null = $request.Headers.TryAddWithoutValidation([string]$key, [string]$Headers[$key])
    }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 40 -Compress
        $request.Content = [System.Net.Http.StringContent]::new($json, [System.Text.Encoding]::UTF8, 'application/json')
    }

    $response = $null
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $responseHeaders = @{}
        foreach ($header in $response.Headers) { $responseHeaders[$header.Key] = @($header.Value) }
        foreach ($header in $response.Content.Headers) { $responseHeaders[$header.Key] = @($header.Value) }
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Headers = $responseHeaders
            Content = $content
        }
    } finally {
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
    }
}

function ConvertFrom-AcaResponseContent {
    param([AllowEmptyString()][string]$Content)
    if ([string]::IsNullOrWhiteSpace($Content)) { return $null }
    try { return $Content | ConvertFrom-Json -Depth 50 } catch { return $null }
}

function Get-AcaSafeErrorFields {
    param($Response, [string[]]$RedactValues = @())
    $parsed = ConvertFrom-AcaResponseContent ([string]$Response.Content)
    $code = [string]$parsed.error.code
    $message = [string]$parsed.error.message
    foreach ($value in $RedactValues) {
        if (-not [string]::IsNullOrEmpty($value)) {
            $message = $message.Replace($value, '[REDACTED]')
            $code = $code.Replace($value, '[REDACTED]')
        }
    }
    if ($message.Length -gt 400) { $message = $message.Substring(0, 400) }
    return [pscustomobject]@{
        HttpStatus = [int]$Response.StatusCode
        Code = $code
        Message = $message
        RequestId = (Get-AcaHeaderValue $Response.Headers 'x-ms-request-id')
        CorrelationId = (Get-AcaHeaderValue $Response.Headers 'x-ms-correlation-request-id')
    }
}

function Throw-AcaResponseError {
    param($Response, [string]$Operation, [string[]]$RedactValues = @())
    $fields = Get-AcaSafeErrorFields -Response $Response -RedactValues $RedactValues
    $parts = @("$Operation HTTP $($fields.HttpStatus)")
    if ($fields.Code) { $parts += "code=$($fields.Code)" }
    if ($fields.Message) { $parts += "message=$($fields.Message)" }
    if ($fields.RequestId) { $parts += "requestId=$($fields.RequestId)" }
    if ($fields.CorrelationId) { $parts += "correlationId=$($fields.CorrelationId)" }
    throw ($parts -join '; ')
}

function Get-AcaJobSnapshot {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$JobName,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$EnvironmentId,
        [Parameter(Mandatory)][string]$ExpectedImage
    )

    $response = Invoke-AcaArmRequest -Method GET -Uri $Uri -Token $Token
    if ($response.StatusCode -ne 200) { Throw-AcaResponseError -Response $response -Operation 'GET Job' }
    $resource = ConvertFrom-AcaResponseContent ([string]$response.Content)
    $expectedIdSuffix = "/resourceGroups/$ResourceGroup/providers/Microsoft.App/jobs/$JobName"
    if ($resource.name -cne $JobName -or $resource.id -notlike "*$expectedIdSuffix") {
        throw 'JOB_IDENTITY_MISMATCH: ARM Job name/resource group differs from the authorized target.'
    }
    if ([string]$resource.properties.environmentId -ine $EnvironmentId) {
        throw 'JOB_ENVIRONMENT_MISMATCH: ARM Job is not attached to the expected managed Environment.'
    }
    $containers = @($resource.properties.template.containers)
    if ($containers.Count -ne 1 -or $containers[0].name -cne 'runner' -or $containers[0].image -cne $ExpectedImage) {
        throw 'JOB_TEMPLATE_MISMATCH: expected one runner container with the pinned image.'
    }
    if ((@($containers[0].command) -join ' ') -cne '/bin/bash -c' -or (@($containers[0].args) -join ' ') -notmatch 'run\.sh --jitconfig') {
        throw 'JOB_COMMAND_MISMATCH: expected the approved JIT runner entry point.'
    }
    $etag = Get-AcaHeaderValue $response.Headers 'ETag'
    if ([string]::IsNullOrWhiteSpace($etag) -and $resource.PSObject.Properties.Name -contains 'etag') { $etag = [string]$resource.etag }
    if ([string]::IsNullOrWhiteSpace($etag)) { $etag = $null }
    return [pscustomobject]@{ Resource=$resource; ETag=$etag; RequestId=(Get-AcaHeaderValue $response.Headers 'x-ms-request-id'); HttpStatus=[int]$response.StatusCode }
}

function Wait-AcaOperation {
    param(
        [Parameter(Mandatory)][string]$OperationUri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [scriptblock]$Sleep = { Start-Sleep -Seconds 3 },
        [string[]]$RedactValues = @(),
        [switch]$NoJournal
    )
    Assert-AcaManagementLroReference -Uri $OperationUri
    $script:AcaLastObservedLroRequestId=$null
    $script:AcaLastObservedLroCorrelationId=$null
    $script:AcaLastObservedLroHttpStatus=$null
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $response = Invoke-AcaArmRequest -Method GET -Uri $OperationUri -Token $Token
        $script:AcaLastObservedLroRequestId=Get-AcaHeaderValue $response.Headers 'x-ms-request-id'
        $script:AcaLastObservedLroCorrelationId=Get-AcaHeaderValue $response.Headers 'x-ms-correlation-request-id'
        $script:AcaLastObservedLroHttpStatus=[int]$response.StatusCode
        if ($response.StatusCode -notin @(200, 202)) { Throw-AcaResponseError -Response $response -Operation 'ARM async operation' -RedactValues $RedactValues }
        $state = ConvertFrom-AcaResponseContent ([string]$response.Content)
        $stateValue = $null
        $statePropertyNames = @()
        if ($null -ne $state) { $statePropertyNames = @($state.PSObject.Properties | ForEach-Object { $_.Name }) }
        if ($state -and $statePropertyNames -contains 'status') { $stateValue = [string]$state.status }
        elseif ($state -and $statePropertyNames -contains 'provisioningState') { $stateValue = [string]$state.provisioningState }
        elseif ($state -and $statePropertyNames -contains 'properties' -and @($state.properties.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'provisioningState') { $stateValue = [string]$state.properties.provisioningState }
        elseif ($response.StatusCode -eq 200) {
            $script:AcaLastObservedLroState='Succeeded'
            if (-not $NoJournal) { Write-AcaPatchJournalEvent -EventType OperationTerminal -TerminalState 'Succeeded' -HttpStatus 200 -RequestId (Get-AcaHeaderValue $response.Headers 'x-ms-request-id') -CorrelationId (Get-AcaHeaderValue $response.Headers 'x-ms-correlation-request-id') }
            return 'Succeeded'
        }
        $script:AcaLastObservedLroState=$stateValue
        if (-not $NoJournal) { Write-AcaPatchJournalEvent -EventType LroPoll -HttpStatus $response.StatusCode -RequestId (Get-AcaHeaderValue $response.Headers 'x-ms-request-id') -CorrelationId (Get-AcaHeaderValue $response.Headers 'x-ms-correlation-request-id') }
        switch ($stateValue) {
            'Succeeded' { if (-not $NoJournal) { Write-AcaPatchJournalEvent -EventType OperationTerminal -TerminalState 'Succeeded' -HttpStatus $response.StatusCode }; return 'Succeeded' }
            'Failed' { $script:AcaLastPatchOutcome='TerminalFailure'; if (-not $NoJournal) { Write-AcaPatchJournalEvent -EventType OperationTerminal -TerminalState 'Failed' -HttpStatus $response.StatusCode }; Throw-AcaResponseError -Response $response -Operation 'ARM async operation' -RedactValues $RedactValues }
            'Canceled' { $script:AcaLastPatchOutcome='TerminalFailure'; if (-not $NoJournal) { Write-AcaPatchJournalEvent -EventType OperationTerminal -TerminalState 'Canceled' -HttpStatus $response.StatusCode }; throw 'ARM_OPERATION_CANCELED: asynchronous Job patch was canceled.' }
            'Cancelled' { $script:AcaLastPatchOutcome='TerminalFailure'; if (-not $NoJournal) { Write-AcaPatchJournalEvent -EventType OperationTerminal -TerminalState 'Cancelled' -HttpStatus $response.StatusCode }; throw 'ARM_OPERATION_CANCELED: asynchronous Job patch was canceled.' }
        }
        if ([string]::IsNullOrWhiteSpace($stateValue) -and $response.StatusCode -eq 202) {
            & $Sleep
            continue
        }
        & $Sleep
    }
    throw 'ARM_OPERATION_TIMEOUT: asynchronous Job patch exceeded its timeout.'
}

function Invoke-AcaJobSecretPatch {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [AllowEmptyString()][string]$ETag,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Secrets,
        [Parameter(Mandatory)][string]$Operation,
        [Parameter(Mandatory)][string]$SecretName,
        [int]$TimeoutSeconds = 120,
        [scriptblock]$Sleep = { Start-Sleep -Seconds 3 },
        [string[]]$RedactValues = @()
    )
    $resourceId=[System.Uri]::new($Uri).AbsolutePath
    Assert-AcaPatchJournalReady -ResourceId $resourceId
    $script:AcaLastPatchOutcome = 'Ambiguous'
    $script:AcaLastObservedLroState = $null
    Write-AcaPatchJournalEvent -EventType AttemptStarted -ResourceId $resourceId -Operation $Operation -ExpectedSecretName $SecretName
    $responseRecorded=$false
    try {
        $body = @{properties=@{configuration=@{secrets=@($Secrets)}}}
        $headers = @{}
        if (-not [string]::IsNullOrWhiteSpace($ETag)) { $headers['If-Match'] = $ETag }
        $response = Invoke-AcaArmRequest -Method PATCH -Uri $Uri -Token $Token -Headers $headers -Body $body
        $requestId=Get-AcaHeaderValue $response.Headers 'x-ms-request-id'
        $correlationId=Get-AcaHeaderValue $response.Headers 'x-ms-correlation-request-id'
        if ($response.StatusCode -eq 200) {
            Write-AcaPatchJournalEvent -EventType PatchResponse -HttpStatus $response.StatusCode -RequestId $requestId -CorrelationId $correlationId
            $responseRecorded=$true
            Write-AcaPatchJournalEvent -EventType OperationTerminal -TerminalState 'Succeeded' -HttpStatus $response.StatusCode
            $script:AcaLastObservedLroState='Succeeded'
            $script:AcaLastPatchOutcome='Completed'
            return
        }
        if ($response.StatusCode -eq 202) {
            $operationUri = Get-AcaHeaderValue $response.Headers 'Azure-AsyncOperation'
            if (-not $operationUri) { $operationUri = Get-AcaHeaderValue $response.Headers 'Location' }
            Write-AcaPatchJournalEvent -EventType PatchResponse -HttpStatus $response.StatusCode -RequestId $requestId -CorrelationId $correlationId -LroReference $operationUri
            $responseRecorded=$true
            if (-not $operationUri) { Throw-AcaResponseError -Response $response -Operation "$Operation LRO location missing" -RedactValues $RedactValues }
            $null=Wait-AcaOperation -OperationUri $operationUri -Token $Token -TimeoutSeconds $TimeoutSeconds -Sleep $Sleep -RedactValues $RedactValues
            $script:AcaLastPatchOutcome='Completed'
            return
        }
        Write-AcaPatchJournalEvent -EventType PatchResponse -HttpStatus $response.StatusCode -RequestId $requestId -CorrelationId $correlationId
        $responseRecorded=$true
        if ([int]$response.StatusCode -ge 400 -and [int]$response.StatusCode -lt 500) {
            $script:AcaLastPatchOutcome='Rejected'
            Write-AcaPatchJournalEvent -EventType OperationTerminal -TerminalState 'Rejected' -HttpStatus $response.StatusCode -ReadbackResult 'NotRequired'
        }
        Throw-AcaResponseError -Response $response -Operation $Operation -RedactValues $RedactValues
    } catch {
        if (-not $responseRecorded) { Write-AcaPatchJournalEvent -EventType PatchResponse }
        if ($script:AcaLastPatchOutcome -notin @('Completed','Rejected','TerminalFailure')) { $script:AcaLastPatchOutcome='Ambiguous' }
        throw
    }
}

function Add-AcaJobSecret {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$JobName,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$EnvironmentId,
        [Parameter(Mandatory)][string]$ExpectedImage,
        [Parameter(Mandatory)][string]$SecretName,
        [Parameter(Mandatory)][string]$SecretValue,
        [int]$TimeoutSeconds = 120,
        [scriptblock]$Sleep = { Start-Sleep -Seconds 3 }
    )
    $snapshot = Get-AcaJobSnapshot -Uri $Uri -Token $Token -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $EnvironmentId -ExpectedImage $ExpectedImage
    $existing = @($snapshot.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name })
    if (@($existing | Where-Object { $_.name -eq $SecretName }).Count -gt 0) {
        throw 'TEMPORARY_SECRET_ALREADY_PRESENT: refusing to overwrite an existing secret.'
    }
    if ($existing.Count -gt 0) {
        throw 'JOB_HAS_OTHER_SECRETS: refusing to replace an existing secret collection with an array PATCH.'
    }
    $newSecret = @{name=$SecretName;value=$SecretValue}
    Invoke-AcaJobSecretPatch -Uri $Uri -Token $Token -ETag $snapshot.ETag -Secrets @($newSecret) -Operation 'PATCH add Job secret' -SecretName $SecretName -TimeoutSeconds $TimeoutSeconds -Sleep $Sleep -RedactValues @($SecretValue,$Token)

    try {
        $verified = Get-AcaJobSnapshot -Uri $Uri -Token $Token -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $EnvironmentId -ExpectedImage $ExpectedImage
        $present = @($verified.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name -eq $SecretName }).Count -eq 1
        Write-AcaPatchJournalEvent -EventType Readback -ReadbackResult $(if($present){'VerifiedPresent'}else{'VerifiedAbsent'})
    } catch {
        Write-AcaPatchJournalEvent -EventType Readback -ReadbackResult 'Unverified'
        throw
    }
    if (-not $present) { throw 'TEMPORARY_SECRET_VERIFY_FAILED: PATCH completed but the secret name was not present after readback.' }
    return $verified
}

function Remove-AcaJobSecret {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$JobName,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$EnvironmentId,
        [Parameter(Mandatory)][string]$ExpectedImage,
        [Parameter(Mandatory)][string]$SecretName,
        [int]$TimeoutSeconds = 120,
        [scriptblock]$Sleep = { Start-Sleep -Seconds 3 }
    )
    $snapshot = Get-AcaJobSnapshot -Uri $Uri -Token $Token -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $EnvironmentId -ExpectedImage $ExpectedImage
    $existing = @($snapshot.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name })
    $temporary = @($existing | Where-Object { $_.name -eq $SecretName })
    if ($temporary.Count -eq 0) { return $false }
    if ($existing.Count -ne 1) { throw 'JOB_HAS_OTHER_SECRETS: refusing to remove/replace a mixed secret collection.' }
    Invoke-AcaJobSecretPatch -Uri $Uri -Token $Token -ETag $snapshot.ETag -Secrets @() -Operation 'PATCH remove Job secret' -SecretName $SecretName -TimeoutSeconds $TimeoutSeconds -Sleep $Sleep -RedactValues @($Token)

    try {
        $verified = Get-AcaJobSnapshot -Uri $Uri -Token $Token -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $EnvironmentId -ExpectedImage $ExpectedImage
        $present = @($verified.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name -eq $SecretName }).Count -gt 0
        Write-AcaPatchJournalEvent -EventType Readback -ReadbackResult $(if($present){'VerifiedPresent'}else{'VerifiedAbsent'})
    } catch {
        Write-AcaPatchJournalEvent -EventType Readback -ReadbackResult 'Unverified'
        throw
    }
    if ($present) { throw 'TEMPORARY_SECRET_CLEANUP_VERIFY_FAILED: secret name remains after PATCH cleanup.' }
    return $true
}

function Resolve-AcaPatchJournalOperations {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$JobName,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$EnvironmentId,
        [Parameter(Mandatory)][string]$ExpectedImage,
        [string]$ResourceId,
        [string]$EvidenceJournalPath,
        [string]$SourceJournalPath,
        [object[]]$Operations,
        [switch]$LegacySource,
        [int]$TimeoutSeconds = 120,
        [scriptblock]$Sleep = { Start-Sleep -Seconds 3 }
    )
    $results=[System.Collections.Generic.List[object]]::new()
    $expectedResourceId = "/subscriptions/$((([uri]$Uri).AbsolutePath -split '/')[2])/resourceGroups/$ResourceGroup/providers/Microsoft.App/jobs/$JobName"
    if ([string]::IsNullOrWhiteSpace($ResourceId)) { $ResourceId=$expectedResourceId }
    if (-not [string]::Equals($ResourceId,$expectedResourceId,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'PATCH_JOURNAL_TARGET_MISMATCH: requested Resource ID does not match the supplied ARM Job URI.' }
    if ($LegacySource) {
        if ([string]::IsNullOrWhiteSpace($SourceJournalPath) -or [string]::IsNullOrWhiteSpace($EvidenceJournalPath)) { throw 'LEGACY_JOURNAL_PATH_REQUIRED: legacy resolution requires explicit source and isolated evidence paths.' }
        if ([string]::Equals([System.IO.Path]::GetFullPath($SourceJournalPath),[System.IO.Path]::GetFullPath($EvidenceJournalPath),[System.StringComparison]::OrdinalIgnoreCase)) { throw 'LEGACY_JOURNAL_WRITE_REJECTED: evidence journal must be distinct from the immutable legacy source.' }
        if (-not [string]::IsNullOrWhiteSpace($script:AcaPatchJournalPathOverride) -and [string]::Equals([System.IO.Path]::GetFullPath($script:AcaPatchJournalPathOverride),[System.IO.Path]::GetFullPath($SourceJournalPath),[System.StringComparison]::OrdinalIgnoreCase)) { throw 'LEGACY_JOURNAL_WRITER_OVERRIDE_REJECTED: the active writer cannot point to the immutable legacy source.' }
    }
    $operationsToResolve=if($null -ne $Operations) {@($Operations)} else {@(Get-AcaPatchJournalPendingOperations -ResourceId $ResourceId)}
    $originalJournalPath=$script:AcaPatchJournalPathOverride
    if (-not [string]::IsNullOrWhiteSpace($EvidenceJournalPath)) { Set-AcaPatchJournalPathOverride $EvidenceJournalPath }
    try {
        $null=Initialize-AcaPatchJournal
        foreach($operation in $operationsToResolve) {
            if (-not [string]::Equals([string]$operation.resourceId,$ResourceId,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'PATCH_JOURNAL_RESOURCE_MISMATCH: selected operation does not match the exact authorized Job Resource ID.' }
            $expectedReadback=Get-AcaPatchExpectedReadback -Operation ([string]$operation.operation)
            $expectedSecretName=Get-AcaPatchExpectedJitSecretName -Operation ([string]$operation.operation) -RecordedName ([string]$operation.expectedSecretName)
            if ([string]::IsNullOrWhiteSpace([string]$operation.lroReference)) {
                $results.Add([pscustomobject]@{AttemptId=$operation.attemptId;State='HISTORICAL_LRO_UNVERIFIABLE';Readback='NotAttempted';Resolved=$false})
                continue
            }
            $script:AcaCurrentPatchAttempt=[pscustomobject]@{
                attemptId=[string]$operation.attemptId;startedAtUtc=[string]$operation.timestampUtc
                resourceId=[string]$operation.resourceId;operation=[string]$operation.operation
                httpStatus=$operation.httpStatus;requestId=$operation.requestId;correlationId=$operation.correlationId
                lroReference=[string]$operation.lroReference;terminalState=$null;readbackResult=$null
                sourceAttemptId=$null;expectedSecretName=$expectedSecretName
                armRequestId=$null;armCorrelationId=$null;armHttpStatus=$null;readbackRequestId=$null;readbackHttpStatus=$null
            }
            $script:AcaLastObservedLroState=$null
            $terminalError=$null
            try {
                $null=Wait-AcaOperation -OperationUri ([string]$operation.lroReference) -Token $Token -TimeoutSeconds $TimeoutSeconds -Sleep $Sleep -NoJournal:$LegacySource
            } catch {
                if ($script:AcaLastObservedLroState -notin @('Succeeded','Failed','Canceled','Cancelled')) { throw }
                $terminalError=$_.Exception.Message
            }
            if ($script:AcaLastObservedLroState -notin @('Succeeded','Failed','Canceled','Cancelled')) { throw 'PATCH_JOURNAL_TERMINAL_STATE_UNVERIFIED: ARM did not return a recognized terminal state.' }
            $snapshot=Get-AcaJobSnapshot -Uri $Uri -Token $Token -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $EnvironmentId -ExpectedImage $ExpectedImage
            $names=@($snapshot.Resource.properties.configuration.secrets|Where-Object{$_ -and $_.name}|ForEach-Object{[string]$_.name})
            $present=$names -contains $expectedSecretName
            $readback=if($present){'VerifiedPresent'}else{'VerifiedAbsent'}
            $resolved=$readback -ceq $expectedReadback
            if ($LegacySource) {
                $script:AcaCurrentPatchAttempt=[pscustomobject]@{
                    attemptId=[guid]::NewGuid().ToString('D');startedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')
                    resourceId=[string]$operation.resourceId;operation=[string]$operation.operation;httpStatus=$null
                    requestId=$null;correlationId=$null;lroReference=[string]$operation.lroReference
                    terminalState=[string]$script:AcaLastObservedLroState;readbackResult=$readback
                    sourceAttemptId=[string]$operation.attemptId;expectedSecretName=$expectedSecretName
                    armRequestId=[string]$script:AcaLastObservedLroRequestId;armCorrelationId=[string]$script:AcaLastObservedLroCorrelationId;armHttpStatus=[int]$script:AcaLastObservedLroHttpStatus
                    readbackRequestId=[string]$snapshot.RequestId;readbackHttpStatus=[int]$snapshot.HttpStatus
                }
                if ([string]::IsNullOrWhiteSpace([string]$script:AcaLastObservedLroRequestId) -or [int]$script:AcaLastObservedLroHttpStatus -ne 200 -or [string]::IsNullOrWhiteSpace([string]$snapshot.RequestId) -or [int]$snapshot.HttpStatus -ne 200) { throw 'PATCH_RECONCILIATION_EVIDENCE_INCOMPLETE: ARM terminal/readback request IDs are required to record an observed result.' }
                $evidenceType=if($resolved){'LegacyReconciliation'}else{'LegacyResolutionObserved'}
                Write-AcaPatchJournalEvent -EventType $evidenceType -ResourceId ([string]$operation.resourceId) -Operation ([string]$operation.operation) -LroReference ([string]$operation.lroReference) -TerminalState ([string]$script:AcaLastObservedLroState) -ReadbackResult $readback -SourceAttemptId ([string]$operation.attemptId) -ExpectedSecretName $expectedSecretName -ArmRequestId ([string]$script:AcaLastObservedLroRequestId) -ArmCorrelationId ([string]$script:AcaLastObservedLroCorrelationId) -ArmHttpStatus ([int]$script:AcaLastObservedLroHttpStatus) -ReadbackRequestId ([string]$snapshot.RequestId) -ReadbackHttpStatus ([int]$snapshot.HttpStatus)
            } else {
                Write-AcaPatchJournalEvent -EventType Readback -ReadbackResult $readback
            }
            $results.Add([pscustomobject]@{AttemptId=$operation.attemptId;State=[string]$script:AcaLastObservedLroState;Readback=$readback;Resolved=$resolved;Error=if($terminalError){'TerminalFailure'}else{$null}})
        }
        return $results.ToArray()
    } finally {
        Set-AcaPatchJournalPathOverride $originalJournalPath
    }
}

function Invoke-AcaJitStartWithCleanup {
    param(
        [Parameter(Mandatory)][scriptblock]$StartAction,
        [Parameter(Mandatory)][scriptblock]$CleanupAction
    )
    try {
        return & $StartAction
    } catch {
        $startFailure = $_.Exception.Message
        try {
            & $CleanupAction
        } catch {
            throw 'CLEANUP_INCOMPLETE: Job start failed and the JIT/secret cleanup action also failed.'
        }
        throw "JOB_START_FAILED: $startFailure"
    }
}
