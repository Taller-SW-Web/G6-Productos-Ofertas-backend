-- Execute in the migration transaction after the owner sets
-- g6.promotions_h5_runtime_role to the existing runtime role for the environment.
DO $migration$
DECLARE
  role_name text := current_setting('g6.promotions_h5_runtime_role', true);
  runtime_role pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO runtime_role FROM pg_roles WHERE rolname = role_name;
  IF NOT FOUND OR runtime_role.rolsuper OR runtime_role.rolbypassrls OR
    runtime_role.rolcreaterole OR runtime_role.rolcreatedb OR
    runtime_role.rolreplication OR
    NOT has_schema_privilege(runtime_role.oid, 'promotions', 'USAGE') OR
    has_schema_privilege(runtime_role.oid, 'promotions', 'CREATE') OR EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid IN ('promotions.h5_coupon_operations'::regclass, 'promotions.h5_coupon_outbox'::regclass)
        AND pg_has_role(runtime_role.oid, relowner, 'MEMBER')
    )
  THEN
    RAISE EXCEPTION 'INVALID_PROMOTIONS_H5_RUNTIME_ROLE';
  END IF;

  -- The schema owner may grant additional table privileges by default.
  -- Replace direct grants on the new tables with the H5 allowlist only.
  EXECUTE format(
    'REVOKE ALL ON promotions.h5_coupon_operations, promotions.h5_coupon_outbox FROM %I',
    runtime_role.rolname
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON promotions.h5_coupon_operations, promotions.h5_coupon_outbox TO %I',
    runtime_role.rolname
  );
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('promotions.h5_coupon_operations'::regclass, 'promotions.h5_coupon_outbox'::regclass)
      AND has_table_privilege(runtime_role.oid, oid, 'DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')
  ) THEN
    RAISE EXCEPTION 'EXCESS_PROMOTIONS_H5_RUNTIME_PRIVILEGES';
  END IF;
END
$migration$;
