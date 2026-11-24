[CmdletBinding()]
param([string]$Image = 'postgres:17.6-alpine')

$ErrorActionPreference = 'Stop'
$name = 'g6-h5-pg17-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$setupPath = Join-Path ([IO.Path]::GetTempPath()) ($name + '-setup.sql')
$setup = @'
CREATE ROLE catalog_app; CREATE ROLE inventory_app; CREATE ROLE pricing_app; CREATE ROLE po_promotions_dev_runtime;
CREATE ROLE catalog_login LOGIN PASSWORD 'preflight-runtime';
CREATE ROLE inventory_login LOGIN PASSWORD 'preflight-runtime';
CREATE ROLE pricing_login LOGIN PASSWORD 'preflight-runtime';
CREATE ROLE promotions_login LOGIN PASSWORD 'preflight-runtime';
GRANT catalog_app TO catalog_login; GRANT inventory_app TO inventory_login;
GRANT pricing_app TO pricing_login; GRANT po_promotions_dev_runtime TO promotions_login;
CREATE SCHEMA catalog; CREATE SCHEMA inventory; CREATE SCHEMA pricing; CREATE SCHEMA promotions;
CREATE TABLE catalog.products(id uuid PRIMARY KEY,sku_base text,estado text);
CREATE TABLE catalog.product_attribute_values(id uuid); CREATE TABLE catalog.product_images(id uuid);
CREATE TABLE catalog.variants(id uuid,product_id uuid,sku text,estado text); CREATE TABLE catalog.variant_images(id uuid);
CREATE TABLE inventory.sku_lifecycle(sku_id uuid PRIMARY KEY,product_id text,sku_version integer,active boolean,changed_at timestamptz,updated_at timestamptz);
CREATE TABLE inventory.offline_sale_reconciliations(client_id text,offline_sale_id text,operation_id uuid UNIQUE,order_id text,request_fingerprint text,request_payload jsonb,result_payload jsonb,status text,completed_at timestamptz,PRIMARY KEY(client_id,offline_sale_id));
CREATE TABLE inventory.locations(id uuid,code text,active boolean);
CREATE TABLE inventory.stock_balance(location_id uuid,sku_id text,available numeric);
CREATE TABLE pricing.prices(id uuid,sku text,channel_id text);
CREATE TABLE pricing.price_validities(id uuid,price_id uuid,valid_from timestamptz,valid_until timestamptz,is_cancelled boolean,precio_regular numeric,price_version bigint);
CREATE TABLE pricing.scheduled_prices(id uuid,product_id text,correlation_id text);
CREATE TABLE pricing.bulk_price_jobs(id uuid); CREATE TABLE pricing.bulk_price_rows(id uuid); CREATE TABLE pricing.outbox(id uuid);
CREATE TABLE promotions.promotions(id uuid,state text,modality text,valid_from timestamptz,valid_until timestamptz,enabled_channels text[]);
CREATE TABLE promotions.coupons(id uuid,promotion_id uuid,state text,minimum_amount numeric,max_global_uses integer,max_customer_uses integer);
CREATE TABLE promotions.coupon_uses(id uuid,coupon_id uuid,customer_ref uuid,restored_at timestamptz);
CREATE TABLE promotions.promotion_scopes(id uuid,promotion_id uuid,sku text,product_id text);
GRANT CONNECT ON DATABASE postgres TO catalog_app,inventory_app,pricing_app,po_promotions_dev_runtime;
GRANT USAGE ON SCHEMA catalog TO catalog_app;
GRANT USAGE ON SCHEMA inventory TO inventory_app;
GRANT USAGE ON SCHEMA pricing TO pricing_app;
GRANT USAGE ON SCHEMA promotions TO po_promotions_dev_runtime;
GRANT SELECT ON catalog.products,catalog.product_attribute_values,catalog.product_images,catalog.variants,catalog.variant_images TO catalog_app;
GRANT SELECT,INSERT,UPDATE ON inventory.sku_lifecycle,inventory.offline_sale_reconciliations TO inventory_app;
GRANT SELECT ON pricing.prices,pricing.price_validities,pricing.scheduled_prices,pricing.bulk_price_jobs,pricing.bulk_price_rows,pricing.outbox TO pricing_app;
'@
function Invoke-Pg([string[]]$Arguments) {
  $output = & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL query failed; container output suppressed.' }
  return @($output)
}

$started = $false
try {
  Set-Content -LiteralPath $setupPath -Value $setup -Encoding utf8
  Invoke-Pg @('run','--detach','--rm','--name',$name,'-e','POSTGRES_PASSWORD=preflight-synthetic',$Image) | Out-Null
  $started = $true
  $ready = $false
  for ($i=0; $i -lt 60; $i++) { & docker exec $name pg_isready -U postgres *> $null; if ($LASTEXITCODE -eq 0) { $ready=$true; break }; Start-Sleep -Seconds 1 }
  if (-not $ready) { throw 'PostgreSQL 17 disposable container did not become ready.' }
  & docker cp $setupPath ($name + ':/tmp/setup.sql') *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy synthetic schema into disposable container.' }
  Invoke-Pg @('exec',$name,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-f','/tmp/setup.sql') | Out-Null

  $sqlRoot = $PSScriptRoot
  $files = @('integration-readonly.sql','catalog-http-readiness.sql','inventory-http-readiness.sql','pricing-http-readiness.sql','fixtures-catalog-readonly.sql','fixtures-inventory-readonly.sql','fixtures-pricing-readonly.sql','fixtures-promotions-readonly.sql')
  foreach ($file in $files) {
    & docker cp (Join-Path $sqlRoot $file) ($name + ':/tmp/' + $file) *> $null
    if ($LASTEXITCODE -ne 0) { throw "Could not copy disposable query $file." }
  }
  & docker cp (Join-Path $sqlRoot 'h5-storage-readonly.sql') ($name + ':/tmp/h5-storage-readonly.sql') *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy H5 storage verification SQL.' }
  foreach ($schema in @('catalog','inventory','pricing','promotions')) {
    $role = switch ($schema) { 'catalog' {'catalog_app'} 'inventory' {'inventory_app'} 'pricing' {'pricing_app'} 'promotions' {'po_promotions_dev_runtime'} }
    $login = switch ($schema) { 'catalog' {'catalog_login'} 'inventory' {'inventory_login'} 'pricing' {'pricing_login'} 'promotions' {'promotions_login'} }
    $service = switch ($schema) { 'catalog' {'catalog-svc'} 'inventory' {'inventory-svc'} 'pricing' {'pricing-svc'} 'promotions' {'promotions-svc'} }
    $output = Invoke-Pg @('exec','-e','PGPASSWORD=preflight-runtime',$name,'psql','-U',$login,'-d','postgres','-XAt','-q','-v','ON_ERROR_STOP=1','-v',"schema=$schema",'-v',"expected_role=$role",'-v',"service=$service",'-f','/tmp/integration-readonly.sql')
    $diagnostic = ($output -join '') | ConvertFrom-Json
    if (-not $diagnostic.database_connect -or -not $diagnostic.schema_usage -or -not $diagnostic.expected_role_inherited -or -not $diagnostic.required_table_privileges) { throw "Runtime login privileges are insufficient for $service." }
    Write-Output "PASS integration-readonly.sql ($schema runtime login; SQL/roles only, PostgreSQL TLS not configured)"
  }
  $missingUsage = Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-c','REVOKE USAGE ON SCHEMA catalog FROM catalog_app')
  $deniedUsage = Invoke-Pg @('exec','-e','PGPASSWORD=preflight-runtime',$name,'psql','-U','catalog_login','-d','postgres','-XAt','-q','-v','ON_ERROR_STOP=1','-v','schema=catalog','-v','expected_role=catalog_app','-v','service=catalog-svc','-f','/tmp/integration-readonly.sql')
  if ((($deniedUsage -join '') | ConvertFrom-Json).schema_usage) { throw 'Catalog runtime passed without schema USAGE.' }
  Write-Output 'PASS negative missing schema USAGE is detected for Catalog runtime login'
  Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-c','GRANT USAGE ON SCHEMA catalog TO catalog_app; REVOKE SELECT ON catalog.products FROM catalog_app') | Out-Null
  $deniedTable = Invoke-Pg @('exec','-e','PGPASSWORD=preflight-runtime',$name,'psql','-U','catalog_login','-d','postgres','-XAt','-q','-v','ON_ERROR_STOP=1','-v','schema=catalog','-v','expected_role=catalog_app','-v','service=catalog-svc','-f','/tmp/integration-readonly.sql')
  $deniedTableResult = ($deniedTable -join '') | ConvertFrom-Json
  if (-not $deniedTableResult.expected_role_inherited -or $deniedTableResult.required_table_privileges) { throw 'Group membership without effective table privileges was not detected.' }
  Write-Output 'PASS negative role membership without SELECT is detected'
  Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-c','GRANT SELECT ON catalog.products TO catalog_app') | Out-Null
  foreach ($file in @('catalog-http-readiness.sql','inventory-http-readiness.sql','pricing-http-readiness.sql')) {
    $schema = switch ($file) { 'catalog-http-readiness.sql' {'catalog'} 'inventory-http-readiness.sql' {'inventory'} 'pricing-http-readiness.sql' {'pricing'} }
    $login = switch ($schema) { 'catalog' {'catalog_login'} 'inventory' {'inventory_login'} 'pricing' {'pricing_login'} }
    $output = Invoke-Pg @('exec','-e','PGPASSWORD=preflight-runtime',$name,'psql','-U',$login,'-d','postgres','-XAt','-q','-v','ON_ERROR_STOP=1','-f',('/tmp/' + $file))
    if (($output -join '') -notmatch '"ready": true') { throw "HTTP-readiness check returned false: $file ($($output -join ''))" }
    Write-Output "PASS $file"
  }
  $h5Absent = Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-XAt','-c',"SELECT to_regclass('pricing.outbox_delivery') IS NULL")
  if (($h5Absent -join '').Trim() -ne 't') { throw 'Pricing optional H5 table unexpectedly exists in test schema.' }
  Write-Output 'PASS Pricing HTTP readiness with pricing.outbox_delivery absent'

  $h5SetupPath = Join-Path ([IO.Path]::GetTempPath()) ($name + '-h5-setup.sql')
  @'
CREATE TABLE catalog.outbox_delivery(message_id uuid, attempts int, available_at timestamptz, lease_token uuid, published_at timestamptz, last_error text);
CREATE TABLE inventory.outbox_delivery(message_id uuid, destination text);
CREATE TABLE pricing.outbox_delivery(message_id uuid, destination text);
CREATE TABLE promotions.h5_coupon_operations(operation_id uuid);
CREATE TABLE promotions.h5_coupon_outbox(message_id uuid);
GRANT SELECT,INSERT ON catalog.outbox_delivery TO catalog_app;
GRANT UPDATE(attempts,available_at,lease_token,published_at,last_error) ON catalog.outbox_delivery TO catalog_app;
GRANT SELECT,INSERT,UPDATE ON inventory.outbox_delivery TO inventory_app;
GRANT SELECT,INSERT,UPDATE ON pricing.outbox_delivery TO pricing_app;
GRANT SELECT,INSERT,UPDATE ON promotions.h5_coupon_operations,promotions.h5_coupon_outbox TO po_promotions_dev_runtime;
'@ | Set-Content -LiteralPath $h5SetupPath -Encoding utf8
  & docker cp $h5SetupPath ($name + ':/tmp/h5-setup.sql') *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy H5 synthetic setup.' }
  Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-f','/tmp/h5-setup.sql') | Out-Null
  Remove-Item -LiteralPath $h5SetupPath -Force -ErrorAction SilentlyContinue
  foreach ($schema in @('catalog','inventory','pricing','promotions')) {
    $runtimeRole = switch ($schema) { 'catalog' {'catalog_app'} 'inventory' {'inventory_app'} 'pricing' {'pricing_app'} 'promotions' {'po_promotions_dev_runtime'} }
    $login = switch ($schema) { 'catalog' {'catalog_login'} 'inventory' {'inventory_login'} 'pricing' {'pricing_login'} 'promotions' {'promotions_login'} }
    $service = switch ($schema) { 'catalog' {'catalog-svc'} 'inventory' {'inventory-svc'} 'pricing' {'pricing-svc'} 'promotions' {'promotions-svc'} }
    $h5Result = Invoke-Pg @('exec','-e','PGPASSWORD=preflight-runtime',$name,'psql','-U',$login,'-d','postgres','-XAt','-q','-v','ON_ERROR_STOP=1','-v',"service=$service",'-f','/tmp/h5-storage-readonly.sql')
    if (-not (($h5Result -join '') | ConvertFrom-Json).ready) { throw "H5 migration/grant check failed for $service." }
    Write-Output "PASS H5 candidate migration and effective grants ($service runtime login; SQL/roles only, PostgreSQL TLS not configured)"
  }
  Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-c','REVOKE UPDATE (attempts) ON catalog.outbox_delivery FROM catalog_app') | Out-Null
  $h5Denied = Invoke-Pg @('exec','-e','PGPASSWORD=preflight-runtime',$name,'psql','-U','catalog_login','-d','postgres','-XAt','-q','-v','ON_ERROR_STOP=1','-v','service=catalog-svc','-f','/tmp/h5-storage-readonly.sql')
  if ((($h5Denied -join '') | ConvertFrom-Json).ready) { throw 'Catalog H5 table passed after a required column UPDATE grant was revoked.' }
  Write-Output 'PASS negative H5 UPDATE grant absence is detected'

  foreach ($file in @('fixtures-catalog-readonly.sql','fixtures-inventory-readonly.sql','fixtures-pricing-readonly.sql','fixtures-promotions-readonly.sql')) {
    Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-XAt','-v','ON_ERROR_STOP=1','-v','sku=SKU-TEST-001','-v','location_code=LOC-TEST-001','-v','product_id=00000000-0000-0000-0000-000000000001','-v','order_amount=100.00','-v','customer_ref=00000000-0000-0000-0000-000000000002','-f',('/tmp/' + $file)) | Out-Null
    Write-Output "PASS $file (synthetic schema, no fixture data)"
  }
} finally {
  if ($started) { & docker stop $name *> $null }
  Remove-Item -LiteralPath $setupPath -Force -ErrorAction SilentlyContinue
  if ($h5SetupPath) { Remove-Item -LiteralPath $h5SetupPath -Force -ErrorAction SilentlyContinue }
}
