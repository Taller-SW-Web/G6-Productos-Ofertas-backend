import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  batchJobs,
  batchRows,
  exportJobs,
  fileManifests,
  inbox,
  outbox,
  rowDomainSteps,
} from './bulk.schema.js';
import { BULK_DATABASE, type BulkDatabase } from './bulk.database.js';
import {
  BulkPersistenceError,
  persistenceError,
} from './bulk.persistence.errors.js';

export type BulkDomain = 'CATALOGO' | 'PRICING' | 'INVENTARIO';
export type BulkFileFormat = 'CSV' | 'XLSX';
export type BulkFileRole =
  'ENTRADA_IMPORTACION' | 'REPORTE_IMPORTACION' | 'RESULTADO_EXPORTACION';
export type BulkJobStatus =
  'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED_GENERAL';
export type BulkRowStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
export type BulkStepStatus = BulkRowStatus;

export interface FileManifestInput {
  role: BulkFileRole;
  format: BulkFileFormat;
  contentRef: string;
}
export interface ImportRowInput {
  rowId: string;
  requiredDomains: BulkDomain[];
}
export interface CreateImportBatchInput {
  batchId: string;
  templateVersion: number;
  correlationId: string;
  inputFile: Omit<FileManifestInput, 'role'>;
  rows: ImportRowInput[];
}
export interface CreateImportBatchResult {
  manifest: typeof fileManifests.$inferSelect;
  batch: typeof batchJobs.$inferSelect;
  rows: Array<{
    row: typeof batchRows.$inferSelect;
    steps: Array<typeof rowDomainSteps.$inferSelect>;
  }>;
}
export interface WorkflowStepChange {
  domain: BulkDomain;
  status: BulkStepStatus;
  errorCode?: string | null;
  errorDetail?: string | null;
}
export interface UpdateWorkflowStateInput {
  batchId: string;
  rowId: string;
  steps: WorkflowStepChange[];
  status: BulkRowStatus;
  failedDomain?: BulkDomain | null;
  needsReconciliation?: boolean;
  errorCode?: string | null;
  errorDetail?: string | null;
}
export interface CreateExportJobInput {
  exportId: string;
  format: BulkFileFormat;
}
export interface OutboxInput {
  messageId: string;
  eventName: string;
  kind: 'command' | 'event' | 'result';
  schemaVersion?: number;
  correlationId: string;
  causationId?: string | null;
  operationId?: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
}
export interface InboxInput {
  messageId: string;
  handler: string;
  eventName: string;
  correlationId?: string | null;
  payload: Record<string, unknown>;
}
export interface InboxMutationContext {
  updateWorkflowState(input: UpdateWorkflowStateInput): Promise<void>;
}

type BulkTx = Parameters<Parameters<BulkDatabase['transaction']>[0]>[0];

const inconsistent = (message: string): never => {
  throw new BulkPersistenceError('CHECK_VIOLATION', new Error(message));
};

@Injectable()
export class BulkPersistenceRepository {
  constructor(
    @Inject(BULK_DATABASE) private readonly database: BulkDatabase | null,
  ) {}

  private get db(): BulkDatabase {
    if (!this.database) throw new BulkPersistenceError('NOT_CONFIGURED');
    return this.database;
  }

  async createImportBatch(
    input: CreateImportBatchInput,
  ): Promise<CreateImportBatchResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const [manifest] = await tx
          .insert(fileManifests)
          .values({
            role: 'ENTRADA_IMPORTACION',
            format: input.inputFile.format,
            contentRef: input.inputFile.contentRef,
          })
          .returning();
        if (!manifest) throw new Error('Manifest insert returned no row');
        const [batch] = await tx
          .insert(batchJobs)
          .values({
            batchId: input.batchId,
            inputFileId: manifest.id,
            status: 'QUEUED',
            templateVersion: input.templateVersion,
            correlationId: input.correlationId,
            totalRows: input.rows.length,
          })
          .returning();
        if (!batch) throw new Error('Batch insert returned no row');
        const createdRows: CreateImportBatchResult['rows'] = [];
        for (const rowInput of input.rows) {
          const [row] = await tx
            .insert(batchRows)
            .values({
              batchJobId: batch.id,
              rowId: rowInput.rowId,
              requiredDomains: rowInput.requiredDomains,
            })
            .returning();
          if (!row) throw new Error('Batch row insert returned no row');
          const steps = await tx
            .insert(rowDomainSteps)
            .values(
              rowInput.requiredDomains.map((domain) => ({
                batchRowId: row.id,
                domain,
              })),
            )
            .returning();
          if (steps.length !== rowInput.requiredDomains.length)
            throw new Error('Incomplete step insert');
          createdRows.push({ row, steps });
        }
        return { manifest, batch, rows: createdRows };
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findBatchByBatchId(
    batchId: string,
  ): Promise<typeof batchJobs.$inferSelect | null> {
    try {
      const [batch] = await this.db
        .select()
        .from(batchJobs)
        .where(eq(batchJobs.batchId, batchId))
        .limit(1);
      return batch ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async listBatchRows(
    batchId: string,
  ): Promise<Array<typeof batchRows.$inferSelect>> {
    try {
      return await this.db
        .select({ row: batchRows })
        .from(batchRows)
        .innerJoin(batchJobs, eq(batchRows.batchJobId, batchJobs.id))
        .where(eq(batchJobs.batchId, batchId))
        .orderBy(asc(batchRows.createdAt), asc(batchRows.id))
        .then((rows) => rows.map(({ row }) => row));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async listRowSteps(
    batchId: string,
    rowId: string,
  ): Promise<Array<typeof rowDomainSteps.$inferSelect>> {
    try {
      const found = await this.db
        .select({ id: batchRows.id })
        .from(batchRows)
        .innerJoin(batchJobs, eq(batchRows.batchJobId, batchJobs.id))
        .where(and(eq(batchJobs.batchId, batchId), eq(batchRows.rowId, rowId)))
        .limit(1);
      if (!found[0]) return [];
      return await this.db
        .select()
        .from(rowDomainSteps)
        .where(eq(rowDomainSteps.batchRowId, found[0].id))
        .orderBy(asc(rowDomainSteps.domain));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async updateWorkflowState(input: UpdateWorkflowStateInput): Promise<void> {
    try {
      await this.db.transaction((tx) => updateWorkflowStateIn(tx, input));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async createExportJob(
    input: CreateExportJobInput,
  ): Promise<typeof exportJobs.$inferSelect> {
    try {
      const [job] = await this.db
        .insert(exportJobs)
        .values({ exportId: input.exportId, format: input.format })
        .returning();
      if (!job) throw new Error('Export insert returned no row');
      return job;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findExportJobByExportId(
    exportId: string,
  ): Promise<typeof exportJobs.$inferSelect | null> {
    try {
      const [job] = await this.db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.exportId, exportId))
        .limit(1);
      return job ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async completeExportJob(
    exportId: string,
    resultFile: Omit<FileManifestInput, 'role'>,
  ): Promise<typeof exportJobs.$inferSelect> {
    try {
      return await this.db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.exportId, exportId))
          .for('update')
          .limit(1);
        if (!job) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        if (job.status === 'COMPLETED')
          inconsistent('Export is already complete');
        const [manifest] = await tx
          .insert(fileManifests)
          .values({
            role: 'RESULTADO_EXPORTACION',
            format: resultFile.format,
            contentRef: resultFile.contentRef,
          })
          .returning();
        if (!manifest)
          throw new Error('Output manifest insert returned no row');
        const [updated] = await tx
          .update(exportJobs)
          .set({
            status: 'COMPLETED',
            outputFileId: manifest.id,
            completedAt: new Date(),
          })
          .where(eq(exportJobs.id, job.id))
          .returning();
        if (!updated) throw new Error('Export update returned no row');
        return updated;
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async enqueueOutbox(
    input: OutboxInput,
    workflow?: UpdateWorkflowStateInput,
  ): Promise<typeof outbox.$inferSelect> {
    try {
      return await this.db.transaction(async (tx) => {
        if (workflow) await updateWorkflowStateIn(tx, workflow);
        const [message] = await tx
          .insert(outbox)
          .values({
            messageId: input.messageId,
            eventName: input.eventName,
            kind: input.kind,
            schemaVersion: input.schemaVersion ?? 1,
            correlationId: input.correlationId,
            causationId: input.causationId ?? null,
            operationId: input.operationId ?? null,
            occurredAt: input.occurredAt,
            payload: input.payload,
          })
          .returning();
        if (!message) throw new Error('Outbox insert returned no row');
        return message;
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findPendingOutbox(
    limit = 100,
  ): Promise<Array<typeof outbox.$inferSelect>> {
    try {
      return await this.db
        .select()
        .from(outbox)
        .where(sql`${outbox.publishedAt} IS NULL`)
        .orderBy(asc(outbox.occurredAt), asc(outbox.id))
        .limit(Math.max(1, Math.min(limit, 1000)));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async markOutboxPublished(
    messageId: string,
    result: {
      publishedAt?: Date | null;
      attempts: number;
      lastError?: string | null;
    },
  ): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const [message] = await tx
          .select()
          .from(outbox)
          .where(eq(outbox.messageId, messageId))
          .for('update')
          .limit(1);
        if (!message) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        const alreadyPublished = message.publishedAt !== null;
        await tx
          .update(outbox)
          .set({
            publishedAt: message.publishedAt ?? result.publishedAt ?? null,
            attempts: Math.max(message.attempts, result.attempts),
            lastError: alreadyPublished
              ? null
              : result.publishedAt
                ? null
                : (result.lastError ?? null),
          })
          .where(eq(outbox.id, message.id));
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async processInboxOnce(
    input: InboxInput,
    mutate: (context: InboxMutationContext) => Promise<string>,
  ): Promise<{ processed: boolean; result: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [receipt] = await tx
          .insert(inbox)
          .values({
            messageId: input.messageId,
            handler: input.handler,
            eventName: input.eventName,
            correlationId: input.correlationId ?? null,
            payload: input.payload,
            result: 'PROCESSING',
          })
          .onConflictDoNothing({ target: [inbox.messageId, inbox.handler] })
          .returning();
        if (!receipt) {
          const [existing] = await tx
            .select({ result: inbox.result })
            .from(inbox)
            .where(
              and(
                eq(inbox.messageId, input.messageId),
                eq(inbox.handler, input.handler),
              ),
            )
            .limit(1);
          if (!existing) throw new BulkPersistenceError('PERSISTENCE_FAILURE');
          const [matching] = await tx
            .select({ result: inbox.result })
            .from(inbox)
            .where(
              and(
                eq(inbox.messageId, input.messageId),
                eq(inbox.handler, input.handler),
                eq(inbox.eventName, input.eventName),
                sql`${inbox.correlationId} IS NOT DISTINCT FROM ${input.correlationId ?? null}`,
                sql`${inbox.payload} = ${JSON.stringify(input.payload)}::jsonb`,
              ),
            )
            .limit(1);
          if (!matching)
            throw new BulkPersistenceError(
              'CHECK_VIOLATION',
              new Error(
                'Inbox replay identity does not match persisted message',
              ),
            );
          return {
            processed: false,
            result: existing.result,
          };
        }
        const result = await mutate({
          updateWorkflowState: (state) => updateWorkflowStateIn(tx, state),
        });
        await tx.update(inbox).set({ result }).where(eq(inbox.id, receipt.id));
        return { processed: true, result };
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }
}

async function updateWorkflowStateIn(
  tx: BulkTx,
  input: UpdateWorkflowStateInput,
): Promise<void> {
  const [batch] = await tx
    .select()
    .from(batchJobs)
    .where(eq(batchJobs.batchId, input.batchId))
    .for('update')
    .limit(1);
  if (!batch) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
  const [row] = await tx
    .select()
    .from(batchRows)
    .where(
      and(eq(batchRows.batchJobId, batch.id), eq(batchRows.rowId, input.rowId)),
    )
    .for('update')
    .limit(1);
  if (!row) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');

  const steps = await tx
    .select()
    .from(rowDomainSteps)
    .where(eq(rowDomainSteps.batchRowId, row.id))
    .for('update');
  const required = new Set(row.requiredDomains);
  if (
    steps.length !== required.size ||
    steps.some((step) => !required.has(step.domain))
  ) {
    inconsistent(
      'Persisted required domains do not match persisted workflow steps',
    );
  }
  const changes = new Map<BulkDomain, WorkflowStepChange>();
  for (const change of input.steps) {
    if (!required.has(change.domain) || changes.has(change.domain))
      inconsistent('Invalid or duplicate workflow domain');
    changes.set(change.domain, change);
  }
  for (const change of changes.values()) {
    const previous = steps.find((step) => step.domain === change.domain);
    if (previous?.status === 'COMPLETED' && change.status !== 'COMPLETED')
      inconsistent('A completed domain step cannot be reverted');
    await tx
      .update(rowDomainSteps)
      .set({
        status: change.status,
        errorCode: change.errorCode ?? null,
        errorDetail: change.errorDetail ?? null,
      })
      .where(
        and(
          eq(rowDomainSteps.batchRowId, row.id),
          eq(rowDomainSteps.domain, change.domain),
        ),
      );
  }
  const statusByDomain = new Map(
    steps.map((step) => [
      step.domain as BulkDomain,
      changes.get(step.domain as BulkDomain)?.status ?? step.status,
    ]),
  );
  const appliedDomains = row.requiredDomains.filter(
    (domain) =>
      row.appliedDomains.includes(domain) ||
      statusByDomain.get(domain as BulkDomain) === 'COMPLETED',
  );
  if (row.status === 'COMPLETED' && input.status !== 'COMPLETED')
    inconsistent('A completed row cannot be reverted');
  if (
    input.status === 'COMPLETED' &&
    row.requiredDomains.some(
      (domain) => statusByDomain.get(domain as BulkDomain) !== 'COMPLETED',
    )
  ) {
    inconsistent(
      'A completed row requires every required domain step to be completed',
    );
  }
  const failedDomain = input.failedDomain ?? null;
  if (
    input.status === 'FAILED' &&
    (!failedDomain || statusByDomain.get(failedDomain) !== 'FAILED')
  ) {
    inconsistent('A failed row requires a failed required domain step');
  }
  const needsReconciliation =
    input.status === 'FAILED' && appliedDomains.length > 0;
  if (
    input.needsReconciliation !== undefined &&
    input.needsReconciliation !== needsReconciliation
  ) {
    inconsistent(
      'Reconciliation flag does not match row state and applied domains',
    );
  }
  await tx
    .update(batchRows)
    .set({
      status: input.status,
      appliedDomains,
      failedDomain,
      needsReconciliation,
      errorCode: input.errorCode ?? null,
      errorDetail: input.errorDetail ?? null,
    })
    .where(eq(batchRows.id, row.id));

  const [counts] = await tx
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) FILTER (WHERE ${batchRows.status} = 'COMPLETED')::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${batchRows.status} = 'FAILED')::int`,
    })
    .from(batchRows)
    .where(eq(batchRows.batchJobId, batch.id));
  const total = counts?.total ?? 0;
  const completed = counts?.completed ?? 0;
  const failed = counts?.failed ?? 0;
  const terminal =
    completed + failed === batch.totalRows && total === batch.totalRows;
  await tx
    .update(batchJobs)
    .set({
      status: terminal ? 'COMPLETED' : 'PROCESSING',
      completedRows: completed,
      failedRows: failed,
      needsReconciliation: failed > 0,
    })
    .where(eq(batchJobs.id, batch.id));
}

export const bulkRepositoryProvider = {
  provide: BulkPersistenceRepository,
  inject: [BULK_DATABASE],
  useFactory: (db: BulkDatabase | null) => new BulkPersistenceRepository(db),
};
