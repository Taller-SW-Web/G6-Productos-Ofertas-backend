-- HTTP-bootstrap connection probe only. H5-specific tables and DML grants are
-- checked separately and only when that service's H5 feature is enabled.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';

SELECT jsonb_build_object(
  'database', current_database(),
  'login_role', session_user,
  'effective_role', current_user,
  'ssl_in_use', COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false),
  'database_connect', has_database_privilege(current_user, current_database(), 'CONNECT'),
  'schema_exists', EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = :'schema'),
  'schema_usage', CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = :'schema'
  ) THEN has_schema_privilege(current_user, :'schema', 'USAGE') ELSE false END,
  'expected_role_exists', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'expected_role'),
  'expected_role_inherited', CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'expected_role')
    THEN pg_has_role(session_user, :'expected_role', 'MEMBER') ELSE false END,
  'required_table_privileges', CASE WHEN has_schema_privilege(current_user, :'schema', 'USAGE') THEN CASE :'service'
    WHEN 'catalog-svc' THEN (
      CASE WHEN to_regclass('catalog.products') IS NOT NULL THEN has_table_privilege(current_user, 'catalog.products', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('catalog.product_attribute_values') IS NOT NULL THEN has_table_privilege(current_user, 'catalog.product_attribute_values', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('catalog.product_images') IS NOT NULL THEN has_table_privilege(current_user, 'catalog.product_images', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('catalog.variants') IS NOT NULL THEN has_table_privilege(current_user, 'catalog.variants', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('catalog.variant_images') IS NOT NULL THEN has_table_privilege(current_user, 'catalog.variant_images', 'SELECT') ELSE false END)
    WHEN 'inventory-svc' THEN (
      CASE WHEN to_regclass('inventory.sku_lifecycle') IS NOT NULL THEN has_table_privilege(current_user, 'inventory.sku_lifecycle', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('inventory.sku_lifecycle') IS NOT NULL THEN has_table_privilege(current_user, 'inventory.sku_lifecycle', 'INSERT') AND has_table_privilege(current_user, 'inventory.sku_lifecycle', 'UPDATE') ELSE false END
      AND CASE WHEN to_regclass('inventory.offline_sale_reconciliations') IS NOT NULL THEN has_table_privilege(current_user, 'inventory.offline_sale_reconciliations', 'SELECT') AND has_table_privilege(current_user, 'inventory.offline_sale_reconciliations', 'INSERT') AND has_table_privilege(current_user, 'inventory.offline_sale_reconciliations', 'UPDATE') ELSE false END)
    WHEN 'pricing-svc' THEN (
      CASE WHEN to_regclass('pricing.prices') IS NOT NULL THEN has_table_privilege(current_user, 'pricing.prices', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('pricing.price_validities') IS NOT NULL THEN has_table_privilege(current_user, 'pricing.price_validities', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('pricing.scheduled_prices') IS NOT NULL THEN has_table_privilege(current_user, 'pricing.scheduled_prices', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('pricing.bulk_price_jobs') IS NOT NULL THEN has_table_privilege(current_user, 'pricing.bulk_price_jobs', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('pricing.bulk_price_rows') IS NOT NULL THEN has_table_privilege(current_user, 'pricing.bulk_price_rows', 'SELECT') ELSE false END
      AND CASE WHEN to_regclass('pricing.outbox') IS NOT NULL THEN has_table_privilege(current_user, 'pricing.outbox', 'SELECT') ELSE false END)
    WHEN 'promotions-svc' THEN has_schema_privilege(current_user, :'schema', 'USAGE')
    ELSE false END ELSE false END
);

ROLLBACK;
