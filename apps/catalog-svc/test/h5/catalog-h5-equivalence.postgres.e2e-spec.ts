import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq, and, sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/database.js';
import {
  activationChecks,
  inbox,
  outbox,
  products,
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
import {
  readSafeDisposablePg17Settings,
  verifyDisposablePg17Contract,
} from './disposable-pg17.helper.js';

/**
 * Suite COMPLEMENTARIA H5 de Catalog (consolidada sin duplicar la base canónica de Backend #310).
 *
 * Base canónica en PR #310 (6dd66036):
 *  - tests/h5/catalog-bulk-inventory.postgres.e2e-spec.ts (BLOCK-A2, BULK-JOINT, BULK-CONSUMER-v2)
 *  - tests/h5/taxonomy-service-bus.postgres.e2e-spec.ts (TAXONOMY-UPDATES, 3-event restart/lost-ACK)
 *  - apps/inventory-svc/test/inventory.real.integration.spec.ts (BLOCK-A2 Inventory)
 *
 * Garantías COMPLEMENTARIAS acreditadas exclusivamente aquí (sobre PostgreSQL 17 descartable):
 *  1. Activación comercial real (BORRADOR -> ACTIVO) tras resultados de Pricing e Inventory + relay con fallo ambiguo.
 *  2. Rechazo estricto de correlaciones falsificadas (causation_id activo + correlation_id alterado -> InvalidCatalogMessage).
 *  3. Conflictos de payload en Inbox (reuso de message_id con payload distinto -> InvalidCatalogMessage) y estado TERMINAL.
 *  4. Bloqueo preventivo ante destinos de respuesta deshabilitados (CATALOG_H5_TAXONOMY_REPLY_DISABLED / BULK_REPLY_DISABLED).
 */

const RUN_PG = process.env.CATALOG_H5_DISPOSABLE_PG === '1';

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
  'Catalog H5 — Garantías complementarias a PR #310 sobre código productivo y PostgreSQL 17 descartable',
  () => {
    let database: Database;
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
      taxonomyServer = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        const url = req.url ?? '/';
        if (url.startsWith('/api/v1/categorias/')) {
          const id = url.split('/').pop()?.split('?')[0] ?? 'cat-h5';
          res.end(JSON.stringify({ categoriaId: id, nombre: 'Calzado H5', estado: 'ACTIVO', version: 1 }));
          return;
        }
        if (url.startsWith('/api/v1/marcas/')) {
          const id = url.split('/').pop()?.split('?')[0] ?? 'marca-h5';
          res.end(JSON.stringify({ marcaId: id, nombre: 'Marca H5', estado: 'ACTIVO', version: 1 }));
          return;
        }
        if (url.startsWith('/api/v1/tipos-producto/') && url.endsWith('/caracteristicas')) {
          const id = url.split('/')[4] ?? 'tp-h5';
          res.end(JSON.stringify({
            tipoProducto: { tipoProductoId: id, estado: 'ACTIVO', schemaVersion: 1 },
            schemaVersion: 1,
            caracteristicas: [],
          }));
          return;
        }
        if (url.startsWith('/api/v1/tipos-producto/')) {
          const id = url.split('/').pop()?.split('?')[0] ?? 'tp-h5';
          res.end(JSON.stringify({ tipoProductoId: id, nombre: 'Zapatilla H5', estado: 'ACTIVO', schemaVersion: 1 }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 'NO_ENCONTRADO' }));
      });
      await new Promise<void>((resolve) => taxonomyServer.listen(0, '127.0.0.1', () => resolve()));
      const addr = taxonomyServer.address();
      if (!addr || typeof addr === 'string') throw new Error('No port');
      taxonomyBaseUrl = `http://127.0.0.1:${addr.port}`;

      // H26: Validacion estricta de host local, BD aislada, rol runtime no-owner, PG17 y migraciones oficiales
      database = new Database(readSafeDisposablePg17Settings());
      await verifyDisposablePg17Contract(database);

      const transactions = new CatalogTransactionManager(database);
      const repository = new PostgresCatalogWriteRepository();
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
      bulk = new CatalogBulkService(
        database,
        mutations,
        { authorization: async () => 'Bearer synthetic-bulk-token' } as unknown as CatalogBulkIdentity,
      );
      messages = new CatalogMessageService(database, new CatalogTelemetry(), bulk);
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

    it('C1 (complemento JOINT-01): activación comercial real BORRADOR -> ACTIVO tras resultados Pricing e Inventory y relay con fallo ambiguo', async () => {
      const sku = `H5-ACT-${randomUUID().slice(0, 8).toUpperCase()}`;
      const correlationId = randomUUID();
      const created = await mutations.createProduct(
        {
          nombre: `Producto Activacion Real ${sku}`,
          descripcion: 'Complemento H5 sobre PG17',
          categoriaId: 'cat-h5-act',
          tipoProductoId: 'tp-h5-act',
          marcaId: 'marca-h5-act',
          skuBase: sku,
          tieneVariantes: false,
          precioBaseInicial: 75,
          imagenes: [{ url: 'https://example.test/act.jpg' }],
          perfilFisico: { pesoKg: 0.8, dimensionesCm: { largo: 18, ancho: 12, alto: 8 } },
        },
        { authorization: 'Bearer synthetic-user-h5', correlationId },
      );

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

      expect(await relayCatalogDelivery(database, busDouble)).toBe('RETRY');
      await database.transaction((tx) =>
        tx.execute(sql`UPDATE catalog.outbox_delivery SET available_at = now() WHERE published_at IS NULL`),
      );
      for (let i = 0; i < 10; i += 1) {
        if ((await relayCatalogDelivery(database, busDouble)) === 'EMPTY') break;
      }

      const pricingReq = published.find(
        (p) => p.envelope.correlation_id === correlationId && p.envelope.name === 'pricing.product.initialization.requested',
      );
      const invReq = published.find(
        (p) => p.envelope.correlation_id === correlationId && p.envelope.name === 'inventory.sku.initialization.requested',
      );
      expect(pricingReq).toBeDefined();
      expect(invReq).toBeDefined();

      expect(
        await messages.consume(
          makeEnvelope(
            'pricing.product.initialization.completed',
            { product_id: created.product_id, sku_base: sku, initialized_at: new Date().toISOString() },
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
            { product_id: created.product_id, sku, variant_id: null, initialized_at: new Date().toISOString() },
            {
              producer: 'inventory-svc',
              correlation_id: invReq!.envelope.correlation_id,
              causation_id: invReq!.envelope.message_id,
              operation_id: invReq!.envelope.operation_id,
            },
          ),
        ),
      ).toBe('APPLIED');

      // Resultado tardio sobre check ya COMPLETED -> TERMINAL sin alterar estado
      expect(
        await messages.consume(
          makeEnvelope(
            'inventory.sku.initialization.rejected',
            { product_id: created.product_id, sku, variant_id: null, reason: 'LATE_REJECT' },
            {
              producer: 'inventory-svc',
              correlation_id: invReq!.envelope.correlation_id,
              causation_id: invReq!.envelope.message_id,
              operation_id: invReq!.envelope.operation_id,
            },
          ),
        ),
      ).toBe('TERMINAL');

      await mutations.state(
        created.product_id,
        undefined,
        'activate',
        { catalogVersion: created.catalog_version },
        { authorization: 'Bearer synthetic-user-h5', correlationId: randomUUID() },
      );
      const [dbProd] = await database.read((db) =>
        db.select().from(products).where(eq(products.id, created.product_id)),
      );
      expect(dbProd?.estado).toBe('ACTIVO');
    });

    it('C2 (complemento JOINT-01-REGRESSION): rechaza correlación falsificada con causation_id activo y marca intento ajeno como STALE', async () => {
      const sku = `H5-CORR-${randomUUID().slice(0, 8).toUpperCase()}`;
      const correlationId = randomUUID();
      const created = await mutations.createProduct(
        {
          nombre: `Producto Correlacion ${sku}`,
          descripcion: 'Regresion de correlacion',
          categoriaId: 'cat-h5-corr',
          tipoProductoId: 'tp-h5-corr',
          marcaId: 'marca-h5-corr',
          skuBase: sku,
          tieneVariantes: false,
          precioBaseInicial: 40,
          imagenes: [{ url: 'https://example.test/corr.jpg' }],
          perfilFisico: { pesoKg: 0.5, dimensionesCm: { largo: 10, ancho: 10, alto: 10 } },
        },
        { authorization: 'Bearer synthetic-user-h5', correlationId },
      );

      const [activeOutbox] = await database.read((db) =>
        db
          .select()
          .from(outbox)
          .where(and(eq(outbox.correlation_id, correlationId), eq(outbox.event_name, 'pricing.product.initialization.requested'))),
      );
      expect(activeOutbox).toBeDefined();

      expect(
        await messages.consume(
          makeEnvelope(
            'pricing.product.initialization.completed',
            { product_id: created.product_id, sku_base: sku, initialized_at: new Date().toISOString() },
            {
              producer: 'pricing-svc',
              correlation_id: randomUUID(),
              causation_id: randomUUID(),
              operation_id: activeOutbox!.operation_id,
            },
          ),
        ),
      ).toBe('STALE');

      await expect(
        messages.consume(
          makeEnvelope(
            'pricing.product.initialization.completed',
            { product_id: created.product_id, sku_base: sku, initialized_at: new Date().toISOString() },
            {
              producer: 'pricing-svc',
              correlation_id: randomUUID(),
              causation_id: activeOutbox!.message_id,
              operation_id: activeOutbox!.operation_id,
            },
          ),
        ),
      ).rejects.toBeInstanceOf(InvalidCatalogMessage);
    });

    it('C3 (conflictos de payload y destinos deshabilitados): rechaza reuso de message_id con payload alterado y bloquea reply deshabilitado', async () => {
      const catId = `cat-h5-${randomUUID().slice(0, 8)}`;
      const consumer = createCatalogTaxonomyConsumer(messages, ALL_DESTINATIONS);
      const evt = makeEnvelope('taxonomy.category.updated', {
        categoria_id: catId,
        nombre: 'Calzado Original',
        estado: 'ACTIVA',
        version: 1,
      });

      expect(await consumer.consume(evt)).toBe('APPLIED');
      await expect(
        consumer.consume({ ...evt, data: { ...evt.data, nombre: 'Nombre Alterado' } }),
      ).rejects.toBeInstanceOf(InvalidCatalogMessage);

      const rows = await database.read((db) =>
        db.select().from(inbox).where(eq(inbox.message_id, evt.message_id)),
      );
      expect(rows).toHaveLength(1);

      const disabledTax = createCatalogTaxonomyConsumer(messages, []);
      await expect(
        disabledTax.consume(
          makeEnvelope('taxonomy.master.deactivation.check.requested', {
            master_type: 'CATEGORIA',
            master_id: catId,
          }),
        ),
      ).rejects.toThrow('CATALOG_H5_TAXONOMY_REPLY_DISABLED');

      const disabledBulk = createCatalogBulkConsumer(messages, []);
      await expect(
        disabledBulk.consume(
          makeEnvelope('catalog.bulk.upsert.requested', {}, { producer: 'bulk-svc', kind: 'command' }),
        ),
      ).rejects.toThrow('CATALOG_H5_BULK_REPLY_DISABLED');
    });
  },
);
