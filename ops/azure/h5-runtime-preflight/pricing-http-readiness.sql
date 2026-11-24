-- Same database check() tables and columns required by Pricing HTTP readiness.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT jsonb_build_object('ready',
  to_regclass('pricing.prices') IS NOT NULL
  AND to_regclass('pricing.price_validities') IS NOT NULL
  AND to_regclass('pricing.scheduled_prices') IS NOT NULL
  AND to_regclass('pricing.bulk_price_jobs') IS NOT NULL
  AND to_regclass('pricing.bulk_price_rows') IS NOT NULL
  AND to_regclass('pricing.outbox') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='pricing' AND table_name='scheduled_prices' AND column_name='product_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='pricing' AND table_name='scheduled_prices' AND column_name='correlation_id'));
ROLLBACK;
