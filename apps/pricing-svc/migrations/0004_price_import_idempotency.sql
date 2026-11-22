BEGIN;

ALTER TABLE pricing.bulk_price_jobs
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_hash text,
  ADD CONSTRAINT uq_bulk_price_jobs_actor_key UNIQUE (usuario_id, idempotency_key);

COMMIT;
