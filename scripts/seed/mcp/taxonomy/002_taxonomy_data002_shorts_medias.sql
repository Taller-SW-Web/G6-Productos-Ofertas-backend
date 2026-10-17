-- =====================================================================
-- Lote .......: 002_taxonomy_data002_shorts_medias
-- Marketplace : Inka Athletics (datos maestros de taxonomia)
-- Issue ......: [DATA-002] apoyo backend (completar maestros de taxonomia)
-- Esquema ....: taxonomy
-- Rama .......: lopez
-- =====================================================================
-- PROPOSITO
--   Completar los maestros de taxonomia necesarios para DATA-002:
--     * categories: 1 subcategoria nueva "Medias deportivas" (nivel 2 bajo Ropa).
--       Para "Short deportivo" NO se crea categoria: se REUTILIZA el par
--       existente Ropa -> "Entrenamiento" (nivel 2).
--     * product_types: 2 tipos nuevos "Short deportivo" y "Medias deportivas".
--     * product_type_characteristics: asociar Color y Talla a ambos tipos
--       nuevos (obligatoria = true, respetando las reglas/limites vigentes).
--     * characteristic_values: colores "Multicolor" y "Blanco" (justificados por
--       shorts/medias) y los rangos de talla de medias:
--         - Nike : EU 34-38, EU 38-42, EU 42-46
--         - adidas: EU 34-36, EU 37-39, EU 40-42
--
--   Total de filas nuevas: 1 categoria + 2 tipos + 4 relaciones + 8 valores = 15.
--
-- NO SE MODIFICA NADA EXISTENTE (con matiz de triggers)
--   * Solo hay INSERT explicito. NO hay UPDATE ni DELETE escritos en el archivo.
--   * Matiz: los triggers vigentes de taxonomy SI actualizan filas por diseno.
--     'trg_ptc_bump_schema_version' incrementa product_types.schema_version de
--     los tipos RECIEN insertados al agregar sus relaciones ptc (1 -> 2 -> 3).
--     Es el comportamiento esperado del esquema: no se fuerza manualmente y
--     NO hay UPDATE escrito para ello.
--   * No se altera el esquema fisico de taxonomy (tablas, triggers, funciones,
--     permisos ni politicas).
--   * No se toca el esquema catalog (ownership de Poma).
--
-- IDEMPOTENCIA CON VERIFICACION DE CONTENIDO
--   1) Bloque previo de VERIFICACION: para cada fila destino compara la clave
--      natural; si existe con OTRO id/contenido -> RAISE EXCEPTION y se detiene
--      la carga (no se sobrescribe nada inesperado).
--   2) INSERT ... ON CONFLICT DO NOTHING con id reproducible (uuid5) -> reejecutar
--      el lote es no-op.
--   3) Verificacion posterior de existencia de todas las filas.
--   Ejecutar SIEMPRE dentro de una transaccion explicita; usar BEGIN..ROLLBACK
--   para una prueba en seco (0 escrituras persistidas).
--
-- IDS REPRODUCIBLES
--   id = uuid5(NAMESPACE_URL="https://g6.inka-athletics/taxonomy", clave)
--   convencion (version 3, extension de la v2):
--     categories                   -> "category:<categoria_padre_id>:<nombre_normalizado>"
--     product_types                -> "product_type:<nombre_normalizado>"
--     product_type_characteristics -> "product_type_characteristic:<tipo_producto_id>:<caracteristica_id>"
--     characteristic_values        -> "characteristic_value:<caracteristica_id>:<nombre>"
--   <nombre_normalizado> = btrim + minusculas + colapso de espacios.
--   Las filas ya existentes en Supabase conservan sus UUID reales.
--
-- NOTA DE MODELO (talla compartida)
--   La caracteristica "Talla" es unica y compartida por todos los tipos de
--   producto (PTC obligatoria). Los rangos de medias quedan disponibles como
--   valores de "Talla"; el mapeo marca->rango (Nike/adidas) se documenta en la
--   matriz, NO en la BD. Validar combinaciones por tipo con Catalogo (Poma).
--
-- ORDEN DE EJECUCION
--   1) categories  2) product_types  3) product_type_characteristics
--   4) characteristic_values
--
-- EJECUCION (la controla el operador; el lote NO se auto-ejecuta)
--   Las cuatro tablas destino son propiedad de 'po_taxonomy_owner'. Debe
--   ejecutarlo un rol autorizado con privilegios EFECTIVOS de:
--     - SELECT/INSERT en taxonomy.categories;
--     - SELECT/INSERT/UPDATE en taxonomy.product_types
--       (el trigger 'trg_ptc_bump_schema_version' hace UPDATE de schema_version);
--     - SELECT/INSERT/UPDATE en taxonomy.product_type_characteristics
--       (triggers de limite de atributos y de bump);
--     - SELECT/INSERT/UPDATE en taxonomy.characteristic_values y en
--       taxonomy.characteristics (el trigger 'fn_enforce_characteristic_value_rules'
--       toma SELECT ... FOR UPDATE de characteristics).
--   No se conceden permisos nuevos: usar un rol ya autorizado y comprobar sus
--   privilegios efectivos con has_table_privilege(...) antes de cargar.
--   El lote NO incluye BEGIN/COMMIT para que el operador controle la transaccion.
--
--   * psql (transaccion explicita; \i es metacomando de psql):
--       BEGIN;
--       SET LOCAL ROLE <rol_autorizado>;
--       \i 002_taxonomy_data002_shorts_medias.sql
--       -- revisar; COMMIT solo tras autorizacion, o ROLLBACK.
--   * Supabase SQL Editor (NO admite \i): pegar el contenido del archivo entre
--       BEGIN; ... COMMIT;  (o BEGIN; ... ROLLBACK; para verificacion en seco).
-- =====================================================================


-- =====================================================================
-- 0) VERIFICACION PREVIA (guardas de conflicto; no escriben nada)
-- =====================================================================

-- 0.1) Categoria raiz "Ropa" requerida (ACTIVA, nivel 1, sin padre) y la
--      subcategoria destino "Medias deportivas": se valida CUALQUIER registro
--      existente, tanto por identidad natural (padre+nombre) como por el UUID
--      previsto (aunque tenga otro nombre o padre).
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        SELECT format('categories raiz: falta/estado/nivel/padre incorrecto id=%s nombre=%L',
                      '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid, 'Ropa') AS issue
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.categories c
            WHERE c.id = '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid
              AND c.nivel = 1 AND c.categoria_padre_id IS NULL AND c.estado = 'ACTIVO'
              AND lower(btrim(c.nombre)) = lower('Ropa')
        )
        UNION ALL
        SELECT format('categories Medias deportivas: ya existe otro id=%s para (padre, nombre) (esperado id=%s)',
                      c.id, '3894c641-982c-5db5-a9d2-3897b16d9cb3') AS issue
        FROM taxonomy.categories c
        WHERE c.categoria_padre_id = '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid
          AND lower(btrim(c.nombre)) = lower('Medias deportivas')
          AND c.id <> '3894c641-982c-5db5-a9d2-3897b16d9cb3'::uuid
        UNION ALL
        SELECT format('categories Medias deportivas: id=%s existe con contenido distinto (nombre=%L padre=%s nivel=%s estado=%s)',
                      c.id, c.nombre, c.categoria_padre_id, c.nivel, c.estado) AS issue
        FROM taxonomy.categories c
        WHERE c.id = '3894c641-982c-5db5-a9d2-3897b16d9cb3'::uuid
          AND (
              lower(btrim(c.nombre)) <> lower('Medias deportivas')
              OR c.categoria_padre_id IS DISTINCT FROM '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid
              OR c.nivel <> 2
              OR c.estado <> 'ACTIVO'
          )
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (categorias):\n%', v_issues;
    END IF;
END $$;

-- 0.2) Categoria REUTILIZADA para shorts: "Entrenamiento" (nivel 2 bajo Ropa).
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        SELECT format('categories reutilizada Entrenamiento: falta/estado/padre/nivel id=%s',
                      '69bda117-9700-d41d-9ccf-f207717068e0'::uuid) AS issue
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.categories c
            WHERE c.id = '69bda117-9700-d41d-9ccf-f207717068e0'::uuid
              AND c.nivel = 2 AND c.estado = 'ACTIVO'
              AND c.categoria_padre_id = '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid
              AND lower(btrim(c.nombre)) = lower('Entrenamiento')
        )
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (categoria reutilizada):\n%', v_issues;
    END IF;
END $$;

-- 0.3) Caracteristicas "Color" y "Talla": deben existir ACTIVAS y de tipo LISTA.
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        SELECT format('characteristics: falta/estado/tipo incorrecto id=%s esperado nombre=%L tipo=LISTA',
                      e.id, e.nombre) AS issue
        FROM (VALUES
            ('acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid, 'Color'),
            ('fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'Talla')
        ) AS e(id, nombre)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.characteristics c
            WHERE c.id = e.id AND c.nombre = e.nombre AND c.tipo = 'LISTA' AND c.estado = 'ACTIVO'
        )
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (characteristics):\n%', v_issues;
    END IF;
END $$;

-- 0.4) product_types: identidad por nombre y por UUID. Un existente con el
--      nombre esperado debe tener el UUID esperado y estar ACTIVO.
DO $$
DECLARE v_conflicts text;
BEGIN
    WITH e(id, nombre) AS (VALUES
        ('69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'Short deportivo'),
        ('db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'Medias deportivas')
    )
    SELECT string_agg(conflict, E'\n') INTO v_conflicts FROM (
        SELECT format('product_types: nombre=%L existe con id=%s (esperado id=%s)',
                      e.nombre, pt.id, e.id) AS conflict
        FROM e JOIN taxonomy.product_types pt
          ON lower(btrim(pt.nombre)) = lower(btrim(e.nombre))
        WHERE pt.id <> e.id
        UNION ALL
        SELECT format('product_types: id=%s existe con datos distintos (nombre=%L estado=%s; esperado %L ACTIVO)',
                      pt.id, pt.nombre, pt.estado, e.nombre) AS conflict
        FROM e JOIN taxonomy.product_types pt ON pt.id = e.id
        WHERE lower(btrim(pt.nombre)) <> lower(btrim(e.nombre)) OR pt.estado <> 'ACTIVO'
    ) x;
    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (product_types):\n%', v_conflicts;
    END IF;
END $$;

-- 0.5) characteristic_values: identidad por (caracteristica_id, nombre) y por
--      UUID, comprobando tambien estado ACTIVO, y detectando duplicados
--      semanticos por normalizacion (mayus/minus/espacios) sin modificar los
--      registros existentes (solo se aborta).
DO $$
DECLARE v_conflicts text;
BEGIN
    WITH e(id, caracteristica_id, nombre) AS (VALUES
        ('35e25c52-aa9b-5572-b656-15b701e4894c'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid, 'Multicolor'),
        ('c0b1a113-b479-5f84-9fa3-0e6cb3a41fea'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid, 'Blanco'),
        ('bac7a07c-2684-523f-aca4-761f1e15d128'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 34-38'),
        ('0223e905-3700-5c92-87ac-f5a0615b2e96'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 38-42'),
        ('0234fd28-6c7f-5203-bef5-733196f382a6'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 42-46'),
        ('6e8053e7-d856-5a20-9a0b-9a34d497def5'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 34-36'),
        ('c417b2a9-f655-57a5-976c-128a0b3c1527'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 37-39'),
        ('20ead521-e596-521d-a057-7c41b52d0626'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 40-42')
    )
    SELECT string_agg(conflict, E'\n') INTO v_conflicts FROM (
        SELECT format('characteristic_values: (%s,%L) existe con id=%s (esperado id=%s)',
                      e.caracteristica_id, e.nombre, cv.id, e.id) AS conflict
        FROM e JOIN taxonomy.characteristic_values cv
          ON cv.caracteristica_id = e.caracteristica_id AND cv.nombre = e.nombre
        WHERE cv.id <> e.id
        UNION ALL
        SELECT format('characteristic_values: id=%s existe con datos distintos (%s,%L estado=%s; esperado (%s,%L) ACTIVO)',
                      cv.id, cv.caracteristica_id, cv.nombre, cv.estado, e.caracteristica_id, e.nombre) AS conflict
        FROM e JOIN taxonomy.characteristic_values cv ON cv.id = e.id
        WHERE cv.caracteristica_id <> e.caracteristica_id
           OR cv.nombre <> e.nombre
           OR cv.estado <> 'ACTIVO'
        UNION ALL
        SELECT format('characteristic_values: duplicado semantico de (%s,%L): existe id=%s nombre=%L',
                      e.caracteristica_id, e.nombre, cv.id, cv.nombre) AS conflict
        FROM e JOIN taxonomy.characteristic_values cv
          ON cv.caracteristica_id = e.caracteristica_id
         AND lower(btrim(regexp_replace(cv.nombre, '[[:space:]]+', ' ', 'g')))
             = lower(btrim(regexp_replace(e.nombre, '[[:space:]]+', ' ', 'g')))
        WHERE cv.id <> e.id OR cv.nombre <> e.nombre
    ) x;
    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (characteristic_values):\n%', v_conflicts;
    END IF;
END $$;

-- 0.6) product_type_characteristics: identidad por (tipo_producto_id,
--      caracteristica_id) y por UUID, comprobando obligatoria=true y ACTIVO.
DO $$
DECLARE v_conflicts text;
BEGIN
    WITH e(id, tipo_producto_id, caracteristica_id) AS (VALUES
        ('9de01dd2-0a7d-5960-a479-a4a88a23be92'::uuid, '69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('35203f8a-ca7b-5bd7-9179-e19a6dbd5ba3'::uuid, '69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
        ('62c0eac7-a34a-577b-bb2a-5929137c2de1'::uuid, 'db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
        ('7ec695ab-9d3e-54aa-96a5-fc5ccdd2484f'::uuid, 'db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid)
    )
    SELECT string_agg(conflict, E'\n') INTO v_conflicts FROM (
        SELECT format('product_type_characteristics: (%s,%s) existe con id=%s (esperado id=%s)',
                      e.tipo_producto_id, e.caracteristica_id, ptc.id, e.id) AS conflict
        FROM e JOIN taxonomy.product_type_characteristics ptc
          ON ptc.tipo_producto_id = e.tipo_producto_id AND ptc.caracteristica_id = e.caracteristica_id
        WHERE ptc.id <> e.id
        UNION ALL
        SELECT format('product_type_characteristics: id=%s existe con datos distintos (tipo=%s caracteristica=%s obligatoria=%s estado=%s; esperado (%s,%s) obligatoria=true ACTIVO)',
                      ptc.id, ptc.tipo_producto_id, ptc.caracteristica_id, ptc.obligatoria, ptc.estado,
                      e.tipo_producto_id, e.caracteristica_id) AS conflict
        FROM e JOIN taxonomy.product_type_characteristics ptc ON ptc.id = e.id
        WHERE ptc.tipo_producto_id <> e.tipo_producto_id
           OR ptc.caracteristica_id <> e.caracteristica_id
           OR ptc.obligatoria <> true
           OR ptc.estado <> 'ACTIVO'
    ) x;
    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (product_type_characteristics):\n%', v_conflicts;
    END IF;
END $$;


-- =====================================================================
-- 1) CATEGORIA nueva: "Medias deportivas" (nivel 2 bajo Ropa)
--    Short deportivo NO crea categoria: reutiliza Ropa -> Entrenamiento.
-- =====================================================================
INSERT INTO taxonomy.categories
    (id, nombre, categoria_padre_id, nivel, estado, taxonomy_version)
VALUES
    ('3894c641-982c-5db5-a9d2-3897b16d9cb3', 'Medias deportivas',
     '3523cb0c-0f00-27dd-d300-2daffdaf285a', 2, 'ACTIVO', 0)
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- 2) TIPOS DE PRODUCTO nuevos
-- =====================================================================
INSERT INTO taxonomy.product_types
    (id, nombre, estado, schema_version, taxonomy_version)
VALUES
    ('69eaf044-dfea-51e6-ad03-f752a73cd1c9', 'Short deportivo', 'ACTIVO', 1, 0),
    ('db4cefc7-9412-5c82-a91f-58b73a9909cd', 'Medias deportivas', 'ACTIVO', 1, 0)
ON CONFLICT (nombre) DO NOTHING;


-- =====================================================================
-- 3) RELACIONES tipo de producto <-> caracteristica (Color y Talla)
--    obligatoria = true (mismo patron que las relaciones existentes).
--    Los triggers vigentes (limite de atributos y bump de schema_version)
--    se aplican automaticamente.
-- =====================================================================
INSERT INTO taxonomy.product_type_characteristics
    (id, tipo_producto_id, caracteristica_id, obligatoria, estado)
VALUES
    ('9de01dd2-0a7d-5960-a479-a4a88a23be92', '69eaf044-dfea-51e6-ad03-f752a73cd1c9', 'acee6db1-ba1c-f020-caf8-f439b09556ff', true, 'ACTIVO'),
    ('35203f8a-ca7b-5bd7-9179-e19a6dbd5ba3', '69eaf044-dfea-51e6-ad03-f752a73cd1c9', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', true, 'ACTIVO'),
    ('62c0eac7-a34a-577b-bb2a-5929137c2de1', 'db4cefc7-9412-5c82-a91f-58b73a9909cd', 'acee6db1-ba1c-f020-caf8-f439b09556ff', true, 'ACTIVO'),
    ('7ec695ab-9d3e-54aa-96a5-fc5ccdd2484f', 'db4cefc7-9412-5c82-a91f-58b73a9909cd', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', true, 'ACTIVO')
ON CONFLICT (tipo_producto_id, caracteristica_id) DO NOTHING;


-- =====================================================================
-- 4) VALORES DE CARACTERISTICA
--    Color: Multicolor, Blanco (justificados por shorts/medias).
--    Talla: rangos de medias (Nike EU 34-38/38-42/42-46;
--           adidas EU 34-36/37-39/40-42). El mapeo marca->rango se
--           documenta en la matriz; la caracteristica "Talla" es global.
-- =====================================================================
INSERT INTO taxonomy.characteristic_values
    (id, caracteristica_id, nombre, estado, taxonomy_version)
VALUES
    ('35e25c52-aa9b-5572-b656-15b701e4894c', 'acee6db1-ba1c-f020-caf8-f439b09556ff', 'Multicolor', 'ACTIVO', 0),
    ('c0b1a113-b479-5f84-9fa3-0e6cb3a41fea', 'acee6db1-ba1c-f020-caf8-f439b09556ff', 'Blanco', 'ACTIVO', 0),
    ('bac7a07c-2684-523f-aca4-761f1e15d128', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'EU 34-38', 'ACTIVO', 0),
    ('0223e905-3700-5c92-87ac-f5a0615b2e96', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'EU 38-42', 'ACTIVO', 0),
    ('0234fd28-6c7f-5203-bef5-733196f382a6', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'EU 42-46', 'ACTIVO', 0),
    ('6e8053e7-d856-5a20-9a0b-9a34d497def5', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'EU 34-36', 'ACTIVO', 0),
    ('c417b2a9-f655-57a5-976c-128a0b3c1527', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'EU 37-39', 'ACTIVO', 0),
    ('20ead521-e596-521d-a057-7c41b52d0626', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'EU 40-42', 'ACTIVO', 0)
ON CONFLICT (caracteristica_id, nombre) DO NOTHING;


-- =====================================================================
-- 5) VERIFICACION POSTERIOR (existencia y coincidencia de todas las filas)
-- =====================================================================
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        -- categoria nueva
        SELECT format('categories: falta o no coincide id=%s', e.id) AS issue
        FROM (VALUES ('3894c641-982c-5db5-a9d2-3897b16d9cb3'::uuid, 'Medias deportivas')) AS e(id, nombre)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.categories c
            WHERE c.id = e.id AND c.nombre = e.nombre AND c.nivel = 2 AND c.estado = 'ACTIVO'
              AND c.categoria_padre_id = '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid
        )
        UNION ALL
        -- categoria reutilizada (short: Ropa -> Entrenamiento)
        SELECT format('categories reutilizada: falta o no coincide id=%s', e.id) AS issue
        FROM (VALUES ('69bda117-9700-d41d-9ccf-f207717068e0'::uuid, 'Entrenamiento')) AS e(id, nombre)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.categories c
            WHERE c.id = e.id AND c.nombre = e.nombre AND c.nivel = 2 AND c.estado = 'ACTIVO'
              AND c.categoria_padre_id = '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid
        )
        UNION ALL
        -- tipos de producto
        SELECT format('product_types: falta o no coincide id=%s', e.id) AS issue
        FROM (VALUES
            ('69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'Short deportivo'),
            ('db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'Medias deportivas')
        ) AS e(id, nombre)
        WHERE NOT EXISTS (SELECT 1 FROM taxonomy.product_types pt WHERE pt.id = e.id AND pt.nombre = e.nombre AND pt.estado = 'ACTIVO')
        UNION ALL
        -- relaciones ptc
        SELECT format('product_type_characteristics: falta o no coincide id=%s', e.id) AS issue
        FROM (VALUES
            ('9de01dd2-0a7d-5960-a479-a4a88a23be92'::uuid, '69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
            ('35203f8a-ca7b-5bd7-9179-e19a6dbd5ba3'::uuid, '69eaf044-dfea-51e6-ad03-f752a73cd1c9'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid),
            ('62c0eac7-a34a-577b-bb2a-5929137c2de1'::uuid, 'db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid),
            ('7ec695ab-9d3e-54aa-96a5-fc5ccdd2484f'::uuid, 'db4cefc7-9412-5c82-a91f-58b73a9909cd'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid)
        ) AS e(id, tipo_producto_id, caracteristica_id)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.product_type_characteristics ptc
            WHERE ptc.id = e.id
              AND ptc.tipo_producto_id = e.tipo_producto_id
              AND ptc.caracteristica_id = e.caracteristica_id
              AND ptc.obligatoria
              AND ptc.estado = 'ACTIVO'
        )
        UNION ALL
        -- valores de caracteristica
        SELECT format('characteristic_values: falta o no coincide id=%s', e.id) AS issue
        FROM (VALUES
            ('35e25c52-aa9b-5572-b656-15b701e4894c'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid, 'Multicolor'),
            ('c0b1a113-b479-5f84-9fa3-0e6cb3a41fea'::uuid, 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid, 'Blanco'),
            ('bac7a07c-2684-523f-aca4-761f1e15d128'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 34-38'),
            ('0223e905-3700-5c92-87ac-f5a0615b2e96'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 38-42'),
            ('0234fd28-6c7f-5203-bef5-733196f382a6'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 42-46'),
            ('6e8053e7-d856-5a20-9a0b-9a34d497def5'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 34-36'),
            ('c417b2a9-f655-57a5-976c-128a0b3c1527'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 37-39'),
            ('20ead521-e596-521d-a057-7c41b52d0626'::uuid, 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd'::uuid, 'EU 40-42')
        ) AS e(id, caracteristica_id, nombre)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.characteristic_values cv
            WHERE cv.id = e.id AND cv.caracteristica_id = e.caracteristica_id AND cv.nombre = e.nombre AND cv.estado = 'ACTIVO'
        )
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'VERIFICACION POSTERIOR FALLIDA:\n%', v_issues;
    END IF;
END $$;
