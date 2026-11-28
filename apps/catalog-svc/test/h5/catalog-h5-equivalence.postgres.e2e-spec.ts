import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq, and, sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Database, type PostgresSettings } from '../../src/database.js';
import {
  activationChecks,
  inbox,
  outbox,
  outboxDelivery,
  products,
  skuIdentity,
  variants,
} from '../../src/catalog.schema.js';
import { CatalogTransactionManager } from '../../src/catalog-transaction.js';
import { PostgresCatalogWriteRepository } from '../../src/postgres-catalog-write.repository.js';
import { CatalogMasterClient } from '../../src/catalog-master.client.js';
import { CatalogMutationService } from '../../src/catalog-mutation.service.js';
import { approvedCatalogProductPolicy } from '../../src/catalog-product.policy.js';
import { CatalogBulkService, type CatalogBulkIdentity } from '../../src/catalog-bulk.service.js';
import { CatalogMessageService } from '../../src/catalog-message.service.js';
import { CatalogTelemetry } from '../../src/catalog-telemetry.js';
import {
  InvalidCatalogMessage,
  type CatalogEnvelope,
} from '../../src/catalog-messages.js';
import { relayCatalogDelivery } from '../../src/catalog-service-bus-relay.js';
import {
  createCatalogBulkConsumer,
  createCatalogTaxonomyConsumer,
} from '../../src/catalog-service-bus.runtime.js';

/**
 * H16 — Suite auténtica de equivalencia H5 para las 6 brechas históricas de catalog-svc
 * contra código productivo real y PostgreSQL 17 descartable (sin RabbitMQ ni Azure real).
 *
 * Escenarios acreditados:
 *  1. TAXONOMY-UPDATES
 *  2. BLOCK-A2
 *  3. JOINT-01
 *  4. JOINT-01-REGRESSION
 *  5. BULK-JOINT
 *  6. BULK-CONSUMER-v2
 *
 * Requiere: CATALOG_H5_DISPOSABLE_PG=1 y contenedor PostgreSQL 17 local con migraciones oficiales.
 */

const RUN_PG = process.env.CATALOG_H5_DISPOSABLE_PG === '1';

function buildLocalPgSettings(): PostgresSettings {
  const host = process.env.PGHOST || '127.0.0.1';
  const port = Number(process.env.PGPORT || '55432');
  const database = process.env.PGDATABASE || 'h5_catalog_isolated';
  const user = process.env.PGUSER || 'catalog_app';
  const password = process.env.PGPASSWORD || 'app_pass';
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error(`H16 solo permite PostgreSQL descartable local (recibido PGHOST=${host})`);
  }
  return {
    expectedRole: user,
    database,
    user,
    password,
    mode: 'direct',
    pool: {
      host,
      port,
      database,
      user,
      password,
      max: 6,
      idleTimeoutMillis: 10000,
    },
  };
}

function makeEnvelope(
  name: CatalogEnvelope['name'],
  data: Record<string, unknown>,
  overrides: Partial<CatalogEnvelope> = {},
): CatalogEnvelope {
  return {
    message_id: overrides.message_id ?? randomUUID(),
    schema_version: overrides.schema_version ?? 1,
    occurred_at: overrides.occurred_at ?? new Date().toISOString(),
    correlation_id: overrides.correlation_id ?? randomUUID(),
    causation_id: overrides.causation_id ?? null,
    operation_id: overrides.operation_id ?? null,
    producer: overrides.producer ?? 'taxonomy-svc',
    kind: overrides.kind ?? 'event',
    name,
    data,
  };
}

describe.runIf(RUN_PG)(
  'H16 — Equivalencias auténticas de Catalog H5 sobre código productivo y PostgreSQL 17 descartable',
  () => {
    let database: Database;
    let transactions: CatalogTransactionManager;
    let repository: PostgresCatalogWriteRepository;
    let mutations: CatalogMutationService;
    let bulk: CatalogBulkService;
    let messages: CatalogMessageService;
    let taxonomyServer: Server;
    let taxonomyBaseUrl = '';

    const ALL_DESTINATIONS = [
      'g6.pricing.from.catalog',
      'g6.inventory.from.catalog',
      'g6.taxonomy.from.catalog',
      'g6.bulk.from.catalog',
      'g6.promotions.from.catalog',
      'g6.combos.from.catalog',
    ];

    beforeAll(async () => {
      // Stub HTTP únicamente en la frontera externa de Taxonomy para lecturas de maestros
      taxonomyServer = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        const url = req.url ?? '/';
        if (url.startsWith('/api/v1/categorias/')) {
          const id = url.split('/').pop()?.split('?')[0] ?? 'cat-h5';
          res.end(
            JSON.stringify({
              categoriaId: id,
              nombre: 'Calzado H5',
              estado: 'ACTIVO',
              version: 1,
            }),
          );
          return;
        }
        if (url.startsWith('/api/v1/marcas/')) {
          const id = url.split('/').pop()?.split('?')[0] ?? 'marca-h5';
          res.end(
            JSON.stringify({
              marcaId: id,
              nombre: 'Marca H5',
              estado: 'ACTIVO',
              version: 1,
            }),
          );
          return;
        }
        if (url.startsWith('/api/v1/tipos-producto/') && url.endsWith('/caracteristicas')) {
          const id = url.split('/')[4] ?? 'tp-h5';
          res.end(
            JSON.stringify({
              tipoProducto: {
                tipoProductoId: id,
                estado: 'ACTIVO',
                schemaVersion: 1,
              },
              schemaVersion: 1,
              caracteristicas: [],
            }),
          );
          return;
        }
        if (url.startsWith('/api/v1/tipos-producto/')) {
          const id = url.split('/').pop()?.split('?')[0] ?? 'tp-h5';
          res.end(
            JSON.stringify({
              tipoProductoId: id,
              nombre: 'Zapatilla H5',
              estado: 'ACTIVO',
              schemaVersion: 1,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 'NO_ENCONTRADO' }));
      });
      await new Promise<void>((resolve) =>
        taxonomyServer.listen(0, '127.0.0.1', () => resolve()),
      );
      const addr = taxonomyServer.address();
      if (!addr || typeof addr === 'string') throw new Error('No port');
      taxonomyBaseUrl = `http://127.0.0.1:${addr.port}`;

      database = new Database(buildLocalPgSettings());
      await database.verifyIdentity();

      transactions = new CatalogTransactionManager(database);
      repository = new PostgresCatalogWriteRepository();
      const masterClient = new CatalogMasterClient(
        { origin: taxonomyBaseUrl } as never,
        { authorization: async () => 'Bearer synthetic-taxonomy-token' } as never,
      );
      mutations = new CatalogMutationService(
        transactions,
        repository,
        masterClient,
        approvedCatalogProductPolicy,
      );
      const bulkIdentity = {
        authorization: async () => 'Bearer synthetic-bulk-token',
      };
      bulk = new CatalogBulkService(
        database,
        mutations,
        bulkIdentity as unknown as CatalogBulkIdentity,
      );
      messages = new CatalogMessageService(
        database,
        new CatalogTelemetry(),
        bulk,
      );
    }, 30000);

    beforeEach(() => {
      vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
      vi.stubEnv('CATALOG_H5_DESTINATIONS', ALL_DESTINATIONS.join(','));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    afterAll(async () => {
      await database?.onModuleDestroy();
      await new Promise<void>((resolve) => taxonomyServer?.close(() => resolve()));
    });

    it('1. TAXONOMY-UPDATES: replay durable, ordenamiento monotónico, reinicio de consumidor y regresión negativa de payload conflictivo', async () => {
      const catId = `cat-h5-${randomUUID().slice(0, 8)}`;
      const consumer = createCatalogTaxonomyConsumer(messages, ALL_DESTINATIONS);

      const evtV1 = makeEnvelope('taxonomy.category.updated', {
        categoria_id: catId,
        nombre: 'Calzado Original',
        estado: 'ACTIVA',
        version: 1,
      });
      const evtV2 = makeEnvelope('taxonomy.category.updated', {
        categoria_id: catId,
        nombre: 'Calzado Deportivo',
        estado: 'ACTIVA',
        version: 2,
      });
      const evtStaleV1 = makeEnvelope('taxonomy.category.updated', {
        categoria_id: catId,
        nombre: 'Calzado Tardío',
        estado: 'ACTIVA',
        version: 1,
      });

      expect(await consumer.consume(evtV1)).toBe('APPLIED');
      expect(await consumer.consume(evtV2)).toBe('APPLIED');
      expect(await consumer.consume(evtStaleV1)).toBe('STALE');

      // Simulación de reinicio real de consumidor (nueva instancia sobre el mismo PostgreSQL 17)
      const restartedMessages = new CatalogMessageService(
        database,
        new CatalogTelemetry(),
        bulk,
      );
      const restartedConsumer = createCatalogTaxonomyConsumer(
        restartedMessages,
        ALL_DESTINATIONS,
      );
      expect(await restartedConsumer.consume(evtV2)).toBe('DUPLICATE');

      // Verificar persistencia real en catalog.inbox
      const rows = await database.read((db) =>
        db.select().from(inbox).where(eq(inbox.message_id, evtV2.message_id)),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('APPLIED');

      // Regresión negativa 1: reutilizar message_id con payload distinto debe fallar con InvalidCatalogMessage
      const conflictingV2 = {
        ...evtV2,
        data: { ...evtV2.data, nombre: 'Nombre Alterado Malicioso' },
      };
      await expect(restartedConsumer.consume(conflictingV2)).rejects.toBeInstanceOf(
        InvalidCatalogMessage,
      );

      // Regresión negativa 2: destino de respuesta deshabilitado bloquea deactivation check antes de ACK
      const disabledConsumer = createCatalogTaxonomyConsumer(messages, []);
      await expect(
        disabledConsumer.consume(
          makeEnvelope('taxonomy.master.deactivation.check.requested', {
            master_type: 'CATEGORIA',
            master_id: catId,
          }),
        ),
      ).rejects.toThrow('CATALOG_H5_TAXONOMY_REPLY_DISABLED');
    });

    it('2. BLOCK-A2: resultados reales de Inventory (completed/rejected), persistencia en activation_checks e idempotencia', async () => {
      const skuOk = `H5-A2-OK-${randomUUID().slice(0, 8).toUpperCase()}`;
      const corrOk = randomUUID();
      const createdOk = await mutations.createProduct(
        {
          nombre: `Producto A2 OK ${skuOk}`,
          descripcion: 'Fixture real PG17',
          categoriaId: 'cat-h5-a2',
          tipoProductoId: 'tp-h5-a2',
          marcaId: 'marca-h5-a2',
          skuBase: skuOk,
          tieneVariantes: false,
          precioBaseInicial: 59.9,
          imagenes: [{ url: 'https://example.test/a2.jpg' }],
          perfilFisico: {
            pesoKg: 1.2,
            dimensionesCm: { largo: 20, ancho: 15, alto: 10 },
          },
        },
        {
          authorization: 'Bearer synthetic-user-h5',
          correlationId: corrOk,
        },
      );

      const [invOutbox] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.correlation_id, corrOk),
              eq(outbox.event_name, 'inventory.sku.initialization.requested'),
            ),
          ),
      );
      expect(invOutbox).toBeDefined();

      const completedEvt = makeEnvelope(
        'inventory.sku.initialization.completed',
        {
          product_id: createdOk.product_id,
          sku: skuOk,
          variant_id: null,
          initialized_at: new Date().toISOString(),
        },
        {
          producer: 'inventory-svc',
          correlation_id: invOutbox!.correlation_id,
          causation_id: invOutbox!.message_id,
          operation_id: invOutbox!.operation_id,
        },
      );

      expect(await messages.consume(completedEvt)).toBe('APPLIED');
      expect(await messages.consume(completedEvt)).toBe('DUPLICATE');

      // Un segundo resultado con distinto message_id sobre check ya terminal devuelve TERMINAL y no altera el estado
      const secondResult = makeEnvelope(
        'inventory.sku.initialization.rejected',
        {
          product_id: createdOk.product_id,
          sku: skuOk,
          variant_id: null,
          reason: 'RECHAZO_TARDIO',
        },
        {
          producer: 'inventory-svc',
          correlation_id: invOutbox!.correlation_id,
          causation_id: invOutbox!.message_id,
          operation_id: invOutbox!.operation_id,
        },
      );
      expect(await messages.consume(secondResult)).toBe('TERMINAL');

      const [checkRow] = await database.read((db) =>
        db
          .select()
          .from(activationChecks)
          .where(
            and(
              eq(activationChecks.product_id, createdOk.product_id),
              eq(activationChecks.dependency, 'INVENTORY'),
            ),
          ),
      );
      expect(checkRow?.state).toBe('COMPLETED');
    });

    it('3. JOINT-01: commit atómico agregado/Outbox, relay Azure Service Bus con fallo ambiguo + recuperación y activación real', async () => {
      const sku = `H5-J01-${randomUUID().slice(0, 8).toUpperCase()}`;
      const correlationId = randomUUID();
      const created = await mutations.createProduct(
        {
          nombre: `Producto Joint 01 ${sku}`,
          descripcion: 'Flujo completo PG17',
          categoriaId: 'cat-h5-j01',
          tipoProductoId: 'tp-h5-j01',
          marcaId: 'marca-h5-j01',
          skuBase: sku,
          tieneVariantes: false,
          precioBaseInicial: 75,
          imagenes: [{ url: 'https://example.test/j01.jpg' }],
          perfilFisico: {
            pesoKg: 0.8,
            dimensionesCm: { largo: 18, ancho: 12, alto: 8 },
          },
        },
        {
          authorization: 'Bearer synthetic-user-h5',
          correlationId,
        },
      );

      // Doble de transporte compatible con Azure Service Bus: falla 1 vez (confirmación ambigua) y luego entrega
      const published: Array<{ destination: string; envelope: CatalogEnvelope }> = [];
      let failOnce = true;
      const busDouble = {
        publish: async (destination: string, env: CatalogEnvelope) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('AMBIGUOUS_BROKER_ACK');
          }
          published.push({ destination, envelope: env });
        },
      };

      const firstRelay = await relayCatalogDelivery(database, busDouble);
      expect(firstRelay).toBe('RETRY');

      // Adelantar available_at para reintento inmediato en PG17 descartable
      await database.transaction((tx) =>
        tx.execute(
          sql`UPDATE catalog.outbox_delivery SET available_at = now() WHERE published_at IS NULL`,
        ),
      );

      // Drenar todas las entregas pendientes de esta correlación
      for (let i = 0; i < 10; i += 1) {
        const step = await relayCatalogDelivery(database, busDouble);
        if (step === 'EMPTY') break;
      }

      const pricingReq = published.find(
        (p) =>
          p.envelope.correlation_id === correlationId &&
          p.envelope.name === 'pricing.product.initialization.requested',
      );
      const invReq = published.find(
        (p) =>
          p.envelope.correlation_id === correlationId &&
          p.envelope.name === 'inventory.sku.initialization.requested',
      );
      expect(pricingReq).toBeDefined();
      expect(invReq).toBeDefined();

      // Consumir resultados de Pricing e Inventory en CatalogMessageService real
      expect(
        await messages.consume(
          makeEnvelope(
            'pricing.product.initialization.completed',
            {
              product_id: created.product_id,
              sku_base: sku,
              initialized_at: new Date().toISOString(),
            },
            {
              producer: 'pricing-svc',
              correlation_id: pricingReq!.envelope.correlation_id,
              causation_id: pricingReq!.envelope.message_id,
              operation_id: pricingReq!.envelope.operation_id,
            },
          ),
        ),
      ).toBe('APPLIED');

      expect(
        await messages.consume(
          makeEnvelope(
            'inventory.sku.initialization.completed',
            {
              product_id: created.product_id,
              sku,
              variant_id: null,
              initialized_at: new Date().toISOString(),
            },
            {
              producer: 'inventory-svc',
              correlation_id: invReq!.envelope.correlation_id,
              causation_id: invReq!.envelope.message_id,
              operation_id: invReq!.envelope.operation_id,
            },
          ),
        ),
      ).toBe('APPLIED');

      // Activar el producto real en PostgreSQL 17 ahora que ambas dependencias están COMPLETED
      const activated = await mutations.state(
        created.product_id,
        undefined,
        'activate',
        { catalogVersion: created.catalog_version },
        { authorization: 'Bearer synthetic-user-h5', correlationId: randomUUID() },
      );
      const [dbProd] = await database.read((db) =>
        db.select().from(products).where(eq(products.id, created.product_id)),
      );
      expect(activated).toBeDefined();
      expect(dbProd?.estado).toBe('ACTIVO');
    });

    it('4. JOINT-01-REGRESSION: residuo previo no publicado en Outbox no puede secuestrar correlación activa', async () => {
      const sku = `H5-JR-${randomUUID().slice(0, 8).toUpperCase()}`;
      const correlationId = randomUUID();
      const created = await mutations.createProduct(
        {
          nombre: `Producto Joint Regression ${sku}`,
          descripcion: 'Prueba de aislamiento de correlación',
          categoriaId: 'cat-h5-jr',
          tipoProductoId: 'tp-h5-jr',
          marcaId: 'marca-h5-jr',
          skuBase: sku,
          tieneVariantes: false,
          precioBaseInicial: 40,
          imagenes: [{ url: 'https://example.test/jr.jpg' }],
          perfilFisico: {
            pesoKg: 0.5,
            dimensionesCm: { largo: 10, ancho: 10, alto: 10 },
          },
        },
        {
          authorization: 'Bearer synthetic-user-h5',
          correlationId,
        },
      );

      const [activeOutbox] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.correlation_id, correlationId),
              eq(outbox.event_name, 'pricing.product.initialization.requested'),
            ),
          ),
      );
      expect(activeOutbox).toBeDefined();

      // Residuo previo con causation_id ajeno (no corresponde al intento activo) -> STALE
      const staleAttemptEvt = makeEnvelope(
        'pricing.product.initialization.completed',
        {
          product_id: created.product_id,
          sku_base: sku,
          initialized_at: new Date().toISOString(),
        },
        {
          producer: 'pricing-svc',
          correlation_id: randomUUID(),
          causation_id: randomUUID(),
          operation_id: activeOutbox!.operation_id,
        },
      );
      expect(await messages.consume(staleAttemptEvt)).toBe('STALE');

      // Regresión negativa: causation_id activo pero correlation_id falsificado -> InvalidCatalogMessage
      const hijackedCorrelationEvt = makeEnvelope(
        'pricing.product.initialization.completed',
        {
          product_id: created.product_id,
          sku_base: sku,
          initialized_at: new Date().toISOString(),
        },
        {
          producer: 'pricing-svc',
          correlation_id: randomUUID(),
          causation_id: activeOutbox!.message_id,
          operation_id: activeOutbox!.operation_id,
        },
      );
      await expect(messages.consume(hijackedCorrelationEvt)).rejects.toBeInstanceOf(
        InvalidCatalogMessage,
      );
    });

    it('5. BULK-JOINT y 6. BULK-CONSUMER-v2: transacción Bulk/Catalog en PG17, resolución de SKU, UNIQUE rollback y replay idempotente', async () => {
      const bulkConsumer = createCatalogBulkConsumer(messages, ALL_DESTINATIONS);
      const batchId = randomUUID();
      const batchOpId = randomUUID();
      const rowOpId = randomUUID();
      const skuBase = `H5-BLK-${randomUUID().slice(0, 8).toUpperCase()}`;

      const bulkReq = makeEnvelope(
        'catalog.bulk.upsert.requested',
        {
          batch_id: batchId,
          batch_operation_id: batchOpId,
          template_version: 2,
          mode: 'ALTA',
          rows: [
            {
              row_number: 2,
              row_operation_id: rowOpId,
              producto_id: null,
              sku_base: skuBase,
              variant_id: null,
              product: {
                nombre: `Producto Bulk H5 ${skuBase}`,
                descripcion: 'Alta masiva real PG17',
                categoriaId: 'cat-h5-blk',
                tipoProductoId: 'tp-h5-blk',
                marcaId: 'marca-h5-blk',
                skuBase,
                tieneVariantes: false,
                precioBaseInicial: 89.9,
                imagenes: [{ url: 'https://example.test/blk.jpg' }],
                perfilFisico: {
                  pesoKg: 1.5,
                  dimensionesCm: { largo: 25, ancho: 20, alto: 12 },
                },
              },
              variant: null,
            },
          ],
        },
        {
          schema_version: 2,
          producer: 'bulk-svc',
          kind: 'command',
          operation_id: batchOpId,
        },
      );

      expect(await bulkConsumer.consume(bulkReq)).toBe('APPLIED');
      // Replay exacto debe ser DUPLICATE sin duplicar producto ni outbox
      expect(await bulkConsumer.consume(bulkReq)).toBe('DUPLICATE');

      // Verificar persistencia real en catalog.products y catalog.sku_identity
      const [persistedSku] = await database.read((db) =>
        db.select().from(skuIdentity).where(eq(skuIdentity.sku, skuBase)),
      );
      expect(persistedSku).toBeDefined();

      const bulkOutboxRows = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.operation_id, batchOpId),
              eq(outbox.event_name, 'catalog.bulk.upsert.completed'),
            ),
          ),
      );
      expect(bulkOutboxRows).toHaveLength(1);

      // Segundo lote intentando duplicar el mismo SKU debe registrar rechazo de negocio SKU_DUPLICADO en Outbox
      const dupBatchOpId = randomUUID();
      const dupReq = makeEnvelope(
        'catalog.bulk.upsert.requested',
        {
          batch_id: randomUUID(),
          batch_operation_id: dupBatchOpId,
          template_version: 2,
          mode: 'ALTA',
          rows: [
            {
              row_number: 2,
              row_operation_id: randomUUID(),
              producto_id: null,
              sku_base: skuBase,
              variant_id: null,
              product: {
                nombre: `Producto Duplicado ${randomUUID().slice(0, 6)}`,
                descripcion: 'Debe rechazarse por SKU_DUPLICADO',
                categoriaId: 'cat-h5-blk',
                tipoProductoId: 'tp-h5-blk',
                marcaId: 'marca-h5-blk',
                skuBase,
                tieneVariantes: false,
                precioBaseInicial: 89.9,
                imagenes: [{ url: 'https://example.test/blk2.jpg' }],
                perfilFisico: {
                  pesoKg: 1.5,
                  dimensionesCm: { largo: 25, ancho: 20, alto: 12 },
                },
              },
              variant: null,
            },
          ],
        },
        {
          schema_version: 2,
          producer: 'bulk-svc',
          kind: 'command',
          operation_id: dupBatchOpId,
        },
      );

      expect(await bulkConsumer.consume(dupReq)).toBe('APPLIED');
      const [dupResultOutbox] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(
            and(
              eq(outbox.operation_id, dupBatchOpId),
              eq(outbox.event_name, 'catalog.bulk.upsert.completed'),
            ),
          ),
      );
      expect(dupResultOutbox).toBeDefined();
      const resultData = dupResultOutbox!.payload as {
        results: Array<{ status: string; code: string | null }>;
      };
      expect(resultData.results[0]?.status).toBe('REJECTED');
      expect(resultData.results[0]?.code).toBe('SKU_DUPLICADO');

      // Regresión negativa: consumidor Bulk sin destino g6.bulk.from.catalog bloquea antes de procesar
      const disabledBulk = createCatalogBulkConsumer(messages, []);
      await expect(disabledBulk.consume(bulkReq)).rejects.toThrow(
        'CATALOG_H5_BULK_REPLY_DISABLED',
      );
    });
  },
);
