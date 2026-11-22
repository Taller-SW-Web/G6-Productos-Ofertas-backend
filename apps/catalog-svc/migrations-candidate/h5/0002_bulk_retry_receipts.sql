BEGIN;

CREATE TABLE IF NOT EXISTS catalog.bulk_retry_command_receipts (
    command_attempt_id uuid NOT NULL,
    message_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    batch_operation_id uuid NOT NULL,
    previous_command_message_id uuid NOT NULL,
    payload_hash char(64) NOT NULL,
    result_message_id uuid,
    result_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT pk_catalog_bulk_retry_command_receipts PRIMARY KEY (command_attempt_id),
    CONSTRAINT uq_catalog_bulk_retry_command_message UNIQUE (message_id),
    CONSTRAINT ck_catalog_bulk_retry_command_payload_hash CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_catalog_bulk_retry_command_result_pair CHECK (
        (result_message_id IS NULL) = (result_payload IS NULL)
        AND (completed_at IS NULL) = (result_message_id IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS catalog.bulk_retry_attempt_receipts (
    attempt_id uuid NOT NULL,
    command_attempt_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    batch_operation_id uuid NOT NULL,
    row_operation_id uuid NOT NULL,
    previous_attempt_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    payload_hash char(64) NOT NULL,
    status text NOT NULL,
    effect_state text NOT NULL,
    retriable boolean NOT NULL DEFAULT false,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_catalog_bulk_retry_attempt_receipts PRIMARY KEY (attempt_id),
    CONSTRAINT fk_catalog_bulk_retry_attempt_command
        FOREIGN KEY (command_attempt_id)
        REFERENCES catalog.bulk_retry_command_receipts(command_attempt_id),
    CONSTRAINT uq_catalog_bulk_retry_attempt_row_number UNIQUE (row_operation_id, attempt_number),
    CONSTRAINT uq_catalog_bulk_retry_previous_attempt UNIQUE (previous_attempt_id),
    CONSTRAINT ck_catalog_bulk_retry_attempt_number CHECK (attempt_number >= 2),
    CONSTRAINT ck_catalog_bulk_retry_attempt_payload_hash CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    CONSTRAINT ck_catalog_bulk_retry_attempt_status CHECK (status IN ('COMPLETED','REJECTED','UNKNOWN')),
    CONSTRAINT ck_catalog_bulk_retry_attempt_effect CHECK (effect_state IN ('NONE','APPLIED','UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS ix_catalog_bulk_retry_attempt_command
    ON catalog.bulk_retry_attempt_receipts(command_attempt_id, row_operation_id);

REVOKE ALL ON catalog.bulk_retry_command_receipts,
    catalog.bulk_retry_attempt_receipts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON catalog.bulk_retry_command_receipts,
    catalog.bulk_retry_attempt_receipts TO catalog_app;

COMMIT;
