-- Catalog D04: pin only the eight Catalog functions whose tracked definition
-- has no function-level search_path. Owners, grants and bodies stay unchanged.
-- The owner-only precondition guarantees rollback restores the prior default.
DO $guard$
DECLARE target text;
BEGIN
  IF current_user <> 'po_catalog_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'catalog'
      AND pg_get_userbyid(nspowner) = current_user
  ) THEN RAISE EXCEPTION 'Require catalog owner'; END IF;

  FOREACH target IN ARRAY ARRAY[
    'catalog.fn_assert_product(uuid)',
    'catalog.fn_check_aggregate()',
    'catalog.fn_guard_dependency()',
    'catalog.fn_guard_identity()',
    'catalog.fn_lock_aggregate()',
    'catalog.fn_register_sku()',
    'catalog.fn_row_product(jsonb,text)',
    'catalog.fn_set_updated_at()'
  ] LOOP
    IF to_regprocedure(target) IS NULL THEN
      RAISE EXCEPTION 'Missing expected Catalog function: %', target;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(target)
        AND p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'catalog')
        AND NOT EXISTS (
          SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS setting
          WHERE setting LIKE 'search_path=%'
        )
    ) THEN RAISE EXCEPTION 'Function owner/configuration drift: %', target; END IF;
  END LOOP;
END
$guard$;

ALTER FUNCTION catalog.fn_assert_product(uuid) SET search_path = pg_catalog, catalog;
ALTER FUNCTION catalog.fn_check_aggregate() SET search_path = pg_catalog, catalog;
ALTER FUNCTION catalog.fn_guard_dependency() SET search_path = pg_catalog, catalog;
ALTER FUNCTION catalog.fn_guard_identity() SET search_path = pg_catalog, catalog;
ALTER FUNCTION catalog.fn_lock_aggregate() SET search_path = pg_catalog, catalog;
ALTER FUNCTION catalog.fn_register_sku() SET search_path = pg_catalog, catalog;
ALTER FUNCTION catalog.fn_row_product(jsonb, text) SET search_path = pg_catalog, catalog;
ALTER FUNCTION catalog.fn_set_updated_at() SET search_path = pg_catalog, catalog;
