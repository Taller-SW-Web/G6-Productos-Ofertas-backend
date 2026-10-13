-- Corrección incremental de infra_001_seed_access_roles; no recrea roles.
-- Aplicar únicamente con aprobación explícita del administrador autorizado.
DO $seed_grants$
DECLARE s text; r text;
BEGIN
  FOREACH s IN ARRAY ARRAY['taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk'] LOOP
    r := 'po_' || s || '_seed';
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=s AND pg_get_userbyid(nspowner)='po_' || s || '_owner')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
       OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=r)) THEN
      RAISE EXCEPTION 'UNEXPECTED_SCHEMA_OR_SEED_ROLE';
    END IF;
    EXECUTE format('SET LOCAL ROLE %I','po_' || s || '_owner');
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',s,r);
    EXECUTE 'RESET ROLE';
    IF NOT has_schema_privilege(r,s,'USAGE') THEN RAISE EXCEPTION 'SEED_USAGE_GRANT_FAILED'; END IF;
  END LOOP;
END $seed_grants$;

SET LOCAL ROLE po_promotions_owner;
GRANT INSERT (sku,availability,snapshot,source_version,source_occurred_at,source_message_id),
      SELECT (sku,availability,snapshot,source_version,source_occurred_at,source_message_id)
ON promotions.stock_projection TO po_promotions_seed;
RESET ROLE;

DO $grant_check$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['sku','availability','snapshot','source_version','source_occurred_at','source_message_id'] LOOP
    IF NOT has_column_privilege('po_promotions_seed','promotions.stock_projection',c,'INSERT')
       OR NOT has_column_privilege('po_promotions_seed','promotions.stock_projection',c,'SELECT') THEN
      RAISE EXCEPTION 'SEED_COLUMN_GRANT_FAILED';
    END IF;
  END LOOP;
END $grant_check$;
