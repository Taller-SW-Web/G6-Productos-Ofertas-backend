-- Propuesta aislada para revisión de Operaciones PostgreSQL.
-- No ejecutar en Supabase compartido ni durante este preflight.
-- Requisito derivado del runtime Inventory (DatabaseService schema checks,
-- sku lifecycle upsert y offline reconciliation insert/upsert) y de la
-- migración 20261104_0001_lifecycle_offline_reconciliation.sql.
GRANT USAGE ON SCHEMA inventory TO inventory_app;
GRANT SELECT, INSERT, UPDATE
  ON inventory.sku_lifecycle, inventory.offline_sale_reconciliations
  TO inventory_app;
