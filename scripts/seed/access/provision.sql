-- Issue #1: ejecutar con una cuenta administrativa individual autorizada.
-- Provisionamiento incremental de roles de carga; no es un segundo historial de DDL.
-- No modifica schemas, owners, tablas, roles runtime ni migraciones históricas.
DO $seed_roles$
DECLARE s text; r text;
BEGIN
  FOREACH s IN ARRAY ARRAY['taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk'] LOOP
    r := 'po_' || s || '_seed';
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=s AND pg_get_userbyid(nspowner)='po_' || s || '_owner') THEN
      RAISE EXCEPTION 'UNEXPECTED_SCHEMA_OWNER';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
       OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=r)) THEN
      RAISE EXCEPTION 'UNEXPECTED_SEED_ROLE_ATTRIBUTES_OR_MEMBERSHIP';
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',s,r);
  END LOOP;
END $seed_roles$;

-- Única tabla habilitada para el fixture aprobado de Promociones.
-- Los demás owners añaden grants de columnas solo al registrar sus seeds revisados.
GRANT INSERT (sku,availability,snapshot,source_version,source_occurred_at,source_message_id),
      SELECT (sku,availability,snapshot,source_version,source_occurred_at,source_message_id)
ON promotions.stock_projection TO po_promotions_seed;

-- SET ROLE desde el MCP administrativo permite la prueba con el rol restringido.
-- No concede a los seed roles membresía de owners ni runtime.
GRANT po_taxonomy_seed, po_catalog_seed, po_pricing_seed, po_price_audit_seed,
      po_promotions_seed, po_combos_seed, po_inventory_seed, po_bulk_seed
TO postgres WITH INHERIT FALSE, SET TRUE;
