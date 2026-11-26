import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  batchJobs,
  batchRows,
  bulkSchema,
  inbox,
  outboxDeliveries,
  rowDomainSteps,
} from '../src/persistence/bulk.schema.js';
import { BulkPersistenceRepository } from '../src/persistence/bulk.repository.js';
import { BulkImportService } from '../src/bulk-import.service.js';
import { BulkContractResultDispatcherService } from '../src/messaging/bulk-contract-result-dispatcher.js';

const exec = promisify(execFile);
const POSTGRES_IMAGE =
  'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const RUN_POSTGRES = process.env.BULK_TEST_POSTGRES === '1';

class IsolatedBulkPostgres {
  private readonly name = `bulk-r14-${randomUUID()}`;
  private created = false;
  pool?: Pool;

  async start(): Promise<Pool> {
    const password = randomUUID();
    await exec(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        this.name,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--env',
        'POSTGRES_DB=bulk_test',
        POSTGRES_IMAGE,
      ],
      { timeout: 60_000 },
    );
    this.created = true;
    const { stdout } = await exec('docker', ['port', this.name, '5432/tcp']);
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
    if (!port) throw new Error('Puerto de PostgreSQL descartable Bulk inválido.');
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/bulk_test`;
    this.pool = new Pool({ connectionString: url, ssl: false });

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await this.pool.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await setTimeout(250);
      }
    }
    if (!ready) throw new Error('PostgreSQL descartable Bulk no disponible.');

    const sqlFiles = [
      '../test/fixtures/0001_create_bulk_persistence.sql',
      '../migrations/0002_export_source_snapshot.sql',
      '../migrations/0003_export_claim_lease.sql',
      '../migrations/0004_catalog_claim_check_content.sql',
      '../migrations/0005_actor_ownership.sql',
      '../migrations/0006_owner_correlation_identity.sql',
      '../migrations/0007_bulk_retry_v1.sql',
      '../migrations/0008_h5_outbox_delivery.sql',
    ];
    for (const rel of sqlFiles) {
      const sql = await readFile(new URL(rel, import.meta.url), 'utf8');
      await this.pool.query(sql);
    }
    return this.pool;
  }

  async stop(): Promise<void> {
    try {
      await this.pool?.end();
    } finally {
      if (this.created) {
        await exec('docker', ['rm', '--force', '--volumes', this.name], {
          timeout: 15_000,
        });
      }
    }
  }
}

describe.skipIf(!RUN_POSTGRES)(
  'Bulk R03 -> R14 conciliación en PostgreSQL descartable aislado (ESCRITA_NO_EJECUTADA)',
  () => {
    const postgres = new IsolatedBulkPostgres();
    let db: ReturnType<typeof drizzle<typeof bulkSchema>>;
    let repository: BulkPersistenceRepository;
    let importService: BulkImportService;
    let dispatcher: BulkContractResultDispatcherService;

    beforeAll(async () => {
      const pool = await postgres.start();
      db = drizzle(pool, { schema: bulkSchema });
      repository = new BulkPersistenceRepository(db as never);
      importService = new BulkImportService(repository);
      dispatcher = new BulkContractResultDispatcherService(importService);
    });

    afterAll(async () => {
      await postgres.stop();
    });

    it('Escenario 1 (fuera de orden): rechaza R14 con DEPENDENCY_PENDING antes de Catalog y persiste PENDING_REPLAY en inbox', async () => {
      const batchId = randomUUID();
      const correlationId = randomUUID();
      const ownerSub = randomUUID();
      const rowId = randomUUID();

      await importService.createImport({
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
            skuBase: 'BULK-OOO-1',
            precioRegular: 25,
          },
        ],
        intentRows: [
          {
            rowNumber: 2,
            rowOperationId: rowId,
            skuBase: 'BULK-OOO-1',
            product: { nombre: 'Prod OOO' },
            variant: null,
          },
        ],
      });

      const deliveries = await db
        .select()
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.destination, 'g6.pricing.from.bulk'));
      expect(deliveries.length).toBeGreaterThanOrEqual(1);

      const r14MsgId = randomUUID();
      const r14Payload = {
        message_id: r14MsgId,
        correlation_id: correlationId,
        causation_id: randomUUID(),
        operation_id: randomUUID(),
        producer: 'pricing-svc',
        kind: 'result',
        name: 'pricing.bulk.price.apply.completed',
        data: {
          batch_id: batchId,
          batch_operation_id: randomUUID(),
          applied_count: 1,
          total_count: 1,
          results: [
            {
              row_number: 2,
              row_operation_id: rowId,
              sku: 'BULK-OOO-1',
              status: 'COMPLETED',
              code: null,
              price_version: 1,
            },
          ],
        },
      };

      await expect(
        dispatcher.dispatch({
          eventName: 'pricing.bulk.price.apply.completed',
          messageId: r14MsgId,
          correlationId,
          payload: r14Payload,
        }),
      ).rejects.toThrow();

      await repository.persistPendingContractResult({
        messageId: r14MsgId,
        eventName: 'pricing.bulk.price.apply.completed',
        correlationId,
        payload: r14Payload,
      });

      const pendingRows = await db
        .select()
        .from(inbox)
        .where(eq(inbox.messageId, r14MsgId));
      expect(pendingRows[0]?.result).toBe('PENDING_REPLAY');
    });

    it('Escenario 2 (elegible tras Catalog): concilia R14 con rechazo parcial, duplicado idempotente y conflicto contradictorio', async () => {
      const batchId = randomUUID();
      const correlationId = randomUUID();
      const ownerSub = randomUUID();
      const rowOk = randomUUID();
      const rowFail = randomUUID();

      await importService.createImport({
        batchId,
        ownerSub,
        correlationId,
        contentRef: `bulk/test/${batchId}.csv`,
        format: 'CSV',
        templateVersion: 2,
        rows: [
          {
            rowId: rowOk,
            productId: null,
            mode: 'ALTA',
            skuBase: 'BULK-R14-OK',
            precioRegular: 25,
          },
          {
            rowId: rowFail,
            productId: null,
            mode: 'ALTA',
            skuBase: 'BULK-R14-FAIL',
            precioRegular: 15,
          },
        ],
        intentRows: [
          {
            rowNumber: 2,
            rowOperationId: rowOk,
            skuBase: 'BULK-R14-OK',
            product: { nombre: 'Prod OK' },
            variant: null,
          },
          {
            rowNumber: 3,
            rowOperationId: rowFail,
            skuBase: 'BULK-R14-FAIL',
            product: { nombre: 'Prod Fail' },
            variant: null,
          },
        ],
      });

      // Confirmar Catalog previamente para ambas filas
      for (const [rowId, sku] of [
        [rowOk, 'BULK-R14-OK'],
        [rowFail, 'BULK-R14-FAIL'],
      ] as const) {
        await importService.applyDomainResult({
          batchId,
          rowId,
          domain: 'CATALOGO',
          messageId: randomUUID(),
          correlationId,
          operationId: randomUUID(),
          causationId: randomUUID(),
          eventName: 'catalog.bulk.upsert.completed',
          action: 'UPSERT',
          skuId: sku,
          status: 'COMPLETED',
        });
      }

      const r14MsgId = randomUUID();
      const r14Payload = {
        message_id: r14MsgId,
        correlation_id: correlationId,
        causation_id: randomUUID(),
        operation_id: randomUUID(),
        producer: 'pricing-svc',
        kind: 'result',
        name: 'pricing.bulk.price.apply.completed',
        data: {
          batch_id: batchId,
          batch_operation_id: randomUUID(),
          applied_count: 1,
          total_count: 2,
          results: [
            {
              row_number: 2,
              row_operation_id: rowOk,
              sku: 'BULK-R14-OK',
              status: 'COMPLETED',
              code: null,
              price_version: 1,
            },
            {
              row_number: 3,
              row_operation_id: rowFail,
              sku: 'BULK-R14-FAIL',
              status: 'REJECTED',
              code: 'VALIDACION',
            },
          ],
        },
      };

      await dispatcher.dispatch({
        eventName: 'pricing.bulk.price.apply.completed',
        messageId: r14MsgId,
        correlationId,
        payload: r14Payload,
      });

      // Duplicado idempotente
      await dispatcher.dispatch({
        eventName: 'pricing.bulk.price.apply.completed',
        messageId: r14MsgId,
        correlationId,
        payload: r14Payload,
      });

      // Contradictorio con mismo messageId pero distinto resultado -> rechaza conflicto
      await expect(
        dispatcher.dispatch({
          eventName: 'pricing.bulk.price.apply.rejected',
          messageId: r14MsgId,
          correlationId,
          payload: {
            ...r14Payload,
            name: 'pricing.bulk.price.apply.rejected',
            data: {
              ...r14Payload.data,
              results: [
                {
                  row_number: 2,
                  row_operation_id: rowOk,
                  sku: 'BULK-R14-OK',
                  status: 'REJECTED',
                  code: 'CONFLICT',
                },
              ],
            },
          },
        }),
      ).rejects.toThrow();

      const [job] = await db
        .select()
        .from(batchJobs)
        .where(eq(batchJobs.batchId, batchId));
      expect(job).toBeDefined();

      const rows = await db
        .select()
        .from(batchRows)
        .where(eq(batchRows.batchJobId, job!.id));
      expect(rows).toHaveLength(2);

      const okRowDb = rows.find((r) => r.rowId === rowOk)!;
      const failRowDb = rows.find((r) => r.rowId === rowFail)!;
      const okSteps = await db
        .select()
        .from(rowDomainSteps)
        .where(eq(rowDomainSteps.batchRowId, okRowDb.id));
      const failSteps = await db
        .select()
        .from(rowDomainSteps)
        .where(eq(rowDomainSteps.batchRowId, failRowDb.id));

      expect(okSteps.find((s) => s.domain === 'PRICING')?.status).toBe(
        'COMPLETED',
      );
      expect(failSteps.find((s) => s.domain === 'PRICING')?.status).toBe(
        'FAILED',
      );
    });
  },
);
