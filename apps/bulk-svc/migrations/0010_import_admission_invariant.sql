-- New admissions only: historical batches remain unchanged and require separate
-- reconciliation. Deploy only with the approved database preflight in phase D.
-- Deferred validation permits the existing batch -> rows -> receipt transaction.
CREATE OR REPLACE FUNCTION bulk.fn_require_import_admission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
    intent_rows jsonb;
BEGIN
    -- A batch inserted then removed in the same transaction has no admission.
    IF NOT EXISTS (SELECT 1 FROM bulk.batch_jobs WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT payload -> 'rows' INTO intent_rows
    FROM bulk.inbox
    WHERE message_id = NEW.batch_id::text AND handler = 'bulk.import.admission'
      AND correlation_id = NEW.correlation_id::text;

    IF jsonb_typeof(intent_rows) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            CONSTRAINT = 'ck_bulk_import_admission_durable',
            MESSAGE = 'A new import requires durable normalized admission intent';
    END IF;

    IF jsonb_array_length(intent_rows) <> (
        SELECT count(*) FROM bulk.batch_rows WHERE batch_job_id = NEW.id
    ) OR EXISTS (
        SELECT r.row_id::text FROM bulk.batch_rows r
        WHERE r.batch_job_id = NEW.id
        EXCEPT
        SELECT intent ->> 'rowId' FROM jsonb_array_elements(intent_rows) AS intent
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            CONSTRAINT = 'ck_bulk_import_admission_durable',
            MESSAGE = 'Admission intent must cover every persisted import row';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ck_bulk_import_admission_durable ON bulk.batch_jobs;
CREATE CONSTRAINT TRIGGER ck_bulk_import_admission_durable
AFTER INSERT ON bulk.batch_jobs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION bulk.fn_require_import_admission();
