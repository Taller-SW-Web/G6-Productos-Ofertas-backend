import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  ServiceBusMessage,
  ServiceBusMessageBatch,
  ServiceBusReceivedMessage,
} from '@azure/service-bus';
import type { Database } from '../../apps/taxonomy-svc/src/database.js';
import { DeactivationIntentService } from '../../apps/taxonomy-svc/src/domain/deactivation-intent.service.js';
import { Database as CatalogDatabase } from '../../apps/catalog-svc/src/database.js';
import { CatalogMessageService } from '../../apps/catalog-svc/src/catalog-message.service.js';
import type { CatalogEnvelope } from '../../apps/catalog-svc/src/catalog-messages.js';
import { relayCatalogDelivery } from '../../apps/catalog-svc/src/catalog-service-bus-relay.js';
import { taxonomyReplyQueue } from '../../apps/catalog-svc/src/catalog-service-bus.js';
import { TaxonomyMessageStore } from '../../apps/taxonomy-svc/src/persistence/taxonomy-message.store.js';
import {
  publishTaxonomyDelivery,
  receiveTaxonomyDelivery,
} from '../../apps/taxonomy-svc/src/domain/taxonomy-service-bus.runtime.js';

describe.skipIf(process.env.G6_TAXONOMY_H5_POSTGRES_TESTS !== '1')(
  'Taxonomy H5 storage and relay with PostgreSQL',
  () => {
    let admin: Pool;
    let runtime: Pool;
    let store: TaxonomyMessageStore;
    let intents: DeactivationIntentService;
    let catalogDb: CatalogDatabase;
    let catalog: CatalogMessageService;
    beforeAll(async () => {
      const url = new URL(process.env.G6_TAXONOMY_H5_POSTGRES_URL ?? '');
      if (
        url.hostname !== '127.0.0.1' ||
        !/^\/g6_taxonomy_h5_test_[a-z0-9]+$/.test(url.pathname)
      )
        throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
      admin = new Pool({ connectionString: url.href });
      const existing = await admin.query(
        "SELECT to_regnamespace('taxonomy') AS schema, to_regnamespace('catalog') AS catalog",
      );
      if (existing.rows[0].schema !== null || existing.rows[0].catalog !== null)
        throw new Error('EMPTY_DATABASE_REQUIRED');
      const password = randomUUID();
      await admin.query(
        "CREATE ROLE po_taxonomy_owner NOLOGIN; CREATE ROLE taxonomy_app LOGIN PASSWORD '" +
          password +
          "'; CREATE SCHEMA taxonomy AUTHORIZATION po_taxonomy_owner",
      );
      const docsPath = process.env.G6_E2E_DOCS_PATH;
      if (!docsPath) throw new Error('G6_E2E_DOCS_PATH_REQUIRED');
      const taxonomyBase = await readFile(
        join(docsPath, 'datos/taxonomy/migrations/0001_create_taxonomy.sql'),
        'utf8',
      );
      const timeoutSetting = await readFile(
        'apps/taxonomy-svc/migrations/0003_deactivation_timeout_setting.sql',
        'utf8',
      );
      const sourceVersion = await readFile(
        'apps/taxonomy-svc/migrations/0002_deactivation_source_version.sql',
        'utf8',
      );
      await admin.query(
        'BEGIN; SET LOCAL ROLE po_taxonomy_owner; ' +
          taxonomyBase +
          sourceVersion +
          timeoutSetting +
          ' COMMIT;',
      );

      const catalogPassword = randomUUID();
      await admin.query(
        "CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD '" +
          catalogPassword +
          "'; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner",
      );
      const catalogOwner = await admin.connect();
      try {
        await catalogOwner.query('SET ROLE po_catalog_owner');
        for (const path of [
          'apps/catalog-svc/test/fixtures/0001_create_catalog.sql',
          'apps/catalog-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
          'apps/catalog-svc/migrations-candidate/h5/0002_taxonomy_reply_transport.sql',
        ]) {
          await catalogOwner.query(await readFile(path, 'utf8'));
        }
      } finally {
        await catalogOwner.query('RESET ROLE');
        catalogOwner.release();
      }
      catalogDb = new CatalogDatabase({
        pool: {
          host: url.hostname,
          port: Number(url.port),
          database: url.pathname.slice(1),
          user: 'catalog_app',
          password: catalogPassword,
          ssl: false,
        },
        expectedRole: 'catalog_app',
        database: url.pathname.slice(1),
        user: 'catalog_app',
        password: catalogPassword,
        mode: 'direct',
      });
      catalog = new CatalogMessageService(catalogDb);
      const candidate = await readFile(
        'apps/taxonomy-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
        'utf8',
      );
      await admin.query(
        'BEGIN; SET LOCAL ROLE po_taxonomy_owner; ' + candidate + ' COMMIT;',
      );
      url.username = 'taxonomy_app';
      url.password = password;
      runtime = new Pool({
        connectionString: url.href,
        options: '-c g6.taxonomy_messaging=AZURE_SERVICE_BUS',
      });
      const pg = drizzle(runtime);
      const database = {
        read: <T>(fn: (db: NodePgDatabase) => Promise<T>) => fn(pg),
      };
      intents = new DeactivationIntentService(database as Database);
      store = new TaxonomyMessageStore(database as Database, intents);
      await store.verifyServiceBusStorage();
    }, 30_000);

    afterAll(async () => {
      await Promise.allSettled([
        runtime?.end(),
        admin?.end(),
        catalogDb?.onModuleDestroy(),
      ]);
    });

    const insert = (
      db: Pick<Pool, 'query'>,
      name = 'taxonomy.category.updated',
    ) => {
      const messageId = randomUUID();
      const correlation = randomUUID();
      const payload = {
        message_id: messageId,
        correlation_id: correlation,
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'taxonomy-svc',
        kind: 'event',
        name,
        data: { categoria_id: randomUUID(), version: 1 },
      };
      return db.query(
        'INSERT INTO taxonomy.outbox (message_id,event_name,kind,correlation_id,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6) RETURNING message_id,delivery_transport',
        [
          messageId,
          name,
          'event',
          correlation,
          payload.occurred_at,
          JSON.stringify(payload),
        ],
      );
    };

    it('stores new H5 intents with the fact, excludes them from H4, and retries the same ID', async () => {
      const legacy = (await insert(admin)).rows[0];
      const h5 = (await insert(runtime)).rows[0];
      expect(legacy.delivery_transport).toBe('RABBITMQ');
      expect(h5.delivery_transport).toBe('AZURE_SERVICE_BUS');
      const publishH4 = vi.fn(async () => undefined);
      expect(await store.publicarUno(publishH4)).toBe('PUBLICADO');
      expect(publishH4).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: legacy.message_id }),
      );
      expect(await store.publicarUno(publishH4)).toBe('VACIO');
      const captured: ServiceBusMessage[] = [];
      const batch = {
        tryAddMessage: (message: ServiceBusMessage) => {
          captured.push(message);
          return true;
        },
      } as ServiceBusMessageBatch;
      const sender = {
        createMessageBatch: async () => batch,
        sendMessages: vi
          .fn(async () => undefined)
          .mockRejectedValueOnce(new Error('AMBIGUOUS')),
      };
      expect(await publishTaxonomyDelivery(store, sender)).toBe(false);
      await admin.query(
        'UPDATE taxonomy.outbox_delivery SET next_attempt_at=clock_timestamp() WHERE message_id=$1',
        [h5.message_id],
      );
      expect(await publishTaxonomyDelivery(store, sender)).toBe(true);
      expect(captured.map((m) => m.messageId)).toEqual([
        h5.message_id,
        h5.message_id,
      ]);
      const result = await admin.query(
        'SELECT sent_at, attempts FROM taxonomy.outbox_delivery',
      );
      expect(result.rows).toEqual([{ sent_at: expect.any(Date), attempts: 2 }]);
      await expect(insert(runtime, 'unknown.event')).rejects.toThrow(
        'Unsupported Taxonomy H5 route',
      );
    });

    it('round-trips a category deactivation through both outboxes and inboxes without publishing the reply in H4', async () => {
      const entityId = randomUUID();
      const operationId = randomUUID();
      const correlationId = randomUUID();
      await admin.query(
        'INSERT INTO taxonomy.categories (id,nombre) VALUES ($1,$2)',
        [entityId, 'Test ' + entityId],
      );
      expect(
        await intents.registrar({
          entityType: 'CATEGORY',
          entityId,
          operationId,
          correlationId,
          version: 0,
        }),
      ).toBe('REGISTRADA');
      const initial = await store.claimServiceBusDelivery();
      expect(initial?.row.event_name).toBe(
        'taxonomy.master.deactivation.check.requested',
      );
      if (!initial) throw new Error('REQUEST_NOT_ENQUEUED');
      const request = initial.row.payload as CatalogEnvelope;
      expect(await store.finishServiceBusDelivery(initial, 'sent')).toBe(true);

      expect(await catalog.consume(request, true)).toBe('APPLIED');
      expect(await catalog.consume(request, true)).toBe('DUPLICATE');
      const h4Publisher = { publish: vi.fn() };
      expect(await catalog.relayOne(h4Publisher)).toBe('EMPTY');
      expect(h4Publisher.publish).not.toHaveBeenCalled();
      const publish = vi
        .fn()
        .mockRejectedValueOnce(new Error('confirmation lost'));
      expect(
        await relayCatalogDelivery(catalogDb, { publish }, taxonomyReplyQueue),
      ).toBe('RETRY');
      await admin.query(
        'UPDATE catalog.outbox_delivery SET available_at=now() WHERE published_at IS NULL',
      );
      expect(
        await relayCatalogDelivery(catalogDb, { publish }, taxonomyReplyQueue),
      ).toBe('CONFIRMED');
      expect(
        publish.mock.calls.map(([queue, message]) => [
          queue,
          message.message_id,
        ]),
      ).toEqual([
        [taxonomyReplyQueue, publish.mock.calls[0]?.[1].message_id],
        [taxonomyReplyQueue, publish.mock.calls[0]?.[1].message_id],
      ]);
      const response = publish.mock.calls[1]?.[1];
      expect(response).toMatchObject({
        name: 'catalog.master.deactivation.checked',
        operation_id: operationId,
        correlation_id: correlationId,
        causation_id: request.message_id,
        data: { result: 'CLEAR' },
      });
      const checkedDelivery = {
        body: Buffer.from(JSON.stringify(response)),
        subject: response.name,
        contentType: 'application/json',
        messageId: response.message_id,
        correlationId: response.correlation_id,
      } as ServiceBusReceivedMessage;
      const checkedReceiver = {
        completeMessage: vi
          .fn()
          .mockRejectedValueOnce(new Error('settlement lost')),
        abandonMessage: vi.fn(async () => {
          throw new Error('UNEXPECTED_ABANDON');
        }),
        deadLetterMessage: vi.fn(async () => {
          throw new Error('UNEXPECTED_DLQ');
        }),
      };
      await expect(
        receiveTaxonomyDelivery(store, checkedReceiver, checkedDelivery),
      ).rejects.toThrow('settlement lost');
      await receiveTaxonomyDelivery(store, checkedReceiver, checkedDelivery);
      expect(checkedReceiver.completeMessage).toHaveBeenCalledTimes(2);
      const final = await store.claimServiceBusDelivery();
      if (!final) throw new Error('FINAL_NOT_ENQUEUED');
      expect(final.row.event_name).toBe('taxonomy.master.deactivated');
      expect(
        await catalog.consume(final.row.payload as CatalogEnvelope, true),
      ).toBe('APPLIED');
      expect(
        await catalog.consume(final.row.payload as CatalogEnvelope, true),
      ).toBe('DUPLICATE');
      expect(await store.finishServiceBusDelivery(final, 'sent')).toBe(true);
      expect(await store.claimServiceBusDelivery()).toBeUndefined();
      expect((await intents.obtenerOperacion(operationId))?.status).toBe(
        'COMPLETED',
      );
      expect(
        (
          await admin.query(
            'SELECT is_blocking FROM catalog.master_barriers WHERE operation_id=$1',
            [operationId],
          )
        ).rows,
      ).toEqual([{ is_blocking: false }]);
    });

    it('uses the existing checked-result handler before settling a matching Azure delivery', async () => {
      const result = {
        message_id: randomUUID(),
        correlation_id: randomUUID(),
        operation_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'catalog-svc',
        kind: 'result',
        name: 'catalog.master.deactivation.checked',
        data: {
          entity_type: 'CATEGORY',
          entity_id: randomUUID(),
          version: 2,
          result: 'CLEAR',
        },
      };
      const delivery = {
        body: Buffer.from(JSON.stringify(result)),
        contentType: 'application/json',
        subject: result.name,
        messageId: result.message_id,
        correlationId: result.correlation_id,
      } as ServiceBusReceivedMessage;
      const consumir = vi.fn(async () => undefined);
      const receiver = {
        completeMessage: vi.fn(async () => undefined),
        abandonMessage: vi.fn(async () => undefined),
        deadLetterMessage: vi.fn(async () => undefined),
      };
      await receiveTaxonomyDelivery({ consumir }, receiver, delivery);
      expect(consumir).toHaveBeenCalledWith(result);
      expect(receiver.completeMessage).toHaveBeenCalledWith(delivery);
      expect(
        receiver.completeMessage.mock.invocationCallOrder[0],
      ).toBeGreaterThan(consumir.mock.invocationCallOrder[0]);
      await receiveTaxonomyDelivery({ consumir }, receiver, {
        ...delivery,
        correlationId: randomUUID(),
      });
      expect(receiver.deadLetterMessage).toHaveBeenCalledOnce();
      expect(consumir).toHaveBeenCalledOnce();
    });
  },
);
