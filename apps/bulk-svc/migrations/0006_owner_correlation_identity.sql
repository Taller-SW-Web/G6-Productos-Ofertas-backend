-- A single human actor may own only one import identity per canonical correlation UUID.
-- Historical rows with owner_sub IS NULL remain unchanged and outside this index.
-- The preflight raises before creating the index; it never deletes or reassigns data.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM bulk.batch_jobs
        WHERE owner_sub IS NOT NULL
        GROUP BY owner_sub, correlation_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate bulk owner_sub/correlation_id identities; resolve data drift explicitly before migration.'
            USING ERRCODE = '23505';
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_jobs_owner_correlation
    ON bulk.batch_jobs (owner_sub, correlation_id)
    WHERE owner_sub IS NOT NULL;
