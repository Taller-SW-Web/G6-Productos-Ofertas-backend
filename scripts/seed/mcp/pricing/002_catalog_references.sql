-- DATA-003 / #13. Inspeccion autorizada de referencias, sin JOIN cross-schema.
-- Se ejecuta aparte con el acceso MCP de lectura; no ampliar permisos de po_pricing_seed.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog, catalog;

SELECT jsonb_build_object(
  'captured_at', now(), 'mode', 'READ_ONLY',
  'session_user', session_user, 'effective_role', current_user,
  'transaction_read_only', current_setting('transaction_read_only'),
  'products', (SELECT jsonb_agg(jsonb_build_object(
    'id', p.id, 'nombre', p.nombre, 'sku_base', p.sku_base,
    'tiene_variantes', p.tiene_variantes, 'estado', p.estado,
    'catalog_version', p.catalog_version) ORDER BY p.id) FROM catalog.products p),
  'variants', (SELECT jsonb_agg(jsonb_build_object(
    'id', v.id, 'product_id', v.product_id, 'sku', v.sku,
    'estado', v.estado, 'catalog_version', v.catalog_version) ORDER BY v.id)
    FROM catalog.variants v),
  'sku_identities', (SELECT jsonb_agg(jsonb_build_object(
    'id', s.id, 'sku', s.sku, 'product_id', s.product_id, 'variant_id', s.variant_id)
    ORDER BY s.sku) FROM catalog.sku_identity s),
  'published_sellable_skus', (SELECT count(*)
    FROM (
      SELECT s.id FROM catalog.sku_identity s
      JOIN catalog.products p ON p.id = s.product_id
      WHERE s.variant_id IS NULL AND s.sku = p.sku_base
        AND NOT p.tiene_variantes AND p.estado = 'ACTIVO'
      UNION ALL
      SELECT s.id FROM catalog.sku_identity s
      JOIN catalog.variants v ON v.id = s.variant_id AND v.sku = s.sku
      JOIN catalog.products p ON p.id = v.product_id
      WHERE s.product_id IS NULL AND p.tiene_variantes
        AND p.estado = 'ACTIVO' AND v.estado = 'ACTIVA'
    ) published),
  'variants_without_identity', (SELECT count(*) FROM catalog.variants v
    WHERE NOT EXISTS (SELECT 1 FROM catalog.sku_identity s
      WHERE s.sku = v.sku AND s.variant_id = v.id AND s.product_id IS NULL))
) AS audit;
COMMIT;
