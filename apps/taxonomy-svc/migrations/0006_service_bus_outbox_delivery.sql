-- Taxonomy H5: execute as po_taxonomy_owner inside one explicit transaction.
-- No historical delivery backfill; incompatible deployments must be reconciled.
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;
LOCK TABLE taxonomy.outbox IN ACCESS EXCLUSIVE MODE;

DO $guard$
DECLARE r record; actual text[];
BEGIN
  IF current_user <> 'po_taxonomy_owner' OR NOT EXISTS (
    SELECT FROM pg_namespace WHERE nspname='taxonomy' AND pg_get_userbyid(nspowner)=current_user
  ) THEN RAISE EXCEPTION 'TAXONOMY_H5_OWNER_REQUIRED'; END IF;
  IF to_regclass('taxonomy.outbox_delivery') IS NOT NULL THEN
    IF NOT EXISTS (SELECT FROM pg_class WHERE oid='taxonomy.outbox_delivery'::regclass AND relkind='r' AND pg_get_userbyid(relowner)=current_user) THEN
      RAISE EXCEPTION 'TAXONOMY_H5_DELIVERY_OWNER_OR_KIND_INCOMPATIBLE';
    END IF;
    SELECT array_agg(a.attname::text ORDER BY k.ordinality) INTO actual
      FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
      WHERE c.conrelid='taxonomy.outbox_delivery'::regclass AND c.contype='p';
    IF actual IS DISTINCT FROM ARRAY['message_id','destination']::text[] THEN
      RAISE EXCEPTION 'TAXONOMY_H5_DELIVERY_PK_INCOMPATIBLE';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='taxonomy.outbox_delivery'::regclass AND contype='f' AND confrelid='taxonomy.outbox'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (message_id) REFERENCES taxonomy.outbox(message_id)%') THEN
      RAISE EXCEPTION 'TAXONOMY_H5_DELIVERY_FK_INCOMPATIBLE';
    END IF;
    FOR r IN SELECT * FROM (VALUES ('message_id','uuid'),('destination','text'),('route_version','integer'),('created_at','timestamp with time zone'),('next_attempt_at','timestamp with time zone'),('attempts','integer'),('lease_token','uuid'),('lease_until','timestamp with time zone'),('sent_at','timestamp with time zone'),('last_error','text')) AS x(col,typ)
    LOOP
      IF EXISTS (SELECT FROM pg_attribute WHERE attrelid='taxonomy.outbox_delivery'::regclass AND attname=r.col AND NOT attisdropped AND format_type(atttypid,atttypmod)<>r.typ) THEN
        RAISE EXCEPTION 'TAXONOMY_H5_COLUMN_INCOMPATIBLE: %',r.col;
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (SELECT FROM pg_attribute WHERE attrelid='taxonomy.outbox'::regclass AND attname='delivery_transport' AND NOT attisdropped AND format_type(atttypid,atttypmod)<>'text') THEN
    RAISE EXCEPTION 'TAXONOMY_H5_TRANSPORT_INCOMPATIBLE';
  END IF;
  IF to_regprocedure('taxonomy.enqueue_catalog_delivery_h5()') IS NOT NULL OR EXISTS (
    SELECT FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='taxonomy.outbox'::regclass AND NOT t.tgisinternal
      AND (t.tgname='taxonomy_enqueue_catalog_delivery_h5' OR (t.tgname='trg_taxonomy_catalog_h5' AND p.proname<>'fn_enqueue_catalog_h5') OR (t.tgname<>'trg_taxonomy_catalog_h5' AND p.prosrc ~* 'outbox_delivery'))
  ) THEN RAISE EXCEPTION 'TAXONOMY_H5_ALTERNATE_WRITER'; END IF;
  IF to_regprocedure('taxonomy.fn_enqueue_catalog_h5()') IS NOT NULL AND EXISTS (
    SELECT FROM pg_proc WHERE oid=to_regprocedure('taxonomy.fn_enqueue_catalog_h5()') AND (prosecdef OR pg_get_userbyid(proowner)<>current_user OR prorettype<>'trigger'::regtype OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR regexp_replace(prosrc, '\s+', '', 'g') IS DISTINCT FROM regexp_replace($expected$
BEGIN
  IF NEW.event_name NOT IN (
    'taxonomy.category.updated', 'taxonomy.product-type-schema.changed',
    'taxonomy.characteristic-value.updated', 'taxonomy.master.deactivation.check.requested',
    'taxonomy.master.deactivated', 'taxonomy.master.deactivation.rejected'
  ) THEN RAISE EXCEPTION 'Unsupported Taxonomy H5 route'; END IF;
  INSERT INTO taxonomy.outbox_delivery (message_id, destination)
  VALUES (NEW.message_id, 'g6.catalog.from.taxonomy');
  RETURN NEW;
END;
$expected$, '\s+', '', 'g'))
  ) THEN RAISE EXCEPTION 'TAXONOMY_H5_FUNCTION_INCOMPATIBLE'; END IF;
END
$guard$;

ALTER TABLE taxonomy.outbox ADD COLUMN IF NOT EXISTS delivery_transport text NOT NULL DEFAULT 'RABBITMQ';
ALTER TABLE taxonomy.outbox ALTER COLUMN delivery_transport SET NOT NULL;
ALTER TABLE taxonomy.outbox ALTER COLUMN delivery_transport SET DEFAULT COALESCE(NULLIF(current_setting('g6.taxonomy_messaging',true),''),'RABBITMQ');
CREATE TABLE IF NOT EXISTS taxonomy.outbox_delivery (
  message_id uuid NOT NULL REFERENCES taxonomy.outbox(message_id) ON DELETE RESTRICT,
  destination text NOT NULL, route_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
  sent_at timestamptz, last_error text, PRIMARY KEY(message_id,destination)
);
ALTER TABLE taxonomy.outbox_delivery ADD COLUMN IF NOT EXISTS route_version integer NOT NULL DEFAULT 1;
ALTER TABLE taxonomy.outbox_delivery ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE taxonomy.outbox_delivery ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE taxonomy.outbox_delivery ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE taxonomy.outbox_delivery ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE taxonomy.outbox_delivery ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE taxonomy.outbox_delivery ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE taxonomy.outbox_delivery ADD COLUMN IF NOT EXISTS last_error text;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='taxonomy.outbox'::regclass AND conname='taxonomy_outbox_delivery_transport_valid') THEN
    ALTER TABLE taxonomy.outbox ADD CONSTRAINT taxonomy_outbox_delivery_transport_valid CHECK (delivery_transport IN ('RABBITMQ','AZURE_SERVICE_BUS'));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='taxonomy.outbox_delivery'::regclass AND conname='taxonomy_h5_delivery_invariants') THEN
    ALTER TABLE taxonomy.outbox_delivery ADD CONSTRAINT taxonomy_h5_delivery_invariants CHECK (destination='g6.catalog.from.taxonomy' AND route_version=1 AND attempts>=0 AND ((lease_token IS NULL)=(lease_until IS NULL)));
  END IF;
END
$constraints$;
CREATE INDEX IF NOT EXISTS ix_taxonomy_delivery_pending ON taxonomy.outbox_delivery(next_attempt_at,created_at) WHERE sent_at IS NULL;
DO $function$
BEGIN
  IF to_regprocedure('taxonomy.fn_enqueue_catalog_h5()') IS NULL THEN
    EXECUTE $ddl$CREATE FUNCTION taxonomy.fn_enqueue_catalog_h5() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
      BEGIN
        IF NEW.event_name NOT IN ('taxonomy.category.updated','taxonomy.product-type-schema.changed','taxonomy.characteristic-value.updated','taxonomy.master.deactivation.check.requested','taxonomy.master.deactivated','taxonomy.master.deactivation.rejected') THEN
          RAISE EXCEPTION 'Unsupported Taxonomy H5 route';
        END IF;
        INSERT INTO taxonomy.outbox_delivery(message_id,destination) VALUES (NEW.message_id,'g6.catalog.from.taxonomy');
        RETURN NEW;
      END;
      $body$$ddl$;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid='taxonomy.outbox'::regclass AND tgname='trg_taxonomy_catalog_h5' AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_taxonomy_catalog_h5 AFTER INSERT ON taxonomy.outbox FOR EACH ROW
      WHEN (NEW.delivery_transport='AZURE_SERVICE_BUS') EXECUTE FUNCTION taxonomy.fn_enqueue_catalog_h5();
  ELSIF NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid='taxonomy.outbox'::regclass AND tgname='trg_taxonomy_catalog_h5' AND NOT tgisinternal AND tgenabled IN ('O','A') AND pg_get_triggerdef(oid) LIKE '%delivery_transport%AZURE_SERVICE_BUS%') THEN
    RAISE EXCEPTION 'TAXONOMY_H5_TRIGGER_INCOMPATIBLE';
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION taxonomy.fn_enqueue_catalog_h5() FROM PUBLIC;
REVOKE ALL ON taxonomy.outbox_delivery FROM PUBLIC;
REVOKE ALL (message_id,destination,route_version,created_at,next_attempt_at,attempts,lease_token,lease_until,sent_at,last_error) ON taxonomy.outbox_delivery FROM PUBLIC;
DO $acl$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON taxonomy.outbox_delivery FROM %I', role_name);
      EXECUTE format('REVOKE ALL (message_id,destination,route_version,created_at,next_attempt_at,attempts,lease_token,lease_until,sent_at,last_error) ON taxonomy.outbox_delivery FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION taxonomy.fn_enqueue_catalog_h5() FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='taxonomy_app') THEN
    REVOKE ALL ON taxonomy.outbox_delivery FROM taxonomy_app;
    REVOKE ALL (message_id,destination,route_version,created_at,next_attempt_at,attempts,lease_token,lease_until,sent_at,last_error) ON taxonomy.outbox_delivery FROM taxonomy_app;
    GRANT USAGE ON SCHEMA taxonomy TO taxonomy_app;
    GRANT EXECUTE ON FUNCTION taxonomy.fn_enqueue_catalog_h5() TO taxonomy_app;
    GRANT SELECT,INSERT ON taxonomy.outbox_delivery TO taxonomy_app;
    GRANT UPDATE (next_attempt_at,attempts,lease_token,lease_until,sent_at,last_error) ON taxonomy.outbox_delivery TO taxonomy_app;
  END IF;
END
$acl$;
