param([Parameter(Mandatory)][string]$Container)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../../../')).Path
$catalogDdl=Join-Path $root 'apps/catalog-svc/test/fixtures/0001_create_catalog.sql'
$delta=(Resolve-Path (Join-Path $PSScriptRoot '../catalog-h5-async-delta.candidate.sql')).Path
function Sql([string]$sql,[switch]$AllowFailure){
  $out=& docker exec $Container psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d h5_fixtures -c $sql 2>&1
  $code=$LASTEXITCODE
  if($code -ne 0 -and -not $AllowFailure){throw ($out -join [Environment]::NewLine)}
  return [pscustomobject]@{Code=$code;Output=($out -join [Environment]::NewLine)}
}
function Assert($actual,$expected,[string]$name){if($actual -ne $expected){throw "$name expected $expected got $actual"}}
Sql @"
CREATE ROLE po_catalog_owner NOLOGIN;
CREATE ROLE catalog_app NOLOGIN;
CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner;
"@ | Out-Null
& docker cp $catalogDdl "${Container}:/tmp/catalog-fixture.sql"
if($LASTEXITCODE -ne 0){throw 'copy catalog fixture failed'}
& docker exec $Container psql -X -q -v ON_ERROR_STOP=1 -U postgres -d h5_fixtures -c 'SET ROLE po_catalog_owner' -f /tmp/catalog-fixture.sql *> $null
if($LASTEXITCODE -ne 0){throw 'canonical Catalog test DDL failed'}
Sql @"
SET ROLE po_catalog_owner;
CREATE TABLE catalog.outbox_delivery (
 message_id uuid NOT NULL REFERENCES catalog.outbox(message_id),
 destination text NOT NULL CHECK(destination IN ('g6.pricing.from.catalog','g6.inventory.from.catalog','g6.promotions.from.catalog','g6.combos.from.catalog','g6.taxonomy.from.catalog','g6.bulk.from.catalog')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), created_at timestamptz NOT NULL DEFAULT now(),
 available_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, published_at timestamptz, last_error text,
 PRIMARY KEY(message_id,destination), CHECK(published_at IS NULL OR lease_token IS NULL));
CREATE INDEX ix_outbox_delivery_pending ON catalog.outbox_delivery(available_at,created_at,message_id,destination) WHERE published_at IS NULL;
INSERT INTO catalog.outbox(message_id,event_name,kind,schema_version,correlation_id,occurred_at,payload)
SELECT gen_random_uuid(),'catalog.sku.deactivated','event',1,gen_random_uuid(),now(),jsonb_build_object('sku','LEGACY-'||g)
FROM generate_series(1,4) g;
"@ | Out-Null
& docker cp $delta "${Container}:/tmp/catalog-delta.sql"
if($LASTEXITCODE -ne 0){throw 'copy Catalog delta failed'}
& docker exec $Container psql -X -q -v ON_ERROR_STOP=1 -U postgres -d h5_fixtures -c 'SET ROLE po_catalog_owner' -f /tmp/catalog-delta.sql *> $null
if($LASTEXITCODE -ne 0){throw 'Catalog async delta candidate failed locally'}
Assert (Sql 'SELECT count(*) FROM catalog.outbox_delivery').Output '0' 'no historical delivery replay'
Assert (Sql "SELECT count(*) FROM catalog.outbox WHERE delivery_transport='RABBITMQ'").Output '4' 'legacy transport default'
$future = "SET ROLE catalog_app; SELECT set_config('catalog.messaging_provider','AZURE_SERVICE_BUS',true); SELECT set_config('catalog.messaging_destinations','g6.inventory.from.catalog',true); INSERT INTO catalog.outbox(message_id,event_name,kind,schema_version,correlation_id,occurred_at,payload) VALUES('90000000-0000-4000-8000-000000000001','catalog.sku.deactivated','event',1,'90000000-0000-4000-8000-000000000002',now(),jsonb_build_object('sku','FUTURE'))"
Sql $future | Out-Null
Assert (Sql 'SELECT count(*) FROM catalog.outbox_delivery').Output '1' 'only new H5 event routed'
Assert (Sql "SELECT delivery_transport FROM catalog.outbox WHERE message_id='90000000-0000-4000-8000-000000000001'").Output 'AZURE_SERVICE_BUS' 'future transport marker'
Assert (Sql "SELECT count(*) FROM catalog.outbox_delivery d JOIN catalog.outbox o USING(message_id) WHERE o.payload->>'sku' LIKE 'LEGACY-%'").Output '0' 'legacy rows remain unrouted'
Write-Output 'PASS Catalog Phase 6 delta: existing table reused, canonical future-only triggers, no historical outbox replay.'
