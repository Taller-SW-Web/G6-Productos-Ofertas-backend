-- Pricing only. Supply :sku from the authorized G5 test fixture.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT jsonb_build_object(
  'current_marketplace_price',
  EXISTS (
    SELECT 1
    FROM pricing.prices p
    JOIN pricing.price_validities v ON v.price_id = p.id
    WHERE p.sku = :'sku'
      AND p.channel_id = 'MARKETPLACE'
      AND v.valid_from <= now()
      AND (v.valid_until IS NULL OR v.valid_until > now())
      AND NOT v.is_cancelled
      AND v.precio_regular > 0
    ORDER BY v.price_version DESC
    LIMIT 1
  )
);
ROLLBACK;
