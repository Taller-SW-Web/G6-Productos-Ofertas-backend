-- Ejecutar únicamente con acceso autorizado de lectura; no aplica migraciones.
BEGIN READ ONLY;

SELECT current_database() AS database_name, current_user AS runtime_role,
       current_setting('g6.taxonomy_messaging', true) AS delivery_transport;

SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'taxonomy'
  AND table_name IN ('outbox', 'outbox_delivery', 'inbox')
ORDER BY table_name, ordinal_position;

SELECT c.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'taxonomy' AND c.relname IN ('outbox', 'outbox_delivery', 'inbox')
ORDER BY c.relname, con.conname;

SELECT c.relname AS table_name, t.tgname, t.tgenabled,
       pg_get_userbyid(p.proowner) AS function_owner, p.prosecdef AS security_definer,
       pg_get_triggerdef(t.oid) AS definition
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'taxonomy' AND c.relname = 'outbox' AND NOT t.tgisinternal
ORDER BY t.tgname;

SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'taxonomy' AND table_name IN ('outbox', 'outbox_delivery', 'inbox')
ORDER BY table_name, grantee, privilege_type;

SELECT grantee, table_name, column_name, privilege_type
FROM information_schema.role_column_grants
WHERE table_schema = 'taxonomy' AND table_name = 'outbox_delivery'
ORDER BY grantee, column_name, privilege_type;


-- Inventario visible también para el rol runtime; no cambia privilegios ni roles.
SELECT n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
       c.relacl AS explicit_acl
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'taxonomy'
  AND c.relname IN ('outbox', 'outbox_delivery', 'inbox', 'schema_migrations')
ORDER BY c.relname;

SELECT member.rolname AS member, role.rolname AS granted_role,
       m.admin_option, m.inherit_option, m.set_option
FROM pg_catalog.pg_auth_members m
JOIN pg_catalog.pg_roles member ON member.oid = m.member
JOIN pg_catalog.pg_roles role ON role.oid = m.roleid
WHERE member.rolname IN (current_user, 'taxonomy_app', 'po_taxonomy_owner')
ORDER BY member.rolname, role.rolname;

SELECT c.relname, p.privilege,
       has_table_privilege(current_user, c.oid, p.privilege) AS effective
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
WHERE n.nspname = 'taxonomy' AND c.relname IN ('outbox', 'outbox_delivery', 'inbox')
ORDER BY c.relname, p.privilege;

SELECT pg_get_userbyid(d.defaclrole) AS owner, n.nspname, d.defaclobjtype,
       d.defaclacl AS default_acl
FROM pg_catalog.pg_default_acl d
LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'taxonomy' OR (d.defaclnamespace = 0 AND
      pg_get_userbyid(d.defaclrole) = 'po_taxonomy_owner')
ORDER BY owner, n.nspname, d.defaclobjtype;

SELECT p.oid::regprocedure AS function_name, pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer, p.proconfig, p.proacl AS explicit_acl,
       has_function_privilege(current_user, p.oid, 'EXECUTE') AS effective_execute
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'taxonomy'
ORDER BY function_name;

-- El ledger oficial es taxonomy.schema_migrations. No supone permiso de SELECT.
SELECT to_regclass('taxonomy.schema_migrations') AS official_ledger,
       CASE WHEN to_regclass('taxonomy.schema_migrations') IS NULL THEN false
            ELSE has_table_privilege(current_user, to_regclass('taxonomy.schema_migrations'), 'SELECT') END AS ledger_readable,
       CASE WHEN to_regclass('taxonomy.schema_migrations') IS NOT NULL
                  AND has_table_privilege(current_user, to_regclass('taxonomy.schema_migrations'), 'SELECT')
            THEN query_to_xml('SELECT * FROM taxonomy.schema_migrations ORDER BY 1', false, true, '')
            ELSE NULL END AS ledger_rows;

-- La variante #247 incluye published_at; la integrada usa sent_at y destino.
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
               WHERE attrelid = to_regclass('taxonomy.outbox_delivery')
                 AND attname = 'published_at' AND NOT attisdropped) AS incompatible_247_published_at,
       to_regprocedure('taxonomy.enqueue_catalog_delivery_h5()') IS NOT NULL AS incompatible_247_function,
       EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'taxonomy_enqueue_catalog_delivery_h5'
               AND tgrelid = to_regclass('taxonomy.outbox') AND NOT tgisinternal) AS incompatible_247_trigger,
       EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
               WHERE attrelid = to_regclass('taxonomy.outbox_delivery')
                 AND attname = 'sent_at' AND NOT attisdropped) AS integrated_sent_at;

ROLLBACK;
