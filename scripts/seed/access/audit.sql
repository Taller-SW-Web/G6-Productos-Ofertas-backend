-- Auditoría de lectura; ejecutar antes y después del provisionamiento/prueba.
SELECT current_setting('server_version') AS server_version;

SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner,
       count(c.oid) FILTER (WHERE c.relkind='r') AS tables, n.nspacl AS schema_acl
FROM pg_namespace n
LEFT JOIN pg_class c ON c.relnamespace=n.oid
WHERE n.nspname IN ('taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk')
GROUP BY n.oid ORDER BY 1;

SELECT n.nspname AS schema, c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS owner, c.relacl AS table_acl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk')
  AND c.relkind='r' ORDER BY 1,2;

SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
       rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname ~ '^po_.*_(owner|runtime|seed)$'
   OR rolname IN ('taxonomy_app','catalog_app','pricing_app','price_audit_app','price_audit_archiver')
ORDER BY rolname;

SELECT pg_get_userbyid(roleid) AS granted_role, pg_get_userbyid(member) AS member,
       admin_option, inherit_option, set_option
FROM pg_auth_members
WHERE pg_get_userbyid(roleid) LIKE 'po_%' ORDER BY 1,2;

SELECT r.rolname, n.nspname,
       has_schema_privilege(r.oid,n.oid,'USAGE') AS usage,
       has_schema_privilege(r.oid,n.oid,'CREATE') AS create_objects
FROM pg_roles r CROSS JOIN pg_namespace n
WHERE (r.rolname LIKE 'po_%' OR r.rolname IN ('anon','authenticated','taxonomy_app','catalog_app','pricing_app','price_audit_app','price_audit_archiver'))
  AND n.nspname IN ('taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk')
  AND (has_schema_privilege(r.oid,n.oid,'USAGE') OR has_schema_privilege(r.oid,n.oid,'CREATE'))
ORDER BY 1,2;

-- information_schema.column_privileges filtra por visibilidad del auditor;
-- usar privilegios efectivos para comprobar las concesiones del rol de carga.
SELECT a.attname AS column_name,
       has_column_privilege('po_promotions_seed',a.attrelid,a.attname,'SELECT') AS can_select,
       has_column_privilege('po_promotions_seed',a.attrelid,a.attname,'INSERT') AS can_insert,
       has_column_privilege('po_promotions_seed',a.attrelid,a.attname,'UPDATE') AS can_update
FROM pg_attribute a
WHERE a.attrelid='promotions.stock_projection'::regclass
  AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum;

SELECT n.nspname, a.privilege_type
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
WHERE n.nspname IN ('taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk')
  AND a.grantee=0;

SELECT c.conname AS cross_schema_fk
FROM pg_constraint c
JOIN pg_class a ON a.oid=c.conrelid
JOIN pg_class b ON b.oid=c.confrelid
JOIN pg_namespace n ON n.oid=a.relnamespace
WHERE c.contype='f' AND a.relnamespace<>b.relnamespace
  AND n.nspname IN ('taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk');

-- Baseline del fixture; comparar antes/después. No devuelve datos personales.
SELECT count(*) AS stock_projection_rows,
       md5(coalesce(string_agg(to_jsonb(p)::text,',' ORDER BY sku),'')) AS data_hash,
       count(*) FILTER (WHERE sku='G6-DEMO-SIMPLE-001') AS fixture_rows
FROM promotions.stock_projection p;

SELECT md5(string_agg(n.nspname||'.'||c.relname||'.'||a.attname||':'||a.atttypid||':'||a.attnotnull::text,','
                     ORDER BY n.nspname,c.relname,a.attnum)) AS table_structure_hash
FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('taxonomy','catalog','pricing','price_audit','promotions','combos','inventory','bulk')
  AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped;
