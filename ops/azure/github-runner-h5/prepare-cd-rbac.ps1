param(
    [switch]$Apply,
    [string]$ApprovalCode,
    [ValidateSet('brazil-isolated','chile-shared')][string]$Destination = 'brazil-isolated',
    [string[]]$Services,
    [switch]$AuthorizeAdditionalServices,
    [string]$ResourceGroup,
    [string]$EnvironmentName,
    [string]$IdentityName
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'rbac-plan.ps1')
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$targetsPath = Join-Path $scriptDirectory '..\container-apps\deployment-targets.json'
$targets = Get-Content -LiteralPath $targetsPath -Raw | ConvertFrom-Json
$target = $targets.destinations.$Destination
if (-not $target) { throw "Destino no autorizado: $Destination" }
$expectedServices = if ($Services) { @($Services) } else { @($target.initialServices) }
$additionalServices = @($expectedServices | Where-Object { $_ -notin @($target.initialServices) })
if ($Destination -ceq 'chile-shared' -and $additionalServices.Count -gt 0 -and -not $AuthorizeAdditionalServices) { throw 'Los otros cuatro servicios requieren -AuthorizeAdditionalServices explícito.' }
if (@($expectedServices | Select-Object -Unique).Count -ne $expectedServices.Count -or @($expectedServices | Where-Object { $_ -notin @($targets.services) }).Count -gt 0) { throw 'Selección de servicios duplicada o fuera de allowlist.' }
$ResourceGroup = if ($ResourceGroup) { $ResourceGroup } else { [string]$target.resourceGroup }
$EnvironmentName = if ($EnvironmentName) { $EnvironmentName } else { [string]$target.acaEnvironment }
$IdentityName = if ($IdentityName) { $IdentityName } else { [string]$target.cdIdentity }
if ($ResourceGroup -cne $target.resourceGroup -or $EnvironmentName -cne $target.acaEnvironment -or $IdentityName -cne $target.cdIdentity) { throw 'Overrides RG, Environment o identidad no coinciden con el destino aprobado.' }
$requiredApps = @($expectedServices)
$roleSuffix = if ($Destination -ceq 'chile-shared') { 'Chile' } else { '' }
$appRoleName = "G6 H5 $roleSuffix Existing Container Apps Operator".Replace('H5  Existing','H5 Existing')
$envRoleName = "G6 H5 $roleSuffix Container Apps Environment Reader".Replace('H5  Container','H5 Container')
$repositoryRoot = (Resolve-Path (Join-Path $scriptDirectory '..\..\..\..')).Path
$templateSuffix = if ($Destination -ceq 'chile-shared') { '-chile' } else { '' }
$appRoleTemplatePath = Join-Path $scriptDirectory "role-aca-existing-apps$templateSuffix.json"
$envRoleTemplatePath = Join-Path $scriptDirectory "role-aca-environment-reader$templateSuffix.json"
$temporaryFiles = [System.Collections.Generic.List[string]]::new()

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & az @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI falló al consultar/aplicar el plan: $($Arguments[0]) (exit $LASTEXITCODE). $($output -join ' ')"
    }
    $text = $output -join "`n"
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
}

function Save-RoleDefinition {
    param([Parameter(Mandatory)]$Role, [Parameter(Mandatory)][string]$Path)
    $existing = Invoke-AzJson @('role','definition','list','--name',$Role.Name,'--output','json','--subscription',$subscriptionId)
    if ($existing -and $existing.Count -gt 0) {
        $found = @($existing | Where-Object { $_.roleName -eq $Role.Name }) | Select-Object -First 1
        if (-not $found) { throw "No se pudo validar la definición existente '$($Role.Name)'" }
        if ([string]$found.roleType -cne 'CustomRole') { throw "La definición '$($Role.Name)' no es un rol personalizado; revisión RBAC manual requerida." }
        $existingActions = @($found.permissions | ForEach-Object { $_.actions } | ForEach-Object { $_ }) | Sort-Object -Unique
        $expectedActions = @($Role.Actions) | Sort-Object -Unique
        $existingNotActions = @($found.permissions | ForEach-Object { $_.notActions } | ForEach-Object { $_ }) | Sort-Object -Unique
        $expectedNotActions = @($Role.NotActions) | Sort-Object -Unique
        $existingDataActions = @($found.permissions | ForEach-Object { $_.dataActions } | ForEach-Object { $_ }) | Sort-Object -Unique
        $expectedDataActions = @($Role.DataActions) | Sort-Object -Unique
        $existingNotDataActions = @($found.permissions | ForEach-Object { $_.notDataActions } | ForEach-Object { $_ }) | Sort-Object -Unique
        $expectedNotDataActions = @($Role.NotDataActions) | Sort-Object -Unique
        $existingScopes = @($found.assignableScopes) | Sort-Object -Unique
        $expectedScopes = @($Role.AssignableScopes) | Sort-Object -Unique
        if ((Compare-Object $existingActions $expectedActions) -or
            (Compare-Object $existingNotActions $expectedNotActions) -or
            (Compare-Object $existingDataActions $expectedDataActions) -or
            (Compare-Object $existingNotDataActions $expectedNotDataActions) -or
            (Compare-Object $existingScopes $expectedScopes)) {
            throw "La definición existente '$($Role.Name)' difiere del template; revisión RBAC manual requerida."
        }
        return
    }
    if ($Apply) {
        $null = Invoke-AzJson @('role','definition','create','--role-definition',"@$Path",'--output','json','--subscription',$subscriptionId)
    }
}

function Ensure-Assignment {
    param([Parameter(Mandatory)][string]$RoleName, [Parameter(Mandatory)][string]$Scope)
    $query = "[?principalId=='$principalId' && roleDefinitionName=='$RoleName'] | length(@)"
    $count = Invoke-AzJson @('role','assignment','list','--scope',$Scope,'--query',$query,'--output','tsv','--subscription',$subscriptionId)
    if ([int]$count -gt 0) { return }
    if ($Apply) {
        $null = Invoke-AzJson @('role','assignment','create','--assignee-object-id',$principalId,'--assignee-principal-type','ServicePrincipal','--role',$RoleName,'--scope',$Scope,'--output','json','--subscription',$subscriptionId)
    }
}

try {
    if ($Apply -and $ApprovalCode -cne 'APPLY-G6-H5-CD-RBAC') {
        throw 'Aplicación bloqueada: requiere -Apply y -ApprovalCode APPLY-G6-H5-CD-RBAC tras autorización del owner RBAC.'
    }

    $account = Invoke-AzJson @('account','show','--output','json')
    $subscriptionId = [string]$account.id
    if ([string]::IsNullOrWhiteSpace($subscriptionId)) { throw 'Azure CLI no tiene una suscripción activa.' }
    if ($subscriptionId -cne [string]$targets.subscriptionId) { throw 'La suscripción activa no es la suscripción autorizada en el plan de destino.' }

    $group = Invoke-AzJson @('group','show','--name',$ResourceGroup,'--output','json','--subscription',$subscriptionId)
    $groupId = [string]$group.id
    $environment = Invoke-AzJson @('containerapp','env','show','--name',$EnvironmentName,'--resource-group',$ResourceGroup,'--output','json','--subscription',$subscriptionId)
    if ([string]$environment.location -ine [string]$target.location) { throw "Environment $EnvironmentName no está en la región esperada $($target.location)." }
    $identity = $null
    try { $identity = Invoke-AzJson @('identity','show','--name',$IdentityName,'--resource-group',$ResourceGroup,'--output','json','--subscription',$subscriptionId) }
    catch {
        if ($Apply -or $Destination -cne 'chile-shared') { throw }
        Write-Warning "La identidad futura $IdentityName aún no existe. El plan de Chile será informativo y no consultará ni aplicará asignaciones para un principal inexistente."
    }
    $principalId = if ($identity) { [string]$identity.principalId } else { '' }
    if (-not $groupId -or -not $environment.id -or ($Apply -and -not $principalId)) { throw 'No se pudo resolver RG, Environment o principal requerido.' }

    $effectiveAssignments = if ($principalId) { Invoke-AzJson @('role','assignment','list','--assignee-object-id',$principalId,'--all','--include-inherited','--output','json','--subscription',$subscriptionId) } else { @() }
    $apps = @()
    $missing = @()
    foreach ($appName in $requiredApps) {
        $raw = & az containerapp show --name $appName --resource-group $ResourceGroup --output json --subscription $subscriptionId 2>$null
        if ($LASTEXITCODE -ne 0) { $missing += $appName; continue }
        $app = ($raw -join "`n") | ConvertFrom-Json
        $appEnvironment = [string]$app.properties.managedEnvironmentId
        if (-not $appEnvironment) { $appEnvironment = [string]$app.properties.environmentId }
        if ($appEnvironment.TrimEnd('/') -ine ([string]$environment.id).TrimEnd('/')) {
            throw "ACA '$appName' no pertenece a $EnvironmentName; no se crea ningún role assignment."
        }
        if ($app.id -notlike "$groupId/providers/Microsoft.App/containerApps/*") {
            throw "Scope inesperado para ACA '$appName'; no se crea ningún role assignment."
        }
        $apps += $app
    }

    foreach ($assignment in @($effectiveAssignments)) {
        $scope = ([string]$assignment.scope).TrimEnd('/')
        $roleName = [string]$assignment.roleDefinitionName
        $allowedRoleScope = ($roleName -eq $envRoleName -and $scope -ieq $groupId.TrimEnd('/')) -or
            ($roleName -eq $appRoleName -and @($apps | Where-Object { ([string]$_.id).TrimEnd('/') -ieq $scope }).Count -eq 1)
        if (-not $allowedRoleScope) {
            throw "RBAC bloqueado: asignación heredada o directa inesperada '$roleName' en scope '$scope'; el owner Azure debe revisarla antes del CD."
        }
    }

    if ($missing.Count -gt 0) {
        throw "Aplicación bloqueada: faltan ACA en $EnvironmentName ($($missing -join ', ')); se verificó RBAC heredado, no se crearon roles ni asignaciones."
    }
    if ($apps.Count -ne $requiredApps.Count) { throw 'El conjunto de ACA no coincide con la selección autorizada.' }
    $rbacPlan = New-H5RbacPlan -TargetConfig $targets -Destination $Destination -Services $requiredApps -ResourceGroupId $groupId -EnvironmentId ([string]$environment.id) -Apps $apps -AuthorizeAdditionalServices:$AuthorizeAdditionalServices
    if ($rbacPlan.AppRoleName -cne $appRoleName -or $rbacPlan.EnvironmentReaderRoleName -cne $envRoleName) { throw 'Los nombres de roles no coinciden con el plan delimitado del destino.' }

    foreach ($pair in @(@{Path=$appRoleTemplatePath; Name=$appRoleName}, @{Path=$envRoleTemplatePath; Name=$envRoleName})) {
        $role = Get-Content -LiteralPath $pair.Path -Raw | ConvertFrom-Json
        $role.Name = $pair.Name
        $role.AssignableScopes = @($groupId)
        $outputPath = [System.IO.Path]::GetTempFileName()
        $temporaryFiles.Add($outputPath)
        $role | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $outputPath -Encoding utf8
        Save-RoleDefinition -Role $role -Path $outputPath
    }

    if ($principalId) { Write-Output "Subscription y scopes obtenidos del contexto Azure; identidad $IdentityName resuelta para revisión." }
    else { Write-Output "Plan informativo; identidad futura $IdentityName pendiente de creación autorizada y sin principal/RBAC real." }
    Write-Output "Plan destino ${Destination}: '$envRoleName' en el RG y '$appRoleName' en $($apps.Count) scopes ACA existentes para $($requiredApps -join ', '). No hay permisos de app write en scope RG/subscription."
    if (-not $Apply) {
        Write-Output 'DRY RUN: no se crearon roles ni asignaciones. Reejecutar con autorización del owner, -Apply y el código de aprobación.'
        exit 0
    }

    Ensure-Assignment -RoleName $envRoleName -Scope $groupId
    foreach ($app in $apps) { Ensure-Assignment -RoleName $appRoleName -Scope ([string]$app.id) }

    $assignmentArgs = @('role','assignment','list','--assignee-object-id',$principalId,'--all','--output','json','--subscription',$subscriptionId)
    $assignments = Invoke-AzJson $assignmentArgs
    $expectedScopes = @($groupId) + @($apps | ForEach-Object { [string]$_.id })
    foreach ($scope in $expectedScopes) {
        $matching = @($assignments | Where-Object { $_.scope.TrimEnd('/') -ieq $scope.TrimEnd('/') })
        if ($scope -eq $groupId) {
            $matching = @($matching | Where-Object { $_.roleDefinitionName -eq $envRoleName })
        } else {
            $matching = @($matching | Where-Object { $_.roleDefinitionName -eq $appRoleName })
        }
        if ($matching.Count -eq 0) { throw "RBAC postcheck sin asignación efectiva para scope $scope" }
    }
    Write-Output 'PASS: asignaciones verificadas en el RG de lectura y en los cinco scopes ACA.'
}
finally {
    foreach ($file in $temporaryFiles) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}
