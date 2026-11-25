$ErrorActionPreference = 'Stop'
$id = [guid]::NewGuid().ToString('N').Substring(0,12)
$name = "g6-catalog-h5-delta-$id"
$label = 'g6.catalog.h5-delta'
$created = $false
try {
  & docker run --detach --rm --name $name --label "$label=$id" --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=h5_fixtures postgres:17.11 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostgreSQL 17.11' }
  $created = $true
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    & docker exec $name pg_isready -U postgres -d h5_fixtures *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Disposable PostgreSQL failed readiness' }
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'test-local-catalog-h5-async-delta.ps1') -Container $name
  if ($LASTEXITCODE -ne 0) { throw 'Catalog delta local test failed' }
}
finally {
  if ($created) {
    $actual = & docker inspect --format "{{index .Config.Labels `"$label`"}}" $name 2>$null
    if ($LASTEXITCODE -eq 0 -and $actual -eq $id) {
      & docker rm --force $name *> $null
      if ($LASTEXITCODE -ne 0) { throw 'Could not clean owned container' }
      $left = & docker ps --all --filter "label=$label=$id" --format '{{.Names}}'
      if ($left) { throw 'Catalog disposable cleanup not confirmed' }
      Write-Output 'DISPOSABLE_POSTGRES_CLEANUP_CONFIRMED'
    }
  }
}
