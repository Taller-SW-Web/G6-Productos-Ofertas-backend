-- Synthetic only. Run only in disposable PostgreSQL 17 h5_fixtures database.
BEGIN;

INSERT INTO catalog.products
  (id, nombre, descripcion, categoria_id, tipo_producto_id, marca_id,
   sku_base, slug, tiene_variantes, estado, catalog_version, updated_at)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'Fixture simple', 'Synthetic simple product',
   'QA-CAT', 'QA-TYPE', 'QA-BRAND', 'G5F-SIMPLE-001', 'g5f-simple-001', false,
   'ACTIVO', 5, '2026-11-20T12:00:00.123456Z'),
  ('10000000-0000-4000-8000-000000000002', 'Fixture variants', 'Synthetic variant product',
   'QA-CAT', 'QA-TYPE', 'QA-BRAND', 'G5F-BASE-002', 'g5f-variants-002', true,
   'ACTIVO', 7, '2026-11-20T12:10:00Z'),
  ('10000000-0000-4000-8000-000000000003', 'Fixture draft', 'Synthetic unversioned draft',
   'QA-CAT', 'QA-TYPE', 'QA-BRAND', 'G5F-DRAFT-003', 'g5f-draft-003', false,
   'BORRADOR', 0, '2026-11-20T12:20:00Z');

INSERT INTO catalog.variants
  (id, product_id, sku, identifying_key, estado, catalog_version, updated_at)
VALUES
  ('20000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002', 'G5F-VARIANT-002-A',
   '{"size":{"valor":"fixture"}}', 'ACTIVA', 4, '2026-11-20T12:30:00Z');

INSERT INTO catalog.variant_attribute_values
  (variant_id, caracteristica_id, nombre_snapshot, valor, es_identificador)
VALUES ('20000000-0000-4000-8000-000000000001', 'size', 'Size', '"fixture"', true);

INSERT INTO catalog.product_images (product_id, url, principal)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'https://fixture.invalid/simple.png', true),
  ('10000000-0000-4000-8000-000000000002', 'https://fixture.invalid/variants.png', true);
INSERT INTO catalog.variant_images (variant_id, url)
VALUES ('20000000-0000-4000-8000-000000000001', 'https://fixture.invalid/variant.png');

INSERT INTO catalog.sku_physical_profiles
  (sku_identity_id, peso_kg, largo_cm, ancho_cm, alto_cm)
SELECT id, 1, 10, 10, 10 FROM catalog.sku_identity
WHERE sku IN ('G5F-SIMPLE-001', 'G5F-VARIANT-002-A');

INSERT INTO catalog.activation_checks
  (product_id, variant_id, sku, dependency, operation_id, correlation_id,
   request_payload, state, result_payload, result_message_id)
VALUES
  ('10000000-0000-4000-8000-000000000001', NULL, 'G5F-SIMPLE-001', 'PRICING',
   '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
   '{}', 'COMPLETED', '{}', '50000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', NULL, 'G5F-SIMPLE-001', 'INVENTORY',
   '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
   '{}', 'COMPLETED', '{}', '50000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000002', NULL, 'G5F-BASE-002', 'PRICING',
   '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003',
   '{}', 'COMPLETED', '{}', '50000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000001', 'G5F-VARIANT-002-A', 'INVENTORY',
   '30000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004',
   '{}', 'COMPLETED', '{}', '50000000-0000-4000-8000-000000000004');

INSERT INTO inventory.locations (id, code, name, type)
VALUES ('60000000-0000-4000-8000-000000000001', 'G5F-LOCAL-01', 'Fixture location', 'QA');
INSERT INTO inventory.stock_balance (sku_id, location_id, on_hand, reserved, blocked)
VALUES
  ('G5F-SIMPLE-001', '60000000-0000-4000-8000-000000000001', 8, 2, 1),
  ('G5F-VARIANT-002-A', '60000000-0000-4000-8000-000000000001', 5, 1, 0);

COMMIT;
