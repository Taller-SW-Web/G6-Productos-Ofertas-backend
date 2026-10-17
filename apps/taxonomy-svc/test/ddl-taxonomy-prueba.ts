import {
  AcreditacionInstanciaEfimera,
  BaseNoAisladaError,
} from './postgres-isolation.js';

export const ROL_PROPIETARIO = 'po_taxonomy_owner';
export const ROL_APP = 'taxonomy_app';
export const PASSWORD_APP = 'taxonomy_app_prueba';

const SENTENCIA_DROP = 'DROP SCHEMA IF EXISTS taxonomy CASCADE';

function exigirAcreditacion(acreditacion: AcreditacionInstanciaEfimera): void {
  if (!(acreditacion instanceof AcreditacionInstanciaEfimera)) {
    throw new BaseNoAisladaError(
      'DDL destructivo sin acreditación de instancia efímera verificada en vivo.',
    );
  }
}

export function construirSentenciaDropDdl(
  acreditacion: AcreditacionInstanciaEfimera,
): string {
  exigirAcreditacion(acreditacion);
  return SENTENCIA_DROP;
}

export function construirSentenciasDdl(
  acreditacion: AcreditacionInstanciaEfimera,
): string[] {
  exigirAcreditacion(acreditacion);
  return [
    SENTENCIA_DROP,
    `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL_PROPIETARIO}') THEN CREATE ROLE ${ROL_PROPIETARIO} LOGIN; END IF; END $do$;`,
    `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL_APP}') THEN CREATE ROLE ${ROL_APP} LOGIN; END IF; END $do$;`,
    `ALTER ROLE ${ROL_APP} WITH LOGIN PASSWORD '${PASSWORD_APP}'`,
    'CREATE SCHEMA taxonomy_isolation_probe',
    'CREATE TABLE taxonomy_isolation_probe.private_data (id uuid PRIMARY KEY DEFAULT gen_random_uuid())',
    'REVOKE ALL ON SCHEMA taxonomy_isolation_probe FROM PUBLIC',
    'REVOKE ALL ON ALL TABLES IN SCHEMA taxonomy_isolation_probe FROM PUBLIC',
    `CREATE SCHEMA taxonomy AUTHORIZATION ${ROL_PROPIETARIO}`,
    "CREATE TYPE taxonomy.estado_entidad AS ENUM ('ACTIVO', 'INACTIVO', 'PENDING_DEACTIVATION')",
    `CREATE TABLE taxonomy.categories (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      nombre text NOT NULL,
      descripcion text NULL,
      categoria_padre_id uuid NULL,
      nivel smallint NOT NULL DEFAULT 1,
      orden integer NOT NULL DEFAULT 0,
      imagen_url text NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_categories PRIMARY KEY (id),
      CONSTRAINT fk_categories_categoria_padre FOREIGN KEY (categoria_padre_id)
        REFERENCES taxonomy.categories(id) ON DELETE RESTRICT,
      CONSTRAINT ck_categories_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_categories_nivel CHECK (nivel IN (1, 2)),
      CONSTRAINT ck_categories_orden CHECK (orden >= 0),
      CONSTRAINT ck_categories_version CHECK (taxonomy_version >= 0),
      CONSTRAINT ck_categories_no_self_parent CHECK (categoria_padre_id <> id),
      CONSTRAINT ck_categories_padre_nivel CHECK (
        (categoria_padre_id IS NULL AND nivel = 1) OR
        (categoria_padre_id IS NOT NULL AND nivel = 2)
      )
    )`,
    `CREATE TABLE taxonomy.brands (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      nombre text NOT NULL,
      nombre_normalizado text GENERATED ALWAYS AS (lower(regexp_replace(btrim(nombre), '[[:space:]]+', ' ', 'g'))) STORED,
      descripcion text NULL,
      logo_url text NULL,
      pais_origen_iso char(2) NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_brands PRIMARY KEY (id),
      CONSTRAINT uq_brands_nombre_normalizado UNIQUE (nombre_normalizado),
      CONSTRAINT ck_brands_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_brands_nombre_normalizado_not_empty CHECK (length(trim(nombre_normalizado)) > 0),
      CONSTRAINT ck_brands_version CHECK (taxonomy_version >= 0),
      CONSTRAINT ck_brands_pais_iso CHECK (pais_origen_iso IS NULL OR pais_origen_iso ~ '^[A-Z]{2}$')
    )`,
    `CREATE TABLE taxonomy.runtime_settings (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      clave text NOT NULL,
      valor_integer integer NOT NULL,
      descripcion text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_runtime_settings PRIMARY KEY (id),
      CONSTRAINT uq_runtime_settings_clave UNIQUE (clave),
      CONSTRAINT ck_runtime_settings_clave_not_empty CHECK (length(trim(clave)) > 0),
      CONSTRAINT ck_runtime_settings_valor_positivo CHECK (valor_integer > 0)
    )`,
    "CREATE TYPE taxonomy.tipo_caracteristica AS ENUM ('TEXTO', 'NUMERO', 'LISTA')",
    "CREATE TYPE taxonomy.tipo_entidad_maestra AS ENUM ('CATEGORY', 'BRAND', 'CHARACTERISTIC', 'CHARACTERISTIC_VALUE', 'PRODUCT_TYPE', 'PRODUCT_TYPE_CHARACTERISTIC')",
    "CREATE TYPE taxonomy.estado_operacion_baja AS ENUM ('REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'FAILED')",
    `CREATE TABLE taxonomy.characteristics (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      nombre text NOT NULL,
      tipo taxonomy.tipo_caracteristica NOT NULL,
      unidad_medida text NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_characteristics PRIMARY KEY (id),
      CONSTRAINT uq_characteristics_nombre UNIQUE (nombre),
      CONSTRAINT ck_characteristics_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_characteristics_unidad_medida CHECK (
        (tipo = 'NUMERO' AND unidad_medida IS NOT NULL AND length(trim(unidad_medida)) > 0) OR
        (tipo <> 'NUMERO' AND unidad_medida IS NULL)
      ),
      CONSTRAINT ck_characteristics_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.characteristic_values (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      caracteristica_id uuid NOT NULL,
      nombre text NOT NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_characteristic_values PRIMARY KEY (id),
      CONSTRAINT fk_characteristic_values_caracteristica FOREIGN KEY (caracteristica_id)
        REFERENCES taxonomy.characteristics(id) ON DELETE RESTRICT,
      CONSTRAINT uq_characteristic_values_nombre UNIQUE (caracteristica_id, nombre),
      CONSTRAINT ck_characteristic_values_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_characteristic_values_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.product_types (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      nombre text NOT NULL,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      schema_version bigint NOT NULL DEFAULT 1,
      taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_product_types PRIMARY KEY (id),
      CONSTRAINT uq_product_types_nombre UNIQUE (nombre),
      CONSTRAINT ck_product_types_nombre_not_empty CHECK (length(trim(nombre)) > 0),
      CONSTRAINT ck_product_types_schema_version CHECK (schema_version >= 1),
      CONSTRAINT ck_product_types_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.product_type_characteristics (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      tipo_producto_id uuid NOT NULL,
      caracteristica_id uuid NOT NULL,
      obligatoria boolean NOT NULL DEFAULT false,
      estado taxonomy.estado_entidad NOT NULL DEFAULT 'ACTIVO',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_product_type_characteristics PRIMARY KEY (id),
      CONSTRAINT fk_ptc_tipo_producto FOREIGN KEY (tipo_producto_id)
        REFERENCES taxonomy.product_types(id) ON DELETE RESTRICT,
      CONSTRAINT fk_ptc_caracteristica FOREIGN KEY (caracteristica_id)
        REFERENCES taxonomy.characteristics(id) ON DELETE RESTRICT,
      CONSTRAINT uq_ptc_tipo_caracteristica UNIQUE (tipo_producto_id, caracteristica_id)
    )`,
    `CREATE TABLE taxonomy.category_seo (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      categoria_id uuid NOT NULL,
      slug text NOT NULL,
      meta_titulo text NULL,
      meta_descripcion text NULL,
      taxonomy_version bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_category_seo PRIMARY KEY (id),
      CONSTRAINT fk_category_seo_categoria FOREIGN KEY (categoria_id)
        REFERENCES taxonomy.categories(id) ON DELETE RESTRICT,
      CONSTRAINT uq_category_seo_categoria UNIQUE (categoria_id),
      CONSTRAINT uq_category_seo_slug UNIQUE (slug),
      CONSTRAINT ck_category_seo_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      CONSTRAINT ck_category_seo_version CHECK (taxonomy_version >= 0)
    )`,
    `CREATE TABLE taxonomy.slug_history (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      categoria_id uuid NOT NULL,
      old_slug text NOT NULL,
      new_slug text NOT NULL,
      changed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_slug_history PRIMARY KEY (id),
      CONSTRAINT fk_slug_history_categoria FOREIGN KEY (categoria_id)
        REFERENCES taxonomy.categories(id) ON DELETE RESTRICT,
      CONSTRAINT ck_slug_history_distinct CHECK (old_slug <> new_slug)
    )`,
    `CREATE TABLE taxonomy.master_deactivation_operations (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      operation_id uuid NOT NULL,
      entity_type taxonomy.tipo_entidad_maestra NOT NULL,
      entity_id uuid NOT NULL,
      status taxonomy.estado_operacion_baja NOT NULL DEFAULT 'REQUESTED',
      reason text NULL,
      correlation_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_master_deactivation_operations PRIMARY KEY (id),
      CONSTRAINT uq_mdo_operation_id UNIQUE (operation_id),
      CONSTRAINT ck_mdo_operation_id_not_nil CHECK (operation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
      CONSTRAINT ck_mdo_correlation_id_not_nil CHECK (correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    )`,
    `CREATE TABLE taxonomy.outbox (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      message_id uuid NOT NULL DEFAULT gen_random_uuid(),
      event_name text NOT NULL,
      kind text NOT NULL,
      schema_version integer NOT NULL DEFAULT 1,
      correlation_id uuid NOT NULL,
      causation_id uuid NULL,
      operation_id uuid NULL,
      occurred_at timestamptz NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text NULL,
      CONSTRAINT pk_outbox PRIMARY KEY (id),
      CONSTRAINT uq_outbox_message_id UNIQUE (message_id),
      CONSTRAINT ck_outbox_kind CHECK (kind IN ('command', 'event', 'result')),
      CONSTRAINT ck_outbox_schema_version CHECK (schema_version >= 1),
      CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0)
    )`,
    `CREATE TABLE taxonomy.inbox (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      message_id uuid NOT NULL,
      handler text NOT NULL,
      event_name text NOT NULL,
      correlation_id uuid NULL,
      payload jsonb NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      result text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_inbox PRIMARY KEY (id),
      CONSTRAINT uq_inbox_message_handler UNIQUE (message_id, handler),
      CONSTRAINT ck_inbox_handler_not_empty CHECK (length(trim(handler)) > 0),
      CONSTRAINT ck_inbox_result CHECK (result IN ('PROCESSED', 'IGNORED', 'FAILED'))
    )`,
    'CREATE INDEX ix_categories_padre_id ON taxonomy.categories(categoria_padre_id)',
    'CREATE INDEX ix_characteristic_values_caracteristica_id ON taxonomy.characteristic_values(caracteristica_id)',
    'CREATE INDEX ix_ptc_tipo_producto_id ON taxonomy.product_type_characteristics(tipo_producto_id)',
    'CREATE INDEX ix_ptc_caracteristica_id ON taxonomy.product_type_characteristics(caracteristica_id)',
    'CREATE INDEX ix_category_seo_categoria_id ON taxonomy.category_seo(categoria_id)',
    'CREATE INDEX ix_slug_history_categoria_id ON taxonomy.slug_history(categoria_id)',
    'CREATE INDEX ix_slug_history_old_slug ON taxonomy.slug_history(old_slug)',
    'CREATE INDEX ix_mdo_entity ON taxonomy.master_deactivation_operations(entity_type, entity_id)',
    'CREATE INDEX ix_outbox_pending ON taxonomy.outbox(published_at, occurred_at) WHERE published_at IS NULL',
    'CREATE INDEX ix_inbox_message_handler ON taxonomy.inbox(message_id, handler)',
    'REVOKE ALL ON SCHEMA taxonomy FROM PUBLIC',
    `GRANT USAGE ON SCHEMA taxonomy TO ${ROL_APP}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA taxonomy TO ${ROL_APP}`,
  ];
}

export function construirSentenciasSemilla(): string[] {
  return [
    `INSERT INTO taxonomy.categories (id, nombre, nivel, orden, estado) VALUES
      ('11111111-1111-4111-8111-111111111111', 'Calzado', 1, 0, 'ACTIVO')`,
    `INSERT INTO taxonomy.categories (id, nombre, categoria_padre_id, nivel, orden, estado) VALUES
      ('22222222-2222-4222-8222-222222222222', 'Zapatillas', '11111111-1111-4111-8111-111111111111', 2, 0, 'ACTIVO')`,
    `INSERT INTO taxonomy.categories (id, nombre, nivel, orden, estado) VALUES
      ('33333333-3333-4333-8333-333333333333', 'Descontinuada', 1, 0, 'INACTIVO')`,
    `INSERT INTO taxonomy.brands (id, nombre, descripcion, pais_origen_iso, estado) VALUES
      ('44444444-4444-4444-8444-444444444444', 'Marathon', 'Marca ecuatoriana', 'EC', 'ACTIVO')`,
    `INSERT INTO taxonomy.brands (id, nombre, descripcion, pais_origen_iso, estado) VALUES
      ('55555555-5555-4555-8555-555555555555', 'Retirada', NULL, NULL, 'INACTIVO')`,
  ];
}
