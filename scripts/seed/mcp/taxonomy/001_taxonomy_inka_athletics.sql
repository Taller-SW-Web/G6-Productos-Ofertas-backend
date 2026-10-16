-- =====================================================================
-- Lote .......: 001_taxonomy_inka_athletics
-- Marketplace : Inka Athletics (datos maestros de taxonomia)
-- Issue ......: [DATA-001] backend #11 (via Supabase MCP / SQL directo)
-- Esquema ....: taxonomy
-- Rama .......: lopez
-- =====================================================================
-- IDEMPOTENCIA
--   Toda fila usa un identificador UUID reproducible derivado con
--   uuid5(NAMESPACE_URL = "https://g6.inka-athletics/taxonomy") y se
--   inserta con "ON CONFLICT DO NOTHING". El script puede ejecutarse
--   N veces sin duplicar filas ni fallar.
--
-- IDENTIDADES DE INTEGRACION RESERVADAS (scripts/seed/dataset.json -> Catalogo)
--   categoria   d60674d1-05fd-47f2-955b-5c2b6e504ec0
--   marca       d60674d1-05fd-47f2-955b-5c2b6e504ec1
--   tipo_prod   d60674d1-05fd-47f2-955b-5c2b6e504ec2
--
-- ALCANCE
--   Conserva las 7 categorias existentes (nivel 1 y 2) y las marcas
--   adidas/Nike/Puma: NO se re-insertan. Solo se agregan filas nuevas.
--
-- ORDEN DE INSERCION
--   1) categories  2) brands  3) product_types
--   4) characteristic_values  5) category_seo
--
-- EJECUCION (fuera del archivo, controla el operador/MCP):
--   BEGIN;
--   SET LOCAL ROLE <rol_de_siembra_autorizado>;
--   \i 001_taxonomy_inka_athletics.sql
--   COMMIT;   -- o ROLLBACK para una verificacion en seco
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) CATEGORIAS
-- Subcategorias comerciales (nivel 2) + identidad demo reservada.
-- Padres de nivel 1 (existentes): Accesorios deportivos, Calzado
-- deportivo y Ropa deportiva.
-- ---------------------------------------------------------------------
INSERT INTO taxonomy.categories
    (id, nombre, descripcion, categoria_padre_id, nivel, orden, estado, taxonomy_version)
VALUES
    ('4c9766ab-16d9-5dc9-99a3-bfa5a3a65db3', 'Chimpunes',
     'Calzado de fútbol (chimpunes) para cancha y futsal.',
     'cd8aa953-eafd-ce4e-628b-4988ebbcded4', 2, 0, 'ACTIVO', 0),
    ('2d648061-8a15-5592-a33b-4f543de0eca0', 'Camisetas deportivas',
     'Camisetas y polos deportivos.',
     '3523cb0c-0f00-27dd-d300-2daffdaf285a', 2, 0, 'ACTIVO', 0),
    ('55dc6d05-8bf4-5976-8ae5-7b8c3f0e9bd8', 'Equipamiento de entrenamiento',
     'Equipamiento y accesorios de entrenamiento.',
     '49a1dbd0-666d-0d43-6d1e-1053d4564455', 2, 0, 'ACTIVO', 0),
    ('d60674d1-05fd-47f2-955b-5c2b6e504ec0', 'Coleccion demo',
     'Categoría de demostración reservada en dataset.json (PENDING_OWNER_REVIEW).',
     '3523cb0c-0f00-27dd-d300-2daffdaf285a', 2, 0, 'ACTIVO', 0)
ON CONFLICT DO NOTHING;


-- ---------------------------------------------------------------------
-- 2) MARCAS
-- Marcas deportivas reales (Marathon, Under Armour, Walon) + identidad
-- demo reservada. adidas/Nike/Puma ya existen.
-- ---------------------------------------------------------------------
INSERT INTO taxonomy.brands
    (id, nombre, descripcion, pais_origen_iso, estado, taxonomy_version)
VALUES
    ('380d9fe0-0290-580a-95e6-6bcd378b9b92', 'Marathon',
     'Marca de calzado y ropa deportiva.', 'PE', 'ACTIVO', 0),
    ('8c51fbfc-eb63-5a4f-9ce3-c5ff7fec107b', 'Under Armour',
     'Marca internacional de indumentaria y calzado deportivo.', 'US', 'ACTIVO', 0),
    ('2ae5529a-b33e-507f-900d-b4a04fc0f831', 'Walon',
     'Marca de calzado deportivo.', 'PE', 'ACTIVO', 0),
    ('d60674d1-05fd-47f2-955b-5c2b6e504ec1', 'Marca demo',
     'Marca de demostración reservada en dataset.json (PENDING_OWNER_REVIEW).',
     NULL, 'ACTIVO', 0)
ON CONFLICT DO NOTHING;


-- ---------------------------------------------------------------------
-- 3) TIPOS DE PRODUCTO
-- Identidad demo reservada para Catalogo (no se re-insertan los 4 tipos
-- existentes).
-- ---------------------------------------------------------------------
INSERT INTO taxonomy.product_types
    (id, nombre, estado, taxonomy_version)
VALUES
    ('d60674d1-05fd-47f2-955b-5c2b6e504ec2', 'Tipo de producto demo',
     'ACTIVO', 0)
ON CONFLICT DO NOTHING;


-- ---------------------------------------------------------------------
-- 4) VALORES DE CARACTERISTICA (caracteristica "Talla", tipo LISTA)
--   Calzado .......: 39, 40, 41, 42  (39/41/42 ya existen)
--   Ropa ..........: S, M, L, XL      (M ya existe)
--   Balón/Equipo ..: N° 5, Talla Única
-- La unicidad es (caracteristica_id, nombre): los valores ya presentes
-- se omiten sin error.
-- ---------------------------------------------------------------------
INSERT INTO taxonomy.characteristic_values
    (id, caracteristica_id, nombre, estado, taxonomy_version)
VALUES
    ('2e748d50-4b22-5f6b-9760-eda6a8b4cb87', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', '39', 'ACTIVO', 0),
    ('c90f8581-0fe2-5fd4-b08c-8b5d3f616399', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', '40', 'ACTIVO', 0),
    ('3f14c9ba-cbde-535c-aaed-1a35b2c2085a', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', '41', 'ACTIVO', 0),
    ('734854bc-4dde-5b90-9d35-41acff69df5e', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', '42', 'ACTIVO', 0),
    ('6787802a-f29f-5a1b-a495-1d034f1002b6', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'S', 'ACTIVO', 0),
    ('02234f98-27cb-52ba-b71b-3414d66d1a6a', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'M', 'ACTIVO', 0),
    ('68e9a97e-7e35-5c46-aed9-046556f9387b', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'L', 'ACTIVO', 0),
    ('353dbffe-8b38-5575-8f35-a7a8e42d8946', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'XL', 'ACTIVO', 0),
    ('9cd57c7e-854f-5149-addc-194353b6a5a2', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'N° 5', 'ACTIVO', 0),
     ('4ea97ea9-df49-55a2-b6ab-ea2d0aef3504', 'fe3fe43d-f3a4-6fe7-4a2f-34e8bdfa0abd', 'Talla Única', 'ACTIVO', 0)
ON CONFLICT DO NOTHING;


-- ---------------------------------------------------------------------
-- 5) SEO DE CATEGORIA (category_seo)
-- Una fila por categoria principal (3 de nivel 1 + 3 subcategorias
-- comerciales nuevas). Slugs unicos con formato [a-z0-9]+(-[a-z0-9]+)*.
-- ---------------------------------------------------------------------
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
    ('5622435e-4271-5475-b9ba-07f050cdefa6', '4c9766ab-16d9-5dc9-99a3-bfa5a3a65db3',
     'chimpunes', 'Chimpunes | Inka Athletics',
     'Chimpunes y calzado de fútbol para cancha y futsal.', 0),
    ('8259af8a-74bc-5e15-a5e4-b3a073538eb5', '2d648061-8a15-5592-a33b-4f543de0eca0',
     'camisetas-deportivas', 'Camisetas deportivas | Inka Athletics',
     'Camisetas y polos deportivos de marcas como adidas, Nike y Under Armour.', 0),
    ('3dbdddd7-0d38-52b7-97a2-64eb5044c68d', '55dc6d05-8bf4-5976-8ae5-7b8c3f0e9bd8',
     'equipamiento-de-entrenamiento', 'Equipamiento de entrenamiento | Inka Athletics',
     'Equipamiento y accesorios para entrenamiento deportivo.', 0)
ON CONFLICT DO NOTHING;
