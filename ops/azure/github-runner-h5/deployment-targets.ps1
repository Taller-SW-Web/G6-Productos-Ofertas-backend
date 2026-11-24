Set-StrictMode -Version Latest

function Get-H5DeploymentTargets {
    $path = Join-Path $PSScriptRoot '..\container-apps\deployment-targets.json'
    if (-not (Test-Path -LiteralPath $path)) { throw 'H5_DESTINATION_CONFIG_MISSING: deployment target map is absent.' }
    $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop
    if ([string]$config.subscriptionId -cne 'fef42188-accd-4470-ae88-78f583eb4906' -or @($config.services).Count -ne 9) {
        throw 'H5_DESTINATION_CONFIG_INVALID: subscription or service allowlist does not match the approved runtime.'
    }
    return $config
}

function Resolve-H5DeploymentTarget {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('brazil-isolated','chile-shared')][string]$Destination,
        [string]$GitHubEnvironment,
        [string]$Service,
        [switch]$PilotSelfReview
    )

    $config = Get-H5DeploymentTargets
    if ($PilotSelfReview) {
        if ($Destination -cne 'brazil-isolated' -or $Service -notin @($config.pilot.services)) {
            throw 'PILOT_SELF_REVIEW_SCOPE_REJECTED: legacy pilot is limited to Brazil selection and Pricing/Price Audit.'
        }
        $target = $config.pilot
        $targetDestination = 'brazil-isolated'
    } else {
        if ($Destination -ceq 'chile-shared' -and $Service -ceq 'all') {
            throw 'CHILE_ALL_SERVICES_REJECTED: chile-shared requires one explicit service.'
        }
        $target = $config.destinations.$Destination
        $targetDestination = $Destination
    }
    if (-not $target) { throw "H5_DESTINATION_UNKNOWN: $Destination" }
    if ($Service -and $Service -cne 'all' -and $Service -notin @($config.services)) {
        throw "H5_SERVICE_NOT_ALLOWED: $Service"
    }
    if ($GitHubEnvironment -and $GitHubEnvironment -cne [string]$target.githubEnvironment) {
        throw 'H5_DESTINATION_ENVIRONMENT_MISMATCH: GitHub Environment does not match the selected destination.'
    }

    return [pscustomobject]@{
        Destination = $targetDestination
        ResourceGroup = [string]$target.resourceGroup
        AcaEnvironment = [string]$target.acaEnvironment
        Location = [string]$target.location
        GitHubEnvironment = [string]$target.githubEnvironment
        RunnerGroupId = [int]$target.runnerGroupId
        JobName = [string]$(if ($PilotSelfReview) { $config.destinations.'brazil-isolated'.jobName } else { $target.jobName })
        SmokeLabel = [string]$target.smokeLabel
        CdIdentity = [string]$(if ($PilotSelfReview) { $config.destinations.'brazil-isolated'.cdIdentity } else { $target.cdIdentity })
        SubscriptionId = [string]$config.subscriptionId
        Services = @($config.services)
        InitialServices = @(if ($PilotSelfReview) { $target.services } else { $target.initialServices })
        PilotSelfReview = [bool]$PilotSelfReview
    }
}

function Assert-H5SmokeRunBinding {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Run,[Parameter(Mandatory)]$Target,[Parameter(Mandatory)][string]$MasterSha,[Parameter(Mandatory)][string]$Service)
    $title = [string]$Run.display_title
    if (-not $title -or $title -notmatch '^H5 CD (?<destination>brazil-isolated|chile-shared) (?<environment>azure-h5|azure-h5-chile|azure-h5-pilot-234) (?<service>[a-z0-9-]+) (?<sha>[0-9a-f]{40}) pilot=(?<pilot>true|false)$') { throw 'SMOKE_RUN_NAME_INVALID: official run-name structure is not exact.' }
    $matches = $Matches
    $expectedPilot = [bool]$Target.PilotSelfReview
    $expectedDestination = [string]$Target.Destination
    $expectedEnvironment = [string]$Target.GitHubEnvironment
    if ($expectedPilot) { $expectedEnvironment = 'azure-h5-pilot-234' }
    if ($matches.destination -cne $expectedDestination -or $matches.environment -cne $expectedEnvironment -or
        $matches.service -cne $Service -or $matches.sha -cne [string]$Run.head_sha -or
        $matches.pilot -cne ([string]$expectedPilot).ToLowerInvariant()) {
        throw 'SMOKE_RUN_NAME_MISMATCH: run-name destination, Environment, service, SHA or pilot flag differs from the approved run.'
    }
    if ($matches.service -eq 'all' -and ($expectedDestination -cne 'brazil-isolated' -or $expectedPilot)) { throw 'SMOKE_ALL_SERVICES_DESTINATION_REJECTED: all is limited to historical Brazil runs.' }
    if ([string]$Run.head_branch -cne 'master' -or [string]$Run.head_sha -cne $MasterSha) { throw 'SMOKE_RUN_SHA_MISMATCH: run is not for the current master release SHA.' }
}

function Assert-H5AcaJobBinding {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Job,[Parameter(Mandatory)]$ManagedEnvironment,[Parameter(Mandatory)]$Target)
    $expectedJob = "/subscriptions/$($Target.SubscriptionId)/resourceGroups/$($Target.ResourceGroup)/providers/Microsoft.App/jobs/$($Target.JobName)"
    $expectedEnvironment = "/subscriptions/$($Target.SubscriptionId)/resourceGroups/$($Target.ResourceGroup)/providers/Microsoft.App/managedEnvironments/$($Target.AcaEnvironment)"
    $jobRegion = ([string]$Job.location -replace '\s','').ToLowerInvariant()
    $environmentRegion = ([string]$ManagedEnvironment.location -replace '\s','').ToLowerInvariant()
    $targetRegion = ([string]$Target.Location -replace '\s','').ToLowerInvariant()
    if ([string]$Job.id -ine $expectedJob -or [string]$ManagedEnvironment.id -ine $expectedEnvironment -or
        [string]$Job.properties.environmentId -ine $expectedEnvironment -or $jobRegion -cne $targetRegion -or $environmentRegion -cne $targetRegion) {
        throw 'JIT_JOB_DESTINATION_MISMATCH: Job resource, ACA Environment or region does not match the selected destination.'
    }
}

function Assert-H5DestinationOverride {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name,[AllowEmptyString()][string]$Value,[Parameter(Mandatory)][string]$Expected)
    if ($Value -and $Value -cne $Expected) { throw "H5_DESTINATION_OVERRIDE_MISMATCH: $Name no coincide con la configuración del destino." }
}

function Assert-H5SmokeLabels {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]]$Labels,[Parameter(Mandatory)][ValidateSet('azure-h5-smoke','azure-h5-smoke-chile')][string]$SmokeLabel)
    $other = if ($SmokeLabel -ceq 'azure-h5-smoke') { 'azure-h5-smoke-chile' } else { 'azure-h5-smoke' }
    if ($Labels -notcontains 'linux' -or $Labels -notcontains $SmokeLabel -or $Labels -contains $other) { throw 'JIT_SMOKE_LABELS_MISMATCH: smoke runner must carry only its destination selector.' }
}
