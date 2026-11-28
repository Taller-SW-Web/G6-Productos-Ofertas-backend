import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { BulkPersistenceRepository } from '../../apps/bulk-svc/src/persistence/bulk.repository.js';
import { bulkSchema } from '../../apps/bulk-svc/src/persistence/bulk.schema.js';
import { BulkImportService } from '../../apps/bulk-svc/src/bulk-import.service.js';
import { BulkServiceBus } from '../../apps/bulk-svc/src/messaging/bulk-service-bus.js';
import { CatalogBulkResultConsumer } from '../../apps/bulk-svc/src/messaging/catalog-bulk-result-consumer.js';
import { BulkContractResultDispatcherService } from '../../apps/bulk-svc/src/messaging/bulk-contract-result-dispatcher.js';
import {
  CatalogBulkService,
  CatalogBulkIdentity,
  type BulkRow,
  type BulkRowResult,
} from '../../apps/catalog-svc/src/catalog-bulk.service.js';
import { CatalogTokenVerifier } from '../../apps/catalog-svc/src/catalog-auth.js';
import type { CatalogEnvelope } from '../../apps/catalog-svc/src/catalog-messages.js';
import type { CatalogMasterClient } from '../../apps/catalog-svc/src/catalog-master.client.js';
import type { Attribute } from '../../apps/catalog-svc/src/commercial.types.js';
import {
  CatalogMutationService,
  type CatalogProductCreationPolicy,
} from '../../apps/catalog-svc/src/catalog-mutation.service.js';
import { CatalogTransactionManager } from '../../apps/catalog-svc/src/catalog-transaction.js';
import { PostgresCatalogWriteRepository } from '../../apps/catalog-svc/src/postgres-catalog-write.repository.js';
import { CatalogTelemetry } from '../../apps/catalog-svc/src/catalog-telemetry.js';
import { relayCatalogDelivery } from '../../apps/catalog-svc/src/catalog-service-bus-relay.js';
import {
  products,
  variants,
  outbox,
} from '../../apps/catalog-svc/src/catalog.schema.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import type {
  ServiceBusClient,
  ServiceBusSender,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import { Database as CatalogDatabase } from '../../apps/catalog-svc/src/database.js';
import { CatalogServiceBus } from '../../apps/catalog-svc/src/catalog-service-bus.js';
import { CatalogMessageService } from '../../apps/catalog-svc/src/catalog-message.service.js';
import { DatabaseService } from '../../apps/inventory-svc/src/database/database.service.js';
import { IdempotencyService } from '../../apps/inventory-svc/src/idempotency/idempotency.service.js';
import { OutboxService } from '../../apps/inventory-svc/src/outbox/outbox.service.js';
import { InventoryCommandService } from '../../apps/inventory-svc/src/inbox/inventory-command.service.js';
import { InventoryServiceBusHandler } from '../../apps/inventory-svc/src/messaging/service-bus-consumer.js';
import { InventoryServiceBusRelay } from '../../apps/inventory-svc/src/messaging/service-bus-relay.js';
import {
  InventoryDeliveryStore,
  INVENTORY_QUEUES,
} from '../../apps/inventory-svc/src/messaging/service-bus-deliveries.js';
import { DrizzleInboxRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-inbox.repository.js';
import { DrizzleOperationsRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleLocationsRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-locations.repository.js';
import { DrizzleStockBalanceRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-stock-balance.repository.js';
import { DrizzleOutboxRepository } from '../../apps/inventory-svc/src/repositories/drizzle/drizzle-outbox.repository.js';

describe.skipIf(process.env.G6_CROSS_H5_POSTGRES_TESTS !== '1')(
  'Catalog Bulk Inventory H5 local',
  () => {
    let pgUrl: string;
    const database = new DatabaseService();
    beforeAll(async () => {
      const url = new URL(process.env.G6_CROSS_H5_POSTGRES_URL ?? '');
      if (
        url.hostname !== '127.0.0.1' ||
        !/^\/g6_cross_h5_test_[a-z0-9]+$/.test(url.pathname)
      )
        throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
      pgUrl = url.href;
      const admin = new pg.Pool({ connectionString: pgUrl });
      try {
        const docs = process.env.G6_E2E_DOCS_PATH;
        if (!docs) throw new Error('G6_E2E_DOCS_PATH_REQUIRED');
        for (const file of [
          resolve(docs, 'datos/inventory-svc/migration.sql'),
          resolve(
            docs,
            'datos/inventory-svc/migrations/0002_order_id_operaciones_disponibilidad.sql',
          ),
          'apps/inventory-svc/migrations/20261104_0001_lifecycle_offline_reconciliation.sql',
        ])
          await admin.query(await readFile(file, 'utf8'));
        await admin.query(
          'CREATE ROLE po_inventory_owner LOGIN SUPERUSER; CREATE ROLE inventory_app LOGIN; ALTER SCHEMA inventory OWNER TO po_inventory_owner; GRANT ALL ON SCHEMA inventory TO po_inventory_owner; GRANT USAGE ON SCHEMA inventory TO inventory_app; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA inventory TO inventory_app; GRANT inventory_app TO postgres',
        );
        await admin.query('SET ROLE po_inventory_owner');
        await admin.query(
          await readFile(
            'apps/inventory-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
            'utf8',
          ),
        );
        await admin.query('RESET ROLE');
      } finally {
        await admin.end();
      }
      process.env.DATABASE_URL = pgUrl;
      await database.onModuleInit();
    }, 120000);
    afterAll(async () => {
      await database.onModuleDestroy();
    });
    function realCommandService() {
      return new InventoryCommandService(
        database,
        new IdempotencyService(),
        new OutboxService(new DrizzleOutboxRepository(database)),
        new DrizzleInboxRepository(database),
        new DrizzleOperationsRepository(database),
        new DrizzleLocationsRepository(database),
        new DrizzleStockBalanceRepository(database),
      );
    }
    it('H5 BLOCK-A2: real Inventory results reach Catalog and reject a foreign producer', async () => {
      const migration = await readFile(
        resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'),
        'utf8',
      );
      const catalogAdmin = new pg.Pool({ connectionString: pgUrl });
      try {
        await catalogAdmin.query(
          `CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD 'local-catalog-fixture'; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner`,
        );
        await catalogAdmin.query('SET ROLE po_catalog_owner');
        await catalogAdmin.query(migration);
        await catalogAdmin.query('RESET ROLE');
        await catalogAdmin.query(
          `GRANT USAGE ON SCHEMA catalog TO catalog_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA catalog TO catalog_app; GRANT USAGE ON ALL SEQUENCES IN SCHEMA catalog TO catalog_app`,
        );
      } finally {
        await catalogAdmin.end();
      }
      const connection = new URL(pgUrl);
      connection.username = 'catalog_app';
      connection.password = 'local-catalog-fixture';
      const catalogDb = new CatalogDatabase({
        pool: { connectionString: connection.href },
        expectedRole: 'catalog_app',
        database: 'inventory_it',
        user: 'catalog_app',
        password: 'local-catalog-fixture',
        mode: 'direct',
      });
      vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
      try {
        type Handlers = Parameters<
          ReturnType<ServiceBusClient['createReceiver']>['subscribe']
        >[0];
        let callbacks!: Handlers;
        const receiver = {
          subscribe: (h: Handlers) => {
            callbacks = h;
            return { close: vi.fn() };
          },
          completeMessage: vi.fn(),
          abandonMessage: vi.fn(),
          deadLetterMessage: vi.fn(),
        };
        const client = {
          createReceiver: () => receiver,
        } as unknown as ServiceBusClient;
        new CatalogServiceBus(client).subscribe(
          'g6.catalog.from.inventory',
          new CatalogMessageService(catalogDb),
          vi.fn(),
        );
        const sent: ServiceBusReceivedMessage[] = [];
        const sender = {
          createMessageBatch: async () => ({
            tryAddMessage: (message: ServiceBusReceivedMessage) => {
              sent.push(message);
              return true;
            },
          }),
          sendMessages: async () => {},
        } as unknown as ServiceBusSender;
        const relay = new InventoryServiceBusRelay(
          new InventoryDeliveryStore(database),
          new Map([[INVENTORY_QUEUES.CATALOG, sender]]),
        );
        const ingress = new InventoryServiceBusHandler(realCommandService(), {
          completeMessage: vi.fn(),
          abandonMessage: vi.fn(),
          deadLetterMessage: vi.fn(),
        });
        const records = [];
        for (const shouldReject of [false, true]) {
          const id = randomUUID(),
            operation = randomUUID(),
            correlation = randomUUID(),
            message = randomUUID(),
            sku = `a2-return-${randomUUID()}`;
          const data = {
            product_id: id,
            sku,
            variant_id: null,
            ...(shouldReject ? { default_location_id: randomUUID() } : {}),
          };
          await database.query(
            `INSERT INTO catalog.products(id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes) VALUES($1,'x','x','x','x','x',$2,$2,false)`,
            [id, sku],
          );
          await database.query(
            `INSERT INTO catalog.activation_checks(product_id,sku,dependency,operation_id,correlation_id,request_payload) VALUES($1,$2,'INVENTORY',$3,$4,$5::jsonb)`,
            [id, sku, operation, correlation, JSON.stringify(data)],
          );
          await database.query(
            `INSERT INTO catalog.outbox(message_id,event_name,kind,correlation_id,operation_id,occurred_at,payload) VALUES($1,'inventory.sku.initialization.requested','command',$2,$3,now(),$4::jsonb)`,
            [message, correlation, operation, JSON.stringify(data)],
          );
          const envelope = {
            message_id: message,
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            correlation_id: correlation,
            operation_id: operation,
            producer: 'catalog-svc',
            kind: 'command',
            name: 'inventory.sku.initialization.requested',
            data,
          };
          expect(
            await ingress.handle({
              body: Buffer.from(JSON.stringify(envelope)),
              messageId: message,
              subject: envelope.name,
            } as ServiceBusReceivedMessage),
          ).toBe('completed');
          expect(await relay.publishOne()).toBe('sent');
          const result = sent.at(-1)!;
          await callbacks.processMessage(result);
          await callbacks.processMessage(result);
          const state = await database.query(
            'SELECT state FROM catalog.activation_checks WHERE operation_id=$1',
            [operation],
          );
          expect(state.rows[0].state).toBe(
            shouldReject ? 'REJECTED' : 'COMPLETED',
          );
          expect(
            (
              await database.query(
                'SELECT count(*)::int n FROM catalog.inbox WHERE message_id=$1',
                [result.messageId],
              )
            ).rows[0].n,
          ).toBe(1);
          records.push(result);
        }
        const forged = JSON.parse(
          Buffer.from(records[0].body).toString('utf8'),
        );
        forged.producer = 'pricing-svc';
        forged.message_id = randomUUID();
        await callbacks.processMessage({
          ...records[0],
          body: Buffer.from(JSON.stringify(forged)),
          messageId: forged.message_id,
        } as ServiceBusReceivedMessage);
        expect(receiver.deadLetterMessage).toHaveBeenCalledTimes(1);
        expect(
          (
            await database.query(
              'SELECT count(*)::int n FROM catalog.inbox WHERE message_id=$1',
              [forged.message_id],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(receiver.abandonMessage).not.toHaveBeenCalled();
      } finally {
        await catalogDb.onModuleDestroy();
        vi.unstubAllEnvs();
      }
    });

    describe('Bulk Catalog H5', () => {
      let admin: pg.Pool;
      let database: CatalogDatabase;
      let transactions: CatalogTransactionManager;
      const repository = new PostgresCatalogWriteRepository();
      beforeAll(async () => {
        admin = new pg.Pool({ connectionString: pgUrl });
        await admin.query('SET ROLE po_catalog_owner');
        for (const file of [
          'apps/catalog-svc/migrations/0002_create_sku_barcodes.sql',
          'apps/catalog-svc/migrations/0003_product_publication_history.sql',
          'apps/catalog-svc/migrations/0004_historical_preparation_requests.sql',
          'apps/catalog-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
          'apps/catalog-svc/migrations-candidate/h5/0002_taxonomy_reply_transport.sql',
          'apps/catalog-svc/migrations-candidate/h5/0003_bulk_retry_receipts.sql',
        ])
          await admin.query(await readFile(file, 'utf8'));
        await admin.query('RESET ROLE');
        const url = new URL(pgUrl);
        url.username = 'catalog_app';
        url.password = 'local-catalog-fixture';
        database = new CatalogDatabase({
          pool: { connectionString: url.href },
          expectedRole: 'catalog_app',
          database: url.pathname.slice(1),
          user: 'catalog_app',
          password: 'local-catalog-fixture',
          mode: 'direct',
        });
        transactions = new CatalogTransactionManager(database);
      }, 120000);
      afterAll(async () => {
        await database?.onModuleDestroy();
        await admin?.end();
      });
      afterEach(() => vi.unstubAllEnvs());
      function mutationService(
        creationPolicy: CatalogProductCreationPolicy = {
          resolve: async (_input, id) => ({
            slug: 'fixture-' + id,
            moneda: 'PEN',
          }),
        },
        masterOverrides: Partial<CatalogMasterClient> = {},
      ) {
        return new CatalogMutationService(
          transactions,
          repository,
          {
            masters: async () => ({ schemaVersion: 1 }),
            attributes: async (_type: string, values: Attribute[]) => values,
            ...masterOverrides,
          } as unknown as CatalogMasterClient,
          creationPolicy,
        );
      }
      const actor = {
        authorization: 'Bearer isolated-master-fixture',
        correlationId: randomUUID(),
      };
      const fullProfile = {
        pesoKg: 1.5,
        dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
      };
      function createRequest(hasVariants = false) {
        return {
          nombre: 'Mutation fixture',
          descripcion: 'Disposable',
          categoriaId: 'category-fixture',
          tipoProductoId: 'type-fixture',
          marcaId: 'brand-fixture',
          skuBase: '000-' + randomUUID(),
          tieneVariantes: hasVariants,
          precioBaseInicial: 20,
          imagenes: [{ url: 'https://example.test/product' }],
          ...(hasVariants ? {} : { perfilFisico: fullProfile }),
        };
      }
      function bulkRow(product = createRequest(), rowNumber = 2): BulkRow {
        return {
          row_number: rowNumber,
          row_operation_id: randomUUID(),
          producto_id: null,
          sku_base: product.skuBase,
          product,
          variant_id: null,
          variant: null,
        };
      }
      function bulkCommand(
        rows: BulkRow[],
        mode = 'ALTA',
        version: 1 | 2 = 1,
      ): CatalogEnvelope {
        const operation = randomUUID();
        return {
          message_id: randomUUID(),
          schema_version: version,
          occurred_at: new Date().toISOString(),
          correlation_id: randomUUID(),
          causation_id: null,
          operation_id: operation,
          producer: 'bulk-svc',
          kind: 'command',
          name: 'catalog.bulk.upsert.requested',
          data: {
            batch_id: randomUUID(),
            batch_operation_id: operation,
            template_version: 2,
            mode,
            rows,
          },
        };
      }
      function bulkHandler(
        mutations = mutationService(),
        contentClient?: {
          getDocument: (reference: unknown) => Promise<unknown>;
        },
      ) {
        const identity = new CatalogBulkIdentity(
          undefined,
          new CatalogTokenVerifier(undefined),
        );
        vi.spyOn(identity, 'authorization').mockResolvedValue(
          actor.authorization,
        );
        return new CatalogBulkService(
          database,
          mutations,
          identity,
          contentClient as never,
        );
      }
      async function bulkReply(command: CatalogEnvelope) {
        return database.read(
          async (db) =>
            (
              await db
                .select()
                .from(outbox)
                .where(
                  and(
                    eq(outbox.causation_id, command.message_id),
                    sql`${outbox.event_name} LIKE 'catalog.bulk.upsert.%'`,
                  ),
                )
            )[0]!,
        );
      }

      async function requested(productId: string) {
        return database.read((db) =>
          db
            .select()
            .from(outbox)
            .where(
              and(
                sql`${outbox.payload}->>'product_id' = ${productId}`,
                sql`${outbox.event_name} IN ('pricing.product.initialization.requested','inventory.sku.initialization.requested')`,
              ),
            ),
        );
      }
      it('H5 BULK-JOINT: durable Bulk Catalog Bulk round trip and redelivery', async () => {
        vi.stubEnv('MESSAGING_PROVIDER', 'AZURE_SERVICE_BUS');
        vi.stubEnv(
          'CATALOG_H5_DESTINATIONS',
          'g6.bulk.from.catalog,g6.pricing.from.catalog,g6.inventory.from.catalog',
        );
        const migrations = [
          'apps/catalog-svc/test/fixtures/0001_create_bulk_persistence.sql',
          'apps/bulk-svc/migrations/0002_export_source_snapshot.sql',
          'apps/bulk-svc/migrations/0003_export_claim_lease.sql',
          'apps/bulk-svc/migrations/0004_catalog_claim_check_content.sql',
          'apps/bulk-svc/migrations/0005_actor_ownership.sql',
          'apps/bulk-svc/migrations/0006_owner_correlation_identity.sql',
          'apps/bulk-svc/migrations/0007_bulk_retry_v1.sql',
          'apps/bulk-svc/migrations/0008_h5_outbox_delivery.sql',
          'apps/bulk-svc/migrations/0009_h5_outbox_delivery_all_destinations.sql',
        ]
          .map((file) => readFileSync(resolve(file), 'utf8'))
          .join('\n');
        await admin.query(
          `CREATE ROLE po_bulk_owner NOLOGIN; CREATE ROLE bulk_fixture_app LOGIN PASSWORD 'isolated-bulk-password'; CREATE SCHEMA bulk AUTHORIZATION po_bulk_owner; SET ROLE po_bulk_owner; ${migrations} GRANT USAGE ON SCHEMA bulk TO bulk_fixture_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bulk TO bulk_fixture_app; GRANT USAGE ON ALL SEQUENCES IN SCHEMA bulk TO bulk_fixture_app; RESET ROLE`,
        );
        const bulkUrl = new URL(pgUrl);
        bulkUrl.username = 'bulk_fixture_app';
        bulkUrl.password = 'isolated-bulk-password';
        const pool = new pg.Pool({ connectionString: bulkUrl.href });
        try {
          expect(
            (
              await pool.query(
                "SELECT has_schema_privilege(current_user,'catalog','USAGE') AS allowed",
              )
            ).rows[0].allowed,
          ).toBe(false);
          const repository = new BulkPersistenceRepository(
            drizzle(pool, { schema: bulkSchema }) as never,
          );
          const importer = new BulkImportService(repository);
          const batchId = randomUUID(),
            rowId = randomUUID(),
            ownerSub = randomUUID(),
            correlationId = randomUUID();
          const product = createRequest();
          await importer.createImport({
            batchId,
            ownerSub,
            correlationId,
            contentRef: `bulk/test/${batchId}.csv`,
            format: 'CSV',
            templateVersion: 2,
            rows: [
              {
                rowId,
                productId: null,
                mode: 'ALTA',
                skuBase: product.skuBase,
                variantSkus: [],
                precioRegular: 20,
              },
            ],
            intentRows: [
              {
                rowNumber: 2,
                rowOperationId: rowId,
                rowId,
                skuBase: product.skuBase,
                precioRegular: 20,
                product,
                variant: null,
              },
            ],
            catalogCommandVersion: 1,
          });
          type Handlers = Parameters<
            ReturnType<ServiceBusClient['createReceiver']>['subscribe']
          >[0];
          const handlers = new Map<string, Handlers>();
          const messages = new Map<string, ServiceBusReceivedMessage[]>();
          const transport = {
            createReceiver: (queue: string) => ({
              subscribe: (h: Handlers) => {
                handlers.set(queue, h);
                return { close: vi.fn() };
              },
              completeMessage: vi.fn(),
              abandonMessage: vi.fn(),
              deadLetterMessage: vi.fn(),
            }),
            createSender: (queue: string) => ({
              createMessageBatch: async () => {
                let value: ServiceBusReceivedMessage;
                return {
                  tryAddMessage: (msg: ServiceBusReceivedMessage) => {
                    value = msg;
                    return true;
                  },
                  send: () => {
                    messages.set(queue, [
                      ...(messages.get(queue) ?? []),
                      value,
                    ]);
                  },
                };
              },
              sendMessages: async (batch: { send: () => void }) => batch.send(),
            }),
          } as unknown as ServiceBusClient;
          const catalogBus = new CatalogServiceBus(transport);
          const bulkBus = new BulkServiceBus(transport);
          catalogBus.subscribe(
            'g6.catalog.from.bulk',
            new CatalogMessageService(
              database,
              new CatalogTelemetry(),
              bulkHandler(),
            ),
            vi.fn(),
          );
          bulkBus.subscribeCatalogResults(
            new CatalogBulkResultConsumer(
              repository,
              null,
              new BulkContractResultDispatcherService(importer),
            ),
            vi.fn(),
          );
          const claims = await repository.claimPendingServiceBusDeliveries(20);
          const claim = claims.find(
            (x) => x.delivery.destination === 'g6.catalog.from.bulk',
          );
          expect(claim?.delivery.leaseToken).toBeTruthy();
          await bulkBus.publishCatalogCommand({
            messageId: claim!.messageId,
            correlationId: claim!.correlationId,
            eventName: claim!.eventName,
            payload: claim!.payload,
          });
          await repository.markServiceBusDeliveryPublished(
            claim!.messageId,
            claim!.delivery.leaseToken!,
          );
          const request = messages.get('g6.catalog.from.bulk')![0];
          await handlers.get('g6.catalog.from.bulk')!.processMessage(request);
          await handlers.get('g6.catalog.from.bulk')!.processMessage(request);
          expect(
            await database.read((db) =>
              db
                .select()
                .from(products)
                .where(eq(products.sku_base, product.skuBase)),
            ),
          ).toHaveLength(1);
          expect(
            await relayCatalogDelivery(
              database,
              catalogBus,
              'g6.bulk.from.catalog',
            ),
          ).toBe('CONFIRMED');
          const reply = messages.get('g6.bulk.from.catalog')![0];
          await handlers.get('g6.bulk.from.catalog')!.processMessage(reply);
          await handlers.get('g6.bulk.from.catalog')!.processMessage(reply);
          const snapshot = await importer.getSnapshot(batchId, ownerSub);
          expect(snapshot.rows[0].steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                domain: 'CATALOGO',
                status: 'COMPLETED',
              }),
            ]),
          );
          expect(
            (
              await pool.query(
                'SELECT handler, count(*)::int n FROM bulk.inbox WHERE message_id=$1 GROUP BY handler',
                [reply.messageId],
              )
            ).rows,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                handler: 'bulk.catalog.bulk-upsert.result',
                n: 1,
              }),
            ]),
          );
          expect(
            (
              await pool.query(
                'SELECT max(n)::int n FROM (SELECT count(*) n FROM bulk.inbox WHERE message_id=$1 GROUP BY handler) x',
                [reply.messageId],
              )
            ).rows[0].n,
          ).toBe(1);
        } finally {
          await pool.end();
        }
      }, 60000);

      it('H5 BULK-CONSUMER-v2: retries Catalog receiver and preserves SKU and batch replay in PostgreSQL', async () => {
        type Handlers = Parameters<
          ReturnType<ServiceBusClient['createReceiver']>['subscribe']
        >[0];
        let handlers!: Handlers;
        const receiver = {
          subscribe: (h: Handlers) => {
            handlers = h;
            return { close: vi.fn() };
          },
          completeMessage: vi.fn(async () => {}),
          abandonMessage: vi.fn(async () => {}),
          deadLetterMessage: vi.fn(async () => {}),
        };
        const client = {
          createReceiver: vi.fn().mockReturnValue(receiver),
        } as unknown as ServiceBusClient;
        const actual = new CatalogMessageService(
          database,
          new CatalogTelemetry(),
          bulkHandler(),
        );
        let fail = true;
        const service = {
          consume: async (message: CatalogEnvelope) => {
            if (fail) {
              fail = false;
              throw new Error('synthetic transient database outage');
            }
            return actual.consume(message);
          },
        };
        new CatalogServiceBus(client).subscribe(
          'g6.catalog.from.bulk',
          service,
          vi.fn(),
        );
        const product = createRequest(true);
        const sku = 'h5-v2-' + randomUUID();
        const alta = bulkCommand(
          [
            {
              ...bulkRow(product),
              variant: {
                sku,
                atributosIdentificadores: [
                  {
                    caracteristica_id: 'size',
                    nombre: 'Size',
                    valor_id: 'B',
                    valor: 'B',
                  },
                ],
                imagenUrl: 'https://example.test/bulk-v2',
                perfilFisico: fullProfile,
              },
            },
          ],
          'ALTA',
          2,
        );
        const deliver = (message: CatalogEnvelope) =>
          handlers.processMessage({
            body: Buffer.from(JSON.stringify(message)),
            messageId: message.message_id,
            correlationId: message.correlation_id,
            subject: message.name,
            contentType: 'application/json',
          } as ServiceBusReceivedMessage);
        await deliver(alta);
        expect(receiver.abandonMessage).toHaveBeenCalledTimes(1);
        expect(await bulkReply(alta)).toBeUndefined();
        await deliver(alta);
        const created = await bulkReply(alta);
        const parentId = (created.payload.results as BulkRowResult[])[0]
          .product_id!;
        const parent = (
          await database.read((db) =>
            db.select().from(products).where(eq(products.id, parentId)),
          )
        )[0];
        const child = (
          await database.read((db) =>
            db.select().from(variants).where(eq(variants.product_id, parentId)),
          )
        )[0];
        expect(child.sku).toBe(sku);
        const update = bulkCommand(
          [
            {
              row_number: 2,
              row_operation_id: randomUUID(),
              producto_id: parentId,
              sku_base: product.skuBase,
              product: {
                catalogVersion: Number(parent.catalog_version),
                nombre: 'H5 bulk v2',
              },
              variant_id: null,
              sku_variante: sku,
              variant: {
                catalogVersion: Number(child.catalog_version),
                imagenUrl: 'https://example.test/h5-v2',
              },
            },
          ],
          'ACTUALIZACION',
          2,
        );
        await deliver(update);
        const result = await bulkReply(update);
        expect(result.payload.results).toMatchObject([
          { status: 'COMPLETED', code: null },
        ]);
        await deliver(update);
        const replay = { ...update, message_id: randomUUID() };
        await deliver(replay);
        expect((await bulkReply(replay)).payload.results).toEqual(
          result.payload.results,
        );
        const after = (
          await database.read((db) =>
            db.select().from(variants).where(eq(variants.id, child.id)),
          )
        )[0];
        expect(after.catalog_version).toBe(child.catalog_version + 1n);
        expect(await requested(parentId)).toHaveLength(2);
        expect(receiver.deadLetterMessage).not.toHaveBeenCalled();
        expect(receiver.completeMessage).toHaveBeenCalledTimes(4);
      }, 30000);
    });
  },
);
