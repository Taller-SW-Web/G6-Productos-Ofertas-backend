$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\deployment-targets.ps1')
. (Join-Path $PSScriptRoot '..\rbac-plan.ps1')
function Assert-True([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
$config = Get-H5DeploymentTargets
$target = $config.destinations.'chile-shared'
$rgId = "/subscriptions/$($config.subscriptionId)/resourceGroups/$($target.resourceGroup)"
$envId = "$rgId/providers/Microsoft.App/managedEnvironments/$($target.acaEnvironment)"
$apps = @($target.initialServices | ForEach-Object { [pscustomobject]@{name=$_;id="$rgId/providers/Microsoft.App/containerApps/$_";properties=[pscustomobject]@{managedEnvironmentId=$envId}} })
Assert-True ((Normalize-H5RbacAssignments -Assignments $null).Count -eq 0) 'empty/null RBAC assignments were not normalized to an empty collection'
Assert-True ((Get-H5IdentityLookupState -ExitCode 0 -Output '{"principalId":"p-1"}') -eq 'Existing') 'existing identity was not detected'
Assert-True ((Get-H5IdentityLookupState -ExitCode 3 -Output 'ResourceNotFound: identity was not found') -eq 'NotFound') 'identity absence was not classified only for explicit ResourceNotFound'
Assert-True ((Get-H5IdentityLookupState -ExitCode 1 -Output 'AuthorizationFailed: forbidden') -eq 'Denied') 'denied identity query was misclassified as absent'
$rgAssignmentScope = @{scope=$rgId;roleDefinitionName='G6 H5 Chile Container Apps Environment Reader'}
$appAssignmentScope = @{scope=$apps[0].id;roleDefinitionName='G6 H5 Chile Existing Container Apps Operator'}
Assert-H5RbacAssignments -Assignments @($rgAssignmentScope,$appAssignmentScope,$null) -AppRoleName 'G6 H5 Chile Existing Container Apps Operator' -EnvironmentRoleName 'G6 H5 Chile Container Apps Environment Reader' -ResourceGroupId $rgId -Apps $apps
try { Assert-H5RbacAssignments -Assignments @(@{scope=$rgId;roleDefinitionName='Contributor'}) -AppRoleName 'G6 H5 Chile Existing Container Apps Operator' -EnvironmentRoleName 'G6 H5 Chile Container Apps Environment Reader' -ResourceGroupId $rgId -Apps $apps; throw 'unexpected assignment accepted' } catch { if ($_.Exception.Message -eq 'unexpected assignment accepted') { throw } }
$plan = New-H5RbacPlan -TargetConfig $config -Destination chile-shared -Services $target.initialServices -ResourceGroupId $rgId -EnvironmentId $envId -Apps $apps
Assert-True ($plan.AppWriteScopes.Count -eq 5 -and $plan.AppWriteScopes -notcontains $rgId -and $plan.ResourceGroupReadScope -eq $rgId) 'Chile scopes are not limited to five individual ACA and RG read'
Assert-True ($plan.AppRoleName -eq 'G6 H5 Chile Existing Container Apps Operator' -and $plan.EnvironmentReaderRoleName -eq 'G6 H5 Chile Container Apps Environment Reader') 'Chile role definitions collide with Brazil names'
$extraServices = @($target.initialServices + 'bulk-svc')
$extraApps = @($apps) + [pscustomobject]@{name='bulk-svc';id="$rgId/providers/Microsoft.App/containerApps/bulk-svc";properties=[pscustomobject]@{managedEnvironmentId=$envId}}
try { New-H5RbacPlan -TargetConfig $config -Destination chile-shared -Services $extraServices -ResourceGroupId $rgId -EnvironmentId $envId -Apps $extraApps | Out-Null; throw 'additional service accepted without explicit authorization' } catch { if ($_.Exception.Message -eq 'additional service accepted without explicit authorization') { throw } }
$authorized = New-H5RbacPlan -TargetConfig $config -Destination chile-shared -Services $extraServices -ResourceGroupId $rgId -EnvironmentId $envId -Apps $extraApps -AuthorizeAdditionalServices
Assert-True ($authorized.AppWriteScopes.Count -eq 6) 'authorized extra service not individually scoped'
foreach ($bad in @('wrong-environment','wrong-app-scope','duplicate','unknown')) {
    try {
        if ($bad -eq 'wrong-environment') { New-H5RbacPlan -TargetConfig $config -Destination chile-shared -Services $target.initialServices -ResourceGroupId $rgId -EnvironmentId "$envId-wrong" -Apps $apps | Out-Null }
        elseif ($bad -eq 'wrong-app-scope') { $badApps=@($apps); $badApps[0].id="$rgId/providers/Microsoft.App/containerapps/foreign"; New-H5RbacPlan -TargetConfig $config -Destination chile-shared -Services $target.initialServices -ResourceGroupId $rgId -EnvironmentId $envId -Apps $badApps | Out-Null }
        elseif ($bad -eq 'duplicate') { New-H5RbacPlan -TargetConfig $config -Destination chile-shared -Services @($target.initialServices[0],$target.initialServices[0]) -ResourceGroupId $rgId -EnvironmentId $envId -Apps $apps | Out-Null }
        else { New-H5RbacPlan -TargetConfig $config -Destination chile-shared -Services @('unknown') -ResourceGroupId $rgId -EnvironmentId $envId -Apps @() | Out-Null }
        throw "invalid $bad accepted"
    } catch { if ($_.Exception.Message -eq "invalid $bad accepted") { throw } }
}
foreach ($file in @('role-aca-existing-apps-chile.json','role-aca-environment-reader-chile.json')) {
    $role = Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\$file") -Raw | ConvertFrom-Json
    Assert-True ($role.IsCustom -eq $true -and @($role.Actions | Where-Object { $_ -match 'Owner|Contributor|delete' }).Count -eq 0) "unexpected permission in $file"
    Assert-True (@($role.DataActions).Count -eq 0 -and @($role.NotDataActions).Count -eq 0 -and @($role.AssignableScopes).Count -eq 1 -and $role.AssignableScopes[0] -eq '__AZURE_INTEGRATION_RESOURCE_GROUP_ID__') "unexpected data permission or assignable scope in $file"
}
$appRole = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\role-aca-existing-apps-chile.json') -Raw | ConvertFrom-Json
$envRole = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\role-aca-environment-reader-chile.json') -Raw | ConvertFrom-Json
$appActionDiff = @(Compare-Object -ReferenceObject @($appRole.Actions | Sort-Object) -DifferenceObject @('Microsoft.App/containerApps/read','Microsoft.App/containerApps/write','Microsoft.App/containerApps/revisions/read' | Sort-Object))
$appNotActionDiff = @(Compare-Object -ReferenceObject @($appRole.NotActions) -DifferenceObject @('Microsoft.App/containerApps/delete'))
$envActionDiff = @(Compare-Object -ReferenceObject @($envRole.Actions | Sort-Object) -DifferenceObject @('Microsoft.App/managedEnvironments/read','Microsoft.Resources/subscriptions/resourceGroups/read' | Sort-Object))
Assert-True ($appActionDiff.Count -eq 0 -and $appNotActionDiff.Count -eq 0) 'Chile ACA role actions differ from the reviewed allowlist'
Assert-True ($envActionDiff.Count -eq 0 -and @($envRole.NotActions).Count -eq 0) 'Chile Environment reader actions differ from the reviewed allowlist'
Assert-True ((Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\prepare-cd-rbac.ps1') -Raw) -match "DRY RUN: no se crearon roles ni asignaciones") 'planning code no longer guarantees dry run'
Write-Output 'PASS RBAC plan: empty/existing/absent/denied identity handling, null/empty/unexpected assignments, explicit services/scopes and dry-run permissions.'
