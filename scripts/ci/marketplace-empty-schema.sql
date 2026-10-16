\set ON_ERROR_STOP on
-- Solo PostgreSQL descartable de CI: DDL vacío, sin productos ni seeds.
CREATE ROLE taxonomy_app LOGIN PASSWORD 'ci-only-password';
CREATE ROLE catalog_app LOGIN PASSWORD 'ci-only-password';
CREATE SCHEMA taxonomy;
CREATE SCHEMA catalog;
CREATE TYPE taxonomy.estado_entidad AS ENUM ('ACTIVO', 'INACTIVO', 'PENDING_DEACTIVATION');
CREATE TABLE taxonomy.categories (id uuid PRIMARY KEY, nombre text NOT NULL, categoria_padre_id uuid, orden integer NOT NULL, estado taxonomy.estado_entidad NOT NULL);
CREATE TABLE taxonomy.brands (id uuid PRIMARY KEY, nombre text NOT NULL, descripcion text, pais_origen_iso char(2), logo_url text, estado taxonomy.estado_entidad NOT NULL);
CREATE TABLE catalog.products (id uuid PRIMARY KEY, nombre text NOT NULL, descripcion text, categoria_id uuid NOT NULL, tipo_producto_id uuid NOT NULL, marca_id uuid NOT NULL, sku_base text, slug text NOT NULL UNIQUE, tiene_variantes boolean NOT NULL, estado text NOT NULL);
CREATE TABLE catalog.variants (id uuid PRIMARY KEY, product_id uuid NOT NULL, sku text NOT NULL, estado text NOT NULL);
CREATE TABLE catalog.product_images (id uuid PRIMARY KEY, product_id uuid NOT NULL, url text NOT NULL, posicion integer NOT NULL);
CREATE TABLE catalog.variant_images (id uuid PRIMARY KEY, variant_id uuid NOT NULL, url text NOT NULL, posicion integer NOT NULL);
CREATE TABLE catalog.product_attribute_values (id uuid PRIMARY KEY, product_id uuid NOT NULL, caracteristica_id uuid NOT NULL, nombre_snapshot text NOT NULL, valor_id uuid, valor jsonb NOT NULL);
CREATE TABLE catalog.variant_attribute_values (id uuid PRIMARY KEY, variant_id uuid NOT NULL, caracteristica_id uuid NOT NULL, nombre_snapshot text NOT NULL, valor_id uuid, valor jsonb NOT NULL, es_identificador boolean NOT NULL);
REVOKE ALL ON SCHEMA taxonomy, catalog FROM PUBLIC;
GRANT USAGE ON SCHEMA taxonomy TO taxonomy_app;
GRANT USAGE ON SCHEMA catalog TO catalog_app;
GRANT SELECT ON ALL TABLES IN SCHEMA taxonomy TO taxonomy_app;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO catalog_app;
ALTER ROLE taxonomy_app SET default_transaction_read_only = on;
ALTER ROLE catalog_app SET default_transaction_read_only = on;
