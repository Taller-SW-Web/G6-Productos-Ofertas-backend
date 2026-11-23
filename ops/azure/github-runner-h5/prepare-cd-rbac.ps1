param(
    [switch]$Apply,
    [string]$ApprovalCode,
    [string]$ResourceGroup = 'rg-g6-sb-h5-int-fork',
    [string]$EnvironmentName = 'env-g6-h5-int',
    [string]$IdentityName = 'g6-h5-int-github-cd'
)

$ErrorActionPreference = 'Stop'
$requiredApps = @('api-gateway', 'catalog-svc', 'inventory-svc', 'pricing-svc', 'promotions-svc')
$appRoleName = 'G6 H5 Existing Container Apps Operator'
$envRoleName = 'G6 H5 Container Apps Environment Reader'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = (Resolve-Path (Join-Path $scriptDirectory '..\..\..\..')).Path
$appRoleTemplatePath = Join-Path $scriptDirectory 'role-aca-existing-apps.json'
$envRoleTemplatePath = Join-Path $scriptDirectory 'role-aca-environment-reader.json'
$temporaryFiles = [System.Collections.Generic.List[string]]::new()

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & az @Arguments 2>&1
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
        $existingActions = @($found.permissions | ForEach-Object { $_.actions } | ForEach-Object { $_ }) | Sort-Object -Unique
        $expectedActions = @($Role.Actions) | Sort-Object -Unique
        $existingScopes = @($found.assignableScopes) | Sort-Object -Unique
        $expectedScopes = @($Role.AssignableScopes) | Sort-Object -Unique
        if ((Compare-Object $existingActions $expectedActions) -or (Compare-Object $existingScopes $expectedScopes)) {
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

    $group = Invoke-AzJson @('group','show','--name',$ResourceGroup,'--output','json','--subscription',$subscriptionId)
    $groupId = [string]$group.id
    $environment = Invoke-AzJson @('containerapp','env','show','--name',$EnvironmentName,'--resource-group',$ResourceGroup,'--output','json','--subscription',$subscriptionId)
    $identity = Invoke-AzJson @('identity','show','--name',$IdentityName,'--resource-group',$ResourceGroup,'--output','json','--subscription',$subscriptionId)
    $principalId = [string]$identity.principalId
    if (-not $groupId -or -not $environment.id -or -not $principalId) { throw 'No se pudo resolver RG, Environment o principal desde Azure CLI.' }

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
    if ($missing.Count -gt 0) {
        throw "Aplicación bloqueada: faltan ACA en $EnvironmentName ($($missing -join ', ')); no se crearon roles ni asignaciones."
    }
    if ($apps.Count -ne $requiredApps.Count) { throw 'El conjunto de ACA no coincide con las cinco apps autorizadas.' }

    foreach ($pair in @(@{Path=$appRoleTemplatePath; Name=$appRoleName}, @{Path=$envRoleTemplatePath; Name=$envRoleName})) {
        $role = Get-Content -LiteralPath $pair.Path -Raw | ConvertFrom-Json
        if ($role.Name -cne $pair.Name) { throw "Nombre de rol inesperado en $($pair.Path)" }
        $role.AssignableScopes = @($groupId)
        $outputPath = [System.IO.Path]::GetTempFileName()
        $temporaryFiles.Add($outputPath)
        $role | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $outputPath -Encoding utf8
        Save-RoleDefinition -Role $role -Path $outputPath
    }

    Write-Output "Subscription y scopes obtenidos del contexto Azure; identidad $IdentityName resuelta en runtime."
    Write-Output "Plan: '$envRoleName' en el RG y '$appRoleName' en $($apps.Count) scopes ACA existentes. No hay permisos de app write en scope RG/subscription."
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
