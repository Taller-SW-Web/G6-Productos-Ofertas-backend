-- Migración delta versionada (NO EJECUTAR contra Supabase compartido sin autorización).
-- Amplía pricing.outbox_delivery para R14 (g6.bulk.from.pricing), R15 (g6.catalog.from.pricing),
-- R16 (g6.price-audit.from.pricing) y R17 (g6.promotions.from.pricing).

ALTER TABLE pricing.outbox_delivery
  DROP CONSTRAINT IF EXISTS ck_delivery_route;

ALTER TABLE pricing.outbox_delivery
  ADD CONSTRAINT ck_delivery_route CHECK (
    route_version = 1
    AND transport = 'AZURE_SERVICE_BUS'
    AND destination IN (
      'g6.price-audit.from.pricing',
      'g6.promotions.from.pricing',
      'g6.catalog.from.pricing',
      'g6.bulk.from.pricing'
    )
  );
