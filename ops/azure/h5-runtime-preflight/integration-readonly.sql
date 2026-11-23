-- HTTP-bootstrap connection probe only. H5-specific tables and DML grants are
-- checked separately and only when that service's H5 feature is enabled.
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
    THEN pg_has_role(session_user, :'expected_role', 'MEMBER') ELSE false END
);

ROLLBACK;
