-- Inventory only. Supply :sku and :location_code from authorized G5 fixtures.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT jsonb_build_object(
  'active_location_with_available_stock',
  EXISTS (
    SELECT 1
    FROM inventory.locations l
    JOIN inventory.stock_balance b ON b.location_id = l.id
    WHERE l.code = :'location_code'
      AND l.active
      AND b.sku_id = :'sku'
      AND b.available > 0
  )
);
ROLLBACK;
