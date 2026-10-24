import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { parseBulkEnvironment } from '../config/bulk-environment.js';
import {
  bulkSchema,
  batchJobs,
  batchRows,
  exportJobs,
  fileManifests,
  inbox,
  outbox,
  rowDomainSteps,
} from './bulk.schema.js';
import { BulkPersistenceError } from './bulk.persistence.errors.js';
import {
  BulkPersistenceRepository,
  type UpdateWorkflowStateInput,
} from './bulk.repository.js';

const testUrl = process.env.BULK_TEST_DATABASE_URL;
const integration = testUrl ? describe : describe.skip;
let pool: Pool;
let repository: BulkPersistenceRepository;
let database: ReturnType<typeof drizzle<typeof bulkSchema>>;

integration('BulkPersistenceRepository with PostgreSQL 17 migration', () => {
  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test')
      throw new Error('NODE_ENV=test is required for local integration tests');
    const parsed = parseBulkEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: testUrl,
    });
    if (!parsed.databaseUrl)
      throw new Error('BULK_TEST_DATABASE_URL is required');
    const url = new URL(parsed.databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !testUrl?.includes('sslmode=disable')
    ) {
      throw new Error(
        'Integration tests require loopback PostgreSQL and explicit sslmode=disable',
      );
    }
    pool = new Pool({
      connectionString: parsed.databaseUrl,
      ssl: parsed.databaseSsl,
      max: 2,
      connectionTimeoutMillis: parsed.databaseConnectionTimeoutMs,
      query_timeout: parsed.databaseQueryTimeoutMs,
      statement_timeout: parsed.databaseQueryTimeoutMs,
      idleTimeoutMillis: parsed.databaseIdleTimeoutMs,
    });
    database = drizzle(pool, { schema: bulkSchema, logger: false });
    repository = new BulkPersistenceRepository(database);
    const version = await pool.query('SHOW server_version_num');
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
      170000,
    );
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(180000);
    await pool.query('SELECT 1 FROM bulk.file_manifests LIMIT 0');
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  const importBatch = (
    rows: Array<{
      rowId: string;
      requiredDomains: Array<'CATALOGO' | 'PRICING' | 'INVENTARIO'>;
    }>,
  ) =>
    repository.createImportBatch({
      batchId: randomUUID(),
      templateVersion: 2,
      correlationId: randomUUID(),
      inputFile: { format: 'CSV', contentRef: `test://${randomUUID()}` },
      rows,
    });

  it('inserts/query manifests and atomically creates a batch with rows and domain steps', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
      { rowId: randomUUID(), requiredDomains: ['INVENTARIO'] },
    ]);
    expect(created.manifest.role).toBe('ENTRADA_IMPORTACION');
    expect(
      (await repository.findBatchByBatchId(created.batch.batchId))?.id,
    ).toBe(created.batch.id);
    expect(
      (await repository.listBatchRows(created.batch.batchId))
        .map((row) => row.id)
        .sort(),
    ).toEqual(created.rows.map(({ row }) => row.id).sort());
    expect(
      (
        await repository.listRowSteps(
          created.batch.batchId,
          created.rows[0]!.row.rowId,
        )
      ).map((step) => step.domain),
    ).toEqual(['CATALOGO', 'PRICING']);
  });

  it('matches all seven migration table columns, nullability and default presence', async () => {
    const actual = await pool.query(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default IS NOT NULL AS has_default
       FROM information_schema.columns WHERE table_schema='bulk'
         AND table_name IN ('file_manifests','batch_jobs','batch_rows','row_domain_steps','export_jobs','outbox','inbox')
       ORDER BY table_name, column_name`,
    );
    const tables = [
      fileManifests,
      batchJobs,
      batchRows,
      rowDomainSteps,
      exportJobs,
      outbox,
      inbox,
    ];
    const expected = tables
      .flatMap((table) =>
        getTableConfig(table).columns.map((column) => ({
          table_name: getTableConfig(table).name,
          column_name: column.name,
          udt_name:
            column.getSQLType() === 'timestamp with time zone'
              ? 'timestamptz'
              : column.getSQLType() === 'text[]'
                ? '_text'
                : column.getSQLType() === 'integer'
                  ? 'int4'
                  : column.getSQLType() === 'boolean'
                    ? 'bool'
                    : column.getSQLType(),
          is_nullable: column.notNull ? 'NO' : 'YES',
          has_default: column.hasDefault,
        })),
      )
      .sort((a, b) =>
        `${a.table_name}.${a.column_name}`.localeCompare(
          `${b.table_name}.${b.column_name}`,
        ),
      );
    const migrated = actual.rows
      .map((row) => ({
        ...row,
        has_default: row.has_default === true,
      }))
      .sort((a, b) =>
        `${a.table_name}.${a.column_name}`.localeCompare(
          `${b.table_name}.${b.column_name}`,
        ),
      );
    expect(migrated).toEqual(expected);
  });

  it('rolls back manifest, batch, rows and steps when an intermediate row violates uniqueness', async () => {
    const batchId = randomUUID();
    const ref = `test://${randomUUID()}`;
    const duplicateRowId = randomUUID();
    try {
      await repository.createImportBatch({
        batchId,
        templateVersion: 2,
        correlationId: randomUUID(),
        inputFile: { format: 'CSV', contentRef: ref },
        rows: [
          { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
          { rowId: duplicateRowId, requiredDomains: ['PRICING'] },
          { rowId: duplicateRowId, requiredDomains: ['INVENTARIO'] },
        ],
      });
      throw new Error('duplicate rows should reject');
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNIQUE_CONFLICT' });
    }
    expect(
      await database
        .select()
        .from(fileManifests)
        .where(eq(fileManifests.contentRef, ref)),
    ).toHaveLength(0);
    expect(await repository.findBatchByBatchId(batchId)).toBeNull();
  });

  it('rolls back all inserts when an official check rejects required domains and rejects repeated row ids', async () => {
    const batchId = randomUUID();
    const ref = `test://${randomUUID()}`;
    await expect(
      repository.createImportBatch({
        batchId,
        templateVersion: 2,
        correlationId: randomUUID(),
        inputFile: { format: 'CSV', contentRef: ref },
        rows: [
          {
            rowId: randomUUID(),
            requiredDomains: ['CATALOGO', 'CATALOGO'] as never,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    expect(
      await database
        .select()
        .from(fileManifests)
        .where(eq(fileManifests.contentRef, ref)),
    ).toHaveLength(0);
    const duplicate = randomUUID();
    await expect(
      importBatch([
        { rowId: duplicate, requiredDomains: ['CATALOGO'] },
        { rowId: duplicate, requiredDomains: ['PRICING'] },
      ]),
    ).rejects.toMatchObject({ code: 'UNIQUE_CONFLICT' });
  });

  it('rolls back batch creation when writing a domain step fails', async () => {
    const ref = `test://${randomUUID()}`;
    const batchId = randomUUID();
    await pool.query(
      `CREATE OR REPLACE FUNCTION bulk.fn_test_fail_step_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='injected integration failure'; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER trg_test_fail_step_insert BEFORE INSERT ON bulk.row_domain_steps FOR EACH ROW EXECUTE FUNCTION bulk.fn_test_fail_step_insert()',
    );
    try {
      await expect(
        repository.createImportBatch({
          batchId,
          templateVersion: 2,
          correlationId: randomUUID(),
          inputFile: { format: 'CSV', contentRef: ref },
          rows: [{ rowId: randomUUID(), requiredDomains: ['CATALOGO'] }],
        }),
      ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
      expect(
        await database
          .select()
          .from(fileManifests)
          .where(eq(fileManifests.contentRef, ref)),
      ).toHaveLength(0);
      expect(await repository.findBatchByBatchId(batchId)).toBeNull();
    } finally {
      await pool.query(
        'DROP TRIGGER IF EXISTS trg_test_fail_step_insert ON bulk.row_domain_steps',
      );
      await pool.query(
        'DROP FUNCTION IF EXISTS bulk.fn_test_fail_step_insert()',
      );
    }
  });

  it('enforces foreign keys, invalid domains, counter constraints and final-state constraints', async () => {
    await expect(
      database.insert(batchRows).values({
        batchJobId: randomUUID(),
        rowId: randomUUID(),
        requiredDomains: ['CATALOGO'],
      }),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    await expect(
      database
        .insert(rowDomainSteps)
        .values({ batchRowId: created.rows[0]!.row.id, domain: 'UNKNOWN' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      database
        .update(batchJobs)
        .set({ totalRows: -1 })
        .where(eq(batchJobs.id, created.batch.id)),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      database
        .update(batchJobs)
        .set({ completedRows: 2 })
        .where(eq(batchJobs.id, created.batch.id)),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      database
        .update(batchRows)
        .set({ appliedDomains: ['PRICING'] })
        .where(eq(batchRows.id, created.rows[0]!.row.id)),
    ).rejects.toBeInstanceOf(Error);
    const job = await repository.createExportJob({
      exportId: randomUUID(),
      format: 'CSV',
    });
    await expect(
      database
        .update(exportJobs)
        .set({ status: 'COMPLETED' })
        .where(eq(exportJobs.id, job.id)),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects incompatible file role/format combinations and completes exports atomically', async () => {
    const job = await repository.createExportJob({
      exportId: randomUUID(),
      format: 'CSV',
    });
    await expect(
      repository.completeExportJob(job.exportId, {
        format: 'XLSX',
        contentRef: `test://${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    expect(
      (await repository.findExportJobByExportId(job.exportId))?.outputFileId,
    ).toBeNull();
    const done = await repository.completeExportJob(job.exportId, {
      format: 'CSV',
      contentRef: `test://${randomUUID()}`,
    });
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeInstanceOf(Date);
  });

  it('enforces message and operation idempotency in Outbox and lists pending messages', async () => {
    const message = {
      messageId: randomUUID(),
      eventName: 'test.event',
      kind: 'event' as const,
      correlationId: 'corr',
      occurredAt: new Date(),
      payload: { ok: true },
    };
    await repository.enqueueOutbox(message);
    await expect(repository.enqueueOutbox(message)).rejects.toMatchObject({
      code: 'UNIQUE_CONFLICT',
    });
    const operationId = randomUUID();
    await repository.enqueueOutbox({
      ...message,
      messageId: randomUUID(),
      operationId,
    });
    await expect(
      repository.enqueueOutbox({
        ...message,
        messageId: randomUUID(),
        operationId,
      }),
    ).rejects.toMatchObject({ code: 'UNIQUE_CONFLICT' });
    expect(
      (await repository.findPendingOutbox(1000)).some(
        (item) => item.messageId === message.messageId,
      ),
    ).toBe(true);
    await repository.markOutboxPublished(message.messageId, {
      attempts: 1,
      lastError: 'temporary transport failure',
    });
    expect(
      (await repository.findPendingOutbox(1000)).some(
        (item) => item.messageId === message.messageId,
      ),
    ).toBe(true);
    await repository.markOutboxPublished(message.messageId, {
      publishedAt: new Date(),
      attempts: 2,
    });
  });

  it('processes each Inbox handler once and rolls back the receipt if its local mutation fails', async () => {
    const input = {
      messageId: randomUUID(),
      handler: 'handler-a',
      eventName: 'test.event',
      payload: { value: 1 },
    };
    let count = 0;
    const effect = async () => {
      count += 1;
      return 'applied';
    };
    expect(await repository.processInboxOnce(input, effect)).toEqual({
      processed: true,
      result: 'applied',
    });
    expect(await repository.processInboxOnce(input, effect)).toEqual({
      processed: false,
      result: 'applied',
    });
    expect(
      await repository.processInboxOnce(
        { ...input, handler: 'handler-b' },
        effect,
      ),
    ).toEqual({ processed: true, result: 'applied' });
    expect(count).toBe(2);
    const applying = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    const applied = await repository.processInboxOnce(
      {
        messageId: randomUUID(),
        handler: 'workflow-handler',
        eventName: 'workflow.done',
        payload: {},
      },
      async (context) => {
        await context.updateWorkflowState({
          batchId: applying.batch.batchId,
          rowId: applying.rows[0]!.row.rowId,
          status: 'COMPLETED',
          steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
        });
        return 'workflow-applied';
      },
    );
    expect(applied.processed).toBe(true);
    expect(
      (await repository.findBatchByBatchId(applying.batch.batchId))?.status,
    ).toBe('COMPLETED');
    const failing = {
      ...input,
      messageId: randomUUID(),
      handler: 'rollback-handler',
    };
    const rollback = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    await expect(
      repository.processInboxOnce(failing, async (context) => {
        await context.updateWorkflowState({
          batchId: rollback.batch.batchId,
          rowId: rollback.rows[0]!.row.rowId,
          status: 'COMPLETED',
          steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
        });
        throw new Error('local mutation failed');
      }),
    ).rejects.toBeInstanceOf(BulkPersistenceError);
    expect(
      (await repository.findBatchByBatchId(rollback.batch.batchId))?.status,
    ).toBe('QUEUED');
    expect(
      await database
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, failing.messageId),
            eq(inbox.handler, failing.handler),
          ),
        ),
    ).toHaveLength(0);
  });

  it('uses transactional locks to preserve counters for concurrent writes to one batch', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    const update = (rowId: string): UpdateWorkflowStateInput => ({
      batchId: created.batch.batchId,
      rowId,
      status: 'COMPLETED',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    });
    await Promise.all(
      created.rows.map(({ row }) =>
        repository.updateWorkflowState(update(row.rowId)),
      ),
    );
    const final = await repository.findBatchByBatchId(created.batch.batchId);
    expect(final).toMatchObject({
      status: 'COMPLETED',
      totalRows: 2,
      completedRows: 2,
      failedRows: 0,
      needsReconciliation: false,
    });
  });

  it('completes a partially failed batch with reconciliation counters consistent with SPEC', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
    ]);
    const rowId = created.rows[0]!.row.rowId;
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId,
      status: 'PROCESSING',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    });
    await repository.updateWorkflowState({
      batchId: created.batch.batchId,
      rowId,
      status: 'FAILED',
      failedDomain: 'PRICING',
      needsReconciliation: true,
      steps: [{ domain: 'PRICING', status: 'FAILED' }],
    });
    expect(
      await repository.findBatchByBatchId(created.batch.batchId),
    ).toMatchObject({
      status: 'COMPLETED',
      completedRows: 0,
      failedRows: 1,
      needsReconciliation: true,
    });
  });

  it('commits workflow and Outbox together and rolls both back on an idempotency conflict', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
      { rowId: randomUUID(), requiredDomains: ['CATALOGO'] },
    ]);
    const message = {
      messageId: randomUUID(),
      eventName: 'workflow.test',
      kind: 'event' as const,
      correlationId: 'corr',
      occurredAt: new Date(),
      payload: { ok: true },
    };
    const first: UpdateWorkflowStateInput = {
      batchId: created.batch.batchId,
      rowId: created.rows[0]!.row.rowId,
      status: 'COMPLETED',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    };
    await repository.enqueueOutbox(message, first);
    const second: UpdateWorkflowStateInput = {
      batchId: created.batch.batchId,
      rowId: created.rows[1]!.row.rowId,
      status: 'COMPLETED',
      steps: [{ domain: 'CATALOGO', status: 'COMPLETED' }],
    };
    await expect(
      repository.enqueueOutbox(message, second),
    ).rejects.toMatchObject({ code: 'UNIQUE_CONFLICT' });
    const rows = await repository.listBatchRows(created.batch.batchId);
    expect(rows.map((row) => row.status).sort()).toEqual([
      'COMPLETED',
      'PENDING',
    ]);
    expect(
      (await repository.findBatchByBatchId(created.batch.batchId))
        ?.completedRows,
    ).toBe(1);
  });

  it('checks terminal completion cannot precede required steps and there are no cross-schema foreign keys', async () => {
    const created = await importBatch([
      { rowId: randomUUID(), requiredDomains: ['CATALOGO', 'PRICING'] },
    ]);
    await expect(
      repository.updateWorkflowState({
        batchId: created.batch.batchId,
        rowId: created.rows[0]!.row.rowId,
        status: 'COMPLETED',
        steps: [],
      }),
    ).rejects.toMatchObject({ code: 'CHECK_VIOLATION' });
    const fks = await pool.query(
      `SELECT count(*)::int AS count FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace s ON s.oid=t.relnamespace JOIN pg_class d ON d.oid=c.confrelid JOIN pg_namespace n ON n.oid=d.relnamespace WHERE s.nspname='bulk' AND c.contype='f' AND n.nspname <> 'bulk'`,
    );
    expect(fks.rows[0]?.count).toBe(0);
  });
});
