import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  batchJobs,
  batchRows,
  bulkSchema,
  outboxDeliveries,
  rowDomainSteps,
} from '../src/persistence/bulk.schema.js';
import { BulkPersistenceRepository } from '../src/persistence/bulk.repository.js';
import { BulkImportService } from '../src/bulk-import.service.js';
import { BulkContractResultDispatcherService } from '../src/messaging/bulk-contract-result-dispatcher.js';

const BULK_PG_URL = process.env.BULK_TEST_DATABASE_URL ?? '';
const RUN_POSTGRES =
  process.env.BULK_TEST_POSTGRES === '1' && Boolean(BULK_PG_URL);

describe.skipIf(!RUN_POSTGRES)(
  'Bulk R03 -> Pricing -> R14 -> Bulk PostgreSQL descartable (ESCRITA_NO_EJECUTADA)',
  () => {
    let pool: Pool;
    let db: ReturnType<typeof drizzle<typeof bulkSchema>>;
    let repository: BulkPersistenceRepository;
    let importService: BulkImportService;
    let dispatcher: BulkContractResultDispatcherService;

    beforeAll(async () => {
      if (/slzglmtiyrzygpkiuthf/i.test(BULK_PG_URL)) {
        throw new Error('Prohibido apuntar BULK_TEST_DATABASE_URL a Supabase.');
      }
      pool = new Pool({ connectionString: BULK_PG_URL, ssl: false });
      db = drizzle(pool, { schema: bulkSchema });
      repository = new BulkPersistenceRepository(db as never);
      importService = new BulkImportService(repository);
      dispatcher = new BulkContractResultDispatcherService(importService);
    });

    afterAll(async () => {
      await pool?.end();
    });

    it('emite R03 en outbox_delivery y concilia R14 con rechazos parciales, duplicados y resultados fuera de orden', async () => {
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

      // Primera entrega (fuera de orden antes de Catalog)
      await dispatcher.dispatch({
        eventName: 'pricing.bulk.price.apply.completed',
        messageId: r14MsgId,
        correlationId,
        payload: r14Payload,
      });

      // Reentrega duplicada idempotente
      await dispatcher.dispatch({
        eventName: 'pricing.bulk.price.apply.completed',
        messageId: r14MsgId,
        correlationId,
        payload: r14Payload,
      });

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

      expect(
        okSteps.find((s) => s.domain === 'PRICING')?.status,
      ).toBe('COMPLETED');
      expect(
        failSteps.find((s) => s.domain === 'PRICING')?.status,
      ).toBe('FAILED');
    });
  },
);
