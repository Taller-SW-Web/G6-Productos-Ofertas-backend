-- INFRA-001 actualizado: preparación no secreta de seis cuentas individuales.
-- PASSWORD NULL deja la autenticación cerrada hasta asignar contraseña con psql \password.
-- No se rota una contraseña existente ni se cambia ningún owner/runtime.
DO $members$
DECLARE member_record record; schema_name text; load_role text;
BEGIN
  FOR member_record IN SELECT * FROM (VALUES
    ('seed_cueva', ARRAY['promotions']),
    ('seed_lopez', ARRAY['taxonomy']),
    ('seed_poma', ARRAY['catalog']),
    ('seed_taco', ARRAY['inventory']),
    ('seed_vera', ARRAY['pricing','price_audit']),
    ('seed_castilla', ARRAY['combos','bulk'])
  ) AS members(login,schemas) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=member_record.login) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3 PASSWORD NULL', member_record.login);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=member_record.login AND
      (NOT rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
      OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname<>member_record.login
        AND rolname <> ALL(ARRAY(SELECT 'po_'||s||'_seed' FROM unnest(member_record.schemas) s))
        AND pg_has_role(member_record.login,oid,'MEMBER')) THEN
      RAISE EXCEPTION 'UNEXPECTED_MEMBER_PRIVILEGES';
    END IF;
    FOREACH schema_name IN ARRAY member_record.schemas LOOP
      load_role := 'po_'||schema_name||'_seed';
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=load_role AND
        NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
        RAISE EXCEPTION 'UNEXPECTED_SEED_ROLE';
      END IF;
      EXECUTE format('GRANT %I TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',load_role,member_record.login);
    END LOOP;
  END LOOP;
END $members$;

-- Carga inicial append-only de tablas ya existentes, con constraints/triggers activos.
-- No concede UPDATE/DELETE/TRUNCATE/CREATE ni acceso a ledger/inbox/outbox/recibos.
-- No hay default privileges: futuras tablas requieren revisión de su owner.
DO $load_permissions$
DECLARE schema_name text; table_record record; load_role text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk'] LOOP
    load_role := 'po_'||schema_name||'_seed';
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=schema_name AND pg_get_userbyid(nspowner)='po_'||schema_name||'_owner') THEN
      RAISE EXCEPTION 'UNEXPECTED_SCHEMA_OWNER';
    END IF;
    EXECUTE format('SET LOCAL ROLE %I','po_'||schema_name||'_owner');
    FOR table_record IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=schema_name AND c.relkind='r'
        AND c.relname NOT IN ('schema_migrations','inbox','outbox','coupon_command_receipts') LOOP
      EXECUTE format('GRANT SELECT, INSERT ON TABLE %I.%I TO %I',schema_name,table_record.relname,load_role);
    END LOOP;
    EXECUTE 'RESET ROLE';
  END LOOP;
END $load_permissions$;

-- Helpers de validación invoker que necesitan los triggers/CHECK existentes.
-- No se concede ejecución de consumir/restaurar cupones ni del archiver DEFINER.
DO $helpers$
DECLARE helper record; function_oid regprocedure;
BEGIN
  FOR helper IN SELECT * FROM (VALUES
    ('catalog','catalog.fn_assert_product(uuid)'),
    ('catalog','catalog.fn_row_product(jsonb,text)'),
    ('combos','combos.fn_assert_combo_min_components(uuid)'),
    ('promotions','promotions.fn_valid_channels(text[])'),
    ('promotions','promotions.fn_normalize_code(text)')
  ) AS helpers(schema_name,signature) LOOP
    function_oid := helper.signature::regprocedure;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=function_oid AND prosecdef) THEN
      RAISE EXCEPTION 'DEFINER_NOT_ALLOWED';
    END IF;
    EXECUTE format('SET LOCAL ROLE %I','po_'||helper.schema_name||'_owner');
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',function_oid,'po_'||helper.schema_name||'_seed');
    EXECUTE 'RESET ROLE';
  END LOOP;
END $helpers$;
