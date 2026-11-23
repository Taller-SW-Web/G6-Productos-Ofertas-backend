-- Ejecutar únicamente con acceso autorizado de lectura; no aplica migraciones.
BEGIN READ ONLY;

SELECT current_database() AS database_name, current_user AS runtime_role,
       current_setting('g6.taxonomy_messaging', true) AS delivery_transport;

SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'taxonomy'
  AND table_name IN ('outbox', 'outbox_delivery', 'inbox')
ORDER BY table_name, ordinal_position;

SELECT c.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'taxonomy' AND c.relname IN ('outbox', 'outbox_delivery', 'inbox')
ORDER BY c.relname, con.conname;

SELECT c.relname AS table_name, t.tgname, t.tgenabled,
       pg_get_userbyid(p.proowner) AS function_owner, p.prosecdef AS security_definer,
       pg_get_triggerdef(t.oid) AS definition
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'taxonomy' AND c.relname = 'outbox' AND NOT t.tgisinternal
ORDER BY t.tgname;

SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'taxonomy' AND table_name IN ('outbox', 'outbox_delivery', 'inbox')
ORDER BY table_name, grantee, privilege_type;

SELECT grantee, table_name, column_name, privilege_type
FROM information_schema.role_column_grants
WHERE table_schema = 'taxonomy' AND table_name = 'outbox_delivery'
ORDER BY grantee, column_name, privilege_type;

ROLLBACK;
