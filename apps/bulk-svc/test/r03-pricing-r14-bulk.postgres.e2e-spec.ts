import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
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
  readonly legacyBatchId = randomUUID();
  readonly legacyRowId = randomUUID();
  readonly legacyCorrelationId = randomUUID();
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
    if (!port)
      throw new Error('Puerto de PostgreSQL descartable Bulk inválido.');
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
    await this.pool.query('CREATE SCHEMA bulk');

    const sqlFiles = [
      '../test/fixtures/0001_create_bulk_persistence.sql',
      '../migrations/0002_export_source_snapshot.sql',
      '../migrations/0003_export_claim_lease.sql',
      '../migrations/0004_catalog_claim_check_content.sql',
      '../migrations/0005_actor_ownership.sql',
      '../migrations/0006_owner_correlation_identity.sql',
      '../migrations/0007_bulk_retry_v1.sql',
      '../migrations/0008_h5_outbox_delivery.sql',
      '../migrations/0009_h5_outbox_delivery_all_destinations.sql',
      '../migrations/0010_import_admission_invariant.sql',
    ];
    for (const rel of sqlFiles) {
      if (rel.endsWith('0010_import_admission_invariant.sql')) {
        const manifest = await this.pool.query<{ id: string }>(
          "INSERT INTO bulk.file_manifests(role, format, content_ref) VALUES ('ENTRADA_IMPORTACION','CSV','test://legacy-before-0010') RETURNING id",
        );
        await this.pool.query(
          "INSERT INTO bulk.batch_jobs(batch_id,input_file_id,template_version,correlation_id,status,total_rows) VALUES ($1,$2,2,$3,'PROCESSING',1) RETURNING id",
          [this.legacyBatchId, manifest.rows[0]!.id, this.legacyCorrelationId],
        );
        await this.pool.query(
          "INSERT INTO bulk.batch_rows(batch_job_id,row_id,status,required_domains,applied_domains) SELECT id,$2,'PROCESSING',ARRAY['CATALOGO','INVENTARIO'],ARRAY['CATALOGO'] FROM bulk.batch_jobs WHERE batch_id=$1",
          [this.legacyBatchId, this.legacyRowId],
        );
        await this.pool.query(
          "INSERT INTO bulk.row_domain_steps(batch_row_id,domain,status) SELECT id,'CATALOGO','COMPLETED' FROM bulk.batch_rows WHERE row_id=$1",
          [this.legacyRowId],
        );
      }
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
  'Bulk R03 -> R14 conciliación en PostgreSQL descartable aislado',
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

    it('la migración es repetible y no repara ni modifica lotes heredados sin intención', async () => {
      const migration = await readFile(
        new URL(
          '../migrations/0010_import_admission_invariant.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await postgres.pool!.query(migration);
      expect(
        await repository.findBatchByBatchId(postgres.legacyBatchId),
      ).toMatchObject({ status: 'PROCESSING' });
      const receipts = await postgres.pool!.query(
        "SELECT message_id FROM bulk.inbox WHERE message_id=$1 AND handler='bulk.import.admission'",
        [postgres.legacyBatchId],
      );
      expect(receipts.rows).toHaveLength(0);
    });

    it('PostgreSQL rechaza al commit un lote nuevo sin recibo y revierte su manifiesto', async () => {
      const batchId = randomUUID();
      const client = await postgres.pool!.connect();
      try {
        await client.query('BEGIN');
        const manifest = await client.query<{ id: string }>(
          "INSERT INTO bulk.file_manifests(role, format, content_ref) VALUES ('ENTRADA_IMPORTACION', 'CSV', $1) RETURNING id",
          [`test://orphan-${batchId}`],
        );
        await client.query(
          'INSERT INTO bulk.batch_jobs(batch_id, input_file_id, template_version, correlation_id) VALUES ($1,$2,2,$3)',
          [batchId, manifest.rows[0]!.id, randomUUID()],
        );
        await expect(client.query('COMMIT')).rejects.toMatchObject({
          code: '23514',
          constraint: 'ck_bulk_import_admission_durable',
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await repository.findBatchByBatchId(batchId)).toBeNull();
      expect(
        (
          await postgres.pool!.query(
            'SELECT id FROM bulk.file_manifests WHERE content_ref=$1',
            [`test://orphan-${batchId}`],
          )
        ).rows,
      ).toHaveLength(0);
    });

    it.each(['fila', 'correlación'])(
      'PostgreSQL rechaza una %s distinta de la admisión persistida',
      async (mismatch) => {
        const batchId = randomUUID(),
          rowId = randomUUID(),
          correlationId = randomUUID();
        const client = await postgres.pool!.connect();
        try {
          await client.query('BEGIN');
          const manifest = await client.query<{ id: string }>(
            "INSERT INTO bulk.file_manifests(role,format,content_ref) VALUES ('ENTRADA_IMPORTACION','CSV','test://mismatch') RETURNING id",
          );
          const batch = await client.query<{ id: string }>(
            'INSERT INTO bulk.batch_jobs(batch_id,input_file_id,template_version,correlation_id,total_rows) VALUES ($1,$2,2,$3,1) RETURNING id',
            [batchId, manifest.rows[0]!.id, correlationId],
          );
          await client.query(
            "INSERT INTO bulk.batch_rows(batch_job_id,row_id,required_domains) VALUES ($1,$2,ARRAY['CATALOGO'])",
            [batch.rows[0]!.id, rowId],
          );
          await client.query(
            "INSERT INTO bulk.inbox(message_id,handler,event_name,correlation_id,payload,result) VALUES ($1,'bulk.import.admission','bulk.import.admission',$2,$3::jsonb,'ADMITTED')",
            [
              batchId,
              mismatch === 'correlación' ? randomUUID() : correlationId,
              JSON.stringify({
                rows: [{ rowId: mismatch === 'fila' ? randomUUID() : rowId }],
              }),
            ],
          );
          await expect(client.query('COMMIT')).rejects.toMatchObject({
            code: '23514',
            constraint: 'ck_bulk_import_admission_durable',
          });
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
        expect(await repository.findBatchByBatchId(batchId)).toBeNull();
        expect(
          (
            await postgres.pool!.query(
              'SELECT message_id FROM bulk.inbox WHERE message_id=$1',
              [batchId],
            )
          ).rows,
        ).toHaveLength(0);
      },
    );

    it('un resultado de un lote heredado sin intención falla cerrado y no fabrica receipts', async () => {
      await expect(
        importService.applyDomainResult({
          batchId: postgres.legacyBatchId,
          rowId: postgres.legacyRowId,
          correlationId: postgres.legacyCorrelationId,
          domain: 'INVENTARIO',
          messageId: randomUUID(),
          operationId: randomUUID(),
          causationId: randomUUID(),
          action: 'STOCK_ADJUSTMENT',
          eventName: 'inventory.bulk.stock.adjust.completed',
          status: 'COMPLETED',
        }),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILURE' });
      expect(
        await repository.findBatchByBatchId(postgres.legacyBatchId),
      ).toMatchObject({ status: 'PROCESSING', completedRows: 0 });
      const receipts = await postgres.pool!.query(
        'SELECT message_id FROM bulk.inbox WHERE correlation_id=$1',
        [postgres.legacyCorrelationId],
      );
      expect(receipts.rows).toHaveLength(0);
    });

    it('no admite lote ni outbox sin intención normalizada y confirma receipt en la misma transacción', async () => {
      const batchId = randomUUID(),
        rowId = randomUUID(),
        ownerSub = randomUUID();
      const input = {
        batchId,
        ownerSub,
        correlationId: randomUUID(),
        templateVersion: 2,
        inputFile: { format: 'CSV' as const, contentRef: `test://${batchId}` },
        rows: [{ rowId, requiredDomains: ['CATALOGO' as const] }],
        admissionIntent: { rows: [{ rowId }] },
      };
      const invalid = { ...input };
      Reflect.deleteProperty(invalid, 'admissionIntent');
      await expect(repository.createImportBatch(invalid)).rejects.toMatchObject(
        { code: 'CHECK_VIOLATION' },
      );
      expect(await repository.findBatchByBatchId(batchId)).toBeNull();
      const first = await repository.createImportBatch(input);
      const repeated = await repository.createImportBatch(input);
      expect(repeated.batch.id).toBe(first.batch.id);
      const receipts = await db
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, batchId),
            eq(inbox.handler, 'bulk.import.admission'),
          ),
        );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.payload.rows).toEqual([{ rowId }]);
    });

    it('un fallo al persistir receipt revierte lote, filas y manifiesto antes de publicar', async () => {
      const batchId = randomUUID(),
        rowId = randomUUID();
      await postgres.pool!.query(
        `CREATE OR REPLACE FUNCTION bulk.audit_fail_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id = '${batchId}' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='isolated admission failure'; END IF; RETURN NEW; END $$`,
      );
      await postgres.pool!.query(
        'CREATE TRIGGER audit_fail_admission BEFORE INSERT ON bulk.inbox FOR EACH ROW EXECUTE FUNCTION bulk.audit_fail_admission()',
      );
      try {
        await expect(
          repository.createImportBatch({
            batchId,
            ownerSub: randomUUID(),
            correlationId: randomUUID(),
            templateVersion: 2,
            inputFile: { format: 'CSV', contentRef: `test://${batchId}` },
            rows: [{ rowId, requiredDomains: ['CATALOGO'] }],
            admissionIntent: { rows: [{ rowId }] },
          }),
        ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
        expect(await repository.findBatchByBatchId(batchId)).toBeNull();
        const manifest = await postgres.pool!.query(
          'SELECT id FROM bulk.file_manifests WHERE content_ref = $1',
          [`test://${batchId}`],
        );
        expect(manifest.rows).toHaveLength(0);
      } finally {
        await postgres.pool!.query(
          'DROP TRIGGER audit_fail_admission ON bulk.inbox',
        );
        await postgres.pool!.query('DROP FUNCTION bulk.audit_fail_admission()');
      }
    });

    it('holds downstream commands until Catalog confirms their family and releases original IDs after recovery', async () => {
      const batchId = randomUUID();
      const rows = [0, 1].map((index) => ({
        rowId: randomUUID(),
        mode: 'ALTA' as const,
        productId: null,
        skuBase: `DEPENDENCY-${batchId}-${index}`,
        skuIdentityRequired: true,
        variantSkus: [],
        precioRegular: 25,
        stockInicial: 10,
        defaultLocationId: randomUUID(),
      }));
      await importService.createImport({
        batchId,
        ownerSub: randomUUID(),
        correlationId: randomUUID(),
        contentRef: `bulk/test/${batchId}.csv`,
        format: 'CSV',
        templateVersion: 2,
        rows,
        intentRows: rows.map((row, index) => ({
          ...row,
          rowNumber: index + 2,
          rowOperationId: row.rowId,
          product: { nombre: `Dependency ${index}` },
          variant: null,
        })),
      });
      const stored = await repository.findImportAdmissionIntent(
        batchId,
        (await repository.findBatchByBatchId(batchId))!.ownerSub,
      );
      const commands = stored!.pricingCommands as Array<{
        message_id: string;
        data: { items: Array<{ row_operation_id: string }> };
      }>;
      expect(commands).toHaveLength(2);
      expect(
        commands.map((c) => c.data.items.map((i) => i.row_operation_id)),
      ).toEqual(rows.map((r) => [r.rowId]));
      const ownClaims = async () =>
        (await repository.claimPendingServiceBusDeliveries(100)).filter(
          (claim) =>
            (claim.payload.data as Record<string, unknown>).batch_id ===
            batchId,
        );
      const first = await ownClaims();
      expect(first.length).toBeGreaterThan(0);
      expect(
        first.every(
          (claim) => claim.delivery.destination === 'g6.catalog.from.bulk',
        ),
      ).toBe(true);
      const persistedRows = await db
        .select()
        .from(batchRows)
        .where(
          eq(
            batchRows.batchJobId,
            (await repository.findBatchByBatchId(batchId))!.id,
          ),
        );
      const setCatalog = async (
        rowId: string,
        status: 'COMPLETED' | 'FAILED' | 'PENDING',
      ) => {
        await db
          .update(rowDomainSteps)
          .set({ status })
          .where(
            and(
              eq(
                rowDomainSteps.batchRowId,
                persistedRows.find((r) => r.rowId === rowId)!.id,
              ),
              eq(rowDomainSteps.domain, 'CATALOGO'),
            ),
          );
      };
      await setCatalog(rows[0]!.rowId, 'COMPLETED');
      await setCatalog(rows[1]!.rowId, 'FAILED');
      const ready = await ownClaims();
      expect(ready.map((c) => c.delivery.destination).sort()).toEqual([
        'g6.inventory.from.bulk',
        'g6.pricing.from.bulk',
      ]);
      expect(
        ready.find((c) => c.delivery.destination === 'g6.pricing.from.bulk')
          ?.messageId,
      ).toBe(commands[0]!.message_id);
      await setCatalog(rows[1]!.rowId, 'PENDING');
      expect(await ownClaims()).toEqual([]);
      await setCatalog(rows[1]!.rowId, 'COMPLETED');
      const recovered = await ownClaims();
      expect(recovered.map((c) => c.delivery.destination).sort()).toEqual([
        'g6.inventory.from.bulk',
        'g6.pricing.from.bulk',
      ]);
      expect(
        recovered.find((c) => c.delivery.destination === 'g6.pricing.from.bulk')
          ?.messageId,
      ).toBe(commands[1]!.message_id);
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
            variantSkus: [],
            precioRegular: 25,
          },
        ],
        intentRows: [
          {
            rowNumber: 2,
            rowOperationId: rowId,
            rowId,
            skuBase: 'BULK-OOO-1',
            precioRegular: 25,
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
            variantSkus: [],
            precioRegular: 25,
          },
          {
            rowId: rowFail,
            productId: null,
            mode: 'ALTA',
            skuBase: 'BULK-R14-FAIL',
            variantSkus: [],
            precioRegular: 15,
          },
        ],
        intentRows: [
          {
            rowNumber: 2,
            rowOperationId: rowOk,
            rowId: rowOk,
            skuBase: 'BULK-R14-OK',
            precioRegular: 25,
            product: { nombre: 'Prod OK' },
            variant: null,
          },
          {
            rowNumber: 3,
            rowOperationId: rowFail,
            rowId: rowFail,
            skuBase: 'BULK-R14-FAIL',
            precioRegular: 15,
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
