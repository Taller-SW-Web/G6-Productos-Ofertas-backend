-- Bulk actor ownership for private imports and export jobs.
-- Existing rows stay NULL because their authenticated owner cannot be recovered safely.
-- Forward rollback strategy: retain these nullable columns/indexes after deploy;
-- reverting to a build that ignores them is safe, but dropping them after new
-- owner assignments would erase isolation data and therefore is not a safe rollback.
ALTER TABLE bulk.batch_jobs
    ADD COLUMN IF NOT EXISTS owner_sub uuid;

ALTER TABLE bulk.export_jobs
    ADD COLUMN IF NOT EXISTS owner_sub uuid;

CREATE INDEX IF NOT EXISTS ix_batch_jobs_owner_created_at
    ON bulk.batch_jobs (owner_sub, created_at);

CREATE INDEX IF NOT EXISTS ix_export_jobs_owner_created_at
    ON bulk.export_jobs (owner_sub, created_at);
