BEGIN;

CREATE TABLE bulk.outbox_delivery (
    message_id text NOT NULL REFERENCES bulk.outbox (message_id),
    destination text NOT NULL CHECK (destination = 'g6.catalog.from.bulk'),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    published_at timestamptz,
    last_error text,
    PRIMARY KEY (message_id, destination),
    CHECK (published_at IS NULL OR lease_token IS NULL)
);

CREATE INDEX ix_outbox_delivery_pending
    ON bulk.outbox_delivery (available_at, created_at, message_id, destination)
    WHERE published_at IS NULL;

INSERT INTO bulk.outbox_delivery (message_id, destination)
SELECT message_id, 'g6.catalog.from.bulk'
FROM bulk.outbox
WHERE event_name = 'catalog.bulk.upsert.requested'
ON CONFLICT (message_id, destination) DO NOTHING;

REVOKE ALL ON bulk.outbox_delivery FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bulk_app') THEN
        EXECUTE 'GRANT SELECT, INSERT ON bulk.outbox_delivery TO bulk_app';
        EXECUTE 'GRANT UPDATE (attempts, available_at, lease_token, published_at, last_error) ON bulk.outbox_delivery TO bulk_app';
    END IF;
END;
$$;

COMMIT;
