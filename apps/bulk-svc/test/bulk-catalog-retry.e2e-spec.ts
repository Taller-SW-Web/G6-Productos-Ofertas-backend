import { randomUUID, createSign, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BulkSvcController } from '../src/bulk-svc.controller.js';
import { BulkSvcService } from '../src/bulk-svc.service.js';
import { BulkImportService } from '../src/bulk-import.service.js';
import { BulkStorageService } from '../src/storage/bulk-storage.service.js';
import { BulkContentService } from '../src/bulk-content.service.js';
import { BulkUserBearerGuard } from '../src/auth/bulk-user-bearer.guard.js';
import { BulkServiceBearerGuard } from '../src/auth/bulk-service-bearer.guard.js';
import { BulkProblemFilter } from '../src/http/bulk-problem.filter.js';
import { BulkReadinessService } from '../src/health/bulk-readiness.service.js';
import { BulkExportService } from '../src/bulk-export.service.js';
import {
  bulkSchema,
  batchJobs,
  batchRows,
  domainAttempts,
  outbox as bulkOutbox,
} from '../src/persistence/bulk.schema.js';
import { BulkPersistenceRepository } from '../src/persistence/bulk.repository.js';
import {
  Database,
  type PostgresSettings,
} from '../../catalog-svc/src/database.js';
import { CatalogTransactionManager } from '../../catalog-svc/src/catalog-transaction.js';
import { CatalogMutationService } from '../../catalog-svc/src/catalog-mutation.service.js';
import { PostgresCatalogWriteRepository } from '../../catalog-svc/src/postgres-catalog-write.repository.js';
import {
  CatalogBulkService,
  CatalogBulkIdentity,
} from '../../catalog-svc/src/catalog-bulk.service.js';
import { CatalogTokenVerifier } from '../../catalog-svc/src/catalog-auth.js';
import { CatalogIdentityAcquisitionError } from '../../catalog-svc/src/catalog-pricing-identity.js';
import {
  CatalogBulkContentClient,
  CatalogBulkContentIdentity,
} from '../../catalog-svc/src/catalog-bulk-content.js';
import {
  outbox as catalogOutbox,
  products,
  bulkRetryAttemptReceipts,
} from '../../catalog-svc/src/catalog.schema.js';
import type { CatalogEnvelope } from '../../catalog-svc/src/catalog-messages.js';
import { BULK_TEMPLATE_HEADERS } from '../src/domain/bulk-template-v2.js';

const bulkDatabaseUrl = process.env.BULK_RETRY_INTEGRATION_BULK_DATABASE_URL;
const catalogDatabaseUrl =
  process.env.BULK_RETRY_INTEGRATION_CATALOG_DATABASE_URL;
const integration =
  bulkDatabaseUrl && catalogDatabaseUrl ? describe : describe.skip;
const ownerSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const jwtKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
let pool: Pool;
let bulkDatabase: ReturnType<typeof drizzle<typeof bulkSchema>>;
let bulkRepository: BulkPersistenceRepository;
let catalogDatabase: Database;
let restoreFlags: Array<[string, string | undefined]> = [];

function setFlag(name: string, value: string) {
  restoreFlags.push([name, process.env[name]]);
  process.env[name] = value;
}

function signedUserToken(sub: string, roles = ['GESTOR_COMERCIAL']) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const claims = encode({
    iss: 'bulk-retry-integration',
    sub,
    tipo: 'acceso',
    aud: 'api-productos',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    jti: randomUUID(),
    roles,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  setFlag(
    'G7_JWT_PUBLIC_KEY',
    jwtKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  return `${header}.${claims}.${signer.sign(jwtKeys.privateKey, 'base64url')}`;
}

function signedServiceToken() {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const claims = encode({
    iss: 'bulk-retry-integration',
    sub: 'catalog-svc',
    client_id: 'catalog-svc',
    tipo: 'servicio',
    aud: 'api-productos',
    scope: 'carga-masiva:contenidos:leer',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    jti: randomUUID(),
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(jwtKeys.privateKey, 'base64url')}`;
}

integration(
  'Bulk ↔ Catalog BULK_RETRY_V1 with direct local test delivery, PostgreSQL 17, no Azure transport',
  () => {
    beforeAll(async () => {
      if (!bulkDatabaseUrl || !catalogDatabaseUrl)
        throw new Error(
          'BULK_RETRY_INTEGRATION_BULK_DATABASE_URL and BULK_RETRY_INTEGRATION_CATALOG_DATABASE_URL required',
        );
      const bulkUrl = new URL(bulkDatabaseUrl);
      const catalogUrl = new URL(catalogDatabaseUrl);
      for (const url of [bulkUrl, catalogUrl]) {
        if (
          !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
          url.searchParams.get('sslmode') !== 'disable'
        )
          throw new Error(
            'Integration requires disposable loopback PostgreSQL',
          );
      }
      if (
        bulkUrl.hostname !== catalogUrl.hostname ||
        bulkUrl.port !== catalogUrl.port ||
        bulkUrl.pathname !== catalogUrl.pathname ||
        bulkUrl.username === catalogUrl.username
      )
        throw new Error(
          'Bulk and Catalog must use distinct roles on the same disposable PostgreSQL database',
        );
      setFlag('NODE_ENV', 'test');
      setFlag('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
      setFlag('G7_JWT_ISSUER', 'bulk-retry-integration');
      setFlag('BULK_STORAGE_BUCKET', 'bulk-retry-integration');
      setFlag('BULK_CATALOG_V3_ENABLED', 'true');
      setFlag('BULK_CATALOG_V3_AUTHORIZATION_VERIFIED', 'true');
      setFlag('BULK_RETRY_CATALOG_V1_ENABLED', 'true');
      setFlag('BULK_RETRY_ELIGIBILITY_ENABLED', 'true');
      setFlag('CATALOG_BULK_RETRY_V1_ENABLED', 'true');
      setFlag('CATALOG_BULK_RESULT_V2_ENABLED', 'true');
      pool = new Pool({ connectionString: bulkDatabaseUrl, max: 6 });
      bulkDatabase = drizzle(pool, { schema: bulkSchema, logger: false });
      bulkRepository = new BulkPersistenceRepository(bulkDatabase);
      const version = await pool.query<{ server_version_num: string }>(
        'SHOW server_version_num',
      );
      expect(
        Number(version.rows[0]?.server_version_num),
      ).toBeGreaterThanOrEqual(170000);
      expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(180000);

      const catalogSettings: PostgresSettings = {
        pool: {
          host: catalogUrl.hostname,
          port: Number(catalogUrl.port || 5432),
          database: catalogUrl.pathname.slice(1),
          user: decodeURIComponent(catalogUrl.username),
          password: decodeURIComponent(catalogUrl.password),
          ssl: false,
          max: 6,
        },
        expectedRole: decodeURIComponent(catalogUrl.username),
        database: catalogUrl.pathname.slice(1),
        user: decodeURIComponent(catalogUrl.username),
        password: decodeURIComponent(catalogUrl.password),
        mode: 'direct',
      };
      catalogDatabase = new Database(catalogSettings);
      await catalogDatabase.verifyIdentity();
    }, 30_000);

    afterAll(async () => {
      await catalogDatabase?.onModuleDestroy();
      await pool?.end();
      for (const [name, oldValue] of restoreFlags) {
        if (oldValue === undefined) delete process.env[name];
        else process.env[name] = oldValue;
      }
    });

    it('admits, rejects without commercial effects, retries through V4, and closes without duplicate effects', async () => {
      const originalCorrelation = randomUUID();
      const retryHttpCorrelation = randomUUID();
      expect(retryHttpCorrelation).not.toBe(originalCorrelation);
      const token = signedUserToken(ownerSub);
      const transactions = new CatalogTransactionManager(catalogDatabase);
      const seedMutations = new CatalogMutationService(
        transactions,
        new PostgresCatalogWriteRepository(),
        {
          masters: async () => ({ schemaVersion: 1 }),
          attributes: async (_type: string, values: unknown[]) => values,
        } as never,
        {
          resolve: async (_input, id) => ({
            slug: `retry-${id}`,
            moneda: 'PEN',
          }),
        },
      );
      const skuBase = `BULK-RETRY-${randomUUID()}`;
      const seed = await seedMutations.createProduct(
        {
          nombre: 'Retry integration seed',
          descripcion: 'Before retry',
          categoriaId: 'category-fixture',
          tipoProductoId: 'type-fixture',
          marcaId: 'brand-fixture',
          skuBase,
          tieneVariantes: false,
          precioBaseInicial: 20,
          imagenes: [{ url: 'https://example.test/product' }],
          perfilFisico: {
            pesoKg: 1.5,
            dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
          },
        },
        {
          authorization: 'Bearer isolated-master-fixture',
          correlationId: randomUUID(),
        },
      );
      const storageObjects = new Map<string, Buffer>();
      const storageFixture = {
        put: vi.fn(async (bytes: Buffer, _mime: string, key: string) => {
          storageObjects.set(key, Buffer.from(bytes));
          return `supabase://bulk-retry-integration/${key}`;
        }),
        get: vi.fn(async (reference: string) => {
          const key = reference.replace(
            'supabase://bulk-retry-integration/',
            '',
          );
          const bytes = storageObjects.get(key);
          if (!bytes) throw new Error('Claim-check object was not stored');
          return Buffer.from(bytes);
        }),
      };
      const imports = new BulkImportService(
        bulkRepository,
        storageFixture as unknown as BulkStorageService,
      );
      const moduleRef = await Test.createTestingModule({
        controllers: [BulkSvcController],
        providers: [
          BulkSvcService,
          BulkUserBearerGuard,
          BulkServiceBearerGuard,
          {
            provide: BulkReadinessService,
            useValue: { probe: async () => ({ ready: true }) },
          },
          { provide: BulkImportService, useValue: imports },
          { provide: BulkPersistenceRepository, useValue: bulkRepository },
          { provide: BulkStorageService, useValue: storageFixture },
          { provide: BulkExportService, useValue: {} },
          BulkContentService,
        ],
      }).compile();
      const http = moduleRef.createNestApplication();
      http.useGlobalFilters(new BulkProblemFilter());
      await http.init();
      await http.listen(0, '127.0.0.1');
      const server = http.getHttpServer();
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Bulk private HTTP fixture did not bind loopback');
      setFlag('CATALOG_BULK_CONTENTS_URL', `http://127.0.0.1:${address.port}`);
      try {
        const csvValues = [
          'ACTUALIZACION',
          seed.product_id,
          JSON.stringify({
            producto: Number(seed.catalog_version),
            variante: null,
          }),
          skuBase,
          '',
          'Retry integration seed',
          'After retry',
          'category-fixture',
          'brand-fixture',
          'type-fixture',
          'false',
          '',
          '[]',
          '',
          '',
          '0',
        ];
        const csv = Buffer.from(
          `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${csvValues.map((value) => `"${value.replace(/"/g, '""')}"`).join(',')}\r\n`,
          'utf8',
        );
        const admit = () =>
          request(server)
            .post('/api/v1/carga-masiva/productos/importaciones')
            .set('Authorization', `Bearer ${token}`)
            .set('X-Correlation-Id', originalCorrelation)
            .field('template_version', '2')
            .attach('archivo', csv, {
              filename: 'retry.csv',
              contentType: 'text/csv',
            });
        const concurrentAdmissions = await Promise.all([admit(), admit()]);
        for (const response of concurrentAdmissions)
          expect(response.status).toBe(202);
        expect(concurrentAdmissions[0]?.body).toEqual(
          concurrentAdmissions[1]?.body,
        );
        const admission = concurrentAdmissions[0]!;
        const changedBytes = Buffer.from(
          csv.toString('utf8').replace('After retry', 'Different intent'),
          'utf8',
        );
        const conflictingAdmission = await request(server)
          .post('/api/v1/carga-masiva/productos/importaciones')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Correlation-Id', originalCorrelation)
          .field('template_version', '2')
          .attach('archivo', changedBytes, {
            filename: 'retry.csv',
            contentType: 'text/csv',
          });
        expect(conflictingAdmission.status).toBe(409);
        expect(admission.body).toMatchObject({
          status: 'QUEUED',
          correlation_id: originalCorrelation,
          template_version: 2,
        });
        const batchId = String(admission.body.batch_id);
        expect(
          await bulkDatabase
            .select()
            .from(batchJobs)
            .where(eq(batchJobs.correlationId, originalCorrelation)),
        ).toHaveLength(1);
        expect(
          await bulkDatabase
            .select()
            .from(bulkOutbox)
            .where(
              and(
                eq(bulkOutbox.correlationId, originalCorrelation),
                eq(bulkOutbox.schemaVersion, 3),
              ),
            ),
        ).toHaveLength(1);
        const [originalOutbox] = await bulkDatabase
          .select()
          .from(bulkOutbox)
          .where(eq(bulkOutbox.correlationId, originalCorrelation));
        expect(originalOutbox?.schemaVersion).toBe(3);
        const original = originalOutbox?.payload as unknown as CatalogEnvelope;
        const contentRef = original.data.content_ref as { content_id: string };
        const contentKey = [...storageObjects.keys()].find((key) =>
          key.includes('/catalog-'),
        );
        if (!contentKey)
          throw new Error('V3 private content document was not stored');
        const contentBytes = storageObjects.get(contentKey)!;
        const decodedDocument = JSON.parse(
          contentBytes.toString('utf8'),
        ) as unknown;

        const productsBefore = await catalogDatabase.read((db) =>
          db.select().from(products),
        );
        const initialIdentity = new CatalogBulkIdentity(
          undefined,
          new CatalogTokenVerifier(undefined),
        );
        vi.spyOn(
          initialIdentity,
          'authorizationForBulkRetry',
        ).mockRejectedValue(new CatalogIdentityAcquisitionError('TRANSIENT'));
        const contentIdentity = new CatalogBulkContentIdentity(
          undefined,
          new CatalogTokenVerifier(undefined),
        );
        vi.spyOn(contentIdentity, 'authorization').mockResolvedValue(
          `Bearer ${signedServiceToken()}`,
        );
        const contentClient = new CatalogBulkContentClient(contentIdentity);
        const mutations = new CatalogMutationService(
          transactions,
          new PostgresCatalogWriteRepository(),
          {
            masters: async () => ({ schemaVersion: 1 }),
            attributes: async (_type: string, values: unknown[]) => values,
          } as never,
          {
            resolve: async (_input, id) => ({
              slug: `retry-${id}`,
              moneda: 'PEN',
            }),
          },
        );
        const initialCatalog = new CatalogBulkService(
          catalogDatabase,
          mutations,
          initialIdentity,
          contentClient as never,
        );
        await expect(initialCatalog.consume(original)).resolves.toBe('APPLIED');
        expect(contentIdentity.authorization).toHaveBeenCalledOnce();
        expect(storageFixture.get).toHaveBeenCalledOnce();
        const [initialResultRow] = await catalogDatabase.read((db) =>
          db
            .select()
            .from(catalogOutbox)
            .where(eq(catalogOutbox.causation_id, original.message_id))
            .limit(1),
        );
        if (!initialResultRow)
          throw new Error('Catalog V2 result was not persisted');
        const initialResult: CatalogEnvelope = {
          message_id: initialResultRow.message_id,
          schema_version: initialResultRow.schema_version,
          occurred_at: initialResultRow.occurred_at.toISOString(),
          correlation_id: initialResultRow.correlation_id,
          causation_id: initialResultRow.causation_id,
          operation_id: initialResultRow.operation_id,
          producer: 'catalog-svc',
          kind: initialResultRow.kind as CatalogEnvelope['kind'],
          name: initialResultRow.event_name,
          data: initialResultRow.payload,
        };
        expect(initialResult).toMatchObject({
          schema_version: 2,
          correlation_id: originalCorrelation,
          causation_id: original.message_id,
          data: {
            results: [
              {
                status: 'REJECTED',
                effect_state: 'NONE',
                retriable: true,
                code: 'CATALOG_AUTH_TEMPORARY_UNAVAILABLE',
              },
            ],
          },
        });
        expect(
          await catalogDatabase.read((db) => db.select().from(products)),
        ).toEqual(productsBefore);
        await bulkRepository.recordCatalogBulkResult({
          messageId: initialResult.message_id,
          operationId: String(initialResult.operation_id),
          causationId: String(initialResult.causation_id),
          eventName: String(
            initialResult.name,
          ) as 'catalog.bulk.upsert.completed',
          correlationId: initialResult.correlation_id,
          payload: initialResult,
        });

        const statePath = `/api/v1/carga-masiva/productos/importaciones/${batchId}`;
        const eligible = await request(server)
          .get(statePath)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(eligible.body.reanudacion).toMatchObject({
          elegible: true,
          motivo_bloqueo: null,
        });
        expect(eligible.body.reanudacion.pasos).toHaveLength(1);
        const resumePath = `${statePath}/reanudar`;
        const resume = () =>
          request(server)
            .post(resumePath)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Correlation-Id', retryHttpCorrelation)
            .send({ motivo: 'Recuperar familia Catalog' });
        const concurrentResumes = await Promise.all([resume(), resume()]);
        for (const response of concurrentResumes)
          expect(response.status).toBe(202);
        expect(concurrentResumes[0]?.body).toEqual(concurrentResumes[1]?.body);
        const resumed = concurrentResumes[0]!;
        expect(resumed.body).toEqual({
          batch_id: batchId,
          status: 'QUEUED',
          template_version: 2,
          correlation_id: originalCorrelation,
        });
        const replay = await request(server)
          .post(resumePath)
          .set('Authorization', `Bearer ${token}`)
          .set('X-Correlation-Id', retryHttpCorrelation)
          .send({ motivo: 'Recuperar familia Catalog' })
          .expect(202);
        expect(replay.body).toEqual(resumed.body);
        const conflict = await request(server)
          .post(resumePath)
          .set('Authorization', `Bearer ${token}`)
          .set('X-Correlation-Id', retryHttpCorrelation)
          .send({ motivo: 'Motivo distinto' });
        expect(conflict.status).toBe(409);
        const [retryOutbox] = await bulkDatabase
          .select()
          .from(bulkOutbox)
          .where(
            and(
              eq(bulkOutbox.schemaVersion, 4),
              eq(bulkOutbox.operationId, original.operation_id),
            ),
          );
        expect(retryOutbox).toMatchObject({
          correlationId: originalCorrelation,
          operationId: original.operation_id,
          causationId: original.message_id,
        });
        expect(retryOutbox?.messageId).not.toBe(original.message_id);
        const retryCommand = retryOutbox?.payload as unknown as CatalogEnvelope;
        expect(retryCommand.correlation_id).toBe(originalCorrelation);

        const retryIdentity = new CatalogBulkIdentity(
          undefined,
          new CatalogTokenVerifier(undefined),
        );
        vi.spyOn(retryIdentity, 'authorizationForBulkRetry').mockResolvedValue(
          'Bearer isolated-catalog-service-identity',
        );
        const retryCatalog = new CatalogBulkService(
          catalogDatabase,
          mutations,
          retryIdentity,
          contentClient as never,
        );
        const concurrentCommandDeliveries = await Promise.all([
          retryCatalog.consume(retryCommand),
          retryCatalog.consume(retryCommand),
        ]);
        expect(concurrentCommandDeliveries.sort()).toEqual([
          'APPLIED',
          'DUPLICATE',
        ]);
        expect(contentIdentity.authorization).toHaveBeenCalledTimes(2);
        expect(storageFixture.get).toHaveBeenCalledTimes(2);
        const [retryResultRow] = await catalogDatabase.read((db) =>
          db
            .select()
            .from(catalogOutbox)
            .where(eq(catalogOutbox.causation_id, retryCommand.message_id))
            .limit(1),
        );
        if (!retryResultRow)
          throw new Error('Catalog retry result was not persisted');
        const retryResult: CatalogEnvelope = {
          message_id: retryResultRow.message_id,
          schema_version: retryResultRow.schema_version,
          occurred_at: retryResultRow.occurred_at.toISOString(),
          correlation_id: retryResultRow.correlation_id,
          causation_id: retryResultRow.causation_id,
          operation_id: retryResultRow.operation_id,
          producer: 'catalog-svc',
          kind: retryResultRow.kind as CatalogEnvelope['kind'],
          name: retryResultRow.event_name,
          data: retryResultRow.payload,
        };
        expect(retryResult).toMatchObject({
          schema_version: 2,
          correlation_id: originalCorrelation,
          causation_id: retryCommand.message_id,
          data: {
            command_attempt_id: Reflect.get(retryCommand.data, 'retry')
              ?.command_attempt_id,
            results: [
              {
                status: 'COMPLETED',
                effect_state: 'APPLIED',
                retriable: false,
                attempt_number: 2,
              },
            ],
          },
        });
        const recordRetryResult = () =>
          bulkRepository.recordCatalogBulkResult({
            messageId: retryResult.message_id,
            operationId: String(retryResult.operation_id),
            causationId: String(retryResult.causation_id),
            eventName: String(
              retryResult.name,
            ) as 'catalog.bulk.upsert.completed',
            correlationId: retryResult.correlation_id,
            payload: retryResult,
          });
        await Promise.all([recordRetryResult(), recordRetryResult()]);
        const replayAfterResult = await resume();
        expect(replayAfterResult.status).toBe(202);
        expect(replayAfterResult.body).toEqual(resumed.body);
        const firstProductCount = await catalogDatabase.read((db) =>
          db
            .select()
            .from(products)
            .where(
              eq(
                products.sku_base,
                String(
                  (decodedDocument as { rows: Array<{ sku_base: string }> })
                    .rows[0]!.sku_base,
                ),
              ),
            ),
        );
        expect(firstProductCount).toHaveLength(1);
        expect(firstProductCount[0]?.id).toBe(seed.product_id);
        expect(firstProductCount[0]?.descripcion).toBe('After retry');
        const persistedAttempts = await catalogDatabase.read((db) =>
          db
            .select()
            .from(bulkRetryAttemptReceipts)
            .where(
              eq(
                bulkRetryAttemptReceipts.batchOperationId,
                String(original.operation_id),
              ),
            )
            .orderBy(bulkRetryAttemptReceipts.attemptNumber),
        );
        expect(persistedAttempts).toMatchObject([
          {
            attemptNumber: 1,
            status: 'REJECTED',
            effectState: 'NONE',
            retriable: true,
          },
          {
            attemptNumber: 2,
            status: 'COMPLETED',
            effectState: 'APPLIED',
            retriable: false,
          },
        ]);
        await expect(
          new CatalogBulkService(
            catalogDatabase,
            mutations,
            retryIdentity,
            contentClient as never,
          ).consume(retryCommand),
        ).resolves.toBe('DUPLICATE');
        await bulkRepository.recordCatalogBulkResult({
          messageId: retryResult.message_id,
          operationId: String(retryResult.operation_id),
          causationId: String(retryResult.causation_id),
          eventName: String(
            retryResult.name,
          ) as 'catalog.bulk.upsert.completed',
          correlationId: retryResult.correlation_id,
          payload: retryResult,
        });
        const completed = await request(server)
          .get(statePath)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(completed.body).toMatchObject({
          status: 'COMPLETED',
          completed_rows: 1,
          failed_rows: 0,
        });
        expect(completed.body.rows[0].steps).toMatchObject([
          { dominio: 'CATALOGO', status: 'COMPLETED' },
        ]);
        const [batch] = await bulkDatabase
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, batchId));
        expect(batch).toMatchObject({
          status: 'COMPLETED',
          completedRows: 1,
          failedRows: 0,
        });
        const currentBatchRows = await bulkDatabase
          .select({ id: batchRows.id })
          .from(batchRows)
          .where(eq(batchRows.batchJobId, batch.id));
        expect(
          await bulkDatabase
            .select()
            .from(domainAttempts)
            .where(
              inArray(
                domainAttempts.batchRowId,
                currentBatchRows.map((row) => row.id),
              ),
            ),
        ).toHaveLength(2);
        expect(
          await bulkDatabase
            .select()
            .from(bulkOutbox)
            .where(
              and(
                eq(bulkOutbox.schemaVersion, 4),
                eq(bulkOutbox.operationId, original.operation_id),
              ),
            ),
        ).toHaveLength(1);
      } finally {
        await http.close();
      }
    }, 90_000);
  },
);
