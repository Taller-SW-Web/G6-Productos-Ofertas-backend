BEGIN;

ALTER TABLE bulk.outbox_delivery
    DROP CONSTRAINT IF EXISTS outbox_delivery_destination_check,
    DROP CONSTRAINT IF EXISTS ck_outbox_delivery_destination;

ALTER TABLE bulk.outbox_delivery
    ADD CONSTRAINT ck_outbox_delivery_destination
    CHECK (destination IN ('g6.catalog.from.bulk', 'g6.pricing.from.bulk', 'g6.inventory.from.bulk'));

COMMIT;
