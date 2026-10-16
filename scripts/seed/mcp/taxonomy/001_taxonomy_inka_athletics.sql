-- =====================================================================
-- Lote .......: 001_taxonomy_inka_athletics
-- Marketplace : Inka Athletics (datos maestros de taxonomia)
-- Issue ......: [DATA-001] backend #11 (via Supabase MCP / SQL directo)
-- Esquema ....: taxonomy
-- Rama .......: lopez
-- =====================================================================
-- PROPOSITO
--   Alta de maestros COMERCIALES minimos y consistentes para el
--   marketplace Inka Athletics: 3 subcategorias comerciales, 3 marcas
--   reales y las tallas/medidas nuevas que faltan, mas SEO de categoria.
--   NO se crean maestros genericos ("demo"): el lote no inserta ninguna
--   identidad de demostracion.
--
-- IDEMPOTENCIA CON VERIFICACION DE CONTENIDO
--   1) Primero un bloque de VERIFICACION que compara, para cada fila
--      esperada, si ya existe una fila con la misma clave natural; si
--      existe pero su contenido difiere -> RAISE EXCEPTION y se detiene
--      la carga (no se sobrescribe nada).
--   2) Luego INSERT ... ON CONFLICT DO NOTHING para las filas nuevas.
--   3) Al final una verificacion de existencia de todas las filas.
--   Ejecutar SIEMPRE dentro de una transaccion explicita para que
--   cualquier RAISE aborte sin carga parcial.
--
-- IDS REPRODUCIBLES
--   id = uuid5(NAMESPACE_URL="https://g6.inka-athletics/taxonomy", clave)
--   convencion (version 2, derivable de los propios datos):
--     categories            -> "category:<categoria_padre_id>:<nombre_normalizado>"
--     brands                -> "brand:<nombre_normalizado>"
--     characteristic_values -> "characteristic_value:<caracteristica_id>:<nombre>"
--     category_seo          -> "category_seo:<slug>"
--
-- IDENTIDADES RESERVADAS dataset.json (...ec0/...ec1/...ec2)
--   Ya NO se usan como maestros genericos. Deben repuntarse a identidades
--   comerciales reales; ver matriz (seccion coordination_with_poma) y
--   coordinar con Poma (owner de dataset.json). Sin cambios unilaterales.
--
-- ORDEN DE INSERCION
--   1) categories  2) brands  3) characteristic_values  4) category_seo
--
-- EJECUCION (fuera del archivo; controla el operador/MCP):
--   BEGIN;
--   SET LOCAL ROLE <rol_de_siembra_autorizado>;
--   \i 001_taxonomy_inka_athletics.sql
--   COMMIT;   -- o ROLLBACK para verificacion en seco
-- =====================================================================


-- =====================================================================
-- 0) VERIFICACION PREVIA (guardas de conflicto; no escriben nada)
-- =====================================================================

-- 0.1) Padres de nivel 1 requeridos por las nuevas subcategorias.
DO $$
DECLARE v_missing text;
BEGIN
    SELECT string_agg(format('%s (%s)', nombre, id), ', ') INTO v_missing
    FROM (VALUES
        ('49a1dbd0-666d-0d43-6d1e-1053d4564455'::uuid, 'Accesorios deportivos'),
        ('cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid, 'Calzado deportivo'),
        ('3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid, 'Ropa deportiva')
    ) AS p(id, nombre)
    WHERE NOT EXISTS (
        SELECT 1 FROM taxonomy.categories c
        WHERE c.id = p.id AND c.nivel = 1 AND c.estado = 'ACTIVO'
    );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'LOTE ABORTADO: faltan categorias padre ACTIVO de nivel 1: %', v_missing;
    END IF;
END $$;

-- 0.2) categorias: conflicto si el id existe con otro contenido, o si ya
--      existe una fila con el mismo (nombre, padre) pero distinto id.
DO $$
DECLARE v_conflicts text;
BEGIN
    WITH e(id, nombre, padre) AS (VALUES
        ('ff68d939-49a4-5dfe-91b3-bd6ebd3747c4'::uuid, 'Chimpunes',                     'cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid),
        ('7656fed5-a59d-596f-90df-ecbc4deb4e49'::uuid, 'Camisetas deportivas',          '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid),
        ('61f3adab-66d6-5312-9e0e-ba6394d10dd4'::uuid, 'Equipamiento de entrenamiento', '49a1dbd0-666d-0d43-6d1e-1053d4564455'::uuid)
    )
    SELECT string_agg(conflict, E'\n') INTO v_conflicts FROM (
        SELECT format('categories: id=%s existe con nombre=%L padre=%s (esperado nombre=%L padre=%s)',
                      c.id, c.nombre, c.categoria_padre_id, e.nombre, e.padre) AS conflict
        FROM e JOIN taxonomy.categories c ON c.id = e.id
        WHERE c.nombre <> e.nombre OR c.categoria_padre_id IS DISTINCT FROM e.padre
        UNION ALL
        SELECT format('categories: ya existe nombre=%L padre=%s con id=%s (esperado id=%s)',
                      e.nombre, e.padre, c.id, e.id)
        FROM e JOIN taxonomy.categories c
          ON lower(btrim(c.nombre)) = lower(btrim(e.nombre))
         AND c.categoria_padre_id IS NOT DISTINCT FROM e.padre
        WHERE c.id <> e.id
    ) x;
    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (categories):\n%', v_conflicts;
    END IF;
END $$;

-- 0.3) marcas: clave natural nombre_normalizado.
DO $$
DECLARE v_conflicts text;
BEGIN
    WITH e(id, nombre, norm, descripcion, pais) AS (VALUES
        ('380d9fe0-0290-580a-95e6-6bcd378b9b92'::uuid, 'Marathon',     'marathon',     'Marca ecuatoriana de ropa y calzado deportivo (fundada en Quito, 1980).', 'EC'),
        ('514d9c18-b418-559b-a692-e304183560ad'::uuid, 'Under Armour', 'under armour', 'Marca estadounidense de indumentaria y calzado deportivo (fundada en 1996).', 'US'),
        ('2ae5529a-b33e-507f-900d-b4a04fc0f831'::uuid, 'Walon',        'walon',        'Marca peruana de indumentaria deportiva (fundada en Lima, 1989).', 'PE')
    )
    SELECT string_agg(conflict, E'\n') INTO v_conflicts FROM (
        SELECT format('brands: nombre_normalizado=%L existe con id=%s (esperado id=%s) o contenido distinto',
                      e.norm, b.id, e.id) AS conflict
        FROM e JOIN taxonomy.brands b ON b.nombre_normalizado = e.norm
        WHERE b.id <> e.id
           OR b.nombre <> e.nombre
           OR b.descripcion IS DISTINCT FROM e.descripcion
           OR b.pais_origen_iso IS DISTINCT FROM e.pais::char(2)
        UNION ALL
        SELECT format('brands: id=%s ya usado por nombre_normalizado=%L (esperado %L)',
                      b.id, b.nombre_normalizado, e.norm)
        FROM e JOIN taxonomy.brands b ON b.id = e.id AND b.nombre_normalizado <> e.norm
    ) x;
    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (brands):\n%', v_conflicts;
    END IF;
END $$;

-- 0.4) valores de caracteristica "Talla": clave natural (caracteristica_id, nombre).
--      Incluye los valores EXISTENTES con sus UUID reales (solo verificacion).
DO $$
DECLARE v_conflicts text;
BEGIN
    WITH e(id, nombre) AS (VALUES
        -- existentes (UUID reales en Supabase)
        ('ae3eba02-52e6-4a8a-d71f-231960bdd9a4'::uuid, '38'),
        ('ea281936-1025-b09c-755e-545db73051b6'::uuid, '39'),
        ('7325e3a3-aa9a-db8e-9339-9f2b414b0d42'::uuid, '41'),
        ('122e93d8-cd1a-4b0e-8224-859fcff6db25'::uuid, '42'),
        ('52d4b91a-f829-c05e-d60e-31ada29b0513'::uuid, '5'),
        ('f0ec53c9-fb28-7464-e308-a2c171d943a3'::uuid, 'M'),
        -- nuevos
        ('c90f8581-0fe2-5fd4-b08c-8b5d3f616399'::uuid, '40'),
        ('6787802a-f29f-5a1b-a495-1d034f1002b6'::uuid, 'S'),
        ('68e9a97e-7e35-5c46-aed9-046556f9387b'::uuid, 'L'),
        ('353dbffe-8b38-5575-8f35-a7a8e42d8946'::uuid, 'XL'),
        ('4ea97ea9-df49-55a2-b6ab-ea2d0aef3504'::uuid, 'Talla Única')
    )
    SELECT string_agg(conflict, E'\n') INTO v_conflicts FROM (
        SELECT format('characteristic_values: (Talla,%L) existe con id=%s estado=%s (esperado id=%s ACTIVO)',
                      e.nombre, cv.id, cv.estado, e.id) AS conflict
        FROM e JOIN taxonomy.characteristic_values cv
          ON cv.caracteristica_id = 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid
         AND cv.nombre = e.nombre
        WHERE cv.id <> e.id OR cv.estado <> 'ACTIVO'
        UNION ALL
        SELECT format('characteristic_values: id=%s ya usado por (Talla,%L) (esperado (Talla,%L))',
                      cv.id, cv.nombre, e.nombre)
        FROM e JOIN taxonomy.characteristic_values cv ON cv.id = e.id
        WHERE cv.caracteristica_id <> 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid
           OR cv.nombre <> e.nombre
    ) x;
    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (characteristic_values):\n%', v_conflicts;
    END IF;
END $$;

-- 0.5) SEO de categoria: claves naturales slug y categoria_id.
DO $$
DECLARE v_conflicts text;
BEGIN
    WITH e(id, categoria_id, slug) AS (VALUES
        ('bc73900d-cf60-54f3-8fd5-2e0a98ded9b9'::uuid, '49a1dbd0-666d-0d43-6d1e-1053d4564455'::uuid, 'accesorios-deportivos'),
        ('341f6685-e6f0-5683-b59d-96ba8bf38fe8'::uuid, 'cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid, 'calzado-deportivo'),
        ('0e5da1a9-819f-52e3-bcb7-5ceef5e088e8'::uuid, '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid, 'ropa-deportiva'),
        ('5622435e-4271-5475-b9ba-07f050cdefa6'::uuid, 'ff68d939-49a4-5dfe-91b3-bd6ebd3747c4'::uuid, 'chimpunes'),
        ('8259af8a-74bc-5e15-a5e4-b3a073538eb5'::uuid, '7656fed5-a59d-596f-90df-ecbc4deb4e49'::uuid, 'camisetas-deportivas'),
        ('3dbdddd7-0d38-52b7-97a2-64eb5044c68d'::uuid, '61f3adab-66d6-5312-9e0e-ba6394d10dd4'::uuid, 'equipamiento-de-entrenamiento')
    )
    SELECT string_agg(conflict, E'\n') INTO v_conflicts FROM (
        SELECT format('category_seo: slug=%L existe con id=%s categoria=%s (esperado id=%s categoria=%s)',
                      e.slug, s.id, s.categoria_id, e.id, e.categoria_id) AS conflict
        FROM e JOIN taxonomy.category_seo s ON s.slug = e.slug
        WHERE s.id <> e.id OR s.categoria_id <> e.categoria_id
        UNION ALL
        SELECT format('category_seo: categoria=%s ya tiene slug=%L (esperado %L)',
                      e.categoria_id, s.slug, e.slug)
        FROM e JOIN taxonomy.category_seo s ON s.categoria_id = e.categoria_id AND s.slug <> e.slug
        UNION ALL
        SELECT format('category_seo: id=%s ya usado por slug=%L (esperado %L)', s.id, s.slug, e.slug)
        FROM e JOIN taxonomy.category_seo s ON s.id = e.id AND s.slug <> e.slug
    ) x;
    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (category_seo):\n%', v_conflicts;
    END IF;
END $$;


-- =====================================================================
-- 1) CATEGORIAS  (3 subcategorias comerciales, nivel 2)
-- =====================================================================
INSERT INTO taxonomy.categories
    (id, nombre, descripcion, categoria_padre_id, nivel, orden, estado, taxonomy_version)
VALUES
    ('ff68d939-49a4-5dfe-91b3-bd6ebd3747c4', 'Chimpunes',
     'Calzado de fútbol para cancha y futsal.',
     'cd8aa953-eafd-ce4e-628b-4988ebbcded4', 2, 0, 'ACTIVO', 0),
    ('7656fed5-a59d-596f-90df-ecbc4deb4e49', 'Camisetas deportivas',
     'Camisetas y polos para práctica deportiva.',
     '3523cb0c-0f00-27dd-d300-2daffdaf285a', 2, 0, 'ACTIVO', 0),
    ('61f3adab-66d6-5312-9e0e-ba6394d10dd4', 'Equipamiento de entrenamiento',
     'Equipamiento y accesorios para entrenamiento.',
     '49a1dbd0-666d-0d43-6d1e-1053d4564455', 2, 0, 'ACTIVO', 0)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 2) MARCAS  (3 marcas reales)
-- =====================================================================
INSERT INTO taxonomy.brands
    (id, nombre, descripcion, pais_origen_iso, estado, taxonomy_version)
VALUES
    ('380d9fe0-0290-580a-95e6-6bcd378b9b92', 'Marathon',
     'Marca ecuatoriana de ropa y calzado deportivo (fundada en Quito, 1980).', 'EC', 'ACTIVO', 0),
    ('514d9c18-b418-559b-a692-e304183560ad', 'Under Armour',
     'Marca estadounidense de indumentaria y calzado deportivo (fundada en 1996).', 'US', 'ACTIVO', 0),
    ('2ae5529a-b33e-507f-900d-b4a04fc0f831', 'Walon',
     'Marca peruana de indumentaria deportiva (fundada en Lima, 1989).', 'PE', 'ACTIVO', 0)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 3) VALORES DE CARACTERISTICA (caracteristica "Talla", tipo LISTA)
--    Solo se insertan los valores NUEVOS; los existentes (38,39,41,42,5,M)
--    se verifican en 0.4 con sus UUID reales y NO se re-insertan.
--    Decisión: se conserva el valor existente "5" (talla de balon) y NO se
--    agrega "N° 5" (duplicado del mismo concepto).
-- =====================================================================
INSERT INTO taxonomy.characteristic_values
    (id, caracteristica_id, nombre, estado, taxonomy_version)
VALUES
    ('c90f8581-0fe2-5fd4-b08c-8b5d3f616399', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', '40', 'ACTIVO', 0),
    ('6787802a-f29f-5a1b-a495-1d034f1002b6', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'S', 'ACTIVO', 0),
    ('68e9a97e-7e35-5c46-aed9-046556f9387b', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'L', 'ACTIVO', 0),
    ('353dbffe-8b38-5575-8f35-a7a8e42d8946', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'XL', 'ACTIVO', 0),
    ('4ea97ea9-df49-55a2-b6ab-ea2d0aef3504', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'Talla Única', 'ACTIVO', 0)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 4) SEO DE CATEGORIA (3 categorias nivel 1 + 3 subcategorias nuevas)
-- =====================================================================
INSERT INTO taxonomy.category_seo
    (id, categoria_id, slug, meta_titulo, meta_descripcion, taxonomy_version)
VALUES
    ('bc73900d-cf60-54f3-8fd5-2e0a98ded9b9', '49a1dbd0-666d-0d43-6d1e-1053d4564455',
     'accesorios-deportivos', 'Accesorios deportivos | Inka Athletics',
     'Accesorios y equipamiento deportivo: bolsos, botellas, protecciones y más.', 0),
    ('341f6685-e6f0-5683-b59d-96ba8bf38fe8', 'cd8aa953-eafd-ce4e-628b-4988ebbcded4',
     'calzado-deportivo', 'Calzado deportivo | Inka Athletics',
     'Zapatillas, chimpunes y calzado para running y fútbol.', 0),
    ('0e5da1a9-819f-52e3-bcb7-5ceef5e088e8', '3523cb0c-0f00-27dd-d300-2daffdaf285a',
     'ropa-deportiva', 'Ropa deportiva | Inka Athletics',
     'Camisetas, shorts y ropa deportiva para entrenamiento y competencia.', 0),
    ('5622435e-4271-5475-b9ba-07f050cdefa6', 'ff68d939-49a4-5dfe-91b3-bd6ebd3747c4',
     'chimpunes', 'Chimpunes | Inka Athletics',
     'Chimpunes y calzado de fútbol para cancha y futsal.', 0),
    ('8259af8a-74bc-5e15-a5e4-b3a073538eb5', '7656fed5-a59d-596f-90df-ecbc4deb4e49',
     'camisetas-deportivas', 'Camisetas deportivas | Inka Athletics',
     'Camisetas y polos deportivos de marcas como adidas, Nike y Under Armour.', 0),
    ('3dbdddd7-0d38-52b7-97a2-64eb5044c68d', '61f3adab-66d6-5312-9e0e-ba6394d10dd4',
     'equipamiento-de-entrenamiento', 'Equipamiento de entrenamiento | Inka Athletics',
     'Equipamiento y accesorios para entrenamiento deportivo.', 0)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5) VERIFICACION POSTERIOR (existencia y coincidencia de todas las filas)
-- =====================================================================
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        -- categorias
        SELECT format('categories: falta o no coincide id=%s', e.id) AS issue
        FROM (VALUES
            ('ff68d939-49a4-5dfe-91b3-bd6ebd3747c4'::uuid, 'Chimpunes'),
            ('7656fed5-a59d-596f-90df-ecbc4deb4e49'::uuid, 'Camisetas deportivas'),
            ('61f3adab-66d6-5312-9e0e-ba6394d10dd4'::uuid, 'Equipamiento de entrenamiento')
        ) AS e(id, nombre)
        WHERE NOT EXISTS (SELECT 1 FROM taxonomy.categories c WHERE c.id = e.id AND c.nombre = e.nombre AND c.estado = 'ACTIVO')
        UNION ALL
        -- marcas
        SELECT format('brands: falta o no coincide id=%s', e.id)
        FROM (VALUES
            ('380d9fe0-0290-580a-95e6-6bcd378b9b92'::uuid, 'Marathon'),
            ('514d9c18-b418-559b-a692-e304183560ad'::uuid, 'Under Armour'),
            ('2ae5529a-b33e-507f-900d-b4a04fc0f831'::uuid, 'Walon')
        ) AS e(id, nombre)
        WHERE NOT EXISTS (SELECT 1 FROM taxonomy.brands b WHERE b.id = e.id AND b.nombre = e.nombre AND b.estado = 'ACTIVO')
        UNION ALL
        -- valores de talla nuevos
        SELECT format('characteristic_values: falta o no coincide id=%s', e.id)
        FROM (VALUES
            ('c90f8581-0fe2-5fd4-b08c-8b5d3f616399'::uuid, '40'),
            ('6787802a-f29f-5a1b-a495-1d034f1002b6'::uuid, 'S'),
            ('68e9a97e-7e35-5c46-aed9-046556f9387b'::uuid, 'L'),
            ('353dbffe-8b38-5575-8f35-a7a8e42d8946'::uuid, 'XL'),
            ('4ea97ea9-df49-55a2-b6ab-ea2d0aef3504'::uuid, 'Talla Única')
        ) AS e(id, nombre)
        WHERE NOT EXISTS (SELECT 1 FROM taxonomy.characteristic_values cv WHERE cv.id = e.id AND cv.nombre = e.nombre AND cv.estado = 'ACTIVO')
        UNION ALL
        -- seo
        SELECT format('category_seo: falta o no coincide id=%s', e.id)
        FROM (VALUES
            ('bc73900d-cf60-54f3-8fd5-2e0a98ded9b9'::uuid),
            ('341f6685-e6f0-5683-b59d-96ba8bf38fe8'::uuid),
            ('0e5da1a9-819f-52e3-bcb7-5ceef5e088e8'::uuid),
            ('5622435e-4271-5475-b9ba-07f050cdefa6'::uuid),
            ('8259af8a-74bc-5e15-a5e4-b3a073538eb5'::uuid),
            ('3dbdddd7-0d38-52b7-97a2-64eb5044c68d'::uuid)
        ) AS e(id)
        WHERE NOT EXISTS (SELECT 1 FROM taxonomy.category_seo s WHERE s.id = e.id)
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'VERIFICACION POSTERIOR FALLIDA:\n%', v_issues;
    END IF;
END $$;
