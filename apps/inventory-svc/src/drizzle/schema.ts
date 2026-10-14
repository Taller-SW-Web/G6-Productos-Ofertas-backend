import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const inventorySchema = pgSchema('inventory');

export const reservationStatusEnum = inventorySchema.enum(
  'reservation_status',
  ['ACTIVA', 'CONSUMIDA', 'LIBERADA', 'EXPIRADA'],
);

export const operationTypeEnum = inventorySchema.enum('operation_type', [
  'RESERVA',
  'CONSUMO',
  'LIBERACION',
  'EXPIRACION',
  'AJUSTE_ABSOLUTO',
  'INCIDENCIA_BLOQUEO',
  'INCIDENCIA_RESOLUCION',
  'REINTEGRO',
  'CONCILIACION_OFFLINE',
  'RECEPCION_TRASLADO',
  'INICIALIZACION_SKU',
]);

export const operationStatusEnum = inventorySchema.enum('operation_status', [
  'RECIBIDO',
  'APLICADO',
  'RECHAZADO',
  'REQUIRES_REVIEW',
]);

export const stockStatusEnum = inventorySchema.enum('stock_status', [
  'AGOTADO',
  'STOCK_BAJO',
  'DISPONIBLE',
]);

export const outboxStatusEnum = inventorySchema.enum('outbox_status', [
  'PENDING',
  'PUBLISHED',
]);

export const inboxStatusEnum = inventorySchema.enum('inbox_status', [
  'RECEIVED',
  'PROCESSED',
]);

// 1. locations
export const locations = inventorySchema.table('locations', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  external_ref: text('external_ref'),
  active: boolean('active').default(true).notNull(),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// 2. stock_balance
export const stockBalance = inventorySchema.table(
  'stock_balance',
  {
    sku_id: text('sku_id').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    on_hand: integer('on_hand').default(0).notNull(),
    reserved: integer('reserved').default(0).notNull(),
    blocked: integer('blocked').default(0).notNull(),
    stock_version: bigint('stock_version', { mode: 'number' })
      .default(0)
      .notNull(),
    available: integer('available').generatedAlwaysAs(
      sql`GREATEST(0, on_hand - reserved - blocked)`,
    ),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.sku_id, t.location_id] })],
);

// 3. reservations
export const reservations = inventorySchema.table(
  'reservations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reservation_id: uuid('reservation_id').notNull().unique(),
    status: reservationStatusEnum('status').default('ACTIVA').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    idempotency_key: text('idempotency_key').notNull().unique(),
    intention: text('intention').default('reservar').notNull(),
    correlation_id: uuid('correlation_id'),
    order_id: text('order_id'),
    operation_id: uuid('operation_id'),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    released_at: timestamp('released_at', { withTimezone: true }),
    expired_at: timestamp('expired_at', { withTimezone: true }),
    request_fingerprint: text('request_fingerprint'),
    accepted_payload: jsonb('accepted_payload'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('uq_inventory_reservations_operation_id')
      .on(t.operation_id)
      .where(sql`${t.operation_id} IS NOT NULL`),
  ],
);

// 4. reservation_lines
export const reservationLines = inventorySchema.table(
  'reservation_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reservation_id: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    sku_id: text('sku_id').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    uniqueIndex('uq_reservation_lines').on(
      t.reservation_id,
      t.sku_id,
      t.location_id,
    ),
  ],
);

// 5. inventory_operations
export const inventoryOperations = inventorySchema.table(
  'inventory_operations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    operation_type: operationTypeEnum('operation_type').notNull(),
    idempotency_key: text('idempotency_key').notNull().unique(),
    intention: text('intention').notNull(),
    status: operationStatusEnum('status').default('RECIBIDO').notNull(),
    sku_id: text('sku_id'),
    location_id: uuid('location_id').references(() => locations.id, {
      onDelete: 'restrict',
    }),
    quantity_requested: integer('quantity_requested'),
    quantity_applied: integer('quantity_applied'),
    result_code: text('result_code'),
    correlation_id: uuid('correlation_id'),
    order_id: text('order_id'),
    reservation_id: uuid('reservation_id'),
    stock_version: bigint('stock_version', { mode: 'number' }),
    accepted_at: timestamp('accepted_at', { withTimezone: true }),
    applied_at: timestamp('applied_at', { withTimezone: true }),
    operation_id: uuid('operation_id'),
    client_id: text('client_id'),
    request_fingerprint: text('request_fingerprint'),
    request_payload: jsonb('request_payload'),
    result_payload: jsonb('result_payload'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('uq_inventory_operations_operation_id')
      .on(t.operation_id)
      .where(sql`${t.operation_id} IS NOT NULL`),
  ],
);

// 6. kardex
export const kardex = inventorySchema.table('kardex', {
  id: uuid('id').defaultRandom().primaryKey(),
  sku_id: text('sku_id').notNull(),
  location_id: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'restrict' }),
  operation_type: operationTypeEnum('operation_type').notNull(),
  operation_id: uuid('operation_id'),
  reservation_id: uuid('reservation_id'),
  quantity: integer('quantity').notNull(),
  on_hand_before: integer('on_hand_before').notNull(),
  on_hand_after: integer('on_hand_after').notNull(),
  reserved_before: integer('reserved_before').notNull(),
  reserved_after: integer('reserved_after').notNull(),
  blocked_before: integer('blocked_before').notNull(),
  blocked_after: integer('blocked_after').notNull(),
  stock_version: bigint('stock_version', { mode: 'number' }).notNull(),
  correlation_id: uuid('correlation_id'),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// 7. outbox
export const outbox = inventorySchema.table('outbox', {
  id: uuid('id').defaultRandom().primaryKey(),
  event_id: uuid('event_id').notNull().unique(),
  event_type: text('event_type').notNull(),
  aggregate_type: text('aggregate_type').notNull(),
  aggregate_id: text('aggregate_id').notNull(),
  correlation_id: uuid('correlation_id'),
  payload: jsonb('payload').notNull(),
  status: outboxStatusEnum('status').default('PENDING').notNull(),
  published_at: timestamp('published_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// 8. commercial_fulfillment_routes
export const commercialFulfillmentRoutes = inventorySchema.table(
  'commercial_fulfillment_routes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    channel_id: text('channel_id').notNull(),
    mode: text('mode').notNull(),
    fulfillment_ref: text('fulfillment_ref').notNull(),
    location_id: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    active: boolean('active').default(true).notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);

// 9. stock_threshold_override
export const stockThresholdOverride = inventorySchema.table(
  'stock_threshold_override',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sku_id: text('sku_id'),
    location_id: uuid('location_id').references(() => locations.id, {
      onDelete: 'restrict',
    }),
    umbral_efectivo: integer('umbral_efectivo').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);
