-- Checks the H5 candidate migration tables and the grants they require.
-- Run as the actual service runtime login in BEGIN READ ONLY.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
WITH expected(relation_name) AS (
  SELECT unnest(CASE :'service'
    WHEN 'catalog-svc' THEN ARRAY['catalog.outbox_delivery']::text[]
    WHEN 'inventory-svc' THEN ARRAY['inventory.outbox_delivery']::text[]
    WHEN 'pricing-svc' THEN ARRAY['pricing.outbox_delivery']::text[]
    WHEN 'promotions-svc' THEN ARRAY['promotions.h5_coupon_operations','promotions.h5_coupon_outbox']::text[]
    ELSE ARRAY[]::text[] END)
), relation_checks AS (
  SELECT relation_name,
    to_regclass(relation_name) IS NOT NULL AS exists,
    CASE WHEN to_regclass(relation_name) IS NULL THEN false
      WHEN :'service' = 'catalog-svc' THEN has_table_privilege(current_user, relation_name, 'SELECT')
       AND has_table_privilege(current_user, relation_name, 'INSERT')
      ELSE has_table_privilege(current_user, relation_name, 'SELECT')
       AND has_table_privilege(current_user, relation_name, 'INSERT')
       AND has_table_privilege(current_user, relation_name, 'UPDATE') END AS dml_ok
  FROM expected
), catalog_column_updates AS (
  SELECT CASE WHEN :'service' <> 'catalog-svc' THEN true
    ELSE to_regclass('catalog.outbox_delivery') IS NOT NULL
      AND has_column_privilege(current_user, 'catalog.outbox_delivery', 'attempts', 'UPDATE')
      AND has_column_privilege(current_user, 'catalog.outbox_delivery', 'available_at', 'UPDATE')
      AND has_column_privilege(current_user, 'catalog.outbox_delivery', 'lease_token', 'UPDATE')
      AND has_column_privilege(current_user, 'catalog.outbox_delivery', 'published_at', 'UPDATE')
      AND has_column_privilege(current_user, 'catalog.outbox_delivery', 'last_error', 'UPDATE') END AS ok
)
SELECT jsonb_build_object(
  'service', :'service',
  'migrations_present', (SELECT count(*) > 0 AND bool_and(exists) FROM relation_checks),
  'effective_grants', (SELECT count(*) > 0 AND bool_and(dml_ok) FROM relation_checks) AND (SELECT ok FROM catalog_column_updates),
  'ready', (SELECT count(*) > 0 AND bool_and(exists AND dml_ok) FROM relation_checks) AND (SELECT ok FROM catalog_column_updates)
);
ROLLBACK;
