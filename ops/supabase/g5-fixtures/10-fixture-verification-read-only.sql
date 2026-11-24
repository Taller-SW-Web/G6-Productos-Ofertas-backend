-- Read-only verification for explicitly supplied fixture identifiers.
-- Do not pass IDs from production or Marketplace. Variables should be generated
-- in the disposable branch manifest and supplied with psql -v.
\if :{?fixture_product_id}
\else
  \echo 'Required: -v fixture_product_id=<UUID>'
  \quit 2
\endif
\if :{?fixture_sku}
\else
  \echo 'Required: -v fixture_sku=<synthetic SKU>'
  \quit 2
\endif

BEGIN READ ONLY;

SELECT id, sku_base, slug, nombre, estado
FROM catalog.products
WHERE id = :'fixture_product_id'::uuid;

SELECT id, product_id, sku, identifying_key, estado
FROM catalog.variants
WHERE product_id = :'fixture_product_id'::uuid OR sku = :'fixture_sku';

SELECT sku_id, location_id, on_hand, reserved, blocked, available, stock_version
FROM inventory.stock_balance
WHERE sku_id = :'fixture_sku';

SELECT sku_id, product_id, sku_version, active
FROM inventory.sku_lifecycle
WHERE sku_id = :'fixture_sku';

SELECT p.id AS price_id, p.product_id, p.sku, p.channel_id, p.price_version,
       v.precio_regular, v.precio_oferta, v.currency, v.valid_from,
       v.valid_until, v.is_cancelled
FROM pricing.prices p
JOIN pricing.price_validities v ON v.price_id = p.id
WHERE p.product_id = :'fixture_product_id' OR p.sku = :'fixture_sku'
ORDER BY p.channel_id, v.valid_from DESC;

ROLLBACK;
