$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$bodyPath = Join-Path $root 'ops/azure/h5-runtime-preflight/inventory-sku-lifecycle-backfill.candidate.sql'
$body = (Get-Content -Raw $bodyPath).Trim()
$prefix = @'
BEGIN;
SET LOCAL g6.inventory_sku_lifecycle_backfill = 'apply';
CREATE TEMP TABLE g6_rollout_protected_before ON COMMIT DROP AS
SELECT
  (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY sku_id,location_id),'')) FROM inventory.stock_balance t) AS stock,
  (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY id),'')) FROM inventory.reservations t) AS reservations,
  (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY id),'')) FROM inventory.inventory_operations t) AS operations,
  (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY id),'')) FROM inventory.kardex t) AS kardex,
  (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY id),'')) FROM inventory.outbox t) AS outbox,
  (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY client_id,offline_sale_id),'')) FROM inventory.offline_sale_reconciliations t) AS offline_sale_reconciliations;
'@
$postcheck = @'
DO $postcheck$
BEGIN
  IF EXISTS (SELECT 1 FROM g6_lifecycle_rejections) THEN
    RAISE EXCEPTION 'LIFECYCLE_POSTCHECK_REJECTED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM g6_lifecycle_eligible e
    LEFT JOIN inventory.sku_lifecycle l ON l.sku_id=e.sku
    WHERE l.sku_id IS NULL OR l.product_id IS DISTINCT FROM e.product_id
       OR l.sku_version < e.sku_version
       OR (l.sku_version=e.sku_version AND
          (l.active IS DISTINCT FROM e.active OR l.changed_at IS DISTINCT FROM e.changed_at))
  ) THEN RAISE EXCEPTION 'LIFECYCLE_POSTCHECK_MISMATCH'; END IF;
  IF EXISTS (
    SELECT 1 FROM g6_rollout_protected_before b
    WHERE b.stock IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY sku_id,location_id),'')) FROM inventory.stock_balance t)
       OR b.reservations IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY id),'')) FROM inventory.reservations t)
       OR b.operations IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY id),'')) FROM inventory.inventory_operations t)
       OR b.kardex IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY id),'')) FROM inventory.kardex t)
       OR b.outbox IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY id),'')) FROM inventory.outbox t)
       OR b.offline_sale_reconciliations IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\n' ORDER BY client_id,offline_sale_id),'')) FROM inventory.offline_sale_reconciliations t)
  ) THEN RAISE EXCEPTION 'PROTECTED_INVENTORY_CONTENT_CHANGED'; END IF;
END
$postcheck$;
SELECT 'POSTCHECK_OK' AS status,
       (SELECT count(*) FROM g6_lifecycle_eligible)::integer AS eligible,
       (SELECT count(*) FROM g6_lifecycle_applied WHERE inserted)::integer AS inserted,
       (SELECT count(*) FROM g6_lifecycle_applied WHERE NOT inserted)::integer AS advanced,
       ((SELECT count(*) FROM g6_lifecycle_eligible) - (SELECT count(*) FROM g6_lifecycle_applied))::integer AS preserved;
'@
foreach ($mode in @('apply', 'ensayo')) {
  $finish = if ($mode -eq 'apply') { 'COMMIT;' } else { 'ROLLBACK;' }
  $path = Join-Path $PSScriptRoot "inventory-sku-lifecycle-$mode.transaction.sql"
  $sql = "$prefix`n$body`n$postcheck`n$finish`n"
  [System.IO.File]::WriteAllText($path, $sql, [System.Text.UTF8Encoding]::new($false))
  Write-Output "Generated $([IO.Path]::GetFileName($path))"
}
