-- Preview-only. Cleanup is performed by deleting the entire disposable branch
-- through the authorized Supabase control plane, never by deleting business rows.
BEGIN READ ONLY;

SELECT current_database() AS database_name,
       current_user AS database_role,
       current_setting('transaction_read_only') AS transaction_read_only;

SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema IN ('catalog', 'inventory', 'pricing', 'promotions', 'combos', 'taxonomy')
ORDER BY table_schema, table_name;

ROLLBACK;
