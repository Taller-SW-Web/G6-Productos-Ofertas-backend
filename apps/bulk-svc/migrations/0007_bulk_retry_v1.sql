-- Additive durable receipts and commands for BULK_RETRY_V1.
-- This migration is intentionally not applied to shared Supabase.
-- Preserve one initial command per operation/event while allowing a new retry
-- command with the same business operation to be causally distinct.
ALTER TABLE bulk.outbox
    DROP CONSTRAINT IF EXISTS uq_outbox_operation_event;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_initial_operation_event
    ON bulk.outbox (operation_id, event_name)
    WHERE causation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_retry_causation_event
    ON bulk.outbox (operation_id, event_name, causation_id)
    WHERE causation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bulk.batch_resume_requests (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    batch_job_id uuid NOT NULL,
    owner_sub uuid NOT NULL,
    correlation_id uuid NOT NULL,
    intent_hash char(64) NOT NULL,
    accepted_response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_batch_resume_requests PRIMARY KEY (id),
    CONSTRAINT fk_batch_resume_requests_batch_job_id
        FOREIGN KEY (batch_job_id) REFERENCES bulk.batch_jobs(id) ON DELETE RESTRICT,
    CONSTRAINT uq_batch_resume_requests_batch_correlation
        UNIQUE (batch_job_id, correlation_id),
    CONSTRAINT ck_batch_resume_requests_intent_hash
        CHECK (intent_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS bulk.retry_commands (
    command_attempt_id uuid NOT NULL,
    resume_request_id uuid NOT NULL,
    batch_job_id uuid NOT NULL,
    domain text NOT NULL,
    family_key text NOT NULL,
    business_operation_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    message_id uuid NOT NULL,
    previous_message_id uuid NOT NULL,
    payload_hash char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_retry_commands PRIMARY KEY (command_attempt_id),
    CONSTRAINT fk_retry_commands_resume_request_id
        FOREIGN KEY (resume_request_id) REFERENCES bulk.batch_resume_requests(id) ON DELETE RESTRICT,
    CONSTRAINT fk_retry_commands_batch_job_id
        FOREIGN KEY (batch_job_id) REFERENCES bulk.batch_jobs(id) ON DELETE RESTRICT,
    CONSTRAINT uq_retry_commands_message_id UNIQUE (message_id),
    CONSTRAINT uq_retry_commands_request_family UNIQUE (resume_request_id, family_key),
    CONSTRAINT ck_retry_commands_domain CHECK (domain = 'CATALOGO'),
    CONSTRAINT ck_retry_commands_attempt_number CHECK (attempt_number >= 2),
    CONSTRAINT ck_retry_commands_payload_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS bulk.domain_attempts (
    attempt_id uuid NOT NULL,
    batch_row_id uuid NOT NULL,
    domain text NOT NULL,
    business_operation_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    previous_attempt_id uuid,
    command_attempt_id uuid,
    status text NOT NULL,
    effect_state text NOT NULL,
    retriable boolean NOT NULL DEFAULT false,
    receipt_message_id uuid,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_domain_attempts PRIMARY KEY (attempt_id),
    CONSTRAINT fk_domain_attempts_batch_row_id
        FOREIGN KEY (batch_row_id) REFERENCES bulk.batch_rows(id) ON DELETE RESTRICT,
    CONSTRAINT fk_domain_attempts_previous_attempt_id
        FOREIGN KEY (previous_attempt_id) REFERENCES bulk.domain_attempts(attempt_id) ON DELETE RESTRICT,
    CONSTRAINT fk_domain_attempts_command_attempt_id
        FOREIGN KEY (command_attempt_id) REFERENCES bulk.retry_commands(command_attempt_id) ON DELETE RESTRICT,
    CONSTRAINT uq_domain_attempts_row_domain_number UNIQUE (batch_row_id, domain, attempt_number),
    CONSTRAINT ck_domain_attempts_domain CHECK (domain = 'CATALOGO'),
    CONSTRAINT ck_domain_attempts_attempt_number CHECK (attempt_number >= 1),
    CONSTRAINT ck_domain_attempts_status CHECK (status IN ('PENDING','COMPLETED','REJECTED','UNKNOWN')),
    CONSTRAINT ck_domain_attempts_effect_state CHECK (effect_state IN ('NONE','APPLIED','UNKNOWN'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_domain_attempts_previous_attempt
    ON bulk.domain_attempts (previous_attempt_id)
    WHERE previous_attempt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_domain_attempts_row_domain_current
    ON bulk.domain_attempts (batch_row_id, domain, attempt_number DESC);

CREATE INDEX IF NOT EXISTS ix_retry_commands_batch_family
    ON bulk.retry_commands (batch_job_id, family_key, created_at DESC);
