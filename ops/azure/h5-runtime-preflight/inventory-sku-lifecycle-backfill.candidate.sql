-- Inventory lifecycle backfill candidate; never run against shared Supabase.
-- Requires an explicit, disposable-session opt-in:
--   SET g6.inventory_sku_lifecycle_backfill = 'apply';
-- Source of truth is catalog.sku_identity plus the owning product/variant row.
-- This script writes only inventory.sku_lifecycle. It emits no outbox events
-- and never changes stock, reservations, operations, or kardex.

BEGIN;

DO $guard$
BEGIN
  IF current_setting('g6.inventory_sku_lifecycle_backfill', true) IS DISTINCT FROM 'apply' THEN
    RAISE EXCEPTION 'Explicit isolated backfill opt-in is required';
  END IF;
  IF to_regclass('catalog.sku_identity') IS NULL
     OR to_regclass('catalog.products') IS NULL
     OR to_regclass('catalog.variants') IS NULL
     OR to_regclass('inventory.sku_lifecycle') IS NULL
     OR to_regclass('inventory.stock_balance') IS NULL THEN
    RAISE EXCEPTION 'Required Catalog or Inventory objects are missing';
  END IF;
END
$guard$;

CREATE TEMP TABLE g6_lifecycle_source ON COMMIT DROP AS
SELECT
  si.sku,
  COALESCE(v.product_id, si.product_id) AS product_id,
  CASE WHEN si.variant_id IS NOT NULL THEN v.catalog_version
       ELSE p.catalog_version END AS catalog_version,
  -- Catalog publishes Date.toISOString(), which has millisecond precision.
  CASE WHEN si.variant_id IS NOT NULL THEN date_trunc('milliseconds', v.updated_at)
       ELSE date_trunc('milliseconds', p.updated_at) END AS changed_at,
  CASE
    WHEN si.variant_id IS NOT NULL THEN
      vp.estado::text = 'ACTIVO' AND vp.tiene_variantes
      AND v.estado::text = 'ACTIVA'
    ELSE
      p.estado::text = 'ACTIVO' AND NOT p.tiene_variantes
  END AS active,
  si.product_id IS NOT NULL AS product_identity,
  si.variant_id IS NOT NULL AS variant_identity,
  p.id IS NOT NULL AS product_found,
  v.id IS NOT NULL AS variant_found,
  vp.id IS NOT NULL AS variant_product_found
FROM catalog.sku_identity AS si
LEFT JOIN catalog.products AS p
  ON si.variant_id IS NULL AND p.id = si.product_id
LEFT JOIN catalog.variants AS v
  ON si.product_id IS NULL AND v.id = si.variant_id
LEFT JOIN catalog.products AS vp
  ON vp.id = v.product_id;

CREATE TEMP TABLE g6_lifecycle_rejections (
  sku text NOT NULL,
  reason text NOT NULL
) ON COMMIT DROP;

INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT sku, 'identity_owner_or_catalog_target_missing'
FROM g6_lifecycle_source
WHERE product_identity = variant_identity
   OR (product_identity AND NOT product_found)
   OR (variant_identity AND (NOT variant_found OR NOT variant_product_found));

-- A version-zero identity has never produced a Catalog lifecycle transition.
-- It is excluded only while non-sellable and without stock. An active or
-- stocked version-zero identity cannot be safely initialized and is rejected.
INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT s.sku, 'active_or_stocked_identity_has_no_positive_catalog_version'
FROM g6_lifecycle_source AS s
WHERE s.catalog_version <= 0
  AND (s.active OR EXISTS (
    SELECT 1 FROM inventory.stock_balance AS sb WHERE sb.sku_id = s.sku
  ));

INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT s.sku, 'catalog_version_exceeds_inventory_integer'
FROM g6_lifecycle_source AS s
WHERE s.catalog_version > 2147483647;

INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT sb.sku_id, 'stock_identity_missing_or_not_versioned'
FROM inventory.stock_balance AS sb
LEFT JOIN g6_lifecycle_source AS s ON s.sku = sb.sku_id
WHERE s.sku IS NULL OR s.catalog_version <= 0;

INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT s.sku, 'stock_exists_for_non_sellable_base_identity'
FROM g6_lifecycle_source AS s
WHERE s.product_identity
  AND EXISTS (
    SELECT 1 FROM catalog.products p
    WHERE p.id = s.product_id AND p.tiene_variantes
  )
  AND EXISTS (SELECT 1 FROM inventory.stock_balance sb WHERE sb.sku_id = s.sku);

INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT s.sku, 'existing_lifecycle_product_mismatch'
FROM g6_lifecycle_source AS s
JOIN inventory.sku_lifecycle AS l ON l.sku_id = s.sku
WHERE l.product_id IS DISTINCT FROM s.product_id;

INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT s.sku, 'same_version_lifecycle_state_mismatch'
FROM g6_lifecycle_source AS s
JOIN inventory.sku_lifecycle AS l ON l.sku_id = s.sku
WHERE s.catalog_version > 0
  AND s.catalog_version <= 2147483647
  AND l.sku_version = s.catalog_version::integer
  AND (l.active IS DISTINCT FROM s.active OR l.changed_at IS DISTINCT FROM s.changed_at);

CREATE TEMP TABLE g6_lifecycle_eligible ON COMMIT DROP AS
SELECT s.sku, s.product_id, s.catalog_version::integer AS sku_version,
       s.active, s.changed_at
FROM g6_lifecycle_source AS s
WHERE ((s.product_identity AND s.product_found)
   OR (s.variant_identity AND s.variant_found AND s.variant_product_found))
  AND s.catalog_version BETWEEN 1 AND 2147483647;

DELETE FROM g6_lifecycle_eligible AS e
USING g6_lifecycle_rejections AS r
WHERE r.sku = e.sku;

CREATE TEMP TABLE g6_lifecycle_applied (
  sku text PRIMARY KEY,
  inserted boolean NOT NULL
) ON COMMIT DROP;

DO $apply$
BEGIN
  IF EXISTS (SELECT 1 FROM g6_lifecycle_rejections) THEN
    RETURN;
  END IF;

  WITH upserted AS (
    INSERT INTO inventory.sku_lifecycle
      (sku_id, product_id, sku_version, active, changed_at, updated_at)
    SELECT sku, product_id, sku_version, active, changed_at, now()
    FROM g6_lifecycle_eligible
    ON CONFLICT (sku_id) DO UPDATE
      SET product_id = EXCLUDED.product_id,
          sku_version = EXCLUDED.sku_version,
          active = EXCLUDED.active,
          changed_at = EXCLUDED.changed_at,
          updated_at = now()
      WHERE inventory.sku_lifecycle.sku_version < EXCLUDED.sku_version
    RETURNING sku_id, (xmax = 0) AS inserted
  )
  INSERT INTO g6_lifecycle_applied (sku, inserted)
  SELECT sku_id, inserted FROM upserted;
END
$apply$;

SELECT
  CASE WHEN rejected > 0 THEN 'REJECTED_NO_WRITES' ELSE 'APPLIED' END AS status,
  eligible,
  inserted,
  advanced,
  preserved,
  rejected
FROM (
  SELECT
    (SELECT count(*) FROM g6_lifecycle_eligible)::integer AS eligible,
    (SELECT count(*) FROM g6_lifecycle_applied WHERE inserted)::integer AS inserted,
    (SELECT count(*) FROM g6_lifecycle_applied WHERE NOT inserted)::integer AS advanced,
    CASE WHEN (SELECT count(*) FROM g6_lifecycle_rejections) > 0 THEN 0
         ELSE ((SELECT count(*) FROM g6_lifecycle_eligible)
           - (SELECT count(*) FROM g6_lifecycle_applied))::integer END AS preserved,
    (SELECT count(*) FROM g6_lifecycle_rejections)::integer AS rejected
) AS summary;

SELECT sku, reason FROM g6_lifecycle_rejections ORDER BY sku, reason;

COMMIT;
