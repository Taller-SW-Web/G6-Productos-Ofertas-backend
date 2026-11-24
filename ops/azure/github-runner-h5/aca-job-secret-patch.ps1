Set-StrictMode -Version Latest

$script:AcaArmRequestOverride = $null
$script:AcaLastPatchOutcome = 'NotStarted'

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
    return [pscustomobject]@{ Resource=$resource; ETag=$etag }
}

function Wait-AcaOperation {
    param(
        [Parameter(Mandatory)][string]$OperationUri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [scriptblock]$Sleep = { Start-Sleep -Seconds 3 },
        [string[]]$RedactValues = @()
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $response = Invoke-AcaArmRequest -Method GET -Uri $OperationUri -Token $Token
        if ($response.StatusCode -notin @(200, 202)) { Throw-AcaResponseError -Response $response -Operation 'ARM async operation' -RedactValues $RedactValues }
        $state = ConvertFrom-AcaResponseContent ([string]$response.Content)
        $stateValue = $null
        $statePropertyNames = @()
        if ($null -ne $state) { $statePropertyNames = @($state.PSObject.Properties | ForEach-Object { $_.Name }) }
        if ($state -and $statePropertyNames -contains 'status') { $stateValue = [string]$state.status }
        elseif ($state -and $statePropertyNames -contains 'provisioningState') { $stateValue = [string]$state.provisioningState }
        elseif ($state -and $statePropertyNames -contains 'properties' -and @($state.properties.PSObject.Properties | ForEach-Object { $_.Name }) -contains 'provisioningState') { $stateValue = [string]$state.properties.provisioningState }
        elseif ($response.StatusCode -eq 200) { return }
        switch ($stateValue) {
            'Succeeded' { return }
            'Failed' { $script:AcaLastPatchOutcome='TerminalFailure'; Throw-AcaResponseError -Response $response -Operation 'ARM async operation' -RedactValues $RedactValues }
            'Canceled' { $script:AcaLastPatchOutcome='TerminalFailure'; throw 'ARM_OPERATION_CANCELED: asynchronous Job patch was canceled.' }
            'Cancelled' { $script:AcaLastPatchOutcome='TerminalFailure'; throw 'ARM_OPERATION_CANCELED: asynchronous Job patch was canceled.' }
        }
        if ([string]::IsNullOrWhiteSpace($stateValue) -and $response.StatusCode -eq 202) { throw 'ARM_OPERATION_STATE_UNAVAILABLE: 202 poll response had no status/provisioningState.' }
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
        [int]$TimeoutSeconds = 120,
        [scriptblock]$Sleep = { Start-Sleep -Seconds 3 },
        [string[]]$RedactValues = @()
    )
    $script:AcaLastPatchOutcome = 'Ambiguous'
    try {
        $body = @{properties=@{configuration=@{secrets=@($Secrets)}}}
        $headers = @{}
        if (-not [string]::IsNullOrWhiteSpace($ETag)) { $headers['If-Match'] = $ETag }
        $response = Invoke-AcaArmRequest -Method PATCH -Uri $Uri -Token $Token -Headers $headers -Body $body
        if ($response.StatusCode -eq 200) { $script:AcaLastPatchOutcome='Completed'; return }
        if ($response.StatusCode -eq 202) {
            $operationUri = Get-AcaHeaderValue $response.Headers 'Azure-AsyncOperation'
            if (-not $operationUri) { $operationUri = Get-AcaHeaderValue $response.Headers 'Location' }
            if (-not $operationUri) { Throw-AcaResponseError -Response $response -Operation "$Operation LRO location missing" -RedactValues $RedactValues }
            Wait-AcaOperation -OperationUri $operationUri -Token $Token -TimeoutSeconds $TimeoutSeconds -Sleep $Sleep -RedactValues $RedactValues
            if ($script:AcaLastPatchOutcome -ne 'TerminalFailure') { $script:AcaLastPatchOutcome='Completed' }
            return
        }
        if ([int]$response.StatusCode -ge 400 -and [int]$response.StatusCode -lt 500) { $script:AcaLastPatchOutcome='Rejected' }
        Throw-AcaResponseError -Response $response -Operation $Operation -RedactValues $RedactValues
    } catch {
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
    Invoke-AcaJobSecretPatch -Uri $Uri -Token $Token -ETag $snapshot.ETag -Secrets @($newSecret) -Operation 'PATCH add Job secret' -TimeoutSeconds $TimeoutSeconds -Sleep $Sleep -RedactValues @($SecretValue,$Token)

    $verified = Get-AcaJobSnapshot -Uri $Uri -Token $Token -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $EnvironmentId -ExpectedImage $ExpectedImage
    if (@($verified.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name -eq $SecretName }).Count -ne 1) {
        throw 'TEMPORARY_SECRET_VERIFY_FAILED: PATCH completed but the secret name was not present after readback.'
    }
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
    Invoke-AcaJobSecretPatch -Uri $Uri -Token $Token -ETag $snapshot.ETag -Secrets @() -Operation 'PATCH remove Job secret' -TimeoutSeconds $TimeoutSeconds -Sleep $Sleep -RedactValues @($Token)

    $verified = Get-AcaJobSnapshot -Uri $Uri -Token $Token -JobName $JobName -ResourceGroup $ResourceGroup -EnvironmentId $EnvironmentId -ExpectedImage $ExpectedImage
    if (@($verified.Resource.properties.configuration.secrets | Where-Object { $_ -and $_.name -eq $SecretName }).Count -ne 0) {
        throw 'TEMPORARY_SECRET_CLEANUP_VERIFY_FAILED: secret name remains after PATCH cleanup.'
    }
    return $true
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
