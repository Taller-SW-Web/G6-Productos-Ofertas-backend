-- Execute only through an authorized runtime login. The caller sets the target
-- schema and expected role using psql variables. This transaction is read-only.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '2s';

SELECT jsonb_build_object(
  'database', current_database(),
  'login_role', session_user,
  'effective_role', current_user,
  'ssl_in_use', COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false),
  'schema_exists', EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = :'schema'),
  'schema_usage', CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = :'schema'
  ) THEN has_schema_privilege(current_user, :'schema', 'USAGE') ELSE false END,
  'expected_role_exists', EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'expected_role'),
  'expected_role_inherited', CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'expected_role')
    THEN pg_has_role(session_user, :'expected_role', 'MEMBER') ELSE false END,
  'h5_table_exists', to_regclass(format('%I.%I', :'schema', :'h5_table')) IS NOT NULL,
  'h5_table_select', CASE WHEN to_regclass(format('%I.%I', :'schema', :'h5_table')) IS NOT NULL
    THEN has_table_privilege(session_user, format('%I.%I', :'schema', :'h5_table'), 'SELECT') ELSE false END,
  'h5_table_insert', CASE WHEN to_regclass(format('%I.%I', :'schema', :'h5_table')) IS NOT NULL
    THEN has_table_privilege(session_user, format('%I.%I', :'schema', :'h5_table'), 'INSERT') ELSE false END,
  'h5_table_update', CASE WHEN to_regclass(format('%I.%I', :'schema', :'h5_table')) IS NOT NULL
    THEN has_table_privilege(session_user, format('%I.%I', :'schema', :'h5_table'), 'UPDATE') ELSE false END
);

ROLLBACK;
