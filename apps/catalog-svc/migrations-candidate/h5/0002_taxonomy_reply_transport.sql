BEGIN;

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

CREATE TRIGGER trg_catalog_taxonomy_reply_transport
BEFORE INSERT ON catalog.outbox
FOR EACH ROW WHEN (NEW.event_name = 'catalog.master.deactivation.checked')
EXECUTE FUNCTION catalog.mark_taxonomy_reply_transport();

COMMIT;
