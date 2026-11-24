param(
  [Parameter(Mandatory)][string]$Container,
  [Parameter(Mandatory)][string]$ContainerId
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../../')).Path
$candidate = Join-Path $repoRoot 'ops/azure/h5-runtime-preflight/inventory-sku-lifecycle-backfill.candidate.sql'
$catalogDdl = Join-Path $repoRoot 'apps/catalog-svc/test/fixtures/0001_create_catalog.sql'
$inventoryDdl = Join-Path $repoRoot 'apps/catalog-svc/test/fixtures/inventory-initial.sql'
$inventoryLifecycleMigration = Join-Path $repoRoot 'apps/inventory-svc/migrations/20261104_0001_lifecycle_offline_reconciliation.sql'
$runtimeGrantProposal = Join-Path $repoRoot 'ops/azure/h5-runtime-preflight/inventory-runtime-grants.proposal.sql'
$syntheticData = Join-Path $PSScriptRoot 'local-inventory-lifecycle-fixtures.sql'

function Assert-Command {
  param([string]$Name)
  if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)" }
}

function Invoke-ContainerSql {
  param([string]$Sql, [string]$User = 'postgres', [switch]$AllowFailure)
  $output = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U $User -d h5_fixtures -c $Sql 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "SQL failed as $User (exit $exitCode): $($output -join [Environment]::NewLine)"
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join [Environment]::NewLine) }
}

function Invoke-ContainerFile {
  param([string]$Path, [string]$Name, [string]$User = 'postgres', [string[]]$PsqlArgs = @())
  & docker cp $Path "${Container}:/tmp/${Name}"
  Assert-Command "docker cp $Name"
  $output = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U $User -d h5_fixtures @PsqlArgs -f "/tmp/$Name" 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "SQL file $Name failed as $User (exit $LASTEXITCODE): $($output -join [Environment]::NewLine)"
  }
  return ($output -join [Environment]::NewLine)
}

if ((& docker inspect -f '{{index .Config.Labels "g6.h5.inventory-lifecycle"}}' $Container) -ne $ContainerId) {
  throw 'Refusing to modify a container without the matching disposable ownership label'
}
if ((& docker inspect -f '{{.State.Running}}' $Container) -ne 'true') {
  throw "Disposable local PostgreSQL container $Container is not running"
}

# Reset only the explicitly named disposable test database in our local container.
& docker exec $Container dropdb -U postgres --if-exists h5_fixtures
Assert-Command 'dropdb local disposable database'
& docker exec $Container createdb -U postgres h5_fixtures
Assert-Command 'createdb local disposable database'

$bootstrap = @'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'po_catalog_owner') THEN CREATE ROLE po_catalog_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'catalog_app') THEN CREATE ROLE catalog_app LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'po_inventory_runtime') THEN CREATE ROLE po_inventory_runtime NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inventory_app') THEN CREATE ROLE inventory_app LOGIN INHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inventory_backfill_test') THEN CREATE ROLE inventory_backfill_test LOGIN; END IF;
END $$;
GRANT po_inventory_runtime TO inventory_app;
CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;
'@
$bootstrapResult = Invoke-ContainerSql $bootstrap

& docker cp $catalogDdl "${Container}:/tmp/catalog-create.sql"
Assert-Command 'copy Catalog DDL fixture'
& docker cp $inventoryDdl "${Container}:/tmp/inventory-create.sql"
Assert-Command 'copy Inventory DDL fixture'
& docker cp $inventoryLifecycleMigration "${Container}:/tmp/inventory-lifecycle.sql"
Assert-Command 'copy Inventory lifecycle migration'
& docker cp $runtimeGrantProposal "${Container}:/tmp/inventory-runtime-grants.sql"
Assert-Command 'copy existing Inventory grant proposal'
& docker cp $syntheticData "${Container}:/tmp/synthetic-data.sql"
Assert-Command 'copy synthetic fixture rows'

$setupSql = @'
SET ROLE po_catalog_owner;
\i /tmp/catalog-create.sql
RESET ROLE;
\i /tmp/inventory-create.sql
\i /tmp/inventory-lifecycle.sql
\i /tmp/inventory-runtime-grants.sql
GRANT USAGE ON SCHEMA catalog TO inventory_backfill_test;
GRANT SELECT ON catalog.sku_identity, catalog.products, catalog.variants TO inventory_backfill_test;
GRANT USAGE ON SCHEMA inventory TO inventory_backfill_test;
GRANT SELECT ON inventory.stock_balance TO inventory_backfill_test;
GRANT SELECT, INSERT, UPDATE ON inventory.sku_lifecycle TO inventory_backfill_test;
GRANT USAGE ON SCHEMA inventory TO inventory_app;
GRANT SELECT ON catalog.sku_identity TO inventory_backfill_test;
\i /tmp/synthetic-data.sql
'@
$setupSql = $setupSql.Replace('\\i /tmp/catalog-create.sql', "\\i /tmp/catalog-create.sql`nRESET ROLE;")
$setupFile = Join-Path $env:TEMP 'g6-h5-fixtures-setup.sql'
[System.IO.File]::WriteAllText($setupFile, $setupSql, [System.Text.UTF8Encoding]::new($false))
& docker cp $setupFile "${Container}:/tmp/setup.sql"
Assert-Command 'copy setup script'
$setupOutput = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d h5_fixtures -f /tmp/setup.sql 2>&1
if ($LASTEXITCODE -ne 0) { throw "Local schema setup failed: $($setupOutput -join [Environment]::NewLine)" }

# Catalog and Inventory source DDL and the service lifecycle migration are local only.
$version = Invoke-ContainerSql "SELECT current_setting('server_version_num')::int >= 170000 AND current_setting('server_version_num')::int < 180000"
if ($version.Output -ne 't') { throw 'Disposable PostgreSQL must be version 17' }

# Missing explicit opt-in must fail before any persistent write.
$beforeRows = (Invoke-ContainerSql 'SELECT count(*) FROM inventory.sku_lifecycle').Output
$protectedEffectsBefore = Invoke-ContainerSql @'
SELECT jsonb_build_object(
  'stock', (SELECT count(*) FROM inventory.stock_balance),
  'reservations', (SELECT count(*) FROM inventory.reservations),
  'operations', (SELECT count(*) FROM inventory.inventory_operations),
  'kardex', (SELECT count(*) FROM inventory.kardex),
  'outbox', (SELECT count(*) FROM inventory.outbox)
)::text
'@
$candidateText = Get-Content -Raw $candidate
$candidateFile = Join-Path $env:TEMP 'g6-h5-lifecycle-candidate.sql'
[System.IO.File]::WriteAllText($candidateFile, $candidateText, [System.Text.UTF8Encoding]::new($false))
& docker cp $candidateFile "${Container}:/tmp/lifecycle-backfill.sql"
Assert-Command 'copy lifecycle candidate'
$missingGateOutput = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U inventory_backfill_test -d h5_fixtures -f /tmp/lifecycle-backfill.sql 2>&1
if ($LASTEXITCODE -eq 0 -or ($missingGateOutput -join ' ') -notmatch 'Explicit isolated backfill opt-in') {
  throw 'Lifecycle candidate did not fail closed without the explicit opt-in'
}
if ((Invoke-ContainerSql 'SELECT count(*) FROM inventory.sku_lifecycle').Output -ne $beforeRows) {
  throw 'Lifecycle candidate changed rows without opt-in'
}

$run = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U inventory_backfill_test -d h5_fixtures -c "SET g6.inventory_sku_lifecycle_backfill = 'apply'" -f /tmp/lifecycle-backfill.sql 2>&1
if ($LASTEXITCODE -ne 0) { throw "Lifecycle backfill failed: $($run -join [Environment]::NewLine)" }
$firstSummary = ($run | Where-Object { $_ -match '^APPLIED\|' } | Select-Object -Last 1).Trim()
if ($firstSummary -ne 'APPLIED|3|3|0|0|0') { throw "Unexpected first backfill summary: $firstSummary" }
if ((Invoke-ContainerSql @'
SELECT jsonb_build_object(
  'stock', (SELECT count(*) FROM inventory.stock_balance),
  'reservations', (SELECT count(*) FROM inventory.reservations),
  'operations', (SELECT count(*) FROM inventory.inventory_operations),
  'kardex', (SELECT count(*) FROM inventory.kardex),
  'outbox', (SELECT count(*) FROM inventory.outbox)
)::text
'@).Output -ne $protectedEffectsBefore.Output) {
  throw 'Backfill changed stock, reservations, operations, kardex, or outbox'
}

$actual = Invoke-ContainerSql "SELECT string_agg(sku_id || ':' || sku_version || ':' || active::text, ',' ORDER BY sku_id) FROM inventory.sku_lifecycle"
if ($actual.Output -ne 'G5F-BASE-002:7:false,G5F-SIMPLE-001:5:true,G5F-VARIANT-002-A:4:true') {
  throw "Base/variant lifecycle mapping mismatch: $($actual.Output)"
}
if ((Invoke-ContainerSql "SELECT changed_at FROM inventory.sku_lifecycle WHERE sku_id='G5F-SIMPLE-001'").Output -ne '2026-11-20 12:00:00.123+00') {
  throw 'Lifecycle timestamp precision does not match Catalog transitionTimestamp()'
}
if ((Invoke-ContainerSql "SELECT count(*) FROM inventory.sku_lifecycle WHERE sku_id = 'G5F-DRAFT-003'").Output -ne '0') {
  throw 'Unversioned unsellable draft must remain outside lifecycle initialization'
}

# Replay is idempotent. Newer existing lifecycle versions are preserved.
$replay = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U inventory_backfill_test -d h5_fixtures -c "SET g6.inventory_sku_lifecycle_backfill = 'apply'" -f /tmp/lifecycle-backfill.sql 2>&1
if ($LASTEXITCODE -ne 0) { throw "Idempotent replay failed: $($replay -join [Environment]::NewLine)" }
$replaySummary = ($replay | Where-Object { $_ -match '^APPLIED\|' } | Select-Object -Last 1).Trim()
if ($replaySummary -ne 'APPLIED|3|0|0|3|0') { throw "Unexpected replay summary: $replaySummary" }

Invoke-ContainerSql "UPDATE inventory.sku_lifecycle SET sku_version = 100 WHERE sku_id = 'G5F-SIMPLE-001'" | Out-Null
$newer = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U inventory_backfill_test -d h5_fixtures -c "SET g6.inventory_sku_lifecycle_backfill = 'apply'" -f /tmp/lifecycle-backfill.sql 2>&1
if ($LASTEXITCODE -ne 0) { throw "Newer-version preservation run failed: $($newer -join [Environment]::NewLine)" }
$newerVersion = Invoke-ContainerSql "SELECT sku_version FROM inventory.sku_lifecycle WHERE sku_id = 'G5F-SIMPLE-001'"
if ($newerVersion.Output -ne '100') { throw 'Backfill overwrote a newer lifecycle version' }

# Equal-version state disagreement and a Catalog value outside the target
# integer range both reject the run without partial writes.
Invoke-ContainerSql "UPDATE inventory.sku_lifecycle SET active = false WHERE sku_id = 'G5F-VARIANT-002-A'" | Out-Null
$countBeforeConflict = (Invoke-ContainerSql 'SELECT count(*) FROM inventory.sku_lifecycle').Output
$conflict = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U inventory_backfill_test -d h5_fixtures -c "SET g6.inventory_sku_lifecycle_backfill = 'apply'" -f /tmp/lifecycle-backfill.sql 2>&1
if ($LASTEXITCODE -ne 0 -or ($conflict -join ' ') -notmatch 'same_version_lifecycle_state_mismatch') {
  throw 'Equal-version state conflict was not rejected'
}
if ((Invoke-ContainerSql 'SELECT count(*) FROM inventory.sku_lifecycle').Output -ne $countBeforeConflict) {
  throw 'Equal-version conflict partially wrote lifecycle rows'
}
Invoke-ContainerSql "UPDATE inventory.sku_lifecycle SET active = true WHERE sku_id = 'G5F-VARIANT-002-A'" | Out-Null

Invoke-ContainerSql @'
INSERT INTO catalog.products
  (id, nombre, descripcion, categoria_id, tipo_producto_id, marca_id,
   sku_base, slug, tiene_variantes, estado, catalog_version)
VALUES
  ('10000000-0000-4000-8000-000000000004', 'Fixture bad version', 'Synthetic invalid version',
   'QA-CAT', 'QA-TYPE', 'QA-BRAND', 'G5F-BAD-VERSION', 'g5f-bad-version', false,
   'BORRADOR', 2147483648)
'@ | Out-Null
$overflow = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U inventory_backfill_test -d h5_fixtures -c "SET g6.inventory_sku_lifecycle_backfill = 'apply'" -f /tmp/lifecycle-backfill.sql 2>&1
if ($LASTEXITCODE -ne 0 -or ($overflow -join ' ') -notmatch 'catalog_version_exceeds_inventory_integer') {
  throw 'Out-of-range Catalog version was not rejected'
}
$overflowSummary = ($overflow | Where-Object { $_ -match '^REJECTED_NO_WRITES\|' } | Select-Object -Last 1).Trim()
if (-not $overflowSummary -or $overflowSummary.Split('|')[-1] -ne '1') {
  throw "Out-of-range Catalog version did not produce the expected rejection summary: $overflowSummary"
}

# A stock SKU without Catalog identity is rejected and the whole run writes nothing.
Invoke-ContainerSql "INSERT INTO inventory.stock_balance (sku_id, location_id, on_hand) VALUES ('G5F-ORPHAN-STOCK', '60000000-0000-4000-8000-000000000001', 1)" | Out-Null
$countBeforeReject = (Invoke-ContainerSql 'SELECT count(*) FROM inventory.sku_lifecycle').Output
$reject = & docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U inventory_backfill_test -d h5_fixtures -c "SET g6.inventory_sku_lifecycle_backfill = 'apply'" -f /tmp/lifecycle-backfill.sql 2>&1
if ($LASTEXITCODE -ne 0) { throw "Fail-closed rejection scenario errored unexpectedly: $($reject -join [Environment]::NewLine)" }
$rejectSummary = ($reject | Where-Object { $_ -match '^REJECTED_NO_WRITES\|' } | Select-Object -Last 1).Trim()
if (-not $rejectSummary -or $rejectSummary.Split('|')[-1] -ne '2' -or
    ($reject -join ' ') -notmatch 'identity_owner_or_catalog_target_missing|stock_identity_missing_or_not_versioned' -or
    ($reject -join ' ') -notmatch 'catalog_version_exceeds_inventory_integer') {
  throw "Expected both the orphan and out-of-range identities in rejection summary: $rejectSummary"
}
if ((Invoke-ContainerSql 'SELECT count(*) FROM inventory.sku_lifecycle').Output -ne $countBeforeReject) {
  throw 'Rejected run partially wrote lifecycle rows'
}

# Verify source tables and generated stock balances remain unchanged by candidate runs.
$stockCheck = Invoke-ContainerSql "SELECT string_agg(sku_id || ':' || on_hand || ':' || reserved || ':' || blocked || ':' || available, ',' ORDER BY sku_id) FROM inventory.stock_balance"
if ($stockCheck.Output -ne 'G5F-ORPHAN-STOCK:1:0:0:1,G5F-SIMPLE-001:8:2:1:5,G5F-VARIANT-002-A:5:1:0:4') {
  throw "Stock invariant changed: $($stockCheck.Output)"
}

# Exercise existing grant proposal via the actual non-superuser login.
$runtimeRead = Invoke-ContainerSql "SELECT count(*) FROM inventory.sku_lifecycle" -User 'inventory_app'
if ($runtimeRead.ExitCode -ne 0) { throw 'Inventory runtime login cannot read sku_lifecycle' }
$runtimeDml = Invoke-ContainerSql @'
BEGIN;
INSERT INTO inventory.sku_lifecycle
  (sku_id, product_id, sku_version, active, changed_at)
VALUES ('RUNTIME-TEST-SKU', '80000000-0000-4000-8000-000000000001', 1, true, now());
UPDATE inventory.sku_lifecycle SET updated_at=now() WHERE sku_id='RUNTIME-TEST-SKU';
INSERT INTO inventory.offline_sale_reconciliations
  (client_id, offline_sale_id, operation_id, order_id, request_fingerprint,
   request_payload, result_payload, status, completed_at)
VALUES ('fixture-client', 'fixture-sale-1', '70000000-0000-4000-8000-000000000001',
        'fixture-order-1', repeat('a', 64), '{}', '{}', 'COMPLETED', now());
UPDATE inventory.offline_sale_reconciliations
   SET result_payload = '{"updated":true}'::jsonb
 WHERE client_id = 'fixture-client' AND offline_sale_id = 'fixture-sale-1';
SELECT count(*) FROM inventory.offline_sale_reconciliations
 WHERE client_id = 'fixture-client' AND offline_sale_id = 'fixture-sale-1';
ROLLBACK;
'@ -User 'inventory_app'
if ($runtimeDml.ExitCode -ne 0 -or $runtimeDml.Output -notmatch '1') {
  throw "Inventory runtime login could not use the existing grant proposal: $($runtimeDml.Output)"
}
$runtimeDelete = Invoke-ContainerSql "DELETE FROM inventory.sku_lifecycle" -User 'inventory_app' -AllowFailure
if ($runtimeDelete.ExitCode -eq 0) { throw 'Inventory runtime login unexpectedly has DELETE on sku_lifecycle' }
$runtimeDdl = Invoke-ContainerSql 'CREATE TABLE inventory.runtime_must_not_ddl(id integer)' -User 'inventory_app' -AllowFailure
if ($runtimeDdl.ExitCode -eq 0) { throw 'Inventory runtime login unexpectedly has DDL privilege' }
$runtimeCrossSchema = Invoke-ContainerSql 'SELECT count(*) FROM catalog.products' -User 'inventory_app' -AllowFailure
if ($runtimeCrossSchema.ExitCode -eq 0) { throw 'Inventory runtime login unexpectedly has access to Catalog schema' }

Write-Output 'PASS PostgreSQL 17 local lifecycle backfill: explicit gate, SKU base/variant identity, state/version mapping, idempotency, newer-version preservation, reject-without-writes, stock invariants, and runtime grants.'
