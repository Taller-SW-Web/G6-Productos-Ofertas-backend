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
CREATE TEMP TABLE g6_rollout_lifecycle_before ON COMMIT DROP AS
SELECT sku_id, product_id, sku_version, active, changed_at, updated_at
FROM inventory.sku_lifecycle;
-- Inventory lifecycle backfill candidate; never run against shared Supabase.
-- Reusable transaction body: the operator/wrapper owns BEGIN/COMMIT/ROLLBACK
-- and must set the opt-in with SET LOCAL inside that transaction.
-- Source of truth is catalog.sku_identity plus the owning product/variant row.
-- This script writes only inventory.sku_lifecycle. It emits no outbox events
-- and never changes stock, reservations, operations, or kardex.

DO $guard$
BEGIN
  IF current_setting('g6.inventory_sku_lifecycle_backfill', true) IS DISTINCT FROM 'apply' THEN
    RAISE EXCEPTION 'Explicit isolated backfill opt-in is required';
  END IF;
  IF to_regclass('catalog.sku_identity') IS NULL
     OR to_regclass('catalog.products') IS NULL
     OR to_regclass('catalog.variants') IS NULL
     OR to_regclass('catalog.outbox') IS NULL
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
  CASE
    WHEN (si.variant_id IS NULL AND NOT p.tiene_variantes AND p.estado::text = 'INACTIVO'
       OR si.variant_id IS NOT NULL AND (v.estado::text = 'INACTIVA' OR vp.estado::text = 'INACTIVO'))
      AND deactivation.event_version IS NOT NULL THEN deactivation.event_version
    WHEN si.variant_id IS NOT NULL THEN v.catalog_version
    ELSE p.catalog_version
  END AS catalog_version,
  CASE
    WHEN (si.variant_id IS NULL AND NOT p.tiene_variantes AND p.estado::text = 'INACTIVO'
       OR si.variant_id IS NOT NULL AND (v.estado::text = 'INACTIVA' OR vp.estado::text = 'INACTIVO'))
      AND deactivation.event_version IS NOT NULL THEN deactivation.changed_at
    -- Active rows without a recorded deactivation are initialized as a current
    -- Catalog snapshot baseline. This is not represented as an emitted event.
    WHEN si.variant_id IS NOT NULL THEN date_trunc('milliseconds', v.updated_at)
    ELSE date_trunc('milliseconds', p.updated_at)
  END AS changed_at,
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
  vp.id IS NOT NULL AS variant_product_found,
  deactivation.event_version IS NOT NULL AS has_sku_deactivation_event,
  deactivation.event_version AS deactivation_version,
  deactivation.changed_at AS deactivation_changed_at,
  (si.variant_id IS NULL AND NOT p.tiene_variantes AND p.estado::text = 'INACTIVO'
   OR si.variant_id IS NOT NULL AND (v.estado::text = 'INACTIVA' OR vp.estado::text = 'INACTIVO'))
    AS requires_authoritative_deactivation
FROM catalog.sku_identity AS si
LEFT JOIN catalog.products AS p
  ON si.variant_id IS NULL AND p.id = si.product_id
LEFT JOIN catalog.variants AS v
  ON si.product_id IS NULL AND v.id = si.variant_id
LEFT JOIN catalog.products AS vp
  ON vp.id = v.product_id
LEFT JOIN LATERAL (
  SELECT CASE WHEN o.payload->>'sku_version' ~ '^[1-9][0-9]*$'
                   AND (o.payload->>'sku_version')::numeric <= 9223372036854775807
              THEN (o.payload->>'sku_version')::bigint END AS event_version,
         CASE WHEN o.payload->>'changed_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
              THEN (o.payload->>'changed_at')::timestamptz END AS changed_at
  FROM catalog.outbox AS o
  WHERE o.event_name = 'catalog.sku.deactivated'
    AND o.kind = 'event'
    AND o.schema_version = 1
    AND o.payload->>'sku' = si.sku
    AND o.payload->>'product_id' = COALESCE(v.product_id, si.product_id)::text
  ORDER BY o.occurred_at DESC, o.id DESC
  LIMIT 1
) AS deactivation ON true;

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

-- The only emitted SKU lifecycle transition is catalog.sku.deactivated.
-- A current inactive state without that authoritative payload (including a
-- parent deactivation that emitted only catalog.product.deactivated) cannot
-- be assigned a SKU event version/timestamp safely.
INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT sku, 'inactive_state_without_authoritative_sku_deactivation_event'
FROM g6_lifecycle_source
WHERE requires_authoritative_deactivation AND NOT has_sku_deactivation_event;

-- Catalog currently emits no SKU activation/reactivation event. If an earlier
-- deactivation exists but the SKU is active now, the transition sequence is
-- not reconstructable from the current row and that event alone.
INSERT INTO g6_lifecycle_rejections (sku, reason)
SELECT sku, 'reactivation_not_published_as_authoritative_sku_event'
FROM g6_lifecycle_source
WHERE active AND has_sku_deactivation_event;

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
SELECT s.sku, 'authoritative_deactivation_version_or_timestamp_invalid'
FROM g6_lifecycle_source AS s
WHERE NOT s.active AND s.has_sku_deactivation_event
  AND (s.deactivation_version IS NULL OR s.deactivation_version > 2147483647
       OR s.deactivation_changed_at IS NULL);

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
    RAISE EXCEPTION 'LIFECYCLE_BACKFILL_REJECTED'
      USING DETAIL = jsonb_build_object(
        'eligible', (SELECT count(*) FROM g6_lifecycle_eligible),
        'inserted', 0,
        'advanced', 0,
        'preserved', 0,
        'rejected', (SELECT count(*) FROM g6_lifecycle_rejections),
        'reasons', (SELECT jsonb_agg(jsonb_build_object('sku', sku, 'reason', reason)
                                      ORDER BY sku, reason)
                    FROM g6_lifecycle_rejections)
      )::text;
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
  'APPLIED' AS status,
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
    ((SELECT count(*) FROM g6_lifecycle_eligible)
      - (SELECT count(*) FROM g6_lifecycle_applied))::integer AS preserved,
    (SELECT count(*) FROM g6_lifecycle_rejections)::integer AS rejected
) AS summary;

SELECT sku, reason FROM g6_lifecycle_rejections ORDER BY sku, reason;
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
SELECT jsonb_build_object(
  'manifest_version', 1,
  'changes', COALESCE(jsonb_agg(jsonb_build_object(
    'sku_id', e.sku,
    'action', CASE WHEN a.inserted THEN 'INSERTED' ELSE 'ADVANCED' END,
    'before', CASE WHEN b.sku_id IS NULL THEN NULL ELSE to_jsonb(b) END,
    'after', to_jsonb(l)
  ) ORDER BY e.sku), '[]'::jsonb)
) AS lifecycle_change_manifest
FROM g6_lifecycle_applied a
JOIN g6_lifecycle_eligible e ON e.sku = a.sku
JOIN inventory.sku_lifecycle l ON l.sku_id = e.sku
LEFT JOIN g6_rollout_lifecycle_before b ON b.sku_id = e.sku;
COMMIT;
