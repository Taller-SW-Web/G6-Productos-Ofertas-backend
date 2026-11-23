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
 SELECT tc.table_name,tc.constraint_type,string_agg(kcu.column_name,',' ORDER BY kcu.ordinal_position) AS columns
 FROM information_schema.table_constraints tc
 JOIN information_schema.key_column_usage kcu USING (constraint_catalog,constraint_schema,constraint_name,table_schema,table_name)
 WHERE tc.constraint_schema='inventory' AND tc.table_name IN ('sku_lifecycle','offline_sale_reconciliations')
   AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
 GROUP BY tc.table_name,tc.constraint_type)
SELECT jsonb_build_object('ready',
 (SELECT count(*)=15 FROM required r JOIN information_schema.columns c USING (table_name,column_name) WHERE c.table_schema='inventory')
 AND EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='sku_lifecycle' AND constraint_type='PRIMARY KEY' AND columns='sku_id')
 AND EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='offline_sale_reconciliations' AND constraint_type='PRIMARY KEY' AND columns='client_id,offline_sale_id')
 AND EXISTS (SELECT 1 FROM actual_constraints WHERE table_name='offline_sale_reconciliations' AND constraint_type='UNIQUE' AND columns='operation_id'));
ROLLBACK;
