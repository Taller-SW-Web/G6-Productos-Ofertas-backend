param(
  [Parameter(Mandatory)][string] $ParametersFile,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{40}$')][string] $AuthorizedSha
)

$ErrorActionPreference = 'Stop'
$templatePath = Join-Path $PSScriptRoot 'h5-isolated-five-apps.bicep'
$validatorPath = Join-Path $PSScriptRoot 'validate-h5-five-apps.mjs'
$validatorTests = Join-Path $PSScriptRoot 'validate-h5-five-apps.test.mjs'
$serviceNames = @('api-gateway', 'catalog-svc', 'inventory-svc', 'pricing-svc', 'promotions-svc')
$whatIfModule = Join-Path $PSScriptRoot '..\azure-whatif-validation.psm1'
Import-Module $whatIfModule -Force
$resolvedParameters = (Resolve-Path -LiteralPath $ParametersFile).Path

$masterSha = gh api repos/Taller-SW-Web/G6-Productos-Ofertas-backend/commits/master --jq .sha 2>$null
if ($LASTEXITCODE -ne 0 -or $masterSha.Trim() -cne $AuthorizedSha.ToLowerInvariant()) { throw 'H5_ACA_SOURCE_SHA_NOT_CURRENT_MASTER' }
$ciQuery = "repos/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs?head_sha=$AuthorizedSha&event=push&status=completed"
$ciRunIds = gh api $ciQuery --jq ".workflow_runs[] | select(.head_sha==\"$AuthorizedSha\" and .event==\"push\" and .status==\"completed\" and .conclusion==\"success\" and .head_branch==\"master\") | .id" 2>$null
if ($LASTEXITCODE -ne 0 -or -not $ciRunIds) { throw 'H5_ACA_SOURCE_CI_PUSH_NOT_SUCCESSFUL' }

$deploymentResourceGroup = 'rg-g6-sb-h5-int-fork'
$preflightErrorPath = Join-Path $env:TEMP ('h5-aca-preflight-' + [guid]::NewGuid().ToString('N') + '.stderr')
try {
  $group = az group show --name $deploymentResourceGroup --output json 2>$preflightErrorPath | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_RESOURCE_GROUP_PREFLIGHT_FAILED' }
  $environment = az containerapp env show --name 'env-g6-h5-int' --resource-group $deploymentResourceGroup --output json 2>$preflightErrorPath | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $environment.location -ne 'brazilsouth' -or $group.location -ne $environment.location) { throw 'H5_ACA_ENVIRONMENT_LOCATION_MISMATCH' }
  if ([string]::IsNullOrWhiteSpace($environment.properties.defaultDomain)) { throw 'H5_ACA_ENVIRONMENT_DEFAULT_DOMAIN_MISSING' }
} finally { Remove-Item -LiteralPath $preflightErrorPath -Force -ErrorAction SilentlyContinue }

node --test $validatorTests *> $null
if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_VALIDATOR_TESTS_FAILED' }

$env:H5_AUTHORIZED_SOURCE_SHA = $AuthorizedSha
$env:H5_ENVIRONMENT_DEFAULT_DOMAIN = $environment.properties.defaultDomain
node $validatorPath $resolvedParameters
Remove-Item Env:H5_AUTHORIZED_SOURCE_SHA -ErrorAction SilentlyContinue
Remove-Item Env:H5_ENVIRONMENT_DEFAULT_DOMAIN -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_PARAMETER_VALIDATION_FAILED_BEFORE_WHAT_IF' }

az bicep build --file $templatePath --stdout *> $null
if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_BICEP_BUILD_FAILED' }

$whatIfPath = Join-Path $env:TEMP ('h5-aca-whatif-' + [guid]::NewGuid().ToString('N') + '.json')
$whatIfErrorPath = "$whatIfPath.stderr"
$whatIfError = $null
try {
  az deployment group what-if --no-pretty-print --name 'h5-aca-isolated-review' `
    --resource-group $deploymentResourceGroup `
    --template-file $templatePath `
    --parameters "@$resolvedParameters" "environmentLocation=$($environment.location)" `
    --output json 1> $whatIfPath 2> $whatIfErrorPath
  if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_AZURE_WHAT_IF_FAILED' }
  $resourceIds = @($serviceNames | ForEach-Object { "$($group.id)/providers/Microsoft.App/containerApps/$_" })
  $currentApps = az containerapp list --resource-group $deploymentResourceGroup --output json 2>$whatIfErrorPath | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_EXISTING_APPS_QUERY_FAILED' }
  foreach ($app in @($currentApps | Where-Object { $_.name -in $serviceNames })) {
    $expectedFqdn = "$($app.name).internal.$($environment.properties.defaultDomain)"
    if ($app.location -ne $environment.location -or $app.properties.configuration.ingress.external -ne $false -or
        $app.properties.configuration.ingress.allowInsecure -ne $false -or $app.properties.configuration.ingress.fqdn -cne $expectedFqdn) {
      throw 'H5_ACA_EXISTING_APP_PRIVATE_FQDN_OR_LOCATION_INVALID'
    }
  }
  $existing = @($currentApps | Where-Object { $_.name -in $serviceNames } | ForEach-Object { "$($group.id)/providers/Microsoft.App/containerApps/$($_.name)" })
  Assert-AcaWhatIfScope -Json (Get-Content -Raw -LiteralPath $whatIfPath) -ExpectedResourceIds $resourceIds -ExistingResourceIds $existing | Out-Null
} catch {
  $whatIfError = $_
} finally {
  try {
    Remove-Item -LiteralPath $whatIfPath -Force -ErrorAction Stop
    Remove-Item -LiteralPath $whatIfErrorPath -Force -ErrorAction SilentlyContinue
  } catch {
    if ($whatIfError) {
      [Console]::Error.WriteLine('H5_ACA_WHAT_IF_TEMP_CLEANUP_FAILED')
    } else {
      $whatIfError = $_
    }
  }
}

if ($whatIfError) { throw $whatIfError }
Write-Output 'H5_ACA_WHAT_IF_SCOPE_PASS: five approved services; full what-if output not emitted.'
