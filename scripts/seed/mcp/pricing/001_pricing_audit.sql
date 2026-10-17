-- DATA-003 / #13. Diagnostico repetible; no es una carga ni un ensayo de escritura.
-- Destino autorizado: slzglmtiyrzygpkiuthf (Modulo de Productos y Ofertas).
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE po_pricing_seed;
SET LOCAL search_path = pg_catalog, pricing;

WITH definitions AS (
  SELECT * FROM pricing.prices
), validities AS (
  SELECT * FROM pricing.price_validities
), issues AS (
  SELECT 'TARGET_OR_CHANNEL' AS code, p.id::text AS id
  FROM definitions p
  WHERE (p.product_id IS NOT NULL) = (p.sku IS NOT NULL)
     OR p.channel_id NOT IN ('MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS')
     OR p.price_version < 1
  UNION ALL
  SELECT 'DUPLICATE_TARGET_CHANNEL', min(p.id::text)
  FROM definitions p
  GROUP BY p.product_id, p.sku, p.channel_id HAVING count(*) > 1
  UNION ALL
  SELECT 'MISSING_CURRENT_VERSION', p.id::text
  FROM definitions p
  WHERE NOT EXISTS (
    SELECT 1 FROM validities v
    WHERE v.price_id = p.id AND v.price_version = p.price_version
  )
  UNION ALL
  SELECT 'INVALID_VALIDITY', v.id::text
  FROM validities v LEFT JOIN definitions p ON p.id = v.price_id
  WHERE p.id IS NULL OR v.price_version < 1 OR v.price_version > p.price_version
     OR v.precio_regular <= 0 OR v.precio_regular = 'NaN'::numeric
     OR v.precio_regular = 'Infinity'::numeric
     OR (v.precio_oferta IS NOT NULL AND
        (v.precio_oferta <= 0 OR v.precio_oferta >= v.precio_regular))
     OR length(btrim(v.currency)) <> 3
     OR length(btrim(v.motivo_cambio)) = 0
     OR v.valid_until <= v.valid_from
  UNION ALL
  SELECT 'OVERLAP', a.id::text || '/' || b.id::text
  FROM validities a JOIN validities b
    ON a.price_id = b.price_id AND a.id < b.id
   AND NOT a.is_cancelled AND NOT b.is_cancelled
   AND tstzrange(a.valid_from, a.valid_until, '[)') &&
       tstzrange(b.valid_from, b.valid_until, '[)')
  UNION ALL
  SELECT 'DUPLICATE_VALIDITY_VERSION', min(v.id::text)
  FROM validities v GROUP BY v.price_id, v.price_version HAVING count(*) > 1
), metadata AS (
  SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner,
         c.relrowsecurity AS rls_enabled,
         has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
         has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
         has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
         has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
         has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
         has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
         has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'pricing' AND c.relname IN ('prices', 'price_validities')
), snapshots AS (
  SELECT p.id AS price_id, p.product_id, p.sku, p.channel_id, p.price_version,
         p.created_at AS price_created_at, p.updated_at AS price_updated_at,
         v.id AS validity_id, v.precio_regular::text, v.precio_oferta::text,
         v.currency, v.valid_from, v.valid_until,
         v.price_version AS validity_version, v.motivo_cambio, v.usuario_id,
         v.is_cancelled, v.created_at AS validity_created_at,
         v.updated_at AS validity_updated_at,
         (NOT v.is_cancelled AND v.valid_from <= now()
          AND (v.valid_until IS NULL OR now() < v.valid_until)) AS effective_now
  FROM definitions p LEFT JOIN validities v ON v.price_id = p.id
)
SELECT jsonb_build_object(
  'captured_at', now(), 'mode', 'READ_ONLY',
  'database', current_database(), 'session_user', session_user,
  'effective_role', current_user, 'transaction_read_only', current_setting('transaction_read_only'),
  'counts', jsonb_build_object(
    'prices', (SELECT count(*) FROM definitions),
    'price_validities', (SELECT count(*) FROM validities),
    'effective_validities', (SELECT count(*) FROM snapshots WHERE effective_now),
    'scheduled_prices', (SELECT count(*) FROM pricing.scheduled_prices)),
  'invariants_status', CASE WHEN EXISTS (SELECT 1 FROM issues) THEN 'FAIL' ELSE 'PASS' END,
  'issues', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY code, id) FROM issues i), '[]'::jsonb),
  'snapshots', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY price_id, valid_from)
                       FROM snapshots s), '[]'::jsonb),
  'tables', (SELECT jsonb_agg(to_jsonb(m) ORDER BY table_name) FROM metadata m),
  'schema_privileges', jsonb_build_object(
    'seed_create', has_schema_privilege(current_user, 'pricing', 'CREATE'),
    'anon_usage', has_schema_privilege('anon', 'pricing', 'USAGE'),
    'authenticated_usage', has_schema_privilege('authenticated', 'pricing', 'USAGE')),
  'columns', (SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name, ordinal_position)
              FROM information_schema.columns c
              WHERE table_schema = 'pricing' AND table_name IN ('prices', 'price_validities')),
  'constraints', (SELECT jsonb_agg(jsonb_build_object(
      'table', c.relname, 'name', k.conname, 'validated', k.convalidated,
      'definition', pg_get_constraintdef(k.oid)) ORDER BY c.relname, k.conname)
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pricing' AND c.relname IN ('prices', 'price_validities')),
  'indexes', (SELECT jsonb_agg(jsonb_build_object(
      'name', i.indexrelid::regclass::text, 'valid', i.indisvalid, 'ready', i.indisready)
      ORDER BY i.indexrelid::regclass::text)
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pricing' AND c.relname IN ('prices', 'price_validities')),
  'triggers', (SELECT jsonb_agg(jsonb_build_object(
      'table', c.relname, 'name', t.tgname, 'enabled', t.tgenabled,
      'definition', pg_get_triggerdef(t.oid),
      'function_definition', pg_get_functiondef(t.tgfoid)) ORDER BY c.relname, t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pricing' AND c.relname IN ('prices', 'price_validities')
      AND NOT t.tgisinternal)
) AS audit;
COMMIT;
