-- Catalog only. Supply :sku from the authorized G5 test fixture.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT jsonb_build_object(
  'sku_active',
  EXISTS (
    SELECT 1 FROM catalog.products p
    WHERE p.sku_base = :'sku' AND p.estado = 'ACTIVO'
  ) OR EXISTS (
    SELECT 1 FROM catalog.variants v
    JOIN catalog.products p ON p.id = v.product_id
    WHERE v.sku = :'sku' AND v.estado = 'ACTIVA' AND p.estado = 'ACTIVO'
  )
);
ROLLBACK;
