-- Promotions only. Supply :sku, :product_id, :order_amount and :customer_ref from the
-- approved G5 preflight context. The query returns booleans only; never print
-- a coupon code or customer reference.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT jsonb_build_object(
  'active_marketplace_coupon_candidate',
  EXISTS (
    SELECT 1
    FROM promotions.promotions p
    JOIN promotions.coupons c ON c.promotion_id = p.id
    WHERE p.state = 'ACTIVO'
      AND p.modality = 'CUPON'
      AND p.valid_from <= now()
      AND p.valid_until > now()
      AND p.enabled_channels @> ARRAY['MARKETPLACE']::text[]
      AND c.state = 'ACTIVO'
      AND (c.minimum_amount IS NULL OR c.minimum_amount <= :'order_amount'::numeric)
      AND (
        c.max_global_uses IS NULL OR c.max_global_uses > (
          SELECT count(*) FROM promotions.coupon_uses u
          WHERE u.coupon_id = c.id AND u.restored_at IS NULL
        )
      )
      AND (
        c.max_customer_uses IS NULL OR c.max_customer_uses > (
          SELECT count(*) FROM promotions.coupon_uses u
          WHERE u.coupon_id = c.id
            AND u.customer_ref = :'customer_ref'::uuid
            AND u.restored_at IS NULL
        )
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM promotions.promotion_scopes s
          WHERE s.promotion_id = p.id
        ) OR EXISTS (
          SELECT 1 FROM promotions.promotion_scopes s
          WHERE s.promotion_id = p.id
            AND (s.sku = :'sku' OR s.product_id = :'product_id')
        )
      )
  )
);
ROLLBACK;
