-- =====================================================================
-- Lote .......: 001_taxonomy_inka_athletics
-- Marketplace : Inka Athletics (datos maestros de taxonomia)
-- Issue ......: [DATA-001] backend #11 (revision de auditoria de calidad de datos)
-- Esquema ....: taxonomy
-- Rama .......: lopez
-- =====================================================================
-- PROPOSITO (revision 2026-10-16, auditoria de calidad de datos)
--   Correcciones de coherencia comercial tras consultar el estado REAL de
--   Supabase (taxonomy_dev_login, solo lectura). El lote:
--     * Renombra las 3 categorias raiz a nombres comerciales limpios
--       (MISMOS UUID, no cambia la identidad):
--         "Calzado deportivo"     -> "Calzado"
--         "Ropa deportiva"        -> "Ropa"
--         "Accesorios deportivos" -> "Equipamiento y Accesorios"
--     * REUTILIZA las subcategorias existentes "Futbol" y "Running"
--       (nivel 2 bajo Calzado) en lugar de crear duplicados.
--     * Agrega 3 marcas reales: Marathon, Under Armour, Walon.
--     * Completa tallas comerciales por uso: Calzado 38-43 y Ropa XS-XL
--       (mas la medida de balon "5" y equipamiento "Talla Unica").
--     * Agrega el SEO de las 3 categorias raiz.
--
--   NO se agregan subcategorias especulativas y NO se altera el color
--   existente "Azul". El detalle se documenta en "PENDIENTES".
--
-- PENDIENTES / FUERA DE ALCANCE (requieren confirmacion externa)
--   * Subcategorias de familia (Camisetas y Tops, Shorts y Pantalones,
--     Casacas y Polerones, Zapatillas Entrenamiento): NO se crean hasta
--     que Catalogo (owner Poma) confirme productos reales en esas
--     familias. Evita categorias que solo rellenen tablas.
--   * Color: el valor existente "Azul" ya lo referencia un producto real
--     (adidas Entrada 22). NO se renombra a "Azul Marino" ni se agregan
--     colores nuevos hasta identificar el tono real de nuestra variante.
--   Estos candidatos se listan como "pendientes_de_confirmacion" en la
--   matriz/manifest, SIN estado en la base.
--
-- IDEMPOTENCIA CON VERIFICACION DE CONTENIDO
--   1) Primero un bloque de VERIFICACION que compara, para cada fila
--      esperada, si ya existe una fila con la misma clave natural; si
--      existe pero su contenido difiere -> RAISE EXCEPTION y se detiene
--      la carga (no se sobrescribe nada inesperado).
--   2) RENOMBRES controlados (UPDATE ... WHERE nombre = <viejo>): solo
--      actuan sobre las 3 raices previstas y son no-op si el renombre ya
--      se aplico (reejecucion idempotente).
--   3) INSERT ... ON CONFLICT DO NOTHING para las filas nuevas.
--   4) Al final una verificacion de existencia de todas las filas.
--   Ejecutar SIEMPRE dentro de una transaccion explicita para que
--   cualquier RAISE aborte sin carga parcial. Para prueba en seco usar
--   BEGIN ... ROLLBACK.
--
-- IDS REPRODUCIBLES
--   id = uuid5(NAMESPACE_URL="https://g6.inka-athletics/taxonomy", clave)
--   convencion (version 2, derivable de los propios datos):
--     categories            -> "category:<categoria_padre_id>:<nombre_normalizado>"
--     brands                -> "brand:<nombre_normalizado>"
--     characteristic_values -> "characteristic_value:<caracteristica_id>:<nombre>"
--     category_seo          -> "category_seo:<slug>"
--   <nombre_normalizado> = btrim + minusculas + colapso de espacios.
--   Las filas ya existentes en Supabase conservan sus UUID reales.
--
-- IDENTIDADES RESERVADAS dataset.json (...ec0/...ec1/...ec2)
--   Ya NO se usan como maestros genericos. Deben repuntarse a identidades
--   comerciales reales; ver matriz (seccion coordination) y coordinar con
--   Poma (owner de dataset.json). Sin cambios unilaterales.
--
-- ORDEN DE EJECUCION
--   1) renombres  2) brands  3) characteristic_values  4) category_seo
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

-- 0.1) Raices de nivel 1 requeridas: deben existir ACTIVAS y de nivel 1,
--      y su nombre debe ser el viejo (a renombrar) o el nuevo (reejecucion).
--      Ademas el nombre destino no debe estar ya en uso por otra raiz.
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        SELECT format('categories raiz: falta/estado/nivel incorrecto id=%s', p.id) AS issue
        FROM (VALUES
            ('49a1dbd0-666d-0d43-6d1e-1053d4564455'::uuid),
            ('cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid),
            ('3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid)
        ) AS p(id)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.categories c
            WHERE c.id = p.id AND c.nivel = 1 AND c.estado = 'ACTIVO'
        )
        UNION ALL
        SELECT format('categories raiz: nombre inesperado id=%s nombre=%L (esperado %L o %L)',
                      r.id, c.nombre, r.viejo, r.nuevo)
        FROM (VALUES
            ('49a1dbd0-666d-0d43-6d1e-1053d4564455'::uuid, 'Accesorios deportivos', 'Equipamiento y Accesorios'),
            ('cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid, 'Calzado deportivo', 'Calzado'),
            ('3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid, 'Ropa deportiva', 'Ropa')
        ) AS r(id, viejo, nuevo)
        JOIN taxonomy.categories c ON c.id = r.id
        WHERE lower(btrim(c.nombre)) <> lower(btrim(r.viejo))
          AND lower(btrim(c.nombre)) <> lower(btrim(r.nuevo))
        UNION ALL
        SELECT format('categories raiz: el nombre destino %L ya lo usa otra raiz id=%s', r.nuevo, o.id)
        FROM (VALUES
            ('49a1dbd0-666d-0d43-6d1e-1053d4564455'::uuid, 'Equipamiento y Accesorios'),
            ('cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid, 'Calzado'),
            ('3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid, 'Ropa')
        ) AS r(id, nuevo)
        JOIN taxonomy.categories o
          ON o.id <> r.id AND o.nivel = 1
         AND lower(btrim(o.nombre)) = lower(btrim(r.nuevo))
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (raices):\n%', v_issues;
    END IF;
END $$;

-- 0.2) Subcategorias REUTILIZADAS: "Futbol" y "Running" deben existir
--      ACTIVAS, de nivel 2, bajo la raiz Calzado. Ademas se verifica que
--      NO existan subcategorias duplicadas de esas familias (evita crear
--      categorias repetidas o con productos separados incorrectamente).
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        SELECT format('categories reutilizadas: falta/estado/padre/nivel incorrecto id=%s nombre=%L',
                      r.id, r.nombre) AS issue
        FROM (VALUES
            ('dbd02734-85f5-b47b-5c95-ee768d5dc875'::uuid, 'Fútbol'),
            ('303886ae-f3f0-bc9c-145a-660979597595'::uuid, 'Running')
        ) AS r(id, nombre)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.categories c
            WHERE c.id = r.id AND c.nivel = 2 AND c.estado = 'ACTIVO'
              AND c.categoria_padre_id = 'cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid
              AND lower(btrim(c.nombre)) = lower(btrim(r.nombre))
        )
        UNION ALL
        SELECT format('categories duplicadas: ya existe nombre=%L id=%s (debe reutilizarse la existente)',
                      d.nombre, c.id)
        FROM (VALUES ('Chimpunes / Fútbol'), ('Zapatillas Running')) AS d(nombre)
        JOIN taxonomy.categories c ON lower(btrim(c.nombre)) = lower(btrim(d.nombre))
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (categorias reutilizadas):\n%', v_issues;
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
--      Incluye los valores EXISTENTES con sus UUID reales (solo verificacion)
--      y las tallas comerciales nuevas (calzado 38-43, ropa XS-XL).
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
        -- nuevas
        ('c90f8581-0fe2-5fd4-b08c-8b5d3f616399'::uuid, '40'),
        ('c636cd16-7146-52d9-a1a5-faab92c5ea42'::uuid, '43'),
        ('6e7505c8-4ae3-5850-86b2-d01d0b40bace'::uuid, 'XS'),
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
        RAISE EXCEPTION E'CONFLICTO DE LOTE (characteristic_values Talla):\n%', v_conflicts;
    END IF;
END $$;

-- 0.5) Color: se CONSERVA el estado existente. El valor "Azul" NO se
--      renombra (lo referencia un producto real) y no se agregan colores
--      nuevos. Solo se verifica que Azul, Gris y Negro existan ACTIVOS.
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        SELECT format('characteristic_values(Color): falta/estado/nombre incorrecto id=%s esperado %L',
                      e.id, e.nombre) AS issue
        FROM (VALUES
            ('931a4c7d-03d4-1ae2-bc95-817315fafcd6'::uuid, 'Azul'),
            ('50347024-7af0-2f6b-03fd-f5bbd3f408cf'::uuid, 'Gris'),
            ('61174517-27e1-1c5f-253b-4f6f2daa8b3f'::uuid, 'Negro')
        ) AS e(id, nombre)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.characteristic_values cv
            WHERE cv.id = e.id
              AND cv.caracteristica_id = 'acee6db1-ba1c-f020-caf8-f439b09556ff'::uuid
              AND cv.nombre = e.nombre AND cv.estado = 'ACTIVO'
        )
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'CONFLICTO DE LOTE (color existente):\n%', v_issues;
    END IF;
END $$;

-- 0.6) SEO de categoria (3 categorias raiz): claves naturales slug y categoria_id.
DO $$
DECLARE v_conflicts text;
BEGIN
    WITH e(id, categoria_id, slug) AS (VALUES
        ('916527ee-9a8a-590a-af25-69a7d4cf7710'::uuid, 'cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid, 'calzado'),
        ('087aaf9a-5d4f-5316-b735-6f49bc9a6087'::uuid, '3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid, 'ropa'),
        ('f5901f8f-8cac-5a25-be31-56d8dc5927e5'::uuid, '49a1dbd0-666d-0d43-6d1e-1053d4564455'::uuid, 'equipamiento-y-accesorios')
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
-- 1) RENOMBRES COMERCIALES DE LAS RAICES (mismos UUID; no-op si ya
--    se aplicaron). No se renombra ningun color.
-- =====================================================================
UPDATE taxonomy.categories SET nombre = 'Equipamiento y Accesorios'
 WHERE id = '49a1dbd0-666d-0d43-6d1e-1053d4564455' AND nombre = 'Accesorios deportivos';

UPDATE taxonomy.categories SET nombre = 'Calzado'
 WHERE id = 'cd8aa953-eafd-ce4e-628b-4988ebbcded4' AND nombre = 'Calzado deportivo';

UPDATE taxonomy.categories SET nombre = 'Ropa'
 WHERE id = '3523cb0c-0f00-27dd-d300-2daffdaf285a' AND nombre = 'Ropa deportiva';


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
-- 3) VALORES DE CARACTERISTICA "Talla" (tipo LISTA)
--    Calzado: 38-43  |  Ropa: XS, S, M, L, XL
--    Balon: "5"      |  Equipamiento: "Talla Unica"
--    Solo se insertan los valores NUEVOS; los existentes (38,39,41,42,5,M)
--    se verifican en 0.4 con sus UUID reales y NO se re-insertan.
-- =====================================================================
INSERT INTO taxonomy.characteristic_values
    (id, caracteristica_id, nombre, estado, taxonomy_version)
VALUES
    ('c90f8581-0fe2-5fd4-b08c-8b5d3f616399', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', '40', 'ACTIVO', 0),
    ('c636cd16-7146-52d9-a1a5-faab92c5ea42', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', '43', 'ACTIVO', 0),
    ('6e7505c8-4ae3-5850-86b2-d01d0b40bace', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'XS', 'ACTIVO', 0),
    ('6787802a-f29f-5a1b-a495-1d034f1002b6', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'S', 'ACTIVO', 0),
    ('68e9a97e-7e35-5c46-aed9-046556f9387b', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'L', 'ACTIVO', 0),
    ('353dbffe-8b38-5575-8f35-a7a8e42d8946', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'XL', 'ACTIVO', 0),
    ('4ea97ea9-df49-55a2-b6ab-ea2d0aef3504', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'Talla Única', 'ACTIVO', 0)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 4) SEO DE CATEGORIA (3 categorias raiz renombradas)
-- =====================================================================
INSERT INTO taxonomy.category_seo
    (id, categoria_id, slug, meta_titulo, meta_descripcion, taxonomy_version)
VALUES
    ('916527ee-9a8a-590a-af25-69a7d4cf7710', 'cd8aa953-eafd-ce4e-628b-4988ebbcded4',
     'calzado', 'Calzado | Inka Athletics',
     'Calzado deportivo: chimpunes, zapatillas de running y de entrenamiento.', 0),
    ('087aaf9a-5d4f-5316-b735-6f49bc9a6087', '3523cb0c-0f00-27dd-d300-2daffdaf285a',
     'ropa', 'Ropa | Inka Athletics',
     'Ropa deportiva para entrenamiento y competencia.', 0),
    ('f5901f8f-8cac-5a25-be31-56d8dc5927e5', '49a1dbd0-666d-0d43-6d1e-1053d4564455',
     'equipamiento-y-accesorios', 'Equipamiento y Accesorios | Inka Athletics',
     'Balones, equipo y accesorios para entrenamiento y competencia.', 0)
ON CONFLICT DO NOTHING;


-- =====================================================================
-- 5) VERIFICACION POSTERIOR (existencia y coincidencia de todas las filas)
-- =====================================================================
DO $$
DECLARE v_issues text;
BEGIN
    SELECT string_agg(issue, E'\n') INTO v_issues FROM (
        -- raices renombradas
        SELECT format('categories raiz: nombre final incorrecto id=%s', r.id) AS issue
        FROM (VALUES
            ('cd8aa953-eafd-ce4e-628b-4988ebbcded4'::uuid, 'Calzado'),
            ('3523cb0c-0f00-27dd-d300-2daffdaf285a'::uuid, 'Ropa'),
            ('49a1dbd0-666d-0d43-6d1e-1053d4564455'::uuid, 'Equipamiento y Accesorios')
        ) AS r(id, nombre)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.categories c
            WHERE c.id = r.id AND c.nombre = r.nombre AND c.nivel = 1 AND c.estado = 'ACTIVO'
        )
        UNION ALL
        -- subcategorias reutilizadas
        SELECT format('categories reutilizadas: falta o no coincide id=%s', r.id)
        FROM (VALUES
            ('dbd02734-85f5-b47b-5c95-ee768d5dc875'::uuid, 'Fútbol'),
            ('303886ae-f3f0-bc9c-145a-660979597595'::uuid, 'Running')
        ) AS r(id, nombre)
        WHERE NOT EXISTS (
            SELECT 1 FROM taxonomy.categories c
            WHERE c.id = r.id AND c.nombre = r.nombre AND c.nivel = 2 AND c.estado = 'ACTIVO'
        )
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
        -- tallas nuevas (las existentes se verifican en 0.4)
        SELECT format('characteristic_values: falta o no coincide id=%s', e.id)
        FROM (VALUES
            ('c90f8581-0fe2-5fd4-b08c-8b5d3f616399'::uuid, '40'),
            ('c636cd16-7146-52d9-a1a5-faab92c5ea42'::uuid, '43'),
            ('6e7505c8-4ae3-5850-86b2-d01d0b40bace'::uuid, 'XS'),
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
            ('916527ee-9a8a-590a-af25-69a7d4cf7710'::uuid),
            ('087aaf9a-5d4f-5316-b735-6f49bc9a6087'::uuid),
            ('f5901f8f-8cac-5a25-be31-56d8dc5927e5'::uuid)
        ) AS e(id)
        WHERE NOT EXISTS (SELECT 1 FROM taxonomy.category_seo s WHERE s.id = e.id)
    ) x;
    IF v_issues IS NOT NULL THEN
        RAISE EXCEPTION E'VERIFICACION POSTERIOR FALLIDA:\n%', v_issues;
    END IF;
END $$;
