[CmdletBinding()]
param([string]$Image = 'postgres:17.6-alpine')

$ErrorActionPreference = 'Stop'
$name = 'g6-h5-pg17-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$setupPath = Join-Path ([IO.Path]::GetTempPath()) ($name + '-setup.sql')
$setup = @'
CREATE ROLE catalog_app; CREATE ROLE inventory_app; CREATE ROLE pricing_app; CREATE ROLE po_promotions_dev_runtime;
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
  foreach ($schema in @('catalog','inventory','pricing','promotions')) {
    $role = switch ($schema) { 'catalog' {'catalog_app'} 'inventory' {'inventory_app'} 'pricing' {'pricing_app'} 'promotions' {'po_promotions_dev_runtime'} }
    Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-XAt','-v','ON_ERROR_STOP=1','-v',"schema=$schema",'-v',"expected_role=$role",'-f','/tmp/integration-readonly.sql') | Out-Null
    Write-Output "PASS integration-readonly.sql ($schema)"
  }
  foreach ($file in @('catalog-http-readiness.sql','inventory-http-readiness.sql','pricing-http-readiness.sql')) {
    $output = Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-XAt','-v','ON_ERROR_STOP=1','-f',('/tmp/' + $file))
    if (($output -join '') -notmatch '"ready": true') { throw "HTTP-readiness check returned false: $file" }
    Write-Output "PASS $file"
  }
  $h5Absent = Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-XAt','-c',"SELECT to_regclass('pricing.outbox_delivery') IS NULL")
  if (($h5Absent -join '').Trim() -ne 't') { throw 'Pricing optional H5 table unexpectedly exists in test schema.' }
  Write-Output 'PASS Pricing HTTP readiness with pricing.outbox_delivery absent'

  foreach ($file in @('fixtures-catalog-readonly.sql','fixtures-inventory-readonly.sql','fixtures-pricing-readonly.sql','fixtures-promotions-readonly.sql')) {
    Invoke-Pg @('exec',$name,'psql','-U','postgres','-d','postgres','-XAt','-v','ON_ERROR_STOP=1','-v','sku=SKU-TEST-001','-v','location_code=LOC-TEST-001','-v','product_id=00000000-0000-0000-0000-000000000001','-v','order_amount=100.00','-v','customer_ref=00000000-0000-0000-0000-000000000002','-f',('/tmp/' + $file)) | Out-Null
    Write-Output "PASS $file (synthetic schema, no fixture data)"
  }
} finally {
  if ($started) { & docker stop $name *> $null }
  Remove-Item -LiteralPath $setupPath -Force -ErrorAction SilentlyContinue
}
