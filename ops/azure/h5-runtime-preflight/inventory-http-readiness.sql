-- Exact production schema preflight enforced by Inventory DatabaseService.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
WITH required(table_name,column_name) AS (VALUES
 ('sku_lifecycle','sku_id'),('sku_lifecycle','product_id'),('sku_lifecycle','sku_version'),
 ('sku_lifecycle','active'),('sku_lifecycle','changed_at'),('sku_lifecycle','updated_at'),
 ('offline_sale_reconciliations','client_id'),('offline_sale_reconciliations','offline_sale_id'),
 ('offline_sale_reconciliations','operation_id'),('offline_sale_reconciliations','order_id'),
 ('offline_sale_reconciliations','request_fingerprint'),('offline_sale_reconciliations','request_payload'),
 ('offline_sale_reconciliations','result_payload'),('offline_sale_reconciliations','status'),
 ('offline_sale_reconciliations','completed_at')),
actual_constraints AS (
 SELECT rel.relname AS table_name,
   CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' END AS constraint_type,
   string_agg(att.attname,',' ORDER BY key_column.ordinality) AS columns
 FROM pg_catalog.pg_constraint con
 JOIN pg_catalog.pg_class rel ON rel.oid=con.conrelid
 JOIN pg_catalog.pg_namespace ns ON ns.oid=rel.relnamespace
 CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_column(attnum,ordinality)
 JOIN pg_catalog.pg_attribute att ON att.attrelid=rel.oid AND att.attnum=key_column.attnum
 WHERE ns.nspname='inventory' AND rel.relname IN ('sku_lifecycle','offline_sale_reconciliations')
   AND con.contype IN ('p','u')
 GROUP BY rel.relname,con.contype)
SELECT jsonb_build_object(
 'ready',
 (SELECT count(*)=15 FROM required r JOIN information_schema.columns c USING (table_name,column_name) WHERE c.table_schema='inventory')
 AND EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='sku_lifecycle' AND constraint_type='PRIMARY KEY' AND columns='sku_id')
 AND EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='offline_sale_reconciliations' AND constraint_type='PRIMARY KEY' AND columns='client_id,offline_sale_id')
 AND EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='offline_sale_reconciliations' AND constraint_type='UNIQUE' AND columns='operation_id'),
 'required_columns', (SELECT count(*)=15 FROM required r JOIN information_schema.columns c USING (table_name,column_name) WHERE c.table_schema='inventory'),
 'sku_lifecycle_pk', EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='sku_lifecycle' AND constraint_type='PRIMARY KEY' AND columns='sku_id'),
 'offline_reconciliation_pk', EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='offline_sale_reconciliations' AND constraint_type='PRIMARY KEY' AND columns='client_id,offline_sale_id'),
 'offline_reconciliation_operation_unique', EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='offline_sale_reconciliations' AND constraint_type='UNIQUE' AND columns='operation_id'));
ROLLBACK;
