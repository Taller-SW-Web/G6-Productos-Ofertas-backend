BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;
LOCK TABLE catalog.outbox IN ACCESS EXCLUSIVE MODE;

DO $preflight$
BEGIN
    IF current_user <> 'po_catalog_owner' OR NOT EXISTS (
        SELECT 1 FROM pg_namespace
        WHERE nspname = 'catalog' AND pg_get_userbyid(nspowner) = current_user
    ) THEN
        RAISE EXCEPTION 'Catalog H5 requires po_catalog_owner';
    END IF;

    IF to_regclass('catalog.outbox_delivery') IS NULL THEN
        RAISE EXCEPTION 'Catalog H5 requires the compatible 0001 outbox_delivery table first';
    END IF;
END;
$preflight$;

LOCK TABLE catalog.outbox_delivery IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'catalog.outbox_delivery'::regclass AND contype = 'p'
          AND pg_get_constraintdef(oid) = 'PRIMARY KEY (message_id, destination)'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'catalog.outbox_delivery'::regclass AND contype = 'f'
          AND confrelid = 'catalog.outbox'::regclass
          AND pg_get_constraintdef(oid) = 'FOREIGN KEY (message_id) REFERENCES catalog.outbox(message_id)'
    ) OR EXISTS (
        SELECT 1 FROM (VALUES
            ('message_id', 'uuid'), ('destination', 'text'),
            ('attempts', 'integer'), ('created_at', 'timestamp with time zone'),
            ('available_at', 'timestamp with time zone'), ('lease_token', 'uuid'),
            ('published_at', 'timestamp with time zone'), ('last_error', 'text')
        ) AS required(name, type)
        WHERE NOT EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = 'catalog.outbox_delivery'::regclass AND NOT a.attisdropped
              AND a.attname = required.name AND format_type(a.atttypid, a.atttypmod) = required.type
        )
    ) THEN
        RAISE EXCEPTION 'Catalog H5 outbox_delivery shape differs from 0001';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'catalog.outbox'::regclass AND NOT tgisinternal
          AND tgname IN ('tr_catalog_outbox_h5_delivery', 'trg_catalog_taxonomy_reply_transport')
    ) OR to_regprocedure('catalog.enqueue_h5_outbox_deliveries()') IS NOT NULL THEN
        RAISE EXCEPTION 'Catalog H5 has an existing or alternate writer; reconcile before applying';
    END IF;

    IF EXISTS (SELECT 1 FROM catalog.outbox_delivery) THEN
        RAISE EXCEPTION 'Catalog H5 has unclassified deliveries; reconcile by message ID before applying';
    END IF;
END;
$preflight$;

-- Historical and ordinary Catalog publications keep the H4 transport.
ALTER TABLE catalog.outbox
    ADD COLUMN delivery_transport text NOT NULL DEFAULT 'RABBITMQ'
    CHECK (delivery_transport IN ('RABBITMQ', 'AZURE_SERVICE_BUS'));

CREATE FUNCTION catalog.mark_taxonomy_reply_transport()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF current_setting('g6.catalog_taxonomy_reply', true) = 'AZURE_SERVICE_BUS'
    THEN
        NEW.delivery_transport := 'AZURE_SERVICE_BUS';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION catalog.mark_taxonomy_reply_transport() FROM PUBLIC;

CREATE TRIGGER trg_catalog_taxonomy_reply_transport
BEFORE INSERT ON catalog.outbox
FOR EACH ROW WHEN (NEW.event_name = 'catalog.master.deactivation.checked')
EXECUTE FUNCTION catalog.mark_taxonomy_reply_transport();

COMMIT;
