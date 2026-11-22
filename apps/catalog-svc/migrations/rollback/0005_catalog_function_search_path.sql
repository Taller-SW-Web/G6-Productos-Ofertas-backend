-- Rollback for 0005: restore the tracked 0001 state, where these eight
-- functions have no function-level proconfig and inherit the caller default.
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
    IF to_regprocedure(target) IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(target)
        AND p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'catalog')
        AND EXISTS (
          SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS setting
          WHERE setting = 'search_path=pg_catalog, catalog'
        )
    ) THEN RAISE EXCEPTION 'Function configuration drift: %', target; END IF;
  END LOOP;
END
$guard$;

ALTER FUNCTION catalog.fn_assert_product(uuid) RESET search_path;
ALTER FUNCTION catalog.fn_check_aggregate() RESET search_path;
ALTER FUNCTION catalog.fn_guard_dependency() RESET search_path;
ALTER FUNCTION catalog.fn_guard_identity() RESET search_path;
ALTER FUNCTION catalog.fn_lock_aggregate() RESET search_path;
ALTER FUNCTION catalog.fn_register_sku() RESET search_path;
ALTER FUNCTION catalog.fn_row_product(jsonb, text) RESET search_path;
ALTER FUNCTION catalog.fn_set_updated_at() RESET search_path;
