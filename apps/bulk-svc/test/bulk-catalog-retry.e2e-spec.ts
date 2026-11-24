import {
  createHash,
  randomUUID,
  createSign,
  generateKeyPairSync,
} from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  contentDocuments,
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
const storageUrl = process.env.BULK_RETRY_INTEGRATION_STORAGE_URL;
const storageServiceKey =
  process.env.BULK_RETRY_INTEGRATION_STORAGE_SERVICE_ROLE_KEY;
const integration =
  bulkDatabaseUrl && catalogDatabaseUrl && storageUrl && storageServiceKey
    ? describe
    : describe.skip;
const ownerSub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const jwtKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
let pool: Pool;
let bulkDatabase: ReturnType<typeof drizzle<typeof bulkSchema>>;
let bulkRepository: BulkPersistenceRepository;
let catalogDatabase: Database;
let restoreFlags: Array<[string, string | undefined]> = [];
const executedScenarios = new Set<string>();

function recordScenario(name: string) {
  executedScenarios.add(name);
}

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

function signedServiceToken(
  clientId = 'catalog-svc',
  scope = 'carga-masiva:contenidos:leer',
) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const claims = encode({
    iss: 'bulk-retry-integration',
    sub: 'catalog-svc',
    client_id: clientId,
    tipo: 'servicio',
    aud: 'api-productos',
    scope,
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
      if (!storageUrl || !storageServiceKey)
        throw new Error(
          'BULK_RETRY_INTEGRATION_STORAGE_URL and BULK_RETRY_INTEGRATION_STORAGE_SERVICE_ROLE_KEY required',
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
      setFlag('SUPABASE_URL', storageUrl);
      setFlag('SUPABASE_SERVICE_ROLE_KEY', storageServiceKey);
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
      const evidencePath = process.env.BULK_H5_SCENARIO_EVIDENCE;
      if (evidencePath) {
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(
          evidencePath,
          `${JSON.stringify({ scenarios: [...executedScenarios].sort() }, null, 2)}\n`,
        );
      }
    });

    it('admits, rejects without commercial effects, retries through V4, and closes without duplicate effects', async () => {
      const originalCorrelation = randomUUID();
      let retryHttpCorrelation = randomUUID();
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
      const storage = new BulkStorageService();
      const storageGet = vi.spyOn(storage, 'get');
      const storagePut = vi.spyOn(storage, 'put');
      await expect(storage.ready()).resolves.toBe(true);
      const imports = new BulkImportService(bulkRepository, storage);
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
          { provide: BulkStorageService, useValue: storage },
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
        recordScenario('admission.concurrent-identical-intent');
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
        recordScenario('admission.conflicting-bytes-409');
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
        const [storedContentDocument] = await bulkDatabase
          .select()
          .from(contentDocuments)
          .where(eq(contentDocuments.contentId, contentRef.content_id));
        if (!storedContentDocument)
          throw new Error('V3 private content document was not persisted');
        const contentBytes = await storage.get(
          storedContentDocument.contentRef,
        );
        expect(contentBytes).toHaveLength(storedContentDocument.byteLength);
        expect(createHash('sha256').update(contentBytes).digest('hex')).toBe(
          storedContentDocument.sha256,
        );
        expect(storagePut).toHaveBeenCalled();
        const privateContentPath = `/interno/carga-masiva/contenidos/${contentRef.content_id}`;
        await request(server).get(privateContentPath).expect(401);
        await request(server)
          .get(privateContentPath)
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
        await request(server)
          .get(privateContentPath)
          .set('Authorization', `Bearer ${signedServiceToken('otro-servicio')}`)
          .expect(403);
        await request(server)
          .get(privateContentPath)
          .set(
            'Authorization',
            `Bearer ${signedServiceToken('catalog-svc', 'scope-ajeno')}`,
          )
          .expect(403);
        const authorizedContent = await request(server)
          .get(privateContentPath)
          .set('Authorization', `Bearer ${signedServiceToken()}`)
          .expect(200);
        expect(authorizedContent.headers['content-type']).toContain(
          'application/json',
        );
        expect(authorizedContent.headers['content-length']).toBe(
          String(storedContentDocument.byteLength),
        );
        expect(authorizedContent.headers['x-content-sha256']).toBe(
          storedContentDocument.sha256,
        );
        expect(authorizedContent.headers['cache-control']).toBe(
          'private, no-store',
        );
        recordScenario('content.private-service-authz-and-integrity-headers');
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
        expect(storageGet).toHaveBeenCalledTimes(3);
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
        recordScenario('catalog.rejection-has-no-commercial-mutation');
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
        const resume = (correlationId = retryHttpCorrelation) =>
          request(server)
            .post(resumePath)
            .set('Authorization', `Bearer ${token}`)
            .set('X-Correlation-Id', correlationId)
            .send({ motivo: 'Recuperar familia Catalog' });
        const competingCorrelations = [randomUUID(), randomUUID()];
        const competingRetries = await Promise.all(
          competingCorrelations.map((correlationId) => resume(correlationId)),
        );
        expect(
          competingRetries.map((response) => response.status).sort(),
        ).toEqual([202, 409]);
        const acceptedCompetingRetry = competingRetries.find(
          (response) => response.status === 202,
        );
        if (!acceptedCompetingRetry)
          throw new Error('No concurrent retry request was accepted');
        const acceptedIndex = competingRetries.indexOf(acceptedCompetingRetry);
        const retryHttpCorrelation = competingCorrelations[acceptedIndex]!;
        recordScenario('retry.distinct-correlations-single-effective-attempt');
        const concurrentResumes = await Promise.all([resume(), resume()]);
        for (const response of concurrentResumes)
          expect(response.status).toBe(202);
        expect(concurrentResumes[0]?.body).toEqual(concurrentResumes[1]?.body);
        recordScenario('retry.same-correlation-concurrent-replay');
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
        recordScenario('retry.same-correlation-different-reason-409');
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
        recordScenario('retry.v4-concurrent-redelivery-once');
        expect(contentIdentity.authorization).toHaveBeenCalled();
        expect(storageGet).toHaveBeenCalled();
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
        recordScenario('retry.v2-concurrent-result-redelivery-once');
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
        const contradictoryLateResult = structuredClone(initialResult);
        contradictoryLateResult.message_id = randomUUID();
        const contradictoryRows = Reflect.get(
          contradictoryLateResult.data,
          'results',
        ) as Array<Record<string, unknown>>;
        contradictoryRows[0] = {
          ...contradictoryRows[0],
          status: 'COMPLETED',
          effect_state: 'APPLIED',
          retriable: false,
          code: null,
        };
        const lateResultOutcome = await bulkRepository.recordCatalogBulkResult({
          messageId: contradictoryLateResult.message_id,
          operationId: String(contradictoryLateResult.operation_id),
          causationId: String(contradictoryLateResult.causation_id),
          eventName: String(
            contradictoryLateResult.name,
          ) as 'catalog.bulk.upsert.completed',
          correlationId: contradictoryLateResult.correlation_id,
          payload: contradictoryLateResult,
        });
        expect(lateResultOutcome).toMatchObject({
          processed: true,
          result: 'RESULTS_APPLIED',
        });
        const staleAttemptId = String(contradictoryRows[0]?.attempt_id);
        const staleReceipt = await pool.query<{ result: string }>(
          `SELECT result FROM bulk.inbox
           WHERE message_id = $1 AND handler = $2`,
          [
            contradictoryLateResult.message_id,
            `bulk.catalog-result-attempt:${staleAttemptId}`,
          ],
        );
        expect(staleReceipt.rows[0]?.result).toBe('STALE');
        const productCountAfterLateResult = await catalogDatabase.read((db) =>
          db
            .select()
            .from(products)
            .where(eq(products.sku_base, firstProductCount[0]!.sku_base)),
        );
        expect(productCountAfterLateResult).toEqual(firstProductCount);
        const catalogOutboxRows = await catalogDatabase.read((db) =>
          db
            .select({ eventName: catalogOutbox.event_name })
            .from(catalogOutbox),
        );
        expect(
          catalogOutboxRows.every(
            ({ eventName }) => !/pricing|inventory/i.test(eventName),
          ),
        ).toBe(true);
        recordScenario('result.tardy-contradictory-result-is-stale');
        recordScenario('effects.catalog-only-no-pricing-inventory');
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
