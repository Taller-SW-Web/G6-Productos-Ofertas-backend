Set-StrictMode -Version Latest

function Normalize-H5RbacAssignments {
    [CmdletBinding()]
    param([AllowNull()][object[]]$Assignments)
    return ,@($Assignments | Where-Object { $null -ne $_ })
}

function Get-H5IdentityLookupState {
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$ExitCode,[AllowEmptyString()][string]$Output)
    if ($ExitCode -eq 0) {
        if ([string]::IsNullOrWhiteSpace($Output)) { return 'Invalid' }
        try { $identity = $Output | ConvertFrom-Json -ErrorAction Stop } catch { return 'Invalid' }
        if ($identity.principalId) { return 'Existing' }
        return 'Invalid'
    }
    if ($Output -match '(?i)\b(ResourceNotFound|IdentityNotFound)\b') { return 'NotFound' }
    return 'Denied'
}

function Assert-H5RbacAssignments {
    [CmdletBinding()]
    param([AllowNull()][object[]]$Assignments,[Parameter(Mandatory)][string]$AppRoleName,[Parameter(Mandatory)][string]$EnvironmentRoleName,[Parameter(Mandatory)][string]$ResourceGroupId,[Parameter(Mandatory)][object[]]$Apps)
    foreach ($assignment in (Normalize-H5RbacAssignments $Assignments)) {
        $scope = ([string]$assignment.scope).TrimEnd('/')
        $role = [string]$assignment.roleDefinitionName
        $allowed = ($role -eq $EnvironmentRoleName -and $scope -ieq $ResourceGroupId.TrimEnd('/')) -or
            ($role -eq $AppRoleName -and @($Apps | Where-Object { ([string]$_.id).TrimEnd('/') -ieq $scope }).Count -eq 1)
        if (-not $allowed) { throw "RBAC_UNEXPECTED_ASSIGNMENT: '$role' en scope '$scope'." }
    }
}

function New-H5RbacPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$TargetConfig,
        [Parameter(Mandatory)][ValidateSet('brazil-isolated','chile-shared')][string]$Destination,
        [Parameter(Mandatory)][string[]]$Services,
        [Parameter(Mandatory)][string]$ResourceGroupId,
        [Parameter(Mandatory)][string]$EnvironmentId,
        [Parameter(Mandatory)][object[]]$Apps,
        [switch]$AuthorizeAdditionalServices
    )
    $target = $TargetConfig.destinations.$Destination
    $selected = @($Services)
    if (-not $target -or $selected.Count -eq 0 -or @($selected | Select-Object -Unique).Count -ne $selected.Count) { throw 'RBAC_PLAN_INVALID_SELECTION: destination/services invalid or duplicate.' }
    if (@($selected | Where-Object { $_ -notin @($TargetConfig.services) }).Count -gt 0) { throw 'RBAC_PLAN_SERVICE_UNAUTHORIZED: service is outside the nine ACA allowlist.' }
    $extra = @($selected | Where-Object { $_ -notin @($target.initialServices) })
    if ($Destination -ceq 'chile-shared' -and $extra.Count -gt 0 -and -not $AuthorizeAdditionalServices) { throw 'RBAC_PLAN_ADDITIONAL_SERVICE_REQUIRES_AUTHORIZATION.' }
    $expectedEnvironment = "/subscriptions/$($TargetConfig.subscriptionId)/resourceGroups/$($target.resourceGroup)/providers/Microsoft.App/managedEnvironments/$($target.acaEnvironment)"
    if ($EnvironmentId.TrimEnd('/') -ine $expectedEnvironment) { throw 'RBAC_PLAN_ENVIRONMENT_SCOPE_MISMATCH.' }
    if ($Apps.Count -ne $selected.Count) { throw 'RBAC_PLAN_APP_SET_MISMATCH.' }
    $appScopes = [System.Collections.Generic.List[string]]::new()
    foreach ($service in $selected) {
        $matches = @($Apps | Where-Object { [string]$_.name -ceq $service })
        if ($matches.Count -ne 1) { throw "RBAC_PLAN_APP_MISSING_OR_DUPLICATE: $service" }
        $app = $matches[0]
        $expectedApp = "/subscriptions/$($TargetConfig.subscriptionId)/resourceGroups/$($target.resourceGroup)/providers/Microsoft.App/containerApps/$service"
        $actualEnvironment = if ($app.properties.managedEnvironmentId) { [string]$app.properties.managedEnvironmentId } else { [string]$app.properties.environmentId }
        if ([string]$app.id -ine $expectedApp -or $actualEnvironment.TrimEnd('/') -ine $expectedEnvironment) { throw "RBAC_PLAN_APP_SCOPE_MISMATCH: $service" }
        $appScopes.Add([string]$app.id)
    }
    $suffix = if ($Destination -ceq 'chile-shared') { 'Chile ' } else { '' }
    return [pscustomobject]@{
        Destination = $Destination
        ResourceGroupReadScope = $ResourceGroupId
        EnvironmentReadScope = $ResourceGroupId
        AppWriteScopes = @($appScopes)
        Services = @($selected)
        AppRoleName = "G6 H5 ${suffix}Existing Container Apps Operator".Replace('H5  Existing','H5 Existing')
        EnvironmentReaderRoleName = "G6 H5 ${suffix}Container Apps Environment Reader".Replace('H5  Container','H5 Container')
    }
}
