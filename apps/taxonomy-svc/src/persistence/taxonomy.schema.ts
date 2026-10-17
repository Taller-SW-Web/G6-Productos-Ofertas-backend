import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const taxonomia = pgSchema('taxonomy');

export const estadoEntidad = taxonomia.enum('estado_entidad', [
  'ACTIVO',
  'INACTIVO',
  'PENDING_DEACTIVATION',
]);

export const tipoCaracteristica = taxonomia.enum('tipo_caracteristica', [
  'TEXTO',
  'NUMERO',
  'LISTA',
]);

export const tipoEntidadMaestra = taxonomia.enum('tipo_entidad_maestra', [
  'CATEGORY',
  'BRAND',
  'CHARACTERISTIC',
  'CHARACTERISTIC_VALUE',
  'PRODUCT_TYPE',
  'PRODUCT_TYPE_CHARACTERISTIC',
]);

export const estadoOperacionBaja = taxonomia.enum('estado_operacion_baja', [
  'REQUESTED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
  'FAILED',
]);

export const runtimeSettings = taxonomia.table(
  'runtime_settings',
  {
    id: uuid('id').defaultRandom().notNull(),
    clave: text('clave').notNull(),
    valorInteger: integer('valor_integer').notNull(),
    descripcion: text('descripcion'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_runtime_settings' }),
    unique('uq_runtime_settings_clave').on(tabla.clave),
    check(
      'ck_runtime_settings_clave_not_empty',
      sql`length(trim(${tabla.clave})) > 0`,
    ),
    check('ck_runtime_settings_valor_positivo', sql`${tabla.valorInteger} > 0`),
  ],
);

export const categorias = taxonomia.table(
  'categories',
  {
    id: uuid('id').defaultRandom().notNull(),
    nombre: text('nombre').notNull(),
    descripcion: text('descripcion'),
    categoriaPadreId: uuid('categoria_padre_id'),
    nivel: smallint('nivel').notNull().default(1),
    orden: integer('orden').notNull().default(0),
    imagenUrl: text('imagen_url'),
    estado: estadoEntidad('estado').notNull().default('ACTIVO'),
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_categories' }),
    foreignKey({
      columns: [tabla.categoriaPadreId],
      foreignColumns: [tabla.id],
      name: 'fk_categories_categoria_padre',
    }).onDelete('restrict'),
    check(
      'ck_categories_nombre_not_empty',
      sql`length(trim(${tabla.nombre})) > 0`,
    ),
    check('ck_categories_nivel', sql`${tabla.nivel} IN (1, 2)`),
    check('ck_categories_orden', sql`${tabla.orden} >= 0`),
    check('ck_categories_version', sql`${tabla.taxonomyVersion} >= 0`),
    check(
      'ck_categories_no_self_parent',
      sql`${tabla.categoriaPadreId} <> ${tabla.id}`,
    ),
    check(
      'ck_categories_padre_nivel',
      sql`(${tabla.categoriaPadreId} IS NULL AND ${tabla.nivel} = 1) OR (${tabla.categoriaPadreId} IS NOT NULL AND ${tabla.nivel} = 2)`,
    ),
    index('ix_categories_padre_id').on(tabla.categoriaPadreId),
  ],
);

export const marcas = taxonomia.table(
  'brands',
  {
    id: uuid('id').defaultRandom().notNull(),
    nombre: text('nombre').notNull(),
    nombreNormalizado: text('nombre_normalizado').generatedAlwaysAs(
      sql`lower(regexp_replace(btrim(nombre), '[[:space:]]+', ' ', 'g'))`,
    ),
    descripcion: text('descripcion'),
    logoUrl: text('logo_url'),
    paisOrigenIso: char('pais_origen_iso', { length: 2 }),
    estado: estadoEntidad('estado').notNull().default('ACTIVO'),
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_brands' }),
    unique('uq_brands_nombre_normalizado').on(tabla.nombreNormalizado),
    check('ck_brands_nombre_not_empty', sql`length(trim(${tabla.nombre})) > 0`),
    check(
      'ck_brands_nombre_normalizado_not_empty',
      sql`length(trim(${tabla.nombreNormalizado})) > 0`,
    ),
    check(
      'ck_brands_pais_iso',
      sql`${tabla.paisOrigenIso} IS NULL OR ${tabla.paisOrigenIso} ~ '^[A-Z]{2}$'`,
    ),
    check('ck_brands_version', sql`${tabla.taxonomyVersion} >= 0`),
  ],
);

export const characteristics = taxonomia.table(
  'characteristics',
  {
    id: uuid('id').defaultRandom().notNull(),
    nombre: text('nombre').notNull(),
    tipo: tipoCaracteristica('tipo').notNull(),
    unidadMedida: text('unidad_medida'),
    estado: estadoEntidad('estado').notNull().default('ACTIVO'),
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_characteristics' }),
    unique('uq_characteristics_nombre').on(tabla.nombre),
    check(
      'ck_characteristics_nombre_not_empty',
      sql`length(trim(${tabla.nombre})) > 0`,
    ),
    check(
      'ck_characteristics_unidad_medida',
      sql`(${tabla.tipo} = 'NUMERO' AND ${tabla.unidadMedida} IS NOT NULL AND length(trim(${tabla.unidadMedida})) > 0) OR (${tabla.tipo} <> 'NUMERO' AND ${tabla.unidadMedida} IS NULL)`,
    ),
    check('ck_characteristics_version', sql`${tabla.taxonomyVersion} >= 0`),
  ],
);

export const characteristicValues = taxonomia.table(
  'characteristic_values',
  {
    id: uuid('id').defaultRandom().notNull(),
    caracteristicaId: uuid('caracteristica_id').notNull(),
    nombre: text('nombre').notNull(),
    estado: estadoEntidad('estado').notNull().default('ACTIVO'),
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_characteristic_values' }),
    foreignKey({
      columns: [tabla.caracteristicaId],
      foreignColumns: [characteristics.id],
      name: 'fk_characteristic_values_caracteristica',
    }).onDelete('restrict'),
    unique('uq_characteristic_values_nombre').on(
      tabla.caracteristicaId,
      tabla.nombre,
    ),
    check(
      'ck_characteristic_values_nombre_not_empty',
      sql`length(trim(${tabla.nombre})) > 0`,
    ),
    check(
      'ck_characteristic_values_version',
      sql`${tabla.taxonomyVersion} >= 0`,
    ),
    index('ix_characteristic_values_caracteristica_id').on(
      tabla.caracteristicaId,
    ),
  ],
);

export const productTypes = taxonomia.table(
  'product_types',
  {
    id: uuid('id').defaultRandom().notNull(),
    nombre: text('nombre').notNull(),
    estado: estadoEntidad('estado').notNull().default('ACTIVO'),
    schemaVersion: bigint('schema_version', { mode: 'number' })
      .notNull()
      .default(1),
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_product_types' }),
    unique('uq_product_types_nombre').on(tabla.nombre),
    check(
      'ck_product_types_nombre_not_empty',
      sql`length(trim(${tabla.nombre})) > 0`,
    ),
    check('ck_product_types_schema_version', sql`${tabla.schemaVersion} >= 1`),
    check('ck_product_types_version', sql`${tabla.taxonomyVersion} >= 0`),
  ],
);

export const productTypeCharacteristics = taxonomia.table(
  'product_type_characteristics',
  {
    id: uuid('id').defaultRandom().notNull(),
    tipoProductoId: uuid('tipo_producto_id').notNull(),
    caracteristicaId: uuid('caracteristica_id').notNull(),
    obligatoria: boolean('obligatoria').notNull().default(false),
    estado: estadoEntidad('estado').notNull().default('ACTIVO'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({
      columns: [tabla.id],
      name: 'pk_product_type_characteristics',
    }),
    foreignKey({
      columns: [tabla.tipoProductoId],
      foreignColumns: [productTypes.id],
      name: 'fk_ptc_tipo_producto',
    }).onDelete('restrict'),
    foreignKey({
      columns: [tabla.caracteristicaId],
      foreignColumns: [characteristics.id],
      name: 'fk_ptc_caracteristica',
    }).onDelete('restrict'),
    unique('uq_ptc_tipo_caracteristica').on(
      tabla.tipoProductoId,
      tabla.caracteristicaId,
    ),
    index('ix_ptc_tipo_producto_id').on(tabla.tipoProductoId),
    index('ix_ptc_caracteristica_id').on(tabla.caracteristicaId),
  ],
);

export const categorySeo = taxonomia.table(
  'category_seo',
  {
    id: uuid('id').defaultRandom().notNull(),
    categoriaId: uuid('categoria_id').notNull(),
    slug: text('slug').notNull(),
    metaTitulo: text('meta_titulo'),
    metaDescripcion: text('meta_descripcion'),
    taxonomyVersion: bigint('taxonomy_version', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_category_seo' }),
    foreignKey({
      columns: [tabla.categoriaId],
      foreignColumns: [categorias.id],
      name: 'fk_category_seo_categoria',
    }).onDelete('restrict'),
    unique('uq_category_seo_categoria').on(tabla.categoriaId),
    unique('uq_category_seo_slug').on(tabla.slug),
    check(
      'ck_category_seo_slug_format',
      sql`${tabla.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check('ck_category_seo_version', sql`${tabla.taxonomyVersion} >= 0`),
    index('ix_category_seo_categoria_id').on(tabla.categoriaId),
  ],
);

export const slugHistory = taxonomia.table(
  'slug_history',
  {
    id: uuid('id').defaultRandom().notNull(),
    categoriaId: uuid('categoria_id').notNull(),
    oldSlug: text('old_slug').notNull(),
    newSlug: text('new_slug').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_slug_history' }),
    foreignKey({
      columns: [tabla.categoriaId],
      foreignColumns: [categorias.id],
      name: 'fk_slug_history_categoria',
    }).onDelete('restrict'),
    check(
      'ck_slug_history_distinct',
      sql`${tabla.oldSlug} <> ${tabla.newSlug}`,
    ),
    index('ix_slug_history_categoria_id').on(tabla.categoriaId),
    index('ix_slug_history_old_slug').on(tabla.oldSlug),
  ],
);

export const masterDeactivationOperations = taxonomia.table(
  'master_deactivation_operations',
  {
    id: uuid('id').defaultRandom().notNull(),
    operationId: uuid('operation_id').notNull(),
    entityType: tipoEntidadMaestra('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    status: estadoOperacionBaja('status').notNull().default('REQUESTED'),
    reason: text('reason'),
    correlationId: uuid('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({
      columns: [tabla.id],
      name: 'pk_master_deactivation_operations',
    }),
    unique('uq_mdo_operation_id').on(tabla.operationId),
    check(
      'ck_mdo_operation_id_not_nil',
      sql`${tabla.operationId} <> '00000000-0000-0000-0000-000000000000'::uuid`,
    ),
    check(
      'ck_mdo_correlation_id_not_nil',
      sql`${tabla.correlationId} <> '00000000-0000-0000-0000-000000000000'::uuid`,
    ),
    index('ix_mdo_entity').on(tabla.entityType, tabla.entityId),
  ],
);

export const outbox = taxonomia.table(
  'outbox',
  {
    id: uuid('id').defaultRandom().notNull(),
    messageId: uuid('message_id').defaultRandom().notNull(),
    eventName: text('event_name').notNull(),
    kind: text('kind').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    correlationId: uuid('correlation_id').notNull(),
    causationId: uuid('causation_id'),
    operationId: uuid('operation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_outbox' }),
    unique('uq_outbox_message_id').on(tabla.messageId),
    check(
      'ck_outbox_kind',
      sql`${tabla.kind} IN ('command', 'event', 'result')`,
    ),
    check('ck_outbox_schema_version', sql`${tabla.schemaVersion} >= 1`),
    check('ck_outbox_attempts', sql`${tabla.attempts} >= 0`),
    index('ix_outbox_pending')
      .on(tabla.publishedAt, tabla.occurredAt)
      .where(sql`${tabla.publishedAt} IS NULL`),
  ],
);

export const inbox = taxonomia.table(
  'inbox',
  {
    id: uuid('id').defaultRandom().notNull(),
    messageId: uuid('message_id').notNull(),
    handler: text('handler').notNull(),
    eventName: text('event_name').notNull(),
    correlationId: uuid('correlation_id'),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    result: text('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (tabla) => [
    primaryKey({ columns: [tabla.id], name: 'pk_inbox' }),
    unique('uq_inbox_message_handler').on(tabla.messageId, tabla.handler),
    check(
      'ck_inbox_handler_not_empty',
      sql`length(trim(${tabla.handler})) > 0`,
    ),
    check(
      'ck_inbox_result',
      sql`${tabla.result} IN ('PROCESSED', 'IGNORED', 'FAILED')`,
    ),
    index('ix_inbox_message_handler').on(tabla.messageId, tabla.handler),
  ],
);

export const esquemaTaxonomia = {
  estadoEntidad,
  tipoCaracteristica,
  tipoEntidadMaestra,
  estadoOperacionBaja,
  runtimeSettings,
  categorias,
  marcas,
  characteristics,
  characteristicValues,
  productTypes,
  productTypeCharacteristics,
  categorySeo,
  slugHistory,
  masterDeactivationOperations,
  outbox,
  inbox,
};
