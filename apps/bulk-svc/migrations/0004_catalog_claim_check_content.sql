-- Opaque lookup for the private, immutable JSON document consumed by Catalog.
-- The Storage object reference is visible only inside Bulk persistence.
CREATE TABLE bulk.content_documents (
    content_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    batch_operation_id uuid NOT NULL,
    content_ref text NOT NULL,
    sha256 text NOT NULL,
    byte_length integer NOT NULL,
    content_type text NOT NULL DEFAULT 'application/json',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_content_documents PRIMARY KEY (content_id),
    CONSTRAINT fk_content_documents_batch_id
        FOREIGN KEY (batch_id) REFERENCES bulk.batch_jobs(batch_id) ON DELETE RESTRICT,
    CONSTRAINT uq_content_documents_batch_operation UNIQUE (batch_id, batch_operation_id),
    CONSTRAINT ck_content_documents_sha256 CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_content_documents_byte_length CHECK (byte_length > 0),
    CONSTRAINT ck_content_documents_content_type CHECK (content_type = 'application/json')
);

CREATE INDEX ix_content_documents_batch_id ON bulk.content_documents (batch_id);
REVOKE ALL ON bulk.content_documents FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bulk_app') THEN
        EXECUTE 'GRANT SELECT, INSERT ON bulk.content_documents TO bulk_app';
    END IF;
END;
$$;
