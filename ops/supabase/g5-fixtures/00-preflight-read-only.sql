-- Read-only gate for a disposable Supabase branch before G5/G6 fixtures.
-- Run with psql -X -v ON_ERROR_STOP=1. This file never writes.
BEGIN READ ONLY;

SELECT current_database() AS database_name,
       current_user AS database_role,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('server_version') AS postgres_version;

SELECT schema_name
FROM information_schema.schemata
WHERE schema_name IN ('catalog', 'inventory', 'pricing', 'promotions', 'combos', 'taxonomy')
ORDER BY schema_name;

SELECT table_schema, table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema IN ('catalog', 'inventory', 'pricing', 'promotions', 'combos', 'taxonomy')
ORDER BY table_schema, table_name, ordinal_position;

SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('catalog', 'inventory', 'pricing', 'promotions', 'combos', 'taxonomy')
  AND c.relkind IN ('r', 'p')
ORDER BY n.nspname, c.relname;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname IN ('catalog', 'inventory', 'pricing', 'promotions', 'combos', 'taxonomy')
ORDER BY schemaname, tablename, policyname;

SELECT table_schema, table_name, constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_schema IN ('catalog', 'inventory', 'pricing', 'promotions', 'combos', 'taxonomy')
ORDER BY table_schema, table_name, constraint_type, constraint_name;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname IN ('catalog', 'inventory', 'pricing', 'promotions', 'combos', 'taxonomy')
ORDER BY schemaname, tablename, indexname;

SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema IN ('catalog', 'inventory', 'pricing', 'promotions', 'combos', 'taxonomy')
  AND (table_name ILIKE '%outbox%' OR table_name ILIKE '%inbox%' OR table_name ILIKE '%operation%')
ORDER BY table_schema, table_name;

ROLLBACK;
