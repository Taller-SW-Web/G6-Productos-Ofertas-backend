-- Read-only, focused bootstrap HTTP migration/DDL inspection.
-- Does not write data or ledgers. Use only through an authorized read-only
-- connection to the already-approved project; return metadata, not row data.
BEGIN TRANSACTION READ ONLY;

SELECT current_setting('server_version_num')::integer AS server_version_num,
       current_database() AS database_name,
       current_user AS effective_role,
       current_setting('transaction_read_only') AS transaction_read_only;

-- Service ledgers only; the global Supabase ledger is intentionally excluded.
SELECT s.nspname AS service_schema, m.version, m.checksum, m.applied_at
FROM pg_namespace s
JOIN pg_class c ON c.relnamespace=s.oid AND c.relname='schema_migrations'
JOIN LATERAL (
  SELECT version, checksum, applied_at FROM catalog.schema_migrations WHERE s.nspname='catalog'
  UNION ALL SELECT version, checksum, applied_at FROM inventory.schema_migrations WHERE s.nspname='inventory'
  UNION ALL SELECT version, checksum, applied_at FROM pricing.schema_migrations WHERE s.nspname='pricing'
  UNION ALL SELECT version, checksum, applied_at FROM promotions.schema_migrations WHERE s.nspname='promotions'
) m ON true
WHERE s.nspname IN ('catalog','inventory','pricing','promotions')
ORDER BY s.nspname, m.version;

-- Exact column/type/default/nullability metadata for the bootstrap path.
SELECT table_schema, table_name, ordinal_position, column_name, data_type,
       udt_name, is_nullable, column_default, is_generated, generation_expression
FROM information_schema.columns
WHERE (table_schema, table_name) IN (
  ('catalog','products'), ('catalog','variants'), ('catalog','sku_identity'),
  ('catalog','outbox'), ('inventory','sku_lifecycle'), ('inventory','stock_balance'),
  ('inventory','reservations'), ('inventory','inventory_operations'),
  ('inventory','kardex'), ('inventory','outbox'),
  ('inventory','offline_sale_reconciliations'), ('inventory','commercial_fulfillment_routes'),
  ('pricing','prices'), ('pricing','price_validities'),
  ('promotions','h5_coupon_operations'), ('promotions','h5_coupon_outbox'),
  ('promotions','coupon_uses')
)
ORDER BY table_schema, table_name, ordinal_position;

SELECT n.nspname AS table_schema, c.relname AS table_name, con.conname,
       con.contype, con.convalidated, pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid=con.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE (n.nspname, c.relname) IN (
  ('catalog','products'), ('catalog','variants'), ('catalog','sku_identity'),
  ('inventory','sku_lifecycle'), ('inventory','stock_balance'),
  ('inventory','commercial_fulfillment_routes'),
  ('pricing','prices'), ('pricing','price_validities'),
  ('promotions','h5_coupon_operations'), ('promotions','h5_coupon_outbox'),
  ('promotions','coupon_uses')
)
ORDER BY n.nspname, c.relname, con.conname;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE (schemaname, tablename) IN (
  ('inventory','sku_lifecycle'), ('inventory','stock_balance'),
  ('inventory','commercial_fulfillment_routes'),
  ('pricing','prices'), ('pricing','price_validities'),
  ('promotions','h5_coupon_operations'), ('promotions','h5_coupon_outbox'),
  ('promotions','coupon_uses')
)
ORDER BY schemaname, tablename, indexname;

SELECT n.nspname AS table_schema, c.relname AS table_name, t.tgname,
       pg_get_triggerdef(t.oid, true) AS definition,
       p.proname AS function_name, pg_get_functiondef(p.oid) AS function_definition
FROM pg_trigger t
JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_proc p ON p.oid=t.tgfoid
WHERE NOT t.tgisinternal
  AND (n.nspname, c.relname) IN (
    ('catalog','products'), ('catalog','variants'), ('catalog','sku_identity'),
    ('inventory','stock_balance'), ('inventory','sku_lifecycle'),
    ('promotions','coupon_uses'), ('promotions','h5_coupon_operations'),
    ('promotions','h5_coupon_outbox')
  )
ORDER BY n.nspname, c.relname, t.tgname;

SELECT n.nspname AS table_schema, c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner,
       r.rolname AS role_name,
       has_table_privilege(r.oid, c.oid, 'SELECT') AS can_select,
       has_table_privilege(r.oid, c.oid, 'INSERT') AS can_insert,
       has_table_privilege(r.oid, c.oid, 'UPDATE') AS can_update,
       has_table_privilege(r.oid, c.oid, 'DELETE') AS can_delete,
       has_table_privilege(r.oid, c.oid, 'TRUNCATE') AS can_truncate,
       has_table_privilege(r.oid, c.oid, 'TRIGGER') AS can_trigger
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN pg_roles r
WHERE c.relkind IN ('r','p')
  AND (n.nspname, c.relname) IN (
    ('inventory','sku_lifecycle'), ('inventory','offline_sale_reconciliations'),
    ('promotions','h5_coupon_operations'), ('promotions','h5_coupon_outbox'),
    ('promotions','coupon_uses')
  )
  AND r.rolname IN ('inventory_app','inventory_dev_login','po_inventory_runtime',
                    'po_inventory_dev_runtime','po_promotions_runtime',
                    'promotions_dev_login','po_promotions_dev_runtime')
ORDER BY n.nspname, c.relname, r.rolname;

ROLLBACK;
