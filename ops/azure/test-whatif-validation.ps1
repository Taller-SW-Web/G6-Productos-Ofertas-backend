$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'azure-whatif-validation.psm1') -Force
$ids = @('gateway','catalog','inventory','pricing','promotions' | ForEach-Object { "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/$_" })
function json($entries) { @{ status='Succeeded'; properties=@{ changes=@($entries) } } | ConvertTo-Json -Depth 8 -Compress }
function change($id,$type) { @{ resourceId=$id; changeType=$type } }
function mustReject($action,$code) { $rejected=$false; try { & $action | Out-Null } catch { if ($_.Exception.Message -like "*$code*") { $rejected=$true } else { throw } }; if (-not $rejected) { throw "TEST_EXPECTED_REJECTION_$code" } }
$created = json (@($ids | ForEach-Object { change $_ 'Create' }))
if (-not (Assert-AcaWhatIfScope -Json $created -ExpectedResourceIds $ids -ExistingResourceIds @())) { throw 'TEST_ACA_CREATE_FAILED' }
$existing = json (@($ids | ForEach-Object { change $_ 'NoChange' }))
if (-not (Assert-AcaWhatIfScope -Json $existing -ExpectedResourceIds $ids -ExistingResourceIds $ids)) { throw 'TEST_ACA_NOCHANGE_FAILED' }
$ignored = json (@($ids | ForEach-Object { change $_ 'Ignore' }))
if (-not (Assert-AcaWhatIfScope -Json $ignored -ExpectedResourceIds $ids -ExistingResourceIds $ids)) { throw 'TEST_ACA_IGNORE_FAILED' }
mustReject { Assert-AcaWhatIfScope -Json (json (@((change $ids[0] 'Modify')) + @($ids | Select-Object -Skip 1 | ForEach-Object { change $_ 'NoChange' }))) -ExpectedResourceIds $ids -ExistingResourceIds $ids } 'EXISTING_APP_CHANGE_UNEXPECTED'
foreach ($type in @('Delete','Deploy','Unsupported')) {
  $bad = json (@((change $ids[0] $type)) + @($ids | Select-Object -Skip 1 | ForEach-Object { change $_ 'Create' }))
  mustReject { Assert-AcaWhatIfScope -Json $bad -ExpectedResourceIds $ids -ExistingResourceIds @() } 'UNCERTIFIABLE'
}
$modify = json (@((change $ids[0] 'Modify')) + @($ids | Select-Object -Skip 1 | ForEach-Object { change $_ 'Create' }))
mustReject { Assert-AcaWhatIfScope -Json $modify -ExpectedResourceIds $ids -ExistingResourceIds @() } 'INITIAL_CREATE_SET_INVALID'
$outside = json (@((change '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/env' 'Modify')) + @($ids | ForEach-Object { change $_ 'Create' }))
mustReject { Assert-AcaWhatIfScope -Json $outside -ExpectedResourceIds $ids -ExistingResourceIds @() } 'RESOURCE_OUT_OF_SCOPE'
mustReject { Assert-AcaWhatIfScope -Json '{broken' -ExpectedResourceIds $ids -ExistingResourceIds @() } 'INVALID_JSON'
mustReject { Assert-AcaWhatIfScope -Json '{"status":"Succeeded","properties":{}}' -ExpectedResourceIds $ids -ExistingResourceIds @() } 'INCOMPLETE_RESULT'
$n01 = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ContainerInstance/containerGroups/h5-n01-test-12345678'
if (-not (Assert-N01WhatIfScope -Json (json @((change $n01 'Create'),(change '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/env' 'Ignore'))) -ExpectedResourceId $n01 -ContainerGroupName 'h5-n01-test-12345678')) { throw 'TEST_N01_CREATE_FAILED' }
mustReject { Assert-N01WhatIfScope -Json (json @((change $n01 'Modify'))) -ExpectedResourceId $n01 -ContainerGroupName 'h5-n01-test-12345678' } 'UNEXPECTED_RESOURCE_CHANGE'
mustReject { Assert-N01WhatIfScope -Json (json @((change '/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/unapproved' 'Create'))) -ExpectedResourceId $n01 -ContainerGroupName 'h5-n01-test-12345678' } 'UNEXPECTED_RESOURCE_CHANGE'
Write-Output 'AZURE_WHATIF_JSON_VALIDATION_TESTS_PASS'
