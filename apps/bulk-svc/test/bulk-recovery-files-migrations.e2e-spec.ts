import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BulkSvcModule } from '../src/bulk-svc.module.js';
import { BulkProblemFilter } from '../src/http/bulk-problem.filter.js';
import { BulkReadinessService } from '../src/health/bulk-readiness.service.js';
import { BulkStorageService } from '../src/storage/bulk-storage.service.js';
import { BulkDomainError } from '../src/domain/bulk.domain-error.js';
import { BULK_EXPORT_SOURCE, type BulkExportSource } from '../src/export/bulk-export-source.js';
import { bulkSchema, outbox as bulkOutbox } from '../src/persistence/bulk.schema.js';
import { BulkPersistenceRepository } from '../src/persistence/bulk.repository.js';
import { BULK_TEMPLATE_HEADERS } from '../src/domain/bulk-template-v2.js';
import { Database, type PostgresSettings } from '../../catalog-svc/src/database.js';
import { CatalogTransactionManager } from '../../catalog-svc/src/catalog-transaction.js';
import { CatalogMutationService } from '../../catalog-svc/src/catalog-mutation.service.js';
import { PostgresCatalogWriteRepository } from '../../catalog-svc/src/postgres-catalog-write.repository.js';
import { CatalogBulkService, CatalogBulkIdentity } from '../../catalog-svc/src/catalog-bulk.service.js';
import { CatalogTokenVerifier } from '../../catalog-svc/src/catalog-auth.js';
import { CatalogBulkContentClient, CatalogBulkContentIdentity } from '../../catalog-svc/src/catalog-bulk-content.js';
import { products } from '../../catalog-svc/src/catalog.schema.js';
import type { CatalogEnvelope } from '../../catalog-svc/src/catalog-messages.js';

const bulkDatabaseUrl = process.env.BULK_RETRY_INTEGRATION_BULK_DATABASE_URL;
const catalogDatabaseUrl = process.env.BULK_RETRY_INTEGRATION_CATALOG_DATABASE_URL;
const storageUrl = process.env.BULK_RETRY_INTEGRATION_STORAGE_URL;
const storageServiceKey = process.env.BULK_RETRY_INTEGRATION_STORAGE_SERVICE_ROLE_KEY;
const adminDatabaseUrl = process.env.BULK_MIGRATION_ADMIN_DATABASE_URL;

const integration =
  bulkDatabaseUrl && catalogDatabaseUrl && storageUrl && storageServiceKey
    ? describe
    : describe.skip;

const jwtKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ownerA = '11111111-1111-4111-8111-111111111111';
const ownerB = '22222222-2222-4222-8222-222222222222';

function signUser(sub: string, roles = ['GESTOR_COMERCIAL']) {
  const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const h = encode({ alg: 'RS256', typ: 'JWT' });
  const c = encode({
    iss: 'bulk-recovery-suite',
    sub,
    tipo: 'acceso',
    aud: 'api-productos',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    jti: randomUUID(),
    roles,
  });
  const s = createSign('RSA-SHA256');
  s.update(`${h}.${c}`);
  return `${h}.${c}.${s.sign(jwtKeys.privateKey, 'base64url')}`;
}

integration('P1 Bulk Recovery, Files/Exports & Migrations (PostgreSQL 17 + Storage local)', () => {
  let pool: Pool;
  let bulkDb: ReturnType<typeof drizzle<typeof bulkSchema>>;
  let bulkRepo: BulkPersistenceRepository;
  let catalogDb: Database;
  const restoreFlags: Array<[string, string | undefined]> = [];

  const setFlag = (name: string, value: string) => {
    restoreFlags.push([name, process.env[name]]);
    process.env[name] = value;
  };

  beforeAll(async () => {
    setFlag('NODE_ENV', 'test');
    setFlag('DATABASE_URL', bulkDatabaseUrl!);
    setFlag('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
    setFlag('G7_JWT_ISSUER', 'bulk-recovery-suite');
    setFlag('G7_JWT_PUBLIC_KEY', jwtKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    setFlag('BULK_STORAGE_BUCKET', 'bulk-retry-integration');
    setFlag('SUPABASE_URL', storageUrl!);
    setFlag('SUPABASE_SERVICE_ROLE_KEY', storageServiceKey!);
    setFlag('BULK_CATALOG_V3_ENABLED', 'true');
    setFlag('BULK_CATALOG_V3_AUTHORIZATION_VERIFIED', 'true');
    setFlag('BULK_RETRY_CATALOG_V1_ENABLED', 'true');
    setFlag('BULK_RETRY_ELIGIBILITY_ENABLED', 'true');
    setFlag('BULK_CORRELATION_RECONCILIATION_ENABLED', 'true');
    setFlag('BULK_AMQP_ENABLED', 'false');

    pool = new Pool({ connectionString: bulkDatabaseUrl, max: 6 });
    bulkDb = drizzle(pool, { schema: bulkSchema, logger: false });
    bulkRepo = new BulkPersistenceRepository(bulkDb);

    const catalogUrl = new URL(catalogDatabaseUrl!);
    const catalogSettings: PostgresSettings = {
      pool: {
        host: catalogUrl.hostname,
        port: Number(catalogUrl.port || 5432),
        database: catalogUrl.pathname.slice(1),
        user: decodeURIComponent(catalogUrl.username),
        password: decodeURIComponent(catalogUrl.password),
        ssl: false,
        max: 4,
      },
      expectedRole: decodeURIComponent(catalogUrl.username),
      database: catalogUrl.pathname.slice(1),
      user: decodeURIComponent(catalogUrl.username),
      password: decodeURIComponent(catalogUrl.password),
      mode: 'direct',
    };
    catalogDb = new Database(catalogSettings);
    await catalogDb.verifyIdentity();
  });

  afterAll(async () => {
    await catalogDb?.onModuleDestroy();
    await pool?.end();
    for (const [name, value] of restoreFlags) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('recovers pending Outbox across real Bulk instance restart, deduplicates Catalog after restart, and handles Storage outage + malformed claim-check', async () => {
    const token = signUser(ownerA);
    const mod1 = await Test.createTestingModule({ imports: [BulkSvcModule] })
      .overrideProvider(BulkReadinessService)
      .useValue({ probe: async () => ({ ready: true }) })
      .compile();
    const app1 = mod1.createNestApplication({ logger: false });
    app1.useGlobalFilters(new BulkProblemFilter());
    await app1.init();

    const correlationId = randomUUID();
    const sku = `BULK-RESTART-${randomUUID().slice(0, 8)}`;
    const csv = Buffer.from(
      `${BULK_TEMPLATE_HEADERS.join(',')}\r\n"ALTA","","","${sku}","","Producto Restart","Desc","category-fixture","brand-fixture","type-fixture","false","10.50","[]","","","0"\r\n`,
      'utf8',
    );
    const admitRes = await request(app1.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', correlationId)
      .field('template_version', '2')
      .attach('archivo', csv, { filename: 'restart.csv', contentType: 'text/csv' })
      .expect(202);
    const batchId = String(admitRes.body.batch_id);

    // Close first Bulk instance while outbox is still pending
    await app1.close();

    // Recreate a fresh Bulk instance
    const mod2 = await Test.createTestingModule({ imports: [BulkSvcModule] })
      .overrideProvider(BulkReadinessService)
      .useValue({ probe: async () => ({ ready: true }) })
      .compile();
    const app2 = mod2.createNestApplication({ logger: false });
    app2.useGlobalFilters(new BulkProblemFilter());
    await app2.init();
    try {
      const [outboxRow] = await bulkDb
        .select()
        .from(bulkOutbox)
        .where(eq(bulkOutbox.correlationId, correlationId));
      expect(outboxRow).toBeDefined();
      expect(outboxRow?.publishedAt).toBeNull();

      // Test Storage outage -> 503, then recovery -> 200
      const storage = mod2.get(BulkStorageService);
      const putSpy = vi
        .spyOn(storage, 'put')
        .mockRejectedValueOnce(
          new BulkDomainError('STORAGE_UNAVAILABLE', 'Storage 503 simulated'),
        );
      await request(app2.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Correlation-Id', randomUUID())
        .field('template_version', '2')
        .attach('archivo', csv, { filename: 'outage.csv', contentType: 'text/csv' })
        .expect(503);
      putSpy.mockRestore();

      // Test malformed claim-check document -> Catalog rejects without commercial mutation
      const productsBefore = await catalogDb.read((db) => db.select().from(products));
      const tx = new CatalogTransactionManager(catalogDb);
      const mutations = new CatalogMutationService(
        tx,
        new PostgresCatalogWriteRepository(),
        { masters: async () => ({ schemaVersion: 1 }), attributes: async (_t: string, v: unknown[]) => v } as never,
        { resolve: async (_i, id) => ({ slug: `rec-${id}`, moneda: 'PEN' }) },
      );
      const idMock = new CatalogBulkIdentity(undefined, new CatalogTokenVerifier(undefined));
      vi.spyOn(idMock, 'authorization').mockResolvedValue('Bearer isolated-master-fixture');
      const badClient = {
        getDocument: async () => { throw new Error('Malformed claim-check JSON'); },
      } as unknown as CatalogBulkContentClient;
      const badConsumer = new CatalogBulkService(catalogDb, mutations, idMock, badClient);
      const envelope = outboxRow!.payload as unknown as CatalogEnvelope;
      await expect(badConsumer.consume(envelope)).rejects.toThrow();
      expect(await catalogDb.read((db) => db.select().from(products))).toEqual(productsBefore);

      // Contradictory batch/family identity -> rejected without mutation
      await expect(
        bulkRepo.recordCatalogBulkResult({
          messageId: randomUUID(),
          operationId: randomUUID(),
          causationId: randomUUID(),
          eventName: 'catalog.bulk.upsert.completed',
          correlationId,
          payload: { unknown: true },
        }),
      ).rejects.toThrow(/inconsistent|INVALID_INPUT/i);

      // Simulate Catalog restart after durable commit -> redelivery is deduplicated
      const contentIdentity = new CatalogBulkContentIdentity(undefined, new CatalogTokenVerifier(undefined));
      vi.spyOn(contentIdentity, 'authorization').mockResolvedValue('Bearer invalid-unused');
      const localContentClient = {
        getDocument: async (ref: { content_id: string }) => {
          const res = await bulkRepo.findContentDocument(ref.content_id);
          const bytes = await storage.get(res!.contentRef);
          return JSON.parse(bytes.toString('utf8'));
        },
      } as unknown as CatalogBulkContentClient;
      const consumer1 = new CatalogBulkService(catalogDb, mutations, idMock, localContentClient);
      await expect(consumer1.consume(envelope)).resolves.toBe('APPLIED');
      const productsAfterFirst = await catalogDb.read((db) => db.select().from(products));
      expect(productsAfterFirst.length).toBe(productsBefore.length + 1);

      // Recreate CatalogBulkService (simulating Catalog restart) and redeliver same envelope
      const consumer2 = new CatalogBulkService(catalogDb, mutations, idMock, localContentClient);
      await expect(consumer2.consume(envelope)).resolves.toBe('DUPLICATE');
      expect(await catalogDb.read((db) => db.select().from(products))).toEqual(productsAfterFirst);
    } finally {
      await app2.close();
    }
  }, 60_000);

  it('validates CSV/XLSX templates, roundtrip, formula injection protection, exports, report download, and owner isolation', async () => {
    const tokenA = signUser(ownerA);
    const tokenB = signUser(ownerB);
    const exportSource: BulkExportSource = {
      catalog: async () => {
        console.info('[export-test] exportSource.catalog invoked');
        return {
          items: [
            {
              productId: randomUUID(),
              skuBase: 'EXP-FORMULA-1',
              variantSku: null,
              name: '=CMD("calc")',
              description: '+SUM(1,2)',
              categoryId: 'cat-1',
              brandId: 'brand-1',
              productTypeId: 'type-1',
            },
          ],
          nextCursor: null,
          observedAt: new Date().toISOString(),
          version: '1',
        };
      },
      pricing: async () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString(), version: '1' }),
      inventory: async () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString(), version: '1' }),
    };

    const mod = await Test.createTestingModule({ imports: [BulkSvcModule] })
      .overrideProvider(BULK_EXPORT_SOURCE)
      .useValue(exportSource)
      .overrideProvider(BulkReadinessService)
      .useValue({ probe: async () => ({ ready: true }) })
      .compile();
    const app = mod.createNestApplication();
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();
    const server = app.getHttpServer();

    // Templates CSV & XLSX + unsupported format
    const csvTpl = await request(server)
      .get('/api/v1/carga-masiva/productos/plantilla?formato=CSV')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(csvTpl.headers['content-type']).toContain('text/csv');
    expect(csvTpl.headers['content-disposition']).toMatch(/filename=/i);
    expect(csvTpl.text).toContain('sku');

    const xlsxTpl = await request(server)
      .get('/api/v1/carga-masiva/productos/plantilla?formato=XLSX')
      .set('Authorization', `Bearer ${tokenA}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(xlsxTpl.headers['content-type']).toContain('spreadsheetml.sheet');
    expect((xlsxTpl.body as Buffer).subarray(0, 2).toString('hex')).toBe('504b');

    await request(server)
      .get('/api/v1/carga-masiva/productos/plantilla?formato=PDF')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);

    // Roundtrip: use downloaded CSV template + 1 valid row -> import 202
    const roundtripRow = `"ALTA","","","RT-${randomUUID().slice(0, 8)}","","Roundtrip","Desc","cat","brand","type","false","15.00","[]","","","0"`;
    const roundtripCsv = Buffer.from(`${csvTpl.text.trimEnd()}\r\n${roundtripRow}\r\n`, 'utf8');
    await request(server)
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Correlation-Id', randomUUID())
      .field('template_version', '2')
      .attach('archivo', roundtripCsv, { filename: 'roundtrip.csv', contentType: 'text/csv' })
      .expect(202);

    // Export CSV with formula injection protection + XLSX + owner isolation + 404
    const storage2 = mod.get(BulkStorageService);
    const origPut = storage2.put.bind(storage2);
    vi.spyOn(storage2, 'put').mockImplementation(async (...args) => {
      try {
        return await origPut(...args);
      } catch (err) {
        console.error('[export-test storage.put error]', err);
        throw err;
      }
    });
    const expCsv = await request(server)
      .post('/api/v1/carga-masiva/productos/exportaciones')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ formato: 'CSV' })
      .expect(202);
    const exportId = String(expCsv.body.export_id);

    let status = 'QUEUED';
    for (let i = 0; i < 30; i++) {
      const poll = await request(server)
        .get(`/api/v1/carga-masiva/productos/exportaciones/${exportId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      status = poll.body.status;
      if (status === 'COMPLETED' || status === 'FAILED_GENERAL') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toBe('COMPLETED');

    const dlCsv = await request(server)
      .get(`/api/v1/carga-masiva/productos/exportaciones/${exportId}/archivo`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(dlCsv.headers['content-type']).toContain('text/csv');
    expect(dlCsv.text).toContain("'=CMD");
    expect(dlCsv.text).toContain("'+SUM");

    // Other owner isolated with 404
    await request(server)
      .get(`/api/v1/carga-masiva/productos/exportaciones/${exportId}/archivo`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);

    // Missing object 404
    await request(server)
      .get(`/api/v1/carga-masiva/productos/exportaciones/${randomUUID()}/archivo`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    await app.close();
  }, 60_000);

  it('verifies Bulk 0001-0008 upgrade with pre-existing data and transactional DDL rollback on isolated schema', async () => {
    if (!adminDatabaseUrl) return;
    const adminPool = new Pool({ connectionString: adminDatabaseUrl, max: 2 });
    const testSchema = `bulk_mig_${randomUUID().slice(0, 8)}`;
    try {
      await adminPool.query(`CREATE SCHEMA ${testSchema};`);
      const apply = async (file: string) => {
        const sql = readFileSync(resolve(file), 'utf8').replaceAll('bulk.', `${testSchema}.`);
        await adminPool.query(`SET search_path TO ${testSchema}, public;\n${sql}`);
      };
      await apply('apps/bulk-svc/test/fixtures/0001_create_bulk_persistence.sql');
      await apply('apps/bulk-svc/migrations/0002_export_source_snapshot.sql');
      await apply('apps/bulk-svc/migrations/0003_export_claim_lease.sql');
      await apply('apps/bulk-svc/migrations/0004_catalog_claim_check_content.sql');
      await apply('apps/bulk-svc/migrations/0005_actor_ownership.sql');
      await apply('apps/bulk-svc/migrations/0006_owner_correlation_identity.sql');

      const mId = randomUUID();
      const bId = randomUUID();
      await adminPool.query(
        `INSERT INTO ${testSchema}.file_manifests (id, role, format, content_ref) VALUES ($1, 'ENTRADA_IMPORTACION', 'CSV', 'fixture://pre-upgrade.csv');`,
        [mId],
      );
      await adminPool.query(
        `INSERT INTO ${testSchema}.batch_jobs (batch_id, owner_sub, input_file_id, template_version, correlation_id) VALUES ($1, $2, $3, 2, $4);`,
        [bId, ownerA, mId, randomUUID()],
      );

      // Upgrade 0007 + 0008 with pre-existing data
      await apply('apps/bulk-svc/migrations/0007_bulk_retry_v1.sql');
      await apply('apps/bulk-svc/migrations/0008_h5_outbox_delivery.sql');

      const preserved = await adminPool.query(`SELECT batch_id FROM ${testSchema}.batch_jobs WHERE batch_id = $1`, [bId]);
      expect(preserved.rows).toHaveLength(1);

      // Simulate failed DDL migration -> rollback preserves existing rows
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE ${testSchema}.batch_jobs ADD COLUMN temp_col TEXT;`);
        await client.query('SELECT * FROM non_existent_table_for_rollback_test;');
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const cols = await adminPool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'batch_jobs' AND column_name = 'temp_col'`,
        [testSchema],
      );
      expect(cols.rows).toHaveLength(0);
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
      await adminPool.end();
    }
  }, 30_000);
});
