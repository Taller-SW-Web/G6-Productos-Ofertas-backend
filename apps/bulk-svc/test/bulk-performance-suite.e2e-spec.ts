import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BulkSvcModule } from '../src/bulk-svc.module.js';
import { BulkProblemFilter } from '../src/http/bulk-problem.filter.js';
import { BulkReadinessService } from '../src/health/bulk-readiness.service.js';
import { BULK_EXPORT_SOURCE, type BulkExportSource } from '../src/export/bulk-export-source.js';
import { BulkExportService } from '../src/bulk-export.service.js';
import { BulkStorageService } from '../src/storage/bulk-storage.service.js';
import { BULK_TEMPLATE_HEADERS } from '../src/domain/bulk-template-v2.js';
import { createValidBulkXlsx } from './support/bulk-template-fixtures.js';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { bulkSchema, batchRows, outbox as bulkOutbox } from '../src/persistence/bulk.schema.js';
import { BulkPersistenceRepository } from '../src/persistence/bulk.repository.js';

const bulkDatabaseUrl = process.env.BULK_RETRY_INTEGRATION_BULK_DATABASE_URL;
const storageUrl = process.env.BULK_RETRY_INTEGRATION_STORAGE_URL;
const storageServiceKey = process.env.BULK_RETRY_INTEGRATION_STORAGE_SERVICE_ROLE_KEY;
const enabled = Boolean(bulkDatabaseUrl && storageUrl && storageServiceKey);

const jwtKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ownerSub = '33333333-3333-4333-8333-333333333333';

function signToken() {
  const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const h = enc({ alg: 'RS256', typ: 'JWT' });
  const c = enc({
    iss: 'bulk-perf-suite',
    sub: ownerSub,
    tipo: 'acceso',
    aud: 'api-productos',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 1800,
    jti: randomUUID(),
    roles: ['GESTOR_COMERCIAL'],
  });
  const s = createSign('RSA-SHA256');
  s.update(`${h}.${c}`);
  return `${h}.${c}.${s.sign(jwtKeys.privateKey, 'base64url')}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[idx]!.toFixed(2));
}

async function runConcurrentBenchmark(
  name: string,
  concurrency: number,
  total: number,
  fn: (index: number) => Promise<number>,
) {
  const latencies: number[] = [];
  let failures = 0;
  let next = 0;
  const memBefore = process.memoryUsage();
  const started = performance.now();

  const worker = async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= total) return;
      const t0 = performance.now();
      try {
        const status = await fn(i);
        if (status >= 500 || status === 0) failures += 1;
      } catch {
        failures += 1;
      }
      latencies.push(performance.now() - t0);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = performance.now() - started;
  const memAfter = process.memoryUsage();
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    name,
    concurrency,
    total,
    failures,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    throughputRps: Number(((total / elapsedMs) * 1000).toFixed(2)),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    rssDeltaMb: Number(((memAfter.rss - memBefore.rss) / (1024 * 1024)).toFixed(2)),
    heapDeltaMb: Number(((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2)),
  };
}

describe.skipIf(!enabled)('P1 Bulk Performance Suite (PostgreSQL 17 + Storage local)', () => {
  const results: Array<Record<string, unknown>> = [];
  const restoreFlags: Array<[string, string | undefined]> = [];

  const setFlag = (name: string, value: string) => {
    restoreFlags.push([name, process.env[name]]);
    process.env[name] = value;
  };

  beforeAll(() => {
    setFlag('NODE_ENV', 'test');
    setFlag('DATABASE_URL', bulkDatabaseUrl!);
    setFlag('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
    setFlag('G7_JWT_ISSUER', 'bulk-perf-suite');
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
  });

  afterAll(async () => {
    for (const [name, value] of restoreFlags) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const outPath = process.env.BULK_PERF_EVIDENCE_PATH ?? '.ci/evidence/bulk-performance-suite.json';
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
  });

  it('benchmarks CSV/XLSX admission (c=1/8/32), large file, GET batch/correlation, retry, replay, and export', async () => {
    const token = signToken();
    const exportSource: BulkExportSource = {
      catalog: async () => ({
        items: Array.from({ length: 50 }, (_, idx) => ({
          productId: randomUUID(),
          skuBase: `PERF-EXP-${idx}`,
          variantSku: null,
          name: `Producto Perf ${idx}`,
          description: 'Benchmark export',
          categoryId: 'cat-1',
          brandId: 'brand-1',
          productTypeId: 'type-1',
        })),
        nextCursor: null,
        observedAt: new Date().toISOString(),
        version: '1',
      }),
      pricing: async () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString(), version: '1' }),
      inventory: async () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString(), version: '1' }),
    };

    const mod = await Test.createTestingModule({ imports: [BulkSvcModule] })
      .overrideProvider(BULK_EXPORT_SOURCE)
      .useValue(exportSource)
      .overrideProvider(BulkExportService)
      .useFactory({
        factory: (repo: BulkPersistenceRepository, storage: BulkStorageService) =>
          new BulkExportService(repo, storage, exportSource),
        inject: [BulkPersistenceRepository, BulkStorageService],
      })
      .overrideProvider(BulkReadinessService)
      .useValue({ probe: async () => ({ ready: true }) })
      .compile();
    const app = mod.createNestApplication({ logger: false });
    app.useGlobalFilters(new BulkProblemFilter());
    await app.init();
    const server = app.getHttpServer();

    const csvRow = (sku: string) =>
      `"ALTA","","","${sku}","","Perf Product","Desc","cat","brand","type","false","10.50","[]","","","0"`;
    const smallCsv = Buffer.from(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n${csvRow('PERF-1')}\r\n`, 'utf8');
    const largeRows = Array.from({ length: 500 }, (_, i) => csvRow(`PERF-LARGE-${i}`)).join('\r\n');
    const largeCsv = Buffer.from(`${BULK_TEMPLATE_HEADERS.join(',')}\r\n${largeRows}\r\n`, 'utf8');
    const xlsxBuf = createValidBulkXlsx('PERF-XLSX-1');

    // Warmup
    const warmupRes = await request(server)
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', randomUUID())
      .field('template_version', '2')
      .attach('archivo', smallCsv, { filename: 'warmup.csv', contentType: 'text/csv' })
      .expect(202);
    const seedBatchId = String(warmupRes.body.batch_id);
    const seedCorrelationId = String(warmupRes.body.correlation_id);

    for (const c of [1, 8, 32]) {
      const total = c === 1 ? 20 : c === 8 ? 40 : 64;
      const r = await runConcurrentBenchmark(`admission_csv_c${c}`, c, total, async () => {
        const res = await request(server)
          .post('/api/v1/carga-masiva/productos/importaciones')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Correlation-Id', randomUUID())
          .field('template_version', '2')
          .attach('archivo', smallCsv, { filename: 'perf.csv', contentType: 'text/csv' });
        return res.status;
      });
      expect(r.failures).toBe(0);
      results.push(r);
    }

    for (const c of [1, 8]) {
      const r = await runConcurrentBenchmark(`admission_xlsx_c${c}`, c, c * 4, async () => {
        const res = await request(server)
          .post('/api/v1/carga-masiva/productos/importaciones')
          .set('Authorization', `Bearer ${token}`)
          .set('X-Correlation-Id', randomUUID())
          .field('template_version', '2')
          .attach('archivo', xlsxBuf, {
            filename: 'perf.xlsx',
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          });
        return res.status;
      });
      expect(r.failures).toBe(0);
      results.push(r);
    }

    const largeR = await runConcurrentBenchmark('admission_large_csv_500rows_c1', 1, 5, async () => {
      const res = await request(server)
        .post('/api/v1/carga-masiva/productos/importaciones')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Correlation-Id', randomUUID())
        .field('template_version', '2')
        .attach('archivo', largeCsv, { filename: 'large.csv', contentType: 'text/csv' });
      return res.status;
    });
    expect(largeR.failures).toBe(0);
    results.push(largeR);

    const getBatchR = await runConcurrentBenchmark('get_batch_c8', 8, 40, async () => {
      const res = await request(server)
        .get(`/api/v1/carga-masiva/productos/importaciones/${seedBatchId}`)
        .set('Authorization', `Bearer ${token}`);
      return res.status;
    });
    expect(getBatchR.failures).toBe(0);
    results.push(getBatchR);

    const getCorrR = await runConcurrentBenchmark('get_correlation_c8', 8, 40, async () => {
      const res = await request(server)
        .get(`/api/v1/carga-masiva/productos/importaciones/por-correlacion/${seedCorrelationId}`)
        .set('Authorization', `Bearer ${token}`);
      return res.status;
    });
    expect(getCorrR.failures).toBe(0);
    results.push(getCorrR);

    const replayR = await runConcurrentBenchmark('replay_idempotent_c8', 8, 24, async () => {
      const res = await request(server)
        .post('/api/v1/carga-masiva/productos/importaciones')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Correlation-Id', seedCorrelationId)
        .field('template_version', '2')
        .attach('archivo', smallCsv, { filename: 'warmup.csv', contentType: 'text/csv' });
      return res.status;
    });
    expect(replayR.failures).toBe(0);
    results.push(replayR);

    // Seed a retriable failure on a batch to benchmark POST .../reanudar
    const pool = new Pool({ connectionString: bulkDatabaseUrl, max: 2 });
    const bulkDb = drizzle(pool, { schema: bulkSchema, logger: false });
    const bulkRepo = new BulkPersistenceRepository(bulkDb);
    const retryAdmit = await request(server)
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', randomUUID())
      .field('template_version', '2')
      .attach('archivo', smallCsv, { filename: 'retry-perf.csv', contentType: 'text/csv' })
      .expect(202);
    const retryBatchId = String(retryAdmit.body.batch_id);
    const batchState = await bulkRepo.findBatchByBatchId(retryBatchId);
    const [firstRow] = await bulkDb
      .select()
      .from(batchRows)
      .where(eq(batchRows.batchJobId, batchState!.id))
      .limit(1);
    const rowId = firstRow!.rowId;
    const msgId = randomUUID();
    const corrId = String(retryAdmit.body.correlation_id);
    const [admittedOutbox] = await bulkDb
      .select()
      .from(bulkOutbox)
      .where(eq(bulkOutbox.correlationId, corrId))
      .limit(1);
    const opId = admittedOutbox!.operationId;
    const causId = admittedOutbox!.messageId;
    const contentId = (admittedOutbox!.payload as { data: { content_ref: { content_id: string } } }).data.content_ref.content_id;
    const contentDoc = await bulkRepo.findContentDocument(contentId);
    const contentBytes = await mod.get(BulkStorageService).get(contentDoc!.contentRef);
    const parsedDoc = JSON.parse(contentBytes.toString('utf8')) as {
      rows: Array<{ row_operation_id: string; row_number: number; sku_base: string }>;
    };
    const firstDocRow = parsedDoc.rows[0]!;
    await bulkRepo.recordCatalogBulkResult({
      messageId: msgId,
      operationId: opId,
      causationId: causId,
      eventName: 'catalog.bulk.upsert.completed',
      correlationId: corrId,
      payload: {
        message_id: msgId,
        schema_version: 2,
        occurred_at: new Date().toISOString(),
        correlation_id: corrId,
        causation_id: causId,
        operation_id: opId,
        producer: 'catalog-svc',
        kind: 'result',
        name: 'catalog.bulk.upsert.completed',
        data: {
          batch_id: retryBatchId,
          batch_operation_id: opId,
          operation_id: opId,
          command_attempt_id: null,
          results: [
            {
              row_id: rowId,
              row_operation_id: firstDocRow.row_operation_id,
              row_number: firstDocRow.row_number,
              sku_base: firstDocRow.sku_base,
              attempt_id: randomUUID(),
              attempt_number: 1,
              status: 'REJECTED',
              effect_state: 'NONE',
              retriable: true,
              code: 'CATALOG_AUTH_TEMPORARY_UNAVAILABLE',
            },
          ],
        },
      },
    });
    const retryCorr = randomUUID();
    const retryR = await runConcurrentBenchmark('retry_reanudar_replay_c8', 8, 16, async () => {
      const res = await request(server)
        .post(`/api/v1/carga-masiva/productos/importaciones/${retryBatchId}/reanudar`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Correlation-Id', retryCorr)
        .send({ motivo: 'Perf retry' });
      return res.status;
    });
    expect(retryR.failures).toBe(0);
    results.push(retryR);
    await pool.end();

    const exportR = await runConcurrentBenchmark('export_csv_e2e_c1', 1, 3, async () => {
      const createRes = await request(server)
        .post('/api/v1/carga-masiva/productos/exportaciones')
        .set('Authorization', `Bearer ${token}`)
        .send({ formato: 'CSV' });
      if (createRes.status !== 202) return createRes.status;
      const expId = String(createRes.body.export_id);
      for (let i = 0; i < 30; i++) {
        const poll = await request(server)
          .get(`/api/v1/carga-masiva/productos/exportaciones/${expId}`)
          .set('Authorization', `Bearer ${token}`);
        if (poll.body.status === 'COMPLETED') {
          const dl = await request(server)
            .get(`/api/v1/carga-masiva/productos/exportaciones/${expId}/archivo`)
            .set('Authorization', `Bearer ${token}`);
          return dl.status;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return 504;
    });
    expect(exportR.failures).toBe(0);
    results.push(exportR);

    console.info('[bulk-performance-suite]', JSON.stringify(results));
    await app.close();
  }, 180_000);
});
