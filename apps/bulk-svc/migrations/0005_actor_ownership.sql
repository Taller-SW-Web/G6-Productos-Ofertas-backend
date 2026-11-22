-- Bulk actor ownership for private imports and export jobs.
-- Existing rows stay NULL because their authenticated owner cannot be recovered safely.
-- Rollback policy: retain this migration and run only service versions that still
-- enforce actor ownership on every read. Never roll back to code that reads jobs
-- by UUID without checking owner_sub. Do not infer owners for historical rows.
ALTER TABLE bulk.batch_jobs
    ADD COLUMN IF NOT EXISTS owner_sub uuid;

ALTER TABLE bulk.export_jobs
    ADD COLUMN IF NOT EXISTS owner_sub uuid;

CREATE INDEX IF NOT EXISTS ix_batch_jobs_owner_created_at
    ON bulk.batch_jobs (owner_sub, created_at);

CREATE INDEX IF NOT EXISTS ix_export_jobs_owner_created_at
    ON bulk.export_jobs (owner_sub, created_at);
