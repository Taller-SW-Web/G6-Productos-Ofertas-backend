param(
  [Parameter(Mandatory)]
  [string] $ParametersFile
)

$ErrorActionPreference = 'Stop'
$templatePath = Join-Path $PSScriptRoot 'h5-isolated-five-apps.bicep'
$validatorPath = Join-Path $PSScriptRoot 'validate-h5-five-apps.mjs'
$validatorTests = Join-Path $PSScriptRoot 'validate-h5-five-apps.test.mjs'
$serviceNames = @('api-gateway', 'catalog-svc', 'inventory-svc', 'pricing-svc', 'promotions-svc')
$resolvedParameters = (Resolve-Path -LiteralPath $ParametersFile).Path

node --test $validatorTests *> $null
if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_VALIDATOR_TESTS_FAILED' }

node $validatorPath $resolvedParameters
if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_PARAMETER_VALIDATION_FAILED_BEFORE_WHAT_IF' }

az bicep build --file $templatePath --stdout *> $null
if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_BICEP_BUILD_FAILED' }

$deploymentResourceGroup = 'rg-g6-sb-h5-int-fork'
$whatIfPath = Join-Path $env:TEMP ('h5-aca-whatif-' + [guid]::NewGuid().ToString('N') + '.txt')
$whatIfError = $null
try {
  az deployment group what-if --name 'h5-aca-isolated-review' `
    --resource-group $deploymentResourceGroup `
    --template-file $templatePath `
    --parameters "@$resolvedParameters" `
    --output jsonc *> $whatIfPath
  if ($LASTEXITCODE -ne 0) { throw 'H5_ACA_AZURE_WHAT_IF_FAILED' }

  $resourceLines = @(Select-String -LiteralPath $whatIfPath -Pattern '^\s{2}[+~*]\s+Microsoft\.[^\s]+')
  $unexpectedChanges = @($resourceLines | Where-Object {
    $_.Line -match '^\s{2}[+~]\s+' -and
    $_.Line -notmatch '^\s{2}[+~]\s+Microsoft\.App/containerApps/(api-gateway|catalog-svc|inventory-svc|pricing-svc|promotions-svc)(\s|$)'
  })
  $observedApps = @($resourceLines | ForEach-Object {
    if ($_.Line -match '^\s{2}[+~*]\s+Microsoft\.App/containerApps/([^\s]+)') { $Matches[1] }
  } | Sort-Object -Unique)
  if ($unexpectedChanges.Count -gt 0 -or $observedApps.Count -ne 5 -or
      @($serviceNames | Where-Object { $_ -notin $observedApps }).Count -gt 0) {
    throw 'H5_ACA_WHAT_IF_SCOPE_OR_SERVICE_SET_INVALID'
  }
} catch {
  $whatIfError = $_
} finally {
  try {
    Remove-Item -LiteralPath $whatIfPath -Force -ErrorAction Stop
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
