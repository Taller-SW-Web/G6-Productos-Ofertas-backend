$ErrorActionPreference = 'Stop'
$id = [guid]::NewGuid().ToString('N').Substring(0, 12)
$container = "g6-h5-inventory-lifecycle-$id"
$labelKey = 'g6.h5.inventory-lifecycle'
$testPath = Join-Path $PSScriptRoot 'test-local-inventory-lifecycle.ps1'
$created = $false

function Assert-Docker {
  param([string]$Operation)
  if ($LASTEXITCODE -ne 0) { throw "$Operation failed (exit $LASTEXITCODE)" }
}

try {
  & docker run --detach --rm --name $container --label "$labelKey=$id" `
    --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=h5_fixtures `
    postgres:17.11
  Assert-Docker 'Start disposable PostgreSQL 17.11 container'
  $created = $true

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker exec $container pg_isready -U postgres -d h5_fixtures *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Disposable PostgreSQL did not become ready' }

  & pwsh -NoProfile -File $testPath -Container $container -ContainerId $id
  $testExit = $LASTEXITCODE
  if ($testExit -ne 0) { throw "Lifecycle test failed (exit $testExit)" }
}
finally {
  if ($created) {
    $actualLabel = & docker inspect --format "{{index .Config.Labels `"$labelKey`"}}" $container 2>$null
    if ($LASTEXITCODE -eq 0 -and $actualLabel -eq $id) {
      & docker rm --force $container *> $null
      if ($LASTEXITCODE -ne 0) { throw 'Failed to remove the owned disposable PostgreSQL container' }
      $remaining = & docker ps --all --filter "label=$labelKey=$id" --format '{{.Names}}'
      if ($LASTEXITCODE -ne 0 -or $remaining) { throw 'Disposable container cleanup was not confirmed' }
      Write-Output 'DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED'
    }
    elseif ($LASTEXITCODE -eq 0) {
      throw 'Container ownership label mismatch; left the container untouched'
    }
  }
}
