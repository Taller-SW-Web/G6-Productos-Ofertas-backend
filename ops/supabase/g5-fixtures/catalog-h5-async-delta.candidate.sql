-- Phase 6 only: missing Catalog Service Bus H5 delta, based on canonical
-- migrations-candidate/h5/0001_outbox_delivery.sql and 0002_taxonomy_reply_transport.sql.
-- Never run for HTTP bootstrap. Does not create outbox_delivery, update ledger,
-- scan historical outbox rows, or create historical deliveries.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE catalog.outbox IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catalog.outbox_delivery IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF current_user <> 'po_catalog_owner' OR NOT EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname='catalog' AND pg_get_userbyid(nspowner)=current_user
  ) THEN RAISE EXCEPTION 'CATALOG_H5_DELTA_REQUIRES_SCHEMA_OWNER'; END IF;
  IF to_regclass('catalog.outbox_delivery') IS NULL THEN
    RAISE EXCEPTION 'CATALOG_H5_DELIVERY_TABLE_MISSING_NO_CREATE_ALLOWED';
  END IF;
  IF EXISTS (SELECT 1 FROM catalog.outbox_delivery) THEN
    RAISE EXCEPTION 'CATALOG_H5_DELIVERIES_PRESENT_RECONCILE_BEFORE_PHASE6';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='catalog.outbox'::regclass
              AND attname='delivery_transport' AND attnum>0 AND NOT attisdropped)
     OR to_regprocedure('catalog.enqueue_h5_outbox_deliveries()') IS NOT NULL
     OR to_regprocedure('catalog.mark_taxonomy_reply_transport()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='catalog.outbox'::regclass
                AND NOT tgisinternal AND tgname IN
                ('tr_catalog_outbox_h5_delivery','trg_catalog_taxonomy_reply_transport')) THEN
    RAISE EXCEPTION 'CATALOG_H5_DELTA_NOT_IN_EXPECTED_MISSING_OBJECT_STATE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('message_id','uuid'),('destination','text'),('attempts','integer'),
      ('created_at','timestamp with time zone'),('available_at','timestamp with time zone'),
      ('lease_token','uuid'),('published_at','timestamp with time zone'),('last_error','text')
    ) required(name,type)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_attribute a WHERE a.attrelid='catalog.outbox_delivery'::regclass
        AND a.attname=required.name AND format_type(a.atttypid,a.atttypmod)=required.type
        AND a.attnum>0 AND NOT a.attisdropped
    )
  ) THEN RAISE EXCEPTION 'CATALOG_H5_DELIVERY_TABLE_SHAPE_MISMATCH'; END IF;
END
$preflight$;

-- Existing H4 outbox rows receive the default marker only; the trigger below
-- is AFTER INSERT and does not create deliveries for prior messages.
ALTER TABLE catalog.outbox
  ADD COLUMN delivery_transport text NOT NULL DEFAULT 'RABBITMQ'
  CHECK (delivery_transport IN ('RABBITMQ','AZURE_SERVICE_BUS'));

CREATE FUNCTION catalog.mark_taxonomy_reply_transport()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF current_setting('catalog.messaging_provider', true)='AZURE_SERVICE_BUS'
     OR current_setting('g6.catalog_taxonomy_reply', true)='AZURE_SERVICE_BUS' THEN
    NEW.delivery_transport := 'AZURE_SERVICE_BUS';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION catalog.mark_taxonomy_reply_transport() FROM PUBLIC;
CREATE TRIGGER trg_catalog_taxonomy_reply_transport
BEFORE INSERT ON catalog.outbox
FOR EACH ROW EXECUTE FUNCTION catalog.mark_taxonomy_reply_transport();

CREATE FUNCTION catalog.enqueue_h5_outbox_deliveries()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,catalog AS $$
BEGIN
  IF current_setting('catalog.messaging_provider', true) IS DISTINCT FROM 'AZURE_SERVICE_BUS' THEN
    RETURN NEW;
  END IF;
  INSERT INTO catalog.outbox_delivery(message_id,destination)
  SELECT NEW.message_id,routes.destination
  FROM (VALUES
    ('pricing.product.initialization.requested','g6.pricing.from.catalog'),
    ('inventory.sku.initialization.requested','g6.inventory.from.catalog'),
    ('catalog.product.deactivated','g6.promotions.from.catalog'),
    ('catalog.product.deactivated','g6.combos.from.catalog'),
    ('catalog.sku.deactivated','g6.inventory.from.catalog'),
    ('catalog.sku.deactivated','g6.pricing.from.catalog'),
    ('catalog.sku.deactivated','g6.promotions.from.catalog'),
    ('catalog.sku.deactivated','g6.combos.from.catalog'),
    ('catalog.master.deactivation.checked','g6.taxonomy.from.catalog'),
    ('catalog.bulk.upsert.completed','g6.bulk.from.catalog'),
    ('catalog.bulk.upsert.rejected','g6.bulk.from.catalog')
  ) routes(event_name,destination)
  WHERE routes.event_name=NEW.event_name
    AND routes.destination=ANY(string_to_array(
      COALESCE(current_setting('catalog.messaging_destinations',true),''),','))
  ON CONFLICT(message_id,destination) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION catalog.enqueue_h5_outbox_deliveries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.enqueue_h5_outbox_deliveries() TO catalog_app;
GRANT SELECT,INSERT ON catalog.outbox_delivery TO catalog_app;
GRANT UPDATE(attempts,available_at,lease_token,published_at,last_error)
  ON catalog.outbox_delivery TO catalog_app;
CREATE TRIGGER tr_catalog_outbox_h5_delivery
AFTER INSERT ON catalog.outbox
FOR EACH ROW EXECUTE FUNCTION catalog.enqueue_h5_outbox_deliveries();

COMMIT;
