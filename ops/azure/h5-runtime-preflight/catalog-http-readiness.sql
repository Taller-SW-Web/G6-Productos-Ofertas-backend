-- Same relations used by PostgresCatalogRepository.checkReadinessAccess().
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT jsonb_build_object('ready',
  to_regclass('catalog.products') IS NOT NULL
  AND to_regclass('catalog.product_attribute_values') IS NOT NULL
  AND to_regclass('catalog.product_images') IS NOT NULL
  AND to_regclass('catalog.variants') IS NOT NULL
  AND to_regclass('catalog.variant_images') IS NOT NULL
  AND has_table_privilege(current_user, to_regclass('catalog.products'), 'SELECT')
  AND has_table_privilege(current_user, to_regclass('catalog.product_attribute_values'), 'SELECT')
  AND has_table_privilege(current_user, to_regclass('catalog.product_images'), 'SELECT')
  AND has_table_privilege(current_user, to_regclass('catalog.variants'), 'SELECT')
  AND has_table_privilege(current_user, to_regclass('catalog.variant_images'), 'SELECT'));
ROLLBACK;
