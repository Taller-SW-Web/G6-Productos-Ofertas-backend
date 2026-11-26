import { randomUUID } from 'node:crypto';
import { loadR18Contract } from './contract-r18.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TAXONOMY_READINESS } from '../../apps/taxonomy-svc/src/health/readiness.port.js';
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
import { createCatalogTaxonomyConsumer } from '../../apps/catalog-svc/src/catalog-service-bus.runtime.js';
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
    const catalogLegacyId = randomUUID();
    const taxonomyLegacyId = randomUUID();
    const taxonomyLegacySentId = randomUUID();
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
        "CREATE ROLE po_taxonomy_owner NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE taxonomy_app LOGIN PASSWORD '" +
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
      const pendingVersion = await readFile(
        'apps/taxonomy-svc/migrations/0004_product_type_pending_version.sql',
        'utf8',
      );
      await admin.query(
        'BEGIN; SET LOCAL ROLE po_taxonomy_owner; ' +
          taxonomyBase +
          sourceVersion +
          timeoutSetting +
          pendingVersion +
          ' COMMIT;',
      );

      const catalogPassword = randomUUID();
      await admin.query(
        "CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD '" +
          catalogPassword +
          "'; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner",
      );
      const catalogOwner = await admin.connect();
      const catalogMigration = await readFile(
        'apps/catalog-svc/migrations-candidate/h5/0002_taxonomy_reply_transport.sql',
        'utf8',
      );
      try {
        await catalogOwner.query('SET ROLE po_catalog_owner');
        for (const path of [
          'apps/catalog-svc/test/fixtures/0001_create_catalog.sql',
          'apps/catalog-svc/migrations-candidate/h5/0001_outbox_delivery.sql',
        ]) {
          await catalogOwner.query(await readFile(path, 'utf8'));
        }
        await catalogOwner.query(
          "INSERT INTO catalog.outbox (message_id,event_name,kind,correlation_id,occurred_at,payload) VALUES ($1,'catalog.product.deactivated','event',$2,now(),'{}')",
          [catalogLegacyId, randomUUID()],
        );
        await catalogOwner.query(
          "INSERT INTO catalog.outbox_delivery (message_id,destination) VALUES ($1,'g6.promotions.from.catalog')",
          [catalogLegacyId],
        );
        const before = await catalogOwner.query(
          'SELECT * FROM catalog.outbox_delivery',
        );
        await expect(catalogOwner.query(catalogMigration)).rejects.toThrow(
          'Catalog H5 has unclassified deliveries',
        );
        await catalogOwner.query('ROLLBACK');
        expect(
          (await catalogOwner.query('SELECT * FROM catalog.outbox_delivery'))
            .rows,
        ).toEqual(before.rows);
        await catalogOwner.query(
          'DELETE FROM catalog.outbox_delivery WHERE message_id=$1',
          [catalogLegacyId],
        );
        await catalogOwner.query(
          'CREATE FUNCTION catalog.alternate_h5_outbox_deliveries() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
        );
        await catalogOwner.query(
          'CREATE TRIGGER trg_catalog_alternate_h5_writer AFTER INSERT ON catalog.outbox FOR EACH ROW EXECUTE FUNCTION catalog.alternate_h5_outbox_deliveries()',
        );
        await expect(catalogOwner.query(catalogMigration)).rejects.toThrow(
          'Catalog H5 requires the canonical 0001 delivery trigger and no alternate transport writer',
        );
        await catalogOwner.query('ROLLBACK');
        await catalogOwner.query(
          'DROP TRIGGER trg_catalog_alternate_h5_writer ON catalog.outbox',
        );
        await catalogOwner.query(
          'DROP FUNCTION catalog.alternate_h5_outbox_deliveries()',
        );
        await catalogOwner.query(catalogMigration);
      } finally {
        await catalogOwner.query('ROLLBACK');
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
        "INSERT INTO taxonomy.outbox (message_id,event_name,kind,correlation_id,occurred_at,payload) VALUES ($1,'taxonomy.category.updated','event',$2,now(),'{}')",
        [taxonomyLegacyId, randomUUID()],
      );
      await admin.query(
        "INSERT INTO taxonomy.outbox (message_id,event_name,kind,correlation_id,occurred_at,published_at,payload) VALUES ($1,'taxonomy.category.updated','event',$2,now(),now(),'{}')",
        [taxonomyLegacySentId, randomUUID()],
      );
      const taxonomyOwner = await admin.connect();
      try {
        await taxonomyOwner.query(
          'SET ROLE po_taxonomy_owner; CREATE TABLE taxonomy.outbox_delivery (message_id uuid PRIMARY KEY, published_at timestamptz)',
        );
        await taxonomyOwner.query(
          'INSERT INTO taxonomy.outbox_delivery (message_id) VALUES ($1)',
          [taxonomyLegacyId],
        );
        await expect(
          taxonomyOwner.query('BEGIN; ' + candidate + ' COMMIT;'),
        ).rejects.toThrow('Taxonomy H5 has an existing or alternate writer');
        await taxonomyOwner.query('ROLLBACK');
        expect(
          (
            await taxonomyOwner.query(
              'SELECT message_id,published_at FROM taxonomy.outbox_delivery',
            )
          ).rows,
        ).toEqual([{ message_id: taxonomyLegacyId, published_at: null }]);
        await taxonomyOwner.query('DROP TABLE taxonomy.outbox_delivery');
        await taxonomyOwner.query('BEGIN; ' + candidate + ' COMMIT;');
      } finally {
        await taxonomyOwner.query('ROLLBACK');
        await taxonomyOwner.query('RESET ROLE');
        taxonomyOwner.release();
      }
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

    it('keeps the installed legacy records and drains only RabbitMQ without creating H5 deliveries', async () => {
      expect(
        (
          await admin.query(
            'SELECT delivery_transport,published_at FROM catalog.outbox WHERE message_id=$1',
            [catalogLegacyId],
          )
        ).rows,
      ).toEqual([{ delivery_transport: 'RABBITMQ', published_at: null }]);
      expect(
        (
          await admin.query(
            'SELECT delivery_transport,published_at FROM taxonomy.outbox WHERE message_id=$1',
            [taxonomyLegacyId],
          )
        ).rows,
      ).toEqual([{ delivery_transport: 'RABBITMQ', published_at: null }]);
      expect(
        (await admin.query('SELECT message_id FROM catalog.outbox_delivery'))
          .rows,
      ).toHaveLength(0);
      expect(
        (await admin.query('SELECT message_id FROM taxonomy.outbox_delivery'))
          .rows,
      ).toHaveLength(0);
      const historical = await admin.query(
        `SELECT o.message_id, CASE WHEN o.published_at IS NULL THEN 'PENDING_H4' ELSE 'SENT_H4' END AS classification,
                count(d.message_id)::int AS h5_deliveries
           FROM taxonomy.outbox o LEFT JOIN taxonomy.outbox_delivery d ON d.message_id=o.message_id
          WHERE o.message_id = ANY($1::uuid[]) GROUP BY o.message_id,o.published_at ORDER BY classification`,
        [[taxonomyLegacyId, taxonomyLegacySentId]],
      );
      expect(historical.rows).toEqual([
        {
          message_id: taxonomyLegacyId,
          classification: 'PENDING_H4',
          h5_deliveries: 0,
        },
        {
          message_id: taxonomyLegacySentId,
          classification: 'SENT_H4',
          h5_deliveries: 0,
        },
      ]);
      const catalogPublisher = { publish: vi.fn(async () => undefined) };
      expect(await catalog.relayOne(catalogPublisher)).toBe('PUBLISHED');
      expect(catalogPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: catalogLegacyId }),
      );
      const taxonomyPublisher = vi.fn(async () => undefined);
      expect(await store.publicarUno(taxonomyPublisher)).toBe('PUBLICADO');
      expect(taxonomyPublisher).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: taxonomyLegacyId }),
      );
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

    it('isolates H4 and H5 deliveries for different events in the same operation', async () => {
      const operationId = randomUUID();
      const correlationId = randomUUID();
      const h4Id = randomUUID();
      const h5Id = randomUUID();
      for (const [db, id, name] of [
        [admin, h4Id, 'taxonomy.category.updated'],
        [runtime, h5Id, 'taxonomy.product-type-schema.changed'],
      ] as const) {
        const payload = {
          message_id: id,
          correlation_id: correlationId,
          operation_id: operationId,
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          producer: 'taxonomy-svc',
          kind: 'event',
          name,
          data: { version: 1 },
        };
        await db.query(
          'INSERT INTO taxonomy.outbox (message_id,event_name,kind,correlation_id,operation_id,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            name,
            'event',
            correlationId,
            operationId,
            payload.occurred_at,
            JSON.stringify(payload),
          ],
        );
      }
      const publishH4 = vi.fn(async () => undefined);
      expect(await store.publicarUno(publishH4)).toBe('PUBLICADO');
      expect(publishH4).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: h4Id }),
      );
      const claim = await store.claimServiceBusDelivery();
      expect(claim?.messageId).toBe(h5Id);
      if (!claim) throw new Error('H5_CLAIM_MISSING');
      expect(await store.finishServiceBusDelivery(claim, 'sent')).toBe(true);
      expect(
        (
          await admin.query(
            'SELECT message_id FROM taxonomy.outbox_delivery WHERE message_id=ANY($1::uuid[])',
            [[h4Id, h5Id]],
          )
        ).rows,
      ).toEqual([{ message_id: h5Id }]);
      expect(await store.publicarUno(publishH4)).toBe('VACIO');
      expect(await store.claimServiceBusDelivery()).toBeUndefined();
    });

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
      const restartedStore = new TaxonomyMessageStore(
        {
          read: <T>(work: (db: NodePgDatabase) => Promise<T>) =>
            work(drizzle(runtime)),
        } as Database,
        intents,
      );
      expect(await restartedStore.publicarUno(publishH4)).toBe('VACIO');
      await admin.query(
        'UPDATE taxonomy.outbox_delivery SET next_attempt_at=clock_timestamp() WHERE message_id=$1',
        [h5.message_id],
      );
      expect(await publishTaxonomyDelivery(restartedStore, sender)).toBe(true);
      expect(await restartedStore.publicarUno(publishH4)).toBe('VACIO');
      expect(publishH4).toHaveBeenCalledTimes(1);
      expect(captured.map((m) => m.messageId)).toEqual([
        h5.message_id,
        h5.message_id,
      ]);
      const result = await admin.query(
        'SELECT sent_at, attempts FROM taxonomy.outbox_delivery WHERE message_id=$1',
        [h5.message_id],
      );
      expect(result.rows).toEqual([{ sent_at: expect.any(Date), attempts: 2 }]);
      await expect(insert(runtime, 'unknown.event')).rejects.toThrow(
        'Unsupported Taxonomy H5 route',
      );
    });

    it('keeps the trigger invoker and grants restricted in the disposable schema', async () => {
      const metadata = await admin.query(`
        SELECT p.prosecdef, pg_get_userbyid(n.nspowner) AS schema_owner,
          has_schema_privilege('taxonomy_app', n.oid, 'USAGE') AS runtime_usage,
          has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon_all,
          has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated_all,
          EXISTS (SELECT FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE a.grantee=0) AS public_table_grant,
          EXISTS (SELECT FROM pg_attribute col, LATERAL aclexplode(col.attacl) a WHERE col.attrelid=c.oid AND a.grantee=0) AS public_column_grant,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
        FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid AND c.relname='outbox_delivery'
        JOIN pg_proc p ON p.pronamespace=n.oid AND p.proname='fn_enqueue_catalog_h5'
        WHERE n.nspname='taxonomy'
      `);
      expect(metadata.rows).toEqual([
        {
          prosecdef: false,
          schema_owner: 'po_taxonomy_owner',
          runtime_usage: true,
          anon_all: false,
          authenticated_all: false,
          public_table_grant: false,
          public_column_grant: false,
          anon_execute: false,
          authenticated_execute: false,
        },
      ]);
      expect(
        (
          await admin.query(
            "SELECT pg_has_role('taxonomy_app','po_taxonomy_owner','MEMBER') AS owns_role",
          )
        ).rows[0].owns_role,
      ).toBe(false);
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          expect(
            (
              await admin.query(
                'SELECT has_table_privilege($1, $2, $3) AS allowed',
                [role, 'taxonomy.outbox_delivery', privilege],
              )
            ).rows[0].allowed,
          ).toBe(false);
        }
        for (const column of [
          'next_attempt_at',
          'attempts',
          'lease_token',
          'lease_until',
          'sent_at',
          'last_error',
        ]) {
          expect(
            (
              await admin.query(
                'SELECT has_column_privilege($1, $2, $3, $4) AS allowed',
                [role, 'taxonomy.outbox_delivery', column, 'UPDATE'],
              )
            ).rows[0].allowed,
          ).toBe(false);
        }
      }
    });

    it('executes the read-only preflight using the non-owner runtime role', async () => {
      const client = await runtime.connect();
      try {
        const preflight = await readFile(
          'apps/taxonomy-svc/migrations-candidate/h5/preflight-readonly.sql',
          'utf8',
        );
        await expect(client.query(preflight)).resolves.toBeDefined();
        expect(
          (await client.query('SELECT current_user AS role')).rows[0].role,
        ).toBe('taxonomy_app');
      } finally {
        client.release();
      }
    });

    it('executes the read-only preflight as owner', async () => {
      const client = await admin.connect();
      try {
        await client.query('SET ROLE po_taxonomy_owner');
        const preflight = await readFile(
          'apps/taxonomy-svc/migrations-candidate/h5/preflight-readonly.sql',
          'utf8',
        );
        await expect(client.query(preflight)).resolves.toBeDefined();
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });

    it('checks storage on every readiness with Azure directions disabled', async () => {
      const messaging = new TaxonomyAmqpRuntime(store);
      messaging.configurar({
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        TAXONOMY_SERVICE_BUS_ENABLED: 'true',
      });
      messaging.iniciar();
      const module = await Test.createTestingModule({
        controllers: [ReadinessController],
        providers: [
          {
            provide: TAXONOMY_READINESS,
            useValue: { verificarReadiness: async () => undefined },
          },
          { provide: TaxonomyAmqpRuntime, useValue: messaging },
        ],
      }).compile();
      const app = module.createNestApplication();
      await app.init();
      try {
        await request(app.getHttpServer()).get('/health/readiness').expect(200);
        await admin.query(
          'REVOKE INSERT ON taxonomy.outbox_delivery FROM taxonomy_app',
        );
        await request(app.getHttpServer()).get('/health/readiness').expect(503);
        await admin.query(
          'GRANT INSERT ON taxonomy.outbox_delivery TO taxonomy_app',
        );
        await request(app.getHttpServer()).get('/health/readiness').expect(200);
      } finally {
        await admin.query(
          'GRANT INSERT ON taxonomy.outbox_delivery TO taxonomy_app',
        );
        await app.close();
      }
    });

    it('creates one delivery for each of the six R18 routes under the runtime role', async () => {
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        const ids: string[] = [];
        for (const name of [
          'taxonomy.category.updated',
          'taxonomy.product-type-schema.changed',
          'taxonomy.characteristic-value.updated',
          'taxonomy.master.deactivation.check.requested',
          'taxonomy.master.deactivated',
          'taxonomy.master.deactivation.rejected',
        ]) {
          const result = await insert(client, name);
          ids.push(result.rows[0].message_id as string);
        }
        const deliveries = await client.query(
          'SELECT message_id, destination FROM taxonomy.outbox_delivery WHERE message_id = ANY($1::uuid[])',
          [ids],
        );
        expect(deliveries.rows).toHaveLength(6);
        expect(new Set(deliveries.rows.map((row) => row.message_id)).size).toBe(
          6,
        );
        expect(
          deliveries.rows.every(
            (row) => row.destination === 'g6.catalog.from.taxonomy',
          ),
        ).toBe(true);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('validates all six R18 payloads and published envelopes against the official AsyncAPI', async () => {
      const docsPath = process.env.G6_E2E_DOCS_PATH;
      if (!docsPath) throw new Error('G6_E2E_DOCS_PATH_REQUIRED');
      const validators = await loadR18Contract(docsPath);
      const names = [
        'taxonomy.category.updated',
        'taxonomy.product-type-schema.changed',
        'taxonomy.characteristic-value.updated',
        'taxonomy.master.deactivation.check.requested',
        'taxonomy.master.deactivated',
        'taxonomy.master.deactivation.rejected',
      ];
      const client = await runtime.connect();
      try {
        await client.query('BEGIN');
        for (const name of names) {
          const messageId = randomUUID();
          const correlationId = randomUUID();
          const operationId = randomUUID();
          const kind = name.endsWith('.requested')
            ? 'command'
            : name.endsWith('.rejected')
              ? 'result'
              : 'event';
          const data = name.startsWith('taxonomy.master.')
            ? {
                entity_type: 'BRAND',
                entity_id: randomUUID(),
                version: 1,
                ...(kind === 'result' ? { reason: 'IN_USE' } : {}),
              }
            : { entity_id: randomUUID(), version: 1 };
          const payload = {
            message_id: messageId,
            correlation_id: correlationId,
            operation_id: operationId,
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            producer: 'taxonomy-svc',
            kind,
            name,
            data,
          };
          const validate = validators.get(name);
          expect(validate).toBeDefined();
          validate(payload);
          for (const id of [messageId, correlationId, operationId])
            expect(id).toMatch(
              /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
            );
          expect(payload.schema_version).toBe(1);
          expect(() =>
            validate({ ...payload, operation_id: 'not-a-uuid' }),
          ).toThrow();
          expect(() =>
            validate({ ...payload, producer: 'catalog-svc' }),
          ).toThrow();
          expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(
            256 * 1024,
          );
          await client.query(
            'INSERT INTO taxonomy.outbox (message_id,event_name,kind,correlation_id,operation_id,occurred_at,payload) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [
              messageId,
              name,
              kind,
              correlationId,
              operationId,
              payload.occurred_at,
              JSON.stringify(payload),
            ],
          );
          expect(
            (
              await client.query(
                'SELECT destination FROM taxonomy.outbox_delivery WHERE message_id=$1',
                [messageId],
              )
            ).rows,
          ).toEqual([{ destination: 'g6.catalog.from.taxonomy' }]);
          const batch = { tryAddMessage: vi.fn().mockReturnValue(true) };
          const sender = {
            createMessageBatch: vi.fn().mockResolvedValue(batch),
            sendMessages: vi.fn().mockResolvedValue(undefined),
          };
          const fakeStore = {
            claimServiceBusDelivery: vi.fn().mockResolvedValue({
              messageId,
              token: randomUUID(),
              row: {
                message_id: messageId,
                correlation_id: correlationId,
                event_name: name,
                payload,
              },
            }),
            finishServiceBusDelivery: vi.fn().mockResolvedValue(true),
          };
          expect(await publishTaxonomyDelivery(fakeStore, sender)).toBe(true);
          expect(batch.tryAddMessage).toHaveBeenCalledWith(
            expect.objectContaining({
              subject: name,
              messageId,
              correlationId,
              contentType: 'application/json',
            }),
          );
          expect(
            sender.createMessageBatch.mock.calls[0][0].maxSizeInBytes,
          ).toBeLessThan(256 * 1024);
          expect(sender.sendMessages).toHaveBeenCalledOnce();
        }
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('claims independent deliveries concurrently without assigning the same row twice', async () => {
      const first = (await insert(runtime)).rows[0];
      const second = (await insert(runtime)).rows[0];
      const claims = await Promise.all([
        store.claimServiceBusDelivery(),
        store.claimServiceBusDelivery(),
      ]);
      expect(claims.every(Boolean)).toBe(true);
      expect(new Set(claims.map((claim) => claim?.messageId))).toEqual(
        new Set([first.message_id, second.message_id]),
      );
      for (const claim of claims) {
        if (!claim) throw new Error('CONCURRENT_CLAIM_MISSING');
        expect(await store.finishServiceBusDelivery(claim, 'sent')).toBe(true);
      }
    });

    it('rejects a stale lease token after another relay reclaims the delivery', async () => {
      const inserted = (await insert(runtime)).rows[0];
      const first = await store.claimServiceBusDelivery();
      expect(first?.messageId).toBe(inserted.message_id);
      if (!first) throw new Error('FIRST_CLAIM_MISSING');
      await admin.query(
        "UPDATE taxonomy.outbox_delivery SET lease_until=clock_timestamp() - interval '1 second' WHERE message_id=$1",
        [inserted.message_id],
      );
      const second = await store.claimServiceBusDelivery();
      if (!second) throw new Error('SECOND_CLAIM_MISSING');
      expect(second.token).not.toBe(first.token);
      expect(await store.finishServiceBusDelivery(first, 'sent')).toBe(false);
      expect(await store.finishServiceBusDelivery(second, 'sent')).toBe(true);
    });

    it('rolls back an outbox fact when the runtime role cannot insert its delivery', async () => {
      const before = (
        await admin.query('SELECT count(*)::int AS total FROM taxonomy.outbox')
      ).rows[0].total;
      await admin.query(
        'REVOKE INSERT ON taxonomy.outbox_delivery FROM taxonomy_app',
      );
      try {
        await expect(insert(runtime)).rejects.toThrow(/permission denied/i);
        expect(
          (
            await admin.query(
              'SELECT count(*)::int AS total FROM taxonomy.outbox',
            )
          ).rows[0].total,
        ).toBe(before);
      } finally {
        await admin.query(
          'GRANT INSERT ON taxonomy.outbox_delivery TO taxonomy_app',
        );
      }
      await store.verifyServiceBusStorage();
    });

    it('round-trips a category deactivation through both outboxes and inboxes without publishing the reply in H4', async () => {
      const entityId = randomUUID();
      const operationId = randomUUID();
      const correlationId = randomUUID();
      await admin.query(
        'INSERT INTO taxonomy.categories (id,nombre) VALUES ($1,$2)',
        [entityId, 'Test ' + entityId],
      );
      const slugAnterior = `antiguo-${entityId}`;
      const slugActual = `actual-${entityId}`;
      await admin.query(
        'INSERT INTO taxonomy.category_seo (categoria_id, slug) VALUES ($1, $2)',
        [entityId, slugAnterior],
      );
      await admin.query(
        'UPDATE taxonomy.category_seo SET slug=$2 WHERE categoria_id=$1',
        [entityId, slugActual],
      );
      const seoDatabase = {
        read: <T>(fn: (db: NodePgDatabase) => Promise<T>) =>
          fn(drizzle(runtime)),
      };
      const seo = new CategorySeoService(seoDatabase as Database);
      await expect(seo.publico(slugActual)).resolves.toMatchObject({
        slug: slugActual,
      });
      await expect(seo.resolver(slugAnterior)).resolves.toMatchObject({
        old_slug: slugAnterior,
        new_slug: slugActual,
      });
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

      const snapshot = async () =>
        (
          await admin.query(
            'SELECT (SELECT count(*)::int FROM catalog.inbox WHERE operation_id=$1) AS inbox, (SELECT count(*)::int FROM catalog.master_barriers WHERE operation_id=$1) AS barriers, (SELECT count(*)::int FROM catalog.outbox WHERE operation_id=$1) AS outbox, (SELECT count(*)::int FROM catalog.outbox_delivery d JOIN catalog.outbox o USING (message_id) WHERE o.operation_id=$1) AS deliveries',
            [operationId],
          )
        ).rows[0];
      const empty = { inbox: 0, barriers: 0, outbox: 0, deliveries: 0 };
      const disabledConsumer = createCatalogTaxonomyConsumer(catalog, []);
      await expect(disabledConsumer.consume(request)).rejects.toThrow(
        'CATALOG_H5_TAXONOMY_REPLY_DISABLED',
      );
      expect(await snapshot()).toEqual(empty);

      const enabledConsumer = createCatalogTaxonomyConsumer(catalog, [
        taxonomyReplyQueue,
      ]);
      expect(await enabledConsumer.consume(request)).toBe('APPLIED');
      expect(await enabledConsumer.consume(request)).toBe('DUPLICATE');
      const replyTransport = await admin.query(
        'SELECT o.delivery_transport,d.destination,d.published_at FROM catalog.outbox o JOIN catalog.outbox_delivery d USING (message_id) WHERE o.operation_id=$1',
        [operationId],
      );
      expect(replyTransport.rows).toEqual([
        {
          delivery_transport: 'AZURE_SERVICE_BUS',
          destination: taxonomyReplyQueue,
          published_at: null,
        },
      ]);
      const h4Publisher = { publish: vi.fn() };
      const priorProvider = process.env.MESSAGING_PROVIDER;
      process.env.MESSAGING_PROVIDER = 'RABBITMQ';
      try {
        expect(await catalog.relayOne(h4Publisher)).toBe('EMPTY');
      } finally {
        if (priorProvider === undefined) delete process.env.MESSAGING_PROVIDER;
        else process.env.MESSAGING_PROVIDER = priorProvider;
      }
      expect(h4Publisher.publish).not.toHaveBeenCalled();
      const publish = vi
        .fn()
        .mockRejectedValueOnce(new Error('confirmation lost'));
      expect(
        await relayCatalogDelivery(catalogDb, { publish }, taxonomyReplyQueue),
      ).toBe('RETRY');
      const restartedCatalog = new CatalogMessageService(catalogDb);
      expect(await restartedCatalog.relayOne(h4Publisher)).toBe('EMPTY');
      await admin.query(
        'UPDATE catalog.outbox_delivery SET available_at=now() WHERE published_at IS NULL',
      );
      expect(
        await relayCatalogDelivery(catalogDb, { publish }, taxonomyReplyQueue),
      ).toBe('CONFIRMED');
      const providerBeforeH4Check = process.env.MESSAGING_PROVIDER;
      process.env.MESSAGING_PROVIDER = 'RABBITMQ';
      try {
        expect(await restartedCatalog.relayOne(h4Publisher)).toBe('EMPTY');
      } finally {
        if (providerBeforeH4Check === undefined)
          delete process.env.MESSAGING_PROVIDER;
        else process.env.MESSAGING_PROVIDER = providerBeforeH4Check;
      }
      expect(h4Publisher.publish).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual({
        inbox: 1,
        barriers: 1,
        outbox: 1,
        deliveries: 1,
      });
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
      const changed = JSON.parse(JSON.stringify(response)) as {
        data: { result: string };
      };
      changed.data.result = 'IN_USE';
      const conflictDelivery = {
        ...checkedDelivery,
        body: Buffer.from(JSON.stringify(changed)),
      };
      const conflictReceiver = {
        completeMessage: vi.fn(),
        abandonMessage: vi.fn(),
        deadLetterMessage: vi.fn(),
      };
      await receiveTaxonomyDelivery(store, conflictReceiver, conflictDelivery);
      expect(conflictReceiver.deadLetterMessage).toHaveBeenCalledWith(
        conflictDelivery,
        expect.objectContaining({
          deadLetterReason: 'TAXONOMY_MESSAGE_ID_CONFLICT',
        }),
      );
      expect(conflictReceiver.completeMessage).not.toHaveBeenCalled();
      expect(conflictReceiver.abandonMessage).not.toHaveBeenCalled();
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS total FROM taxonomy.inbox WHERE message_id=$1',
            [response.message_id],
          )
        ).rows,
      ).toEqual([{ total: 1 }]);
      expect((await intents.obtenerOperacion(operationId))?.status).toBe(
        'COMPLETED',
      );
      await expect(seo.resolver(slugAnterior)).resolves.toEqual({
        old_slug: slugAnterior,
        new_slug: slugActual,
        resolution: 'PERMANENT',
      });
      await expect(seo.publico(slugActual)).resolves.toBeUndefined();
      await expect(seo.obtener(entityId)).resolves.toMatchObject({
        slug: slugActual,
      });
      const final = await store.claimServiceBusDelivery();
      if (!final) throw new Error('FINAL_NOT_ENQUEUED');
      expect(final.row.event_name).toBe('taxonomy.master.deactivated');
      expect(
        await enabledConsumer.consume(final.row.payload as CatalogEnvelope),
      ).toBe('APPLIED');
      expect(
        await enabledConsumer.consume(final.row.payload as CatalogEnvelope),
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

    it.each(['BRAND', 'CATEGORY'] as const)(
      'rejects %s with an active Catalog SKU and completes after release',
      async (entityType) => {
        const consumer = createCatalogTaxonomyConsumer(catalog, [
          taxonomyReplyQueue,
        ]);
        const brand = randomUUID();
        const table = entityType === 'BRAND' ? 'brands' : 'categories';
        const product = randomUUID();
        const sku = `sku-${product}`;
        await admin.query(
          `INSERT INTO taxonomy.${table} (id,nombre) VALUES ($1,$2)`,
          [brand, `Brand ${brand}`],
        );
        const client = await admin.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            "INSERT INTO catalog.products (id,nombre,descripcion,categoria_id,tipo_producto_id,marca_id,sku_base,slug,tiene_variantes) VALUES ($1,'Producto','Fixture',$4,'type',$2,$3,$3,false)",
            [
              product,
              entityType === 'BRAND' ? brand : 'other-brand',
              sku,
              entityType === 'CATEGORY' ? brand : 'other-category',
            ],
          );
          await client.query(
            "INSERT INTO catalog.product_images (product_id,url) VALUES ($1,'https://example.test/image')",
            [product],
          );
          await client.query(
            'INSERT INTO catalog.sku_physical_profiles (sku_identity_id,peso_kg,largo_cm,ancho_cm,alto_cm) SELECT id,1,1,1,1 FROM catalog.sku_identity WHERE product_id=$1',
            [product],
          );
          for (const dependency of ['PRICING', 'INVENTORY']) {
            await client.query(
              "INSERT INTO catalog.activation_checks (product_id,sku,dependency,operation_id,correlation_id,request_payload,state,result_payload,result_message_id) VALUES ($1,$2,$3,$4,$5,'{}','COMPLETED','{}',$6)",
              [
                product,
                sku,
                dependency,
                randomUUID(),
                randomUUID(),
                randomUUID(),
              ],
            );
          }
          await client.query(
            "UPDATE catalog.products SET estado='ACTIVO' WHERE id=$1",
            [product],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

        const runCheck = async (expected: 'IN_USE' | 'CLEAR') => {
          const operationId = randomUUID();
          const correlationId = randomUUID();
          const version = Number(
            (
              await admin.query(
                `SELECT taxonomy_version FROM taxonomy.${table} WHERE id=$1`,
                [brand],
              )
            ).rows[0].taxonomy_version,
          );
          expect(
            await intents.registrar({
              entityType,
              entityId: brand,
              operationId,
              correlationId,
              version,
            }),
          ).toBe('REGISTRADA');
          const request = await store.claimServiceBusDelivery();
          if (!request) throw new Error('BRAND_REQUEST_NOT_ENQUEUED');
          expect(await store.finishServiceBusDelivery(request, 'sent')).toBe(
            true,
          );
          expect(
            await consumer.consume(request.row.payload as CatalogEnvelope),
          ).toBe('APPLIED');
          const publish = vi.fn(async () => undefined);
          expect(
            await relayCatalogDelivery(
              catalogDb,
              { publish },
              taxonomyReplyQueue,
            ),
          ).toBe('CONFIRMED');
          const response = publish.mock.calls[0]?.[1];
          expect(response).toMatchObject({
            operation_id: operationId,
            data: { result: expected },
          });
          if (!response) throw new Error('BRAND_RESPONSE_NOT_ENQUEUED');
          const delivery = {
            body: Buffer.from(JSON.stringify(response)),
            subject: response.name,
            contentType: 'application/json',
            messageId: response.message_id,
            correlationId: response.correlation_id,
          } as ServiceBusReceivedMessage;
          const receiver = {
            completeMessage: vi.fn(),
            abandonMessage: vi.fn(),
            deadLetterMessage: vi.fn(),
          };
          if (expected === 'CLEAR') {
            const stale = JSON.parse(JSON.stringify(response)) as {
              message_id: string;
              data: { version: number };
            };
            stale.message_id = randomUUID();
            stale.data.version = version + 1;
            await receiveTaxonomyDelivery(store, receiver, {
              ...delivery,
              messageId: stale.message_id,
              body: Buffer.from(JSON.stringify(stale)),
            });
            expect((await intents.obtenerOperacion(operationId))?.status).toBe(
              'PENDING_DEACTIVATION',
            );
            expect(
              (
                await admin.query(
                  'SELECT result FROM taxonomy.inbox WHERE message_id=$1',
                  [stale.message_id],
                )
              ).rows,
            ).toEqual([{ result: 'IGNORED' }]);
            receiver.completeMessage.mockClear();
          }
          await receiveTaxonomyDelivery(store, receiver, delivery);
          expect(receiver.completeMessage).toHaveBeenCalledOnce();
          expect((await intents.obtenerOperacion(operationId))?.status).toBe(
            expected === 'IN_USE' ? 'REJECTED' : 'COMPLETED',
          );
          const final = await store.claimServiceBusDelivery();
          if (!final) throw new Error('BRAND_FINAL_NOT_ENQUEUED');
          expect(
            await consumer.consume(final.row.payload as CatalogEnvelope),
          ).toBe('APPLIED');
          expect(await store.finishServiceBusDelivery(final, 'sent')).toBe(
            true,
          );
          if (expected === 'CLEAR') {
            await receiveTaxonomyDelivery(store, receiver, delivery);
            const late = {
              ...response,
              message_id: randomUUID(),
              data: { ...response.data, version: version + 1 },
            };
            await receiveTaxonomyDelivery(store, receiver, {
              ...delivery,
              messageId: late.message_id,
              body: Buffer.from(JSON.stringify(late)),
            });
            expect((await intents.obtenerOperacion(operationId))?.status).toBe(
              'COMPLETED',
            );
            expect(
              (
                await admin.query(
                  `SELECT estado FROM taxonomy.${table} WHERE id=$1`,
                  [brand],
                )
              ).rows[0].estado,
            ).toBe('INACTIVO');
            expect(
              (
                await admin.query(
                  'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id=$1',
                  [response.message_id],
                )
              ).rows[0].n,
            ).toBe(1);
          }
        };
        await runCheck('IN_USE');
        expect(
          (
            await admin.query(
              `SELECT estado FROM taxonomy.${table} WHERE id=$1`,
              [brand],
            )
          ).rows[0].estado,
        ).toBe('ACTIVO');
        await admin.query(
          "UPDATE catalog.products SET estado='INACTIVO' WHERE id=$1",
          [product],
        );
        await runCheck('CLEAR');
        expect(
          (
            await admin.query(
              `SELECT estado FROM taxonomy.${table} WHERE id=$1`,
              [brand],
            )
          ).rows[0].estado,
        ).toBe('INACTIVO');
      },
    );

    it('rolls back Inbox, barrier, Outbox and delivery when the Catalog marker or Inbox insert fails', async () => {
      const request: CatalogEnvelope = {
        message_id: randomUUID(),
        correlation_id: randomUUID(),
        operation_id: randomUUID(),
        schema_version: 1,
        occurred_at: new Date().toISOString(),
        producer: 'taxonomy-svc',
        kind: 'command',
        name: 'taxonomy.master.deactivation.check.requested',
        data: { entity_type: 'CATEGORY', entity_id: randomUUID(), version: 0 },
      };
      const snapshot = async () =>
        (
          await admin.query(
            'SELECT (SELECT count(*)::int FROM catalog.inbox WHERE operation_id=$1) AS inbox, (SELECT count(*)::int FROM catalog.master_barriers WHERE operation_id=$1) AS barriers, (SELECT count(*)::int FROM catalog.outbox WHERE operation_id=$1) AS outbox, (SELECT count(*)::int FROM catalog.outbox_delivery d JOIN catalog.outbox o USING (message_id) WHERE o.operation_id=$1) AS deliveries',
            [request.operation_id],
          )
        ).rows[0];
      const empty = { inbox: 0, barriers: 0, outbox: 0, deliveries: 0 };
      await admin.query(
        'ALTER TABLE catalog.outbox DISABLE TRIGGER trg_catalog_taxonomy_reply_transport',
      );
      try {
        await expect(catalog.consume(request, true)).rejects.toThrow(
          'CATALOG_H5_REPLY_TRANSPORT_NOT_PERSISTED',
        );
        expect(await snapshot()).toEqual(empty);
      } finally {
        await admin.query(
          'ALTER TABLE catalog.outbox ENABLE TRIGGER trg_catalog_taxonomy_reply_transport',
        );
      }
      await admin.query('REVOKE INSERT ON catalog.inbox FROM catalog_app');
      try {
        await expect(catalog.consume(request, true)).rejects.toThrow();
        expect(await snapshot()).toEqual(empty);
      } finally {
        await admin.query('GRANT INSERT ON catalog.inbox TO catalog_app');
      }
      expect(await catalog.consume(request, true)).toBe('APPLIED');
      expect(
        await new CatalogMessageService(catalogDb).consume(request, true),
      ).toBe('DUPLICATE');
      expect(await snapshot()).toEqual({
        inbox: 1,
        barriers: 1,
        outbox: 1,
        deliveries: 1,
      });
    });

    it.each([
      'CATEGORY',
      'BRAND',
      'PRODUCT_TYPE',
      'CHARACTERISTIC_VALUE',
      'PRODUCT_TYPE_CHARACTERISTIC',
    ] as const)(
      'correlates, deduplicates and persists both R09 outcomes for %s',
      async (entityType) => {
        for (const result of ['CLEAR', 'IN_USE'] as const) {
          const id = randomUUID();
          const typeId = randomUUID();
          const characteristicId = randomUUID();
          if (entityType === 'CATEGORY')
            await admin.query(
              'INSERT INTO taxonomy.categories (id,nombre) VALUES ($1,$2)',
              [id, id],
            );
          if (entityType === 'BRAND')
            await admin.query(
              'INSERT INTO taxonomy.brands (id,nombre) VALUES ($1,$2)',
              [id, id],
            );
          if (entityType === 'PRODUCT_TYPE')
            await admin.query(
              'INSERT INTO taxonomy.product_types (id,nombre) VALUES ($1,$2)',
              [id, id],
            );
          if (
            entityType === 'CHARACTERISTIC_VALUE' ||
            entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
          ) {
            await admin.query(
              "INSERT INTO taxonomy.characteristics (id,nombre,tipo) VALUES ($1,$2,'LISTA')",
              [characteristicId, characteristicId],
            );
            if (entityType === 'CHARACTERISTIC_VALUE')
              await admin.query(
                'INSERT INTO taxonomy.characteristic_values (id,caracteristica_id,nombre) VALUES ($1,$2,$3)',
                [id, characteristicId, id],
              );
            else {
              await admin.query(
                'INSERT INTO taxonomy.product_types (id,nombre) VALUES ($1,$2)',
                [typeId, typeId],
              );
              await admin.query(
                'INSERT INTO taxonomy.product_type_characteristics (id,tipo_producto_id,caracteristica_id) VALUES ($1,$2,$3)',
                [id, typeId, characteristicId],
              );
            }
          }
          const version =
            entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
              ? Number(
                  (
                    await admin.query(
                      'SELECT schema_version FROM taxonomy.product_types WHERE id=$1',
                      [typeId],
                    )
                  ).rows[0].schema_version,
                )
              : 0;
          const operationId = randomUUID();
          const correlationId = randomUUID();
          const association =
            entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
              ? { tipoProductoId: typeId, caracteristicaId: characteristicId }
              : {};
          const intent = {
            entityType,
            entityId: id,
            operationId,
            correlationId,
            version,
            ...association,
          };
          expect(await intents.registrar(intent)).toBe('REGISTRADA');
          expect(await intents.registrar(intent)).toBe('REINTENTO');
          const message = {
            message_id: randomUUID(),
            correlation_id: correlationId,
            operation_id: operationId,
            schema_version: 1,
            occurred_at: new Date().toISOString(),
            producer: 'catalog-svc',
            kind: 'result',
            name: 'catalog.master.deactivation.checked',
            data: {
              entity_type: entityType,
              entity_id: id,
              version,
              result,
              ...(entityType === 'PRODUCT_TYPE_CHARACTERISTIC'
                ? {
                    tipo_producto_id: typeId,
                    caracteristica_id: characteristicId,
                  }
                : {}),
            },
          };
          for (const invalid of [
            {
              ...message,
              message_id: randomUUID(),
              operation_id: randomUUID(),
            },
            {
              ...message,
              message_id: randomUUID(),
              data: { ...message.data, version: version + 1 },
            },
          ]) {
            await store.consumir(parseChecked(invalid));
            expect((await intents.obtenerOperacion(operationId))?.status).toBe(
              'PENDING_DEACTIVATION',
            );
          }
          const checked = parseChecked(message);
          await store.consumir(checked);
          await store.consumir(checked);
          expect((await intents.obtenerOperacion(operationId))?.status).toBe(
            result === 'CLEAR' ? 'COMPLETED' : 'REJECTED',
          );
          expect(
            (
              await admin.query(
                'SELECT count(*)::int AS n FROM taxonomy.inbox WHERE message_id=$1',
                [message.message_id],
              )
            ).rows[0].n,
          ).toBe(1);
        }
      },
    );

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
