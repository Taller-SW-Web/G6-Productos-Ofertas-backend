<#
.SYNOPSIS
    Elimina EXCLUSIVAMENTE la instancia APIM para detener su facturación horaria (~$0.0658/h),
    preservando la VNet, subred snet-g6-apim, NSG, Application Insights y ACA.
.DESCRIPTION
    Requiere autorización explícita mediante -AuthorizeDelete y confirmación interactiva
    (o -NonInteractiveConfirmed cuando sea ejecutado por un operador autorizado).
    IMPORTANTE (Soft-Delete):
    - Al eliminar APIM, Azure retiene el nombre en soft-delete durante 48 horas.
    - Para recrear con el mismo nombre antes de 48h deberá purgarse primero:
      az apim deletedservice purge --location chilecentral --service-name apim-g6-productos-chile
    - Al recrear con IP administrada por APIM, la IP pública puede cambiar y deberá
      re-ejecutarse Conectar-APIM.ps1 para actualizar ipSecurityRestrictions en api-gateway.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [switch]$AuthorizeDelete,
    [switch]$NonInteractiveConfirmed,
    [string]$SubscriptionId = "fef42188-accd-4470-ae88-78f583eb4906",
    [string]$ResourceGroup = "rg-g6-aca-chile",
    [string]$ApimName = "apim-g6-productos-chile"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $AuthorizeDelete) {
    throw "Operación bloqueada: debes especificar -AuthorizeDelete explícitamente."
}

if (-not $NonInteractiveConfirmed) {
    $confirm = Read-Host "CONFIRMAR ELIMINACIÓN DE '$ApimName' en '$ResourceGroup' (escribe el nombre exacto para continuar)"
    if ($confirm -ne $ApimName) {
        throw "Confirmación cancelada: el nombre ingresado no coincide con '$ApimName'."
    }
}

az account set --subscription $SubscriptionId

Write-Host "[Eliminar-APIM] Eliminando exclusivamente APIM '$ApimName' (preservando VNet, snet-g6-apim, nsg-g6-apim, AppInsights y ACA)..."
az apim delete --resource-group $ResourceGroup --name $ApimName --yes --no-wait

Write-Host "[Eliminar-APIM] Solicitud de eliminación enviada. Recuerda el soft-delete de 48h y que al recrear la instancia puede cambiar su IP pública."
