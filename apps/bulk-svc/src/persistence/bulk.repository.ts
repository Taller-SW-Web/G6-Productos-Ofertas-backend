import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  batchJobs,
  batchResumeRequests,
  batchRows,
  domainAttempts,
  contentDocuments,
  exportJobs,
  fileManifests,
  inbox,
  outbox,
  rowDomainSteps,
  retryCommands,
} from './bulk.schema.js';
import { BULK_DATABASE, type BulkDatabase } from './bulk.database.js';
import {
  BulkPersistenceError,
  persistenceError,
} from './bulk.persistence.errors.js';
import { BulkDomainError } from '../domain/bulk.domain-error.js';
import { matchesBulkStorageReference } from '../storage/bulk-storage-reference.js';

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
  ownerSub: string;
  templateVersion: number;
  correlationId: string;
  inputFile: Omit<FileManifestInput, 'role'>;
  rows: ImportRowInput[];
  admissionIntent?: Record<string, unknown>;
  catalogCommands?: OutboxInput[];
  contentDocument?: {
    contentId: string;
    batchId: string;
    batchOperationId: string;
    contentRef: string;
    sha256: string;
    byteLength: number;
  };
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
  ownerSub: string;
  format: BulkFileFormat;
}
export interface ExportSnapshotMetadata {
  requestedAt: string;
  catalogObservedAt: string;
  pricingObservedAt: string;
  inventoryObservedAt: string;
  catalogVersion: string;
  pricingVersion: string;
  inventoryVersion: string;
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
export interface PendingContractResult {
  messageId: string;
  eventName: string;
  correlationId: string;
  payload: Record<string, unknown>;
}
export interface InboxMutationContext {
  updateWorkflowState(input: UpdateWorkflowStateInput): Promise<void>;
}

export interface DomainResultInput {
  batchId: string;
  rowId: string;
  domain: BulkDomain;
  operationId: string;
  messageId: string;
  correlationId: string;
  causationId?: string | null;
  eventName: string;
  action:
    | 'UPSERT'
    | 'PRICE_INITIALIZATION'
    | 'SKU_INITIALIZATION'
    | 'STOCK_ADJUSTMENT';
  skuId?: string;
  status: 'COMPLETED' | 'FAILED';
  errorCode?: string | null;
  errorDetail?: string | null;
}

export interface CatalogBulkResultInput {
  messageId: string;
  operationId: string;
  causationId: string;
  eventName: 'catalog.bulk.upsert.completed' | 'catalog.bulk.upsert.rejected';
  correlationId: string;
  payload: Record<string, unknown>;
}

type BulkTx = Parameters<Parameters<BulkDatabase['transaction']>[0]>[0];

const inconsistent = (message: string): never => {
  throw new BulkPersistenceError('CHECK_VIOLATION', new Error(message));
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function admissionIntentWithoutCommandTimes(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const commands = Array.isArray(value.catalogCommands)
    ? value.catalogCommands.map((item) => {
        if (typeof item !== 'object' || item === null) return item;
        const command = structuredClone(item) as Record<string, unknown>;
        if (typeof command.occurred_at === 'string')
          command.occurred_at = '<persisted-at-first-admission>';
        return command;
      })
    : value.catalogCommands;
  return { ...value, catalogCommands: commands };
}

const domainFailure = (
  code:
    | 'INVALID_INPUT'
    | 'IDEMPOTENCY_CONFLICT'
    | 'INVALID_TRANSITION'
    | 'DEPENDENCY_PENDING'
    | 'PERSISTENCE_FAILURE',
  message: string,
): never => {
  throw new BulkDomainError(code, message);
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
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.batchId}, 0))`,
        );
        const [existingBatch] = await tx
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, input.batchId))
          .for('update')
          .limit(1);
        if (existingBatch) {
          if (existingBatch.ownerSub !== input.ownerSub)
            throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
          const [intentReceipt] = await tx
            .select()
            .from(inbox)
            .where(
              and(
                eq(inbox.messageId, input.batchId),
                eq(inbox.handler, 'bulk.import.admission'),
              ),
            )
            .limit(1);
          const sameIntent =
            intentReceipt && input.admissionIntent
              ? canonicalJson(
                  admissionIntentWithoutCommandTimes(
                    intentReceipt.payload as Record<string, unknown>,
                  ),
                ) ===
                canonicalJson(
                  admissionIntentWithoutCommandTimes(input.admissionIntent),
                )
              : false;
          if (!sameIntent) {
            throw new BulkPersistenceError('UNIQUE_CONFLICT');
          }
          const [manifest] = await tx
            .select({
              id: fileManifests.id,
              role: fileManifests.role,
              format: fileManifests.format,
              contentRef: fileManifests.contentRef,
              createdAt: fileManifests.createdAt,
              updatedAt: fileManifests.updatedAt,
            })
            .from(fileManifests)
            .where(eq(fileManifests.id, existingBatch.inputFileId))
            .limit(1);
          if (!manifest)
            throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
          const joined = await tx
            .select({ row: batchRows, step: rowDomainSteps })
            .from(batchRows)
            .leftJoin(
              rowDomainSteps,
              eq(rowDomainSteps.batchRowId, batchRows.id),
            )
            .where(eq(batchRows.batchJobId, existingBatch.id))
            .orderBy(
              asc(batchRows.createdAt),
              asc(batchRows.id),
              asc(rowDomainSteps.domain),
            );
          const grouped = new Map<
            string,
            CreateImportBatchResult['rows'][number]
          >();
          for (const item of joined) {
            let existing = grouped.get(item.row.id);
            if (!existing) {
              existing = { row: item.row, steps: [] };
              grouped.set(item.row.id, existing);
            }
            if (item.step) existing.steps.push(item.step);
          }
          const resultRows = [...grouped.values()];
          return { manifest, batch: existingBatch, rows: resultRows };
        }
        const [manifest] = await tx
          .insert(fileManifests)
          .values({
            role: 'ENTRADA_IMPORTACION',
            format: input.inputFile.format,
            contentRef: input.inputFile.contentRef,
          })
          .returning({
            id: fileManifests.id,
            role: fileManifests.role,
            format: fileManifests.format,
            contentRef: fileManifests.contentRef,
            createdAt: fileManifests.createdAt,
            updatedAt: fileManifests.updatedAt,
          });
        if (!manifest) throw new Error('Manifest insert returned no row');
        const [batch] = await tx
          .insert(batchJobs)
          .values({
            batchId: input.batchId,
            ownerSub: input.ownerSub,
            inputFileId: manifest.id,
            status: 'QUEUED',
            templateVersion: input.templateVersion,
            correlationId: input.correlationId,
            totalRows: input.rows.length,
          })
          .returning();
        if (!batch) throw new Error('Batch insert returned no row');
        const rows = input.rows.length
          ? await tx
              .insert(batchRows)
              .values(
                input.rows.map((rowInput) => ({
                  batchJobId: batch.id,
                  rowId: rowInput.rowId,
                  requiredDomains: rowInput.requiredDomains,
                })),
              )
              .returning()
          : [];
        if (rows.length !== input.rows.length)
          throw new Error('Incomplete batch row insert');
        const rowsById = new Map(rows.map((row) => [row.rowId, row]));
        const stepInputs = input.rows.flatMap((rowInput) => {
          const row = rowsById.get(rowInput.rowId);
          if (!row) throw new Error('Batch row insert returned no row');
          return rowInput.requiredDomains.map((domain) => ({
            batchRowId: row.id,
            domain,
          }));
        });
        const steps = stepInputs.length
          ? await tx.insert(rowDomainSteps).values(stepInputs).returning()
          : [];
        if (steps.length !== stepInputs.length)
          throw new Error('Incomplete step insert');
        const stepsByRow = new Map<string, typeof steps>();
        for (const step of steps) {
          const group = stepsByRow.get(step.batchRowId) ?? [];
          group.push(step);
          stepsByRow.set(step.batchRowId, group);
        }
        const createdRows = rows.map((row) => ({
          row,
          steps: stepsByRow.get(row.id) ?? [],
        }));
        if (input.contentDocument) {
          if (
            input.contentDocument.batchId !== input.batchId ||
            !Number.isSafeInteger(input.contentDocument.byteLength) ||
            input.contentDocument.byteLength < 1 ||
            !/^[a-f0-9]{64}$/.test(input.contentDocument.sha256)
          )
            throw new BulkPersistenceError('CHECK_VIOLATION');
          await tx.insert(contentDocuments).values({
            ...input.contentDocument,
            contentType: 'application/json',
          });
        }
        if (input.admissionIntent) {
          await tx.insert(inbox).values({
            messageId: input.batchId,
            handler: 'bulk.import.admission',
            eventName: 'bulk.import.admission',
            correlationId: input.correlationId,
            payload: input.admissionIntent,
            result: 'ADMITTED',
          });
        }
        for (const command of input.catalogCommands ?? []) {
          await tx.insert(outbox).values({
            messageId: command.messageId,
            eventName: command.eventName,
            kind: command.kind,
            schemaVersion: command.schemaVersion ?? 1,
            correlationId: command.correlationId,
            causationId: command.causationId ?? null,
            operationId: command.operationId ?? null,
            occurredAt: command.occurredAt,
            payload: command.payload,
          });
        }
        return { manifest, batch, rows: createdRows };
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async recordDomainResult(
    input: DomainResultInput,
  ): Promise<{ processed: boolean; result: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, input.batchId))
          .for('update')
          .limit(1);
        if (!batch) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        if (input.correlationId !== batch.correlationId)
          domainFailure(
            'INVALID_INPUT',
            'Result correlation_id does not match its batch',
          );
        const [row] = await tx
          .select()
          .from(batchRows)
          .where(
            and(
              eq(batchRows.batchJobId, batch.id),
              eq(batchRows.rowId, input.rowId),
            ),
          )
          .for('update')
          .limit(1);
        if (!row) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        const expectedEvent =
          input.status === 'COMPLETED' ? 'completed' : 'rejected';
        const payload = {
          batchId: input.batchId,
          rowId: input.rowId,
          domain: input.domain,
          operationId: input.operationId,
          causationId: input.causationId ?? null,
          action: input.action,
          skuId: input.skuId ?? null,
          status: input.status,
          errorCode: input.errorCode ?? null,
          errorDetail: input.errorDetail ?? null,
        };
        const handler = 'bulk.domain-result';
        const [byMessage] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, input.messageId),
              eq(inbox.handler, handler),
            ),
          )
          .limit(1);
        if (byMessage) {
          const [sameMessage] = await tx
            .select({ id: inbox.id })
            .from(inbox)
            .where(
              and(
                eq(inbox.id, byMessage.id),
                eq(inbox.eventName, input.eventName),
                eq(inbox.correlationId, input.correlationId),
                sql`${inbox.payload} = ${JSON.stringify(payload)}::jsonb`,
              ),
            )
            .limit(1);
          if (!sameMessage) {
            domainFailure(
              'IDEMPOTENCY_CONFLICT',
              'message_id was reused with a different result intent',
            );
          }
          return { processed: false, result: byMessage.result };
        }
        const [byOperation] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.handler, handler),
              sql`${inbox.payload}->>'operationId' = ${input.operationId}`,
              sql`${inbox.payload}->>'batchId' = ${input.batchId}`,
              sql`${inbox.payload}->>'rowId' = ${input.rowId}`,
              sql`${inbox.payload}->>'domain' = ${input.domain}`,
              sql`${inbox.payload}->>'action' = ${input.action}`,
            ),
          )
          .orderBy(desc(inbox.createdAt))
          .limit(1);
        if (byOperation) {
          const [sameOperation] = await tx
            .select({ id: inbox.id })
            .from(inbox)
            .where(
              and(
                eq(inbox.id, byOperation.id),
                eq(inbox.eventName, input.eventName),
                eq(inbox.correlationId, input.correlationId),
                sql`${inbox.payload} = ${JSON.stringify(payload)}::jsonb`,
              ),
            )
            .limit(1);
          if (sameOperation) {
            return { processed: false, result: byOperation.result };
          } else {
            const [authorizedRequeue] = await tx
              .select({ id: inbox.id })
              .from(inbox)
              .where(
                and(
                  eq(inbox.handler, 'bulk.batch.requeue'),
                  sql`${inbox.payload}->>'batchId' = ${input.batchId}`,
                  sql`${inbox.createdAt} > ${byOperation.createdAt}`,
                ),
              )
              .limit(1);
            const priorAttemptFailed = byOperation.result === 'FAILED';
            const newAttempt =
              input.causationId !== null &&
              input.causationId !== undefined &&
              input.causationId !== byOperation.payload.causationId;
            if (!authorizedRequeue || !priorAttemptFailed || !newAttempt) {
              domainFailure(
                'IDEMPOTENCY_CONFLICT',
                'operation_id was reused with a different result intent',
              );
            }
          }
        }
        if (
          batch.status === 'COMPLETED' ||
          batch.status === 'FAILED_GENERAL' ||
          row.status === 'COMPLETED' ||
          row.status === 'FAILED'
        ) {
          domainFailure(
            'INVALID_TRANSITION',
            'A terminal result cannot reopen a row or batch without an explicit requeue',
          );
        }
        const [catalogStep] = await tx
          .select()
          .from(rowDomainSteps)
          .where(
            and(
              eq(rowDomainSteps.batchRowId, row.id),
              eq(rowDomainSteps.domain, 'CATALOGO'),
            ),
          )
          .limit(1);
        if (
          input.domain !== 'CATALOGO' &&
          catalogStep?.status !== 'COMPLETED'
        ) {
          domainFailure(
            'DEPENDENCY_PENDING',
            'Dependent domain result arrived before Catalog confirmation',
          );
        }
        if (!row.requiredDomains.includes(input.domain))
          domainFailure(
            'INVALID_INPUT',
            'Result domain is not required by this row',
          );
        const [admission] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, input.batchId),
              eq(inbox.handler, 'bulk.import.admission'),
            ),
          )
          .limit(1);
        if (!admission)
          domainFailure(
            'PERSISTENCE_FAILURE',
            'Normalized row intent is not durably available',
          );
        const intentRowsValue = admission.payload.rows;
        if (!Array.isArray(intentRowsValue))
          domainFailure(
            'PERSISTENCE_FAILURE',
            'Persisted normalized intent is incomplete',
          );
        const intentRows = intentRowsValue as unknown[];
        const normalized = intentRows.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            Reflect.get(candidate, 'rowId') === input.rowId,
        ) as Record<string, unknown> | undefined;
        if (!normalized)
          domainFailure(
            'INVALID_INPUT',
            'Result row does not exist in persisted normalized intent',
          );
        const normalizedRow = normalized as Record<string, unknown>;
        const skuIds = Array.isArray(normalizedRow.vendibleSkus)
          ? normalizedRow.vendibleSkus
          : [];
        if (
          input.domain === 'CATALOGO' &&
          (input.action !== 'UPSERT' ||
            input.eventName !== 'catalog.bulk.upsert.completed')
        )
          domainFailure(
            'INVALID_INPUT',
            'Bulk row results must be adapted from catalog.bulk.upsert.completed; catalog.bulk.upsert.rejected rejects the command as a whole.',
          );
        if (
          input.domain === 'PRICING' &&
          (input.action !== 'PRICE_INITIALIZATION' ||
            input.causationId == null ||
            (input.status === 'COMPLETED'
              ? input.eventName !== 'pricing.product.initialization.completed'
              : input.eventName !== 'pricing.product.initialization.rejected'))
        )
          inconsistent(
            'Pricing ALTA results must preserve initialization event, operation_id and causation_id identities.',
          );
        if (input.domain === 'INVENTARIO') {
          if (
            input.action === 'SKU_INITIALIZATION' &&
            (input.eventName !==
              `inventory.sku.initialization.${expectedEvent}` ||
              typeof input.skuId !== 'string' ||
              !skuIds.includes(input.skuId))
          )
            domainFailure(
              'INVALID_INPUT',
              'Inventory SKU result is not part of the normalized row intent',
            );
          if (
            input.action === 'STOCK_ADJUSTMENT' &&
            (input.eventName !==
              `inventory.bulk.stock.adjust.${expectedEvent}` ||
              Number(normalizedRow.stockInicial ?? 0) <= 0 ||
              !normalizedRow.defaultLocationId)
          )
            domainFailure(
              'INVALID_INPUT',
              'Inventory stock adjustment is not required by the normalized row intent',
            );
          if (
            input.action !== 'SKU_INITIALIZATION' &&
            input.action !== 'STOCK_ADJUSTMENT'
          )
            domainFailure(
              'INVALID_INPUT',
              'Inventory result action is invalid',
            );
        }
        const [step] = await tx
          .select()
          .from(rowDomainSteps)
          .where(
            and(
              eq(rowDomainSteps.batchRowId, row.id),
              eq(rowDomainSteps.domain, input.domain),
            ),
          )
          .for('update')
          .limit(1);
        if (!step)
          domainFailure(
            'PERSISTENCE_FAILURE',
            'Required workflow step is missing',
          );
        if (step.status === 'COMPLETED')
          domainFailure(
            'INVALID_TRANSITION',
            'A confirmed domain cannot accept a new operation result',
          );
        if (step.status === 'FAILED')
          domainFailure(
            'INVALID_TRANSITION',
            'A failed domain step cannot be retried before batch requeue',
          );
        if (
          input.domain === 'INVENTARIO' &&
          input.action === 'STOCK_ADJUSTMENT'
        ) {
          const activeSince = await findActiveRunStart(tx, batch);
          const earlierSkuReceipts = await tx
            .select()
            .from(inbox)
            .where(
              and(
                eq(inbox.handler, handler),
                sql`${inbox.payload}->>'batchId' = ${input.batchId}`,
                sql`${inbox.payload}->>'rowId' = ${input.rowId}`,
                sql`${inbox.payload}->>'action' = 'SKU_INITIALIZATION'`,
                sql`${inbox.createdAt} >= ${activeSince}`,
              ),
            );
          const completedSkuIds = earlierSkuReceipts
            .filter((receipt) => receipt.payload.status === 'COMPLETED')
            .map((receipt) => receipt.payload.skuId);
          if (skuIds.some((sku) => !completedSkuIds.includes(sku)))
            domainFailure(
              'DEPENDENCY_PENDING',
              'Stock adjustment result cannot precede all SKU initialization confirmations',
            );
        }
        await tx.insert(inbox).values({
          messageId: input.messageId,
          handler,
          eventName: input.eventName,
          correlationId: input.correlationId,
          payload,
          result: input.status,
        });
        let stepStatus: BulkStepStatus = input.status;
        if (input.domain === 'INVENTARIO' && input.status === 'COMPLETED') {
          const activeSince = await findActiveRunStart(tx, batch);
          const results = await tx
            .select()
            .from(inbox)
            .where(
              and(
                eq(inbox.handler, handler),
                sql`${inbox.payload}->>'batchId' = ${input.batchId}`,
                sql`${inbox.payload}->>'rowId' = ${input.rowId}`,
                sql`${inbox.payload}->>'domain' = 'INVENTARIO'`,
                sql`${inbox.createdAt} >= ${activeSince}`,
              ),
            );
          const completedSkuIds = results
            .filter(
              (receipt) =>
                receipt.payload.action === 'SKU_INITIALIZATION' &&
                receipt.payload.status === 'COMPLETED',
            )
            .map((receipt) => receipt.payload.skuId);
          const adjustmentRequired =
            Number(normalizedRow.stockInicial ?? 0) > 0 &&
            Boolean(normalizedRow.defaultLocationId);
          const adjustmentComplete = results.some(
            (receipt) =>
              receipt.payload.action === 'STOCK_ADJUSTMENT' &&
              receipt.payload.status === 'COMPLETED',
          );
          const inventoryFailed = results.some(
            (receipt) => receipt.payload.status === 'FAILED',
          );
          if (inventoryFailed) stepStatus = 'FAILED';
          else if (
            Number(normalizedRow.stockInicial ?? 0) > 0 &&
            !normalizedRow.defaultLocationId &&
            skuIds.every((sku) => completedSkuIds.includes(sku))
          )
            stepStatus = 'FAILED';
          else
            stepStatus =
              skuIds.every((sku) => completedSkuIds.includes(sku)) &&
              (!adjustmentRequired || adjustmentComplete)
                ? 'COMPLETED'
                : 'PROCESSING';
        }
        const currentSteps = await tx
          .select()
          .from(rowDomainSteps)
          .where(eq(rowDomainSteps.batchRowId, row.id));
        const stepChanges: WorkflowStepChange[] = [
          {
            domain: input.domain,
            status: stepStatus,
            errorCode:
              stepStatus === 'FAILED'
                ? (input.errorCode ??
                  (input.domain === 'INVENTARIO' &&
                  Number(normalizedRow.stockInicial ?? 0) > 0 &&
                  !normalizedRow.defaultLocationId
                    ? 'DEFAULT_LOCATION_REQUIRED'
                    : 'DOMAIN_REJECTED'))
                : null,
            errorDetail:
              stepStatus === 'FAILED'
                ? (input.errorDetail ??
                  (input.domain === 'INVENTARIO' &&
                  Number(normalizedRow.stockInicial ?? 0) > 0 &&
                  !normalizedRow.defaultLocationId
                    ? 'No existe ubicación predeterminada para aplicar el stock inicial.'
                    : null))
                : null,
          },
        ];
        if (input.domain === 'CATALOGO' && stepStatus === 'FAILED') {
          for (const candidate of currentSteps) {
            if (
              candidate.domain !== 'CATALOGO' &&
              candidate.status === 'PENDING'
            ) {
              stepChanges.push({
                domain: candidate.domain as BulkDomain,
                status: 'FAILED',
                errorCode: 'DEPENDENCY_REJECTED',
                errorDetail:
                  'Catálogo rechazó la fila; el paso dependiente no se ejecutó.',
              });
            }
          }
        }
        const changedByDomain = new Map<BulkDomain, WorkflowStepChange>(
          stepChanges.map((change) => [change.domain, change]),
        );
        const requiredDomains = row.requiredDomains as BulkDomain[];
        const statusFor = (domain: BulkDomain) =>
          changedByDomain.get(domain)?.status ??
          currentSteps.find((candidate) => candidate.domain === domain)
            ?.status ??
          'PENDING';
        const allTerminal = requiredDomains.every((domain) =>
          ['COMPLETED', 'FAILED'].includes(statusFor(domain)),
        );
        const allCompleted = requiredDomains.every(
          (domain) => statusFor(domain) === 'COMPLETED',
        );
        const rowStatus: BulkRowStatus = !allTerminal
          ? 'PROCESSING'
          : allCompleted
            ? 'COMPLETED'
            : 'FAILED';
        const failedDomain =
          rowStatus === 'FAILED'
            ? (requiredDomains.find(
                (domain) => statusFor(domain) === 'FAILED',
              ) ?? null)
            : null;
        const failedChange = failedDomain
          ? changedByDomain.get(failedDomain)
          : undefined;
        const previousFailure = failedDomain
          ? currentSteps.find((candidate) => candidate.domain === failedDomain)
          : undefined;
        const failedCode =
          failedChange?.errorCode ?? previousFailure?.errorCode ?? null;
        const failedDetail =
          failedChange?.errorDetail ?? previousFailure?.errorDetail ?? null;
        await updateWorkflowStateIn(tx, {
          batchId: input.batchId,
          rowId: input.rowId,
          steps: stepChanges,
          status: rowStatus,
          failedDomain,
          errorCode: failedCode,
          errorDetail: failedDetail,
        });
        const response = failedDomain
          ? 'FAILED'
          : stepStatus === 'COMPLETED'
            ? 'DOMAIN_COMPLETED'
            : 'PROCESSING';
        await tx
          .update(inbox)
          .set({ result: response })
          .where(
            and(
              eq(inbox.messageId, input.messageId),
              eq(inbox.handler, handler),
            ),
          );
        return { processed: true, result: response };
      });
    } catch (error) {
      if (error instanceof BulkDomainError) throw error;
      throw persistenceError(error);
    }
  }

  async recordCatalogBulkResult(
    input: CatalogBulkResultInput,
  ): Promise<{ processed: boolean; result: string }> {
    if (input.payload.schema_version === 2)
      return this.recordCatalogBulkResultV2(input);
    const messageHandler = 'bulk.catalog.bulk-upsert.result';
    try {
      return await this.db.transaction(async (tx) => {
        const envelope = input.payload;
        const data = envelope.data as Record<string, unknown>;
        if (
          !data ||
          envelope.message_id !== input.messageId ||
          envelope.operation_id !== input.operationId ||
          envelope.causation_id !== input.causationId ||
          envelope.correlation_id !== input.correlationId ||
          envelope.name !== input.eventName ||
          envelope.producer !== 'catalog-svc' ||
          envelope.kind !== 'result' ||
          envelope.schema_version !== 1
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog result envelope identity is inconsistent.',
          );
        const batchIdValue = data?.batch_id;
        if (typeof batchIdValue !== 'string')
          domainFailure('INVALID_INPUT', 'Catalog result has no batch_id.');
        const batchId = batchIdValue as string;
        const resultData = data as Record<string, unknown>;
        const [batch] = await tx
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, batchId))
          .for('update')
          .limit(1);
        if (!batch)
          domainFailure('INVALID_INPUT', 'Catalog result batch is unknown.');
        if (input.correlationId !== batch.correlationId)
          domainFailure(
            'INVALID_INPUT',
            'Catalog result correlation_id does not match its batch.',
          );
        const [admission] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, batchId),
              eq(inbox.handler, 'bulk.import.admission'),
            ),
          )
          .limit(1);
        const admissionPayload = admission?.payload;
        if (!admissionPayload)
          domainFailure(
            'PERSISTENCE_FAILURE',
            'The admitted batch command relationship is missing.',
          );
        const catalogCommands = Array.isArray(admissionPayload.catalogCommands)
          ? admissionPayload.catalogCommands
          : [];
        const matchingCommand = catalogCommands.find((candidate) => {
          if (typeof candidate !== 'object' || candidate === null) return false;
          const command = candidate as Record<string, unknown>;
          return (
            command.message_id === input.causationId &&
            command.operation_id === input.operationId
          );
        }) as Record<string, unknown> | undefined;
        if (!matchingCommand)
          domainFailure(
            'INVALID_INPUT',
            'Catalog result causation/operation identity does not match an admitted command.',
          );
        const commandData = (matchingCommand as Record<string, unknown>)
          .data as Record<string, unknown> | undefined;
        const batchOperationId =
          typeof commandData?.batch_operation_id === 'string'
            ? commandData.batch_operation_id
            : domainFailure(
                'INVALID_INPUT',
                'Admitted Catalog chunk has no batch_operation_id.',
              );
        if (resultData.batch_operation_id !== batchOperationId)
          domainFailure(
            'INVALID_INPUT',
            'Catalog result batch_operation_id does not match its admitted chunk.',
          );
        const commandRows = Array.isArray(commandData?.rows)
          ? commandData.rows
          : [];
        const admittedRows = Array.isArray(admissionPayload.rows)
          ? admissionPayload.rows
          : [];
        const commandRowOperations = new Set(
          commandRows.map((value) =>
            typeof value === 'object' && value !== null
              ? Reflect.get(value, 'row_operation_id')
              : null,
          ),
        );
        const normalizedRows = admittedRows.filter(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            commandRowOperations.has(Reflect.get(value, 'rowOperationId')),
        );
        const normalizedByOperationId = new Map<
          string,
          Record<string, unknown>
        >();
        for (const candidate of normalizedRows) {
          if (typeof candidate !== 'object' || candidate === null) continue;
          const row = candidate as Record<string, unknown>;
          if (
            typeof row.rowOperationId === 'string' &&
            !normalizedByOperationId.has(row.rowOperationId)
          )
            normalizedByOperationId.set(row.rowOperationId, row);
        }
        const [existingMessage] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, input.messageId),
              eq(inbox.handler, messageHandler),
            ),
          )
          .limit(1);
        if (existingMessage) {
          const same =
            existingMessage.eventName === input.eventName &&
            existingMessage.correlationId === input.correlationId &&
            canonicalJson(existingMessage.payload) ===
              canonicalJson(input.payload);
          if (!same)
            domainFailure(
              'IDEMPOTENCY_CONFLICT',
              'message_id was reused with a different Catalog result.',
            );
          return { processed: false, result: existingMessage.result };
        }

        const rawResults =
          input.eventName === 'catalog.bulk.upsert.completed'
            ? resultData.results
            : null;
        if (
          input.eventName === 'catalog.bulk.upsert.completed' &&
          (!Array.isArray(rawResults) || rawResults.length === 0)
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog completed result must include row results.',
          );
        const results: Array<{
          row_number: number;
          row_operation_id: string;
          product_id: string | null;
          sku_base: string;
          status: 'COMPLETED' | 'REJECTED';
          code: string | null;
        }> =
          input.eventName === 'catalog.bulk.upsert.completed'
            ? (rawResults as Array<{
                row_number: number;
                row_operation_id: string;
                product_id: string | null;
                sku_base: string;
                status: 'COMPLETED' | 'REJECTED';
                code: string | null;
              }>)
            : normalizedRows.map((value) => {
                const row = value as Record<string, unknown>;
                return {
                  row_number: Number(row.rowNumber),
                  row_operation_id: String(row.rowOperationId),
                  product_id: null,
                  sku_base: String(row.skuBase),
                  status: 'REJECTED',
                  code: String(resultData.code),
                };
              });
        if (
          input.eventName === 'catalog.bulk.upsert.rejected' &&
          (!resultData.code || typeof resultData.detail !== 'string')
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog rejected result is missing its command-level reason.',
          );
        const seen = new Set<string>();
        for (const result of results) {
          const normalized = normalizedByOperationId.get(
            result.row_operation_id,
          );
          if (
            !normalized ||
            seen.has(result.row_operation_id) ||
            Number(normalized.rowNumber) !== result.row_number ||
            normalized.skuBase !== result.sku_base
          )
            domainFailure(
              'INVALID_INPUT',
              'Catalog result row identity does not belong to the admitted batch.',
            );
          seen.add(result.row_operation_id);
          if (
            input.eventName === 'catalog.bulk.upsert.completed' &&
            (result.status === 'COMPLETED'
              ? result.code !== null
              : typeof result.code !== 'string')
          )
            domainFailure(
              'INVALID_INPUT',
              'Catalog row status and code are inconsistent.',
            );

          const rowId = String((normalized as Record<string, unknown>).rowId);
          const rowHandler = `bulk.catalog-result-row:${result.row_operation_id}`;
          const rowIntent = {
            batchId,
            batchOperationId,
            eventName: input.eventName,
            result,
          };
          const [priorOperation] = await tx
            .select()
            .from(inbox)
            .where(and(eq(inbox.handler, rowHandler)))
            .orderBy(desc(inbox.createdAt))
            .limit(1);
          if (priorOperation) {
            if (
              canonicalJson(priorOperation.payload) !== canonicalJson(rowIntent)
            )
              domainFailure(
                'IDEMPOTENCY_CONFLICT',
                'row_operation_id was replayed with a different Catalog result.',
              );
            continue;
          }
          const [row] = await tx
            .select()
            .from(batchRows)
            .where(
              and(
                eq(batchRows.batchJobId, batch.id),
                eq(batchRows.rowId, rowId),
              ),
            )
            .for('update')
            .limit(1);
          if (!row)
            domainFailure(
              'INVALID_INPUT',
              'Catalog result row is not persisted.',
            );
          const [step] = await tx
            .select()
            .from(rowDomainSteps)
            .where(
              and(
                eq(rowDomainSteps.batchRowId, row.id),
                eq(rowDomainSteps.domain, 'CATALOGO'),
              ),
            )
            .for('update')
            .limit(1);
          if (!step || !row.requiredDomains.includes('CATALOGO'))
            domainFailure(
              'INVALID_INPUT',
              'Catalog result does not match a required workflow step.',
            );
          if (step.status === 'COMPLETED' || step.status === 'FAILED') {
            domainFailure(
              'INVALID_TRANSITION',
              'Catalog step is already terminal.',
            );
          }
          const status = result.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
          const pendingSteps = await tx
            .select()
            .from(rowDomainSteps)
            .where(eq(rowDomainSteps.batchRowId, row.id));
          const changes: WorkflowStepChange[] = [
            {
              domain: 'CATALOGO',
              status,
              errorCode:
                status === 'FAILED'
                  ? (result.code ?? 'CATALOG_REJECTED')
                  : null,
              errorDetail:
                status === 'FAILED'
                  ? input.eventName === 'catalog.bulk.upsert.rejected'
                    ? String(resultData.detail)
                    : null
                  : null,
            },
          ];
          if (status === 'FAILED') {
            for (const dependency of pendingSteps) {
              if (
                dependency.domain !== 'CATALOGO' &&
                dependency.status === 'PENDING'
              )
                changes.push({
                  domain: dependency.domain as BulkDomain,
                  status: 'FAILED',
                  errorCode: 'DEPENDENCY_REJECTED',
                  errorDetail:
                    'Catalog rechazó la fila; el paso dependiente no se ejecutó.',
                });
            }
          }
          const statusByDomain = new Map(
            changes.map((change) => [change.domain, change.status]),
          );
          const allTerminal = row.requiredDomains.every((domain) => {
            const current =
              statusByDomain.get(domain as BulkDomain) ??
              pendingSteps.find((candidate) => candidate.domain === domain)
                ?.status;
            return current === 'COMPLETED' || current === 'FAILED';
          });
          const allCompleted = row.requiredDomains.every(
            (domain) =>
              (statusByDomain.get(domain as BulkDomain) ??
                pendingSteps.find((candidate) => candidate.domain === domain)
                  ?.status) === 'COMPLETED',
          );
          const rowStatus: BulkRowStatus = !allTerminal
            ? 'PROCESSING'
            : allCompleted
              ? 'COMPLETED'
              : 'FAILED';
          await updateWorkflowStateIn(tx, {
            batchId,
            rowId,
            steps: changes,
            status: rowStatus,
            failedDomain:
              rowStatus === 'FAILED'
                ? (changes.find((change) => change.status === 'FAILED')
                    ?.domain ?? 'CATALOGO')
                : null,
            errorCode:
              status === 'FAILED' ? (result.code ?? 'CATALOG_REJECTED') : null,
            errorDetail:
              status === 'FAILED' &&
              input.eventName === 'catalog.bulk.upsert.rejected'
                ? String(resultData.detail)
                : null,
          });
          await tx.insert(inbox).values({
            messageId: input.messageId,
            handler: rowHandler,
            eventName: input.eventName,
            correlationId: input.correlationId,
            payload: rowIntent,
            result: status,
          });
        }
        if (
          input.eventName === 'catalog.bulk.upsert.completed' &&
          seen.size !== normalizedRows.length
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog result omitted one or more admitted rows.',
          );
        const outcome =
          input.eventName === 'catalog.bulk.upsert.rejected'
            ? 'COMMAND_REJECTED'
            : 'RESULTS_APPLIED';
        await tx.insert(inbox).values({
          messageId: input.messageId,
          handler: messageHandler,
          eventName: input.eventName,
          correlationId: input.correlationId,
          payload: input.payload,
          result: outcome,
        });
        await tx
          .update(outbox)
          .set({
            publishedAt: sql`coalesce(${outbox.publishedAt}, now())`,
            lastError: null,
          })
          .where(
            and(
              eq(outbox.messageId, input.causationId),
              eq(outbox.eventName, 'catalog.bulk.upsert.requested'),
              sql`${outbox.publishedAt} IS NULL`,
            ),
          );
        return { processed: true, result: outcome };
      });
    } catch (error) {
      if (error instanceof BulkDomainError) throw error;
      throw persistenceError(error);
    }
  }

  private async recordCatalogBulkResultV2(
    input: CatalogBulkResultInput,
  ): Promise<{ processed: boolean; result: string }> {
    const messageHandler = 'bulk.catalog.bulk-upsert.result';
    try {
      return await this.db.transaction(async (tx) => {
        const envelope = input.payload;
        const data = envelope.data as Record<string, unknown>;
        if (
          !data ||
          envelope.message_id !== input.messageId ||
          envelope.operation_id !== input.operationId ||
          envelope.causation_id !== input.causationId ||
          envelope.correlation_id !== input.correlationId ||
          envelope.name !== input.eventName ||
          envelope.producer !== 'catalog-svc' ||
          envelope.kind !== 'result' ||
          envelope.schema_version !== 2 ||
          (input.eventName === 'catalog.bulk.upsert.completed' &&
            (!Array.isArray(data.results) || data.results.length === 0)) ||
          (input.eventName === 'catalog.bulk.upsert.rejected' &&
            (typeof data.code !== 'string' ||
              typeof data.detail !== 'string' ||
              Array.isArray(data.results))) ||
          ![
            'catalog.bulk.upsert.completed',
            'catalog.bulk.upsert.rejected',
          ].includes(input.eventName)
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog V2 result envelope is incomplete.',
          );
        const commandAttemptId = data.command_attempt_id;
        if (commandAttemptId !== null && typeof commandAttemptId !== 'string')
          domainFailure(
            'INVALID_INPUT',
            'Catalog V2 command_attempt_id is invalid.',
          );
        const [batch] = await tx
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.batchId, String(data.batch_id)))
          .for('update')
          .limit(1);
        if (!batch)
          domainFailure('INVALID_INPUT', 'Catalog result batch is unknown.');
        const [admission] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, batch.batchId),
              eq(inbox.handler, 'bulk.import.admission'),
            ),
          )
          .limit(1);
        if (!admission)
          domainFailure(
            'PERSISTENCE_FAILURE',
            'Admitted batch intent is missing.',
          );
        const admissionRows = Array.isArray(admission.payload.rows)
          ? admission.payload.rows
          : [];
        const normalized = new Map<string, Record<string, unknown>>();
        for (const value of admissionRows) {
          if (typeof value !== 'object' || value === null) continue;
          const row = value as Record<string, unknown>;
          const rowOperationId = row.rowOperationId;
          if (
            typeof rowOperationId !== 'string' ||
            row.rowId !== rowOperationId ||
            normalized.has(rowOperationId)
          )
            domainFailure(
              'INVALID_INPUT',
              'Normalized admitted row identities are inconsistent.',
            );
          normalized.set(String(rowOperationId), row);
        }
        let commandData: Record<string, unknown> | undefined;
        let retryRows: Array<Record<string, unknown>> = [];
        let retryFamilyKey: string | null = null;
        if (typeof commandAttemptId === 'string') {
          const [retry] = await tx
            .select()
            .from(retryCommands)
            .where(eq(retryCommands.commandAttemptId, commandAttemptId))
            .for('update')
            .limit(1);
          const [command] = await tx
            .select()
            .from(outbox)
            .where(
              and(
                eq(outbox.messageId, input.causationId),
                eq(outbox.schemaVersion, 4),
              ),
            )
            .for('update')
            .limit(1);
          commandData = command?.payload.data as
            Record<string, unknown> | undefined;
          const retryData = commandData?.retry as
            Record<string, unknown> | undefined;
          retryFamilyKey = retry?.familyKey ?? null;
          retryRows = Array.isArray(retryData?.rows)
            ? retryData.rows.filter(
                (row): row is Record<string, unknown> =>
                  typeof row === 'object' && row !== null,
              )
            : [];
          if (
            !retry ||
            !command ||
            retry.messageId !== input.causationId ||
            retry.businessOperationId !== input.operationId ||
            retry.batchJobId !== batch.id ||
            command.operationId !== input.operationId ||
            command.correlationId !== input.correlationId ||
            commandData?.batch_id !== batch.batchId ||
            commandData?.batch_operation_id !== input.operationId ||
            retryData?.attempt_number !== retry?.attemptNumber ||
            retryData?.command_attempt_id !== commandAttemptId ||
            retryData?.previous_command_message_id !== command.causationId ||
            createHash('sha256')
              .update(canonicalJson(command.payload))
              .digest('hex') !== retry.payloadHash ||
            data.batch_operation_id !== input.operationId
          )
            domainFailure(
              'INVALID_INPUT',
              'Catalog V2 retry causation does not match its Outbox command.',
            );
        } else {
          const commands = Array.isArray(admission.payload.catalogCommands)
            ? admission.payload.catalogCommands
            : [];
          const originals = commands.filter(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              Reflect.get(value, 'schema_version') === 3 &&
              Reflect.get(value, 'message_id') === input.causationId &&
              Reflect.get(value, 'operation_id') === input.operationId,
          );
          const original = originals[0] as Record<string, unknown> | undefined;
          commandData = original?.data as Record<string, unknown> | undefined;
          if (
            originals.length !== 1 ||
            !commandData ||
            commandData.batch_id !== batch.batchId ||
            commandData.batch_operation_id !== input.operationId ||
            envelope.correlation_id !== batch.correlationId ||
            data.batch_operation_id !== input.operationId ||
            commands.filter(
              (value) =>
                typeof value === 'object' &&
                value !== null &&
                Reflect.get(value, 'schema_version') === 3,
            ).length !== 1
          )
            domainFailure(
              'INVALID_INPUT',
              'Catalog initial V2 result has no unique admitted V3 command.',
            );
        }
        const [previousMessage] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, input.messageId),
              eq(inbox.handler, messageHandler),
            ),
          )
          .limit(1);
        if (previousMessage) {
          if (
            canonicalJson(previousMessage.payload) !==
            canonicalJson(input.payload)
          )
            domainFailure(
              'IDEMPOTENCY_CONFLICT',
              'Catalog V2 message_id was reused with a different payload.',
            );
          return { processed: false, result: previousMessage.result };
        }
        if (input.eventName === 'catalog.bulk.upsert.rejected') {
          const operationIds =
            typeof commandAttemptId === 'string'
              ? retryRows.map((row) => String(row.row_operation_id))
              : [...normalized.keys()];
          if (typeof commandAttemptId === 'string') {
            const familyOperations = [...normalized.entries()]
              .filter(([, row]) => row.skuBase === retryFamilyKey)
              .map(([operationId]) => operationId)
              .sort();
            if (
              familyOperations.length !== operationIds.length ||
              familyOperations.join('|') !== [...operationIds].sort().join('|')
            )
              domainFailure(
                'INVALID_INPUT',
                'Rejected retry command does not cover a complete SKU family.',
              );
          }
          for (const operationId of operationIds) {
            const source = normalized.get(operationId);
            if (!source)
              domainFailure(
                'INVALID_INPUT',
                'Rejected Catalog command references an unknown row.',
              );
            const [row] = await tx
              .select()
              .from(batchRows)
              .where(
                and(
                  eq(batchRows.batchJobId, batch.id),
                  eq(batchRows.rowId, String(source!.rowId)),
                ),
              )
              .for('update')
              .limit(1);
            if (!row)
              domainFailure(
                'INVALID_INPUT',
                'Rejected Catalog command row is not persisted.',
              );
            const [currentAttempt] = await tx
              .select()
              .from(domainAttempts)
              .where(
                and(
                  eq(domainAttempts.batchRowId, row.id),
                  eq(domainAttempts.domain, 'CATALOGO'),
                ),
              )
              .orderBy(desc(domainAttempts.attemptNumber))
              .for('update')
              .limit(1);
            if (typeof commandAttemptId === 'string') {
              const retryRow = retryRows.find(
                (candidate) => candidate.row_operation_id === operationId,
              );
              if (
                !retryRow ||
                currentAttempt?.attemptId !== retryRow.attempt_id ||
                currentAttempt.commandAttemptId !== commandAttemptId
              )
                domainFailure(
                  'INVALID_INPUT',
                  'Rejected retry result does not match the current attempt.',
                );
              await tx
                .update(domainAttempts)
                .set({
                  status: 'UNKNOWN',
                  effectState: 'UNKNOWN',
                  retriable: false,
                  receiptMessageId: input.messageId,
                  errorCode: String(data.code),
                  updatedAt: new Date(),
                })
                .where(
                  eq(domainAttempts.attemptId, String(retryRow!.attempt_id)),
                );
            } else if (currentAttempt && currentAttempt.attemptNumber > 1) {
              continue;
            }
            const steps = await tx
              .select()
              .from(rowDomainSteps)
              .where(eq(rowDomainSteps.batchRowId, row.id));
            const catalogStep = steps.find(
              (step) => step.domain === 'CATALOGO',
            );
            if (!catalogStep || catalogStep.status === 'COMPLETED')
              domainFailure(
                'INVALID_TRANSITION',
                'Rejected Catalog command cannot overwrite a completed step.',
              );
            const changes: WorkflowStepChange[] = [
              {
                domain: 'CATALOGO',
                status: 'FAILED',
                errorCode: String(data.code),
                errorDetail: String(data.detail),
              },
            ];
            for (const dependency of steps)
              if (
                dependency.domain !== 'CATALOGO' &&
                dependency.status === 'PENDING'
              )
                changes.push({
                  domain: dependency.domain as BulkDomain,
                  status: 'FAILED',
                  errorCode: 'DEPENDENCY_REJECTED',
                  errorDetail:
                    'Catalog rechazó el comando; el paso dependiente no se ejecutó.',
                });
            const changedStatuses = new Map(
              changes.map((change) => [change.domain, change.status]),
            );
            const allTerminal = row.requiredDomains.every((domain) =>
              ['COMPLETED', 'FAILED'].includes(
                String(
                  changedStatuses.get(domain as BulkDomain) ??
                    steps.find((step) => step.domain === domain)?.status,
                ),
              ),
            );
            const allCompleted = row.requiredDomains.every(
              (domain) =>
                (changedStatuses.get(domain as BulkDomain) ??
                  steps.find((step) => step.domain === domain)?.status) ===
                'COMPLETED',
            );
            const rowStatus: BulkRowStatus = !allTerminal
              ? 'PROCESSING'
              : allCompleted
                ? 'COMPLETED'
                : 'FAILED';
            await updateWorkflowStateIn(tx, {
              batchId: batch.batchId,
              rowId: row.rowId,
              steps: changes,
              status: rowStatus,
              failedDomain: rowStatus === 'FAILED' ? 'CATALOGO' : null,
              errorCode: rowStatus === 'FAILED' ? String(data.code) : null,
              errorDetail: rowStatus === 'FAILED' ? String(data.detail) : null,
            });
          }
          await tx.insert(inbox).values({
            messageId: input.messageId,
            handler: messageHandler,
            eventName: input.eventName,
            correlationId: input.correlationId,
            payload: input.payload,
            result: 'COMMAND_REJECTED_UNKNOWN_EFFECT',
          });
          await tx
            .update(outbox)
            .set({
              publishedAt: sql`coalesce(${outbox.publishedAt}, now())`,
              lastError: null,
            })
            .where(
              and(
                eq(outbox.messageId, input.causationId),
                eq(outbox.eventName, 'catalog.bulk.upsert.requested'),
              ),
            );
          return { processed: true, result: 'COMMAND_REJECTED_UNKNOWN_EFFECT' };
        }
        const resultRows = data.results as Array<Record<string, unknown>>;
        if (
          resultRows.some(
            (result) =>
              typeof result.row_operation_id !== 'string' ||
              !normalized.has(result.row_operation_id),
          )
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog V2 result contains a row outside the admitted intent.',
          );
        const expectedOperations =
          typeof commandAttemptId === 'string'
            ? retryRows.map((row) => row.row_operation_id)
            : [...normalized.keys()];
        if (typeof commandAttemptId === 'string') {
          const familyOperations = [...normalized.entries()]
            .filter(([, row]) => row.skuBase === retryFamilyKey)
            .map(([operationId]) => operationId)
            .sort();
          if (
            familyOperations.length !== expectedOperations.length ||
            familyOperations.join('|') !==
              [...expectedOperations].sort().join('|')
          )
            domainFailure(
              'INVALID_INPUT',
              'Catalog V2 retry command is not a complete SKU family.',
            );
        }
        const actualOperations = resultRows.map((row) => row.row_operation_id);
        if (
          new Set(actualOperations).size !== actualOperations.length ||
          [...expectedOperations].sort().join('|') !==
            [...actualOperations].sort().join('|')
        )
          domainFailure(
            'INVALID_INPUT',
            'Catalog V2 result does not cover exactly its command rows.',
          );
        const [existingMessage] = await tx
          .select()
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, input.messageId),
              eq(inbox.handler, messageHandler),
            ),
          )
          .limit(1);
        if (existingMessage)
          return { processed: false, result: existingMessage.result };
        for (const result of resultRows) {
          const operationId = String(result.row_operation_id);
          const source = normalized.get(operationId)!;
          if (
            Number(source.rowNumber) !== result.row_number ||
            source.skuBase !== result.sku_base ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              String(result.attempt_id),
            ) ||
            !Number.isSafeInteger(result.attempt_number) ||
            !['COMPLETED', 'REJECTED'].includes(String(result.status)) ||
            !['NONE', 'APPLIED', 'UNKNOWN'].includes(
              String(result.effect_state),
            ) ||
            typeof result.retriable !== 'boolean' ||
            (result.status === 'COMPLETED' &&
              (result.effect_state !== 'APPLIED' ||
                result.retriable ||
                result.code !== null)) ||
            (result.status === 'REJECTED' &&
              (result.effect_state === 'APPLIED' ||
                typeof result.code !== 'string' ||
                (result.retriable &&
                  (result.effect_state !== 'NONE' ||
                    result.code !== 'CATALOG_AUTH_TEMPORARY_UNAVAILABLE'))))
          )
            domainFailure(
              'INVALID_INPUT',
              'Catalog V2 attempt receipt is inconsistent.',
            );
          const [row] = await tx
            .select()
            .from(batchRows)
            .where(
              and(
                eq(batchRows.batchJobId, batch.id),
                eq(batchRows.rowId, String(source.rowId)),
              ),
            )
            .for('update')
            .limit(1);
          if (!row)
            domainFailure(
              'INVALID_INPUT',
              'Catalog V2 result row is not persisted.',
            );
          const [currentAttempt] = await tx
            .select()
            .from(domainAttempts)
            .where(
              and(
                eq(domainAttempts.batchRowId, row.id),
                eq(domainAttempts.domain, 'CATALOGO'),
              ),
            )
            .orderBy(desc(domainAttempts.attemptNumber))
            .for('update')
            .limit(1);
          const attemptNumber = Number(result.attempt_number);
          let previousAttemptId: string | null = null;
          if (typeof commandAttemptId === 'string') {
            const matchingRetryRow = retryRows.find(
              (candidate) => candidate.row_operation_id === operationId,
            );
            if (!matchingRetryRow)
              domainFailure('INVALID_INPUT', 'Catalog V2 retry row is absent.');
            if (
              matchingRetryRow!.attempt_id !== result.attempt_id ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                String(matchingRetryRow!.previous_attempt_id),
              )
            )
              domainFailure(
                'INVALID_INPUT',
                'Catalog V2 attempt identity does not match the retry command.',
              );
            previousAttemptId = String(matchingRetryRow!.previous_attempt_id);
            if (
              currentAttempt &&
              currentAttempt.attemptNumber > attemptNumber
            ) {
              const [oldAttempt] = await tx
                .select()
                .from(domainAttempts)
                .where(eq(domainAttempts.attemptId, String(result.attempt_id)))
                .limit(1);
              if (!oldAttempt)
                domainFailure(
                  'INVALID_INPUT',
                  'A tardy Catalog result has no durable attempt.',
                );
              await tx.insert(inbox).values({
                messageId: input.messageId,
                handler: `bulk.catalog-result-attempt:${result.attempt_id}`,
                eventName: input.eventName,
                correlationId: input.correlationId,
                payload: { stale: true, result },
                result: 'STALE',
              });
              continue;
            }
            if (
              !currentAttempt ||
              currentAttempt.attemptId !== result.attempt_id ||
              currentAttempt.commandAttemptId !== commandAttemptId ||
              currentAttempt.previousAttemptId !== previousAttemptId ||
              attemptNumber !== currentAttempt.attemptNumber
            )
              domainFailure(
                'INVALID_INPUT',
                'Catalog V2 result does not extend the current attempt chain.',
              );
          } else if (
            currentAttempt &&
            currentAttempt.attemptNumber > attemptNumber
          ) {
            const [oldAttempt] = await tx
              .select()
              .from(domainAttempts)
              .where(eq(domainAttempts.attemptId, String(result.attempt_id)))
              .limit(1);
            if (!oldAttempt)
              domainFailure(
                'INVALID_INPUT',
                'A tardy initial Catalog result has no durable attempt.',
              );
            await tx.insert(inbox).values({
              messageId: input.messageId,
              handler: `bulk.catalog-result-attempt:${result.attempt_id}`,
              eventName: input.eventName,
              correlationId: input.correlationId,
              payload: { stale: true, result },
              result: 'STALE',
            });
            continue;
          } else if (attemptNumber !== 1 || currentAttempt) {
            domainFailure(
              'INVALID_INPUT',
              'Catalog initial V2 result conflicts with an existing attempt.',
            );
          }
          if (currentAttempt && currentAttempt.attemptNumber > attemptNumber) {
            await tx.insert(inbox).values({
              messageId: input.messageId,
              handler: `bulk.catalog-result-attempt:${result.attempt_id}`,
              eventName: input.eventName,
              correlationId: input.correlationId,
              payload: { stale: true, result },
              result: 'STALE',
            });
            continue;
          }
          const attemptValues = {
            attemptId: String(result.attempt_id),
            batchRowId: row.id,
            domain: 'CATALOGO',
            businessOperationId: String(data.batch_operation_id),
            attemptNumber,
            previousAttemptId,
            commandAttemptId:
              typeof commandAttemptId === 'string' ? commandAttemptId : null,
            status: result.status === 'COMPLETED' ? 'COMPLETED' : 'REJECTED',
            effectState: String(result.effect_state),
            retriable: result.retriable === true,
            receiptMessageId: input.messageId,
            errorCode: typeof result.code === 'string' ? result.code : null,
            updatedAt: new Date(),
          } as const;
          if (typeof commandAttemptId === 'string') {
            await tx
              .update(domainAttempts)
              .set(attemptValues)
              .where(eq(domainAttempts.attemptId, String(result.attempt_id)));
          } else {
            await tx.insert(domainAttempts).values(attemptValues);
          }
          const [step] = await tx
            .select()
            .from(rowDomainSteps)
            .where(
              and(
                eq(rowDomainSteps.batchRowId, row.id),
                eq(rowDomainSteps.domain, 'CATALOGO'),
              ),
            )
            .for('update')
            .limit(1);
          if (!step || !row.requiredDomains.includes('CATALOGO'))
            domainFailure(
              'INVALID_INPUT',
              'Catalog V2 result has no matching workflow step.',
            );
          if (step.status === 'COMPLETED')
            domainFailure(
              'INVALID_TRANSITION',
              'Catalog V2 result cannot revert a completed step.',
            );
          const pendingSteps = await tx
            .select()
            .from(rowDomainSteps)
            .where(eq(rowDomainSteps.batchRowId, row.id));
          const status: BulkStepStatus =
            result.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
          const changes: WorkflowStepChange[] = [
            {
              domain: 'CATALOGO',
              status,
              errorCode: status === 'FAILED' ? String(result.code) : null,
              errorDetail: null,
            },
          ];
          if (status === 'FAILED')
            for (const dependency of pendingSteps)
              if (
                dependency.domain !== 'CATALOGO' &&
                dependency.status === 'PENDING'
              )
                changes.push({
                  domain: dependency.domain as BulkDomain,
                  status: 'FAILED',
                  errorCode: 'DEPENDENCY_REJECTED',
                  errorDetail:
                    'Catalog rechazó la fila; el paso dependiente no se ejecutó.',
                });
          const statusByDomain = new Map(
            changes.map((change) => [change.domain, change.status]),
          );
          const allTerminal = row.requiredDomains.every((domain) =>
            ['COMPLETED', 'FAILED'].includes(
              String(
                statusByDomain.get(domain as BulkDomain) ??
                  pendingSteps.find((candidate) => candidate.domain === domain)
                    ?.status,
              ),
            ),
          );
          const allCompleted = row.requiredDomains.every(
            (domain) =>
              (statusByDomain.get(domain as BulkDomain) ??
                pendingSteps.find((candidate) => candidate.domain === domain)
                  ?.status) === 'COMPLETED',
          );
          await updateWorkflowStateIn(tx, {
            batchId: batch.batchId,
            rowId: row.rowId,
            steps: changes,
            status: !allTerminal
              ? 'PROCESSING'
              : allCompleted
                ? 'COMPLETED'
                : 'FAILED',
            failedDomain: status === 'FAILED' ? 'CATALOGO' : null,
            errorCode: status === 'FAILED' ? String(result.code) : null,
          });
          await tx.insert(inbox).values({
            messageId: input.messageId,
            handler: `bulk.catalog-result-attempt:${result.attempt_id}`,
            eventName: input.eventName,
            correlationId: input.correlationId,
            payload: {
              batchId: batch.batchId,
              batchOperationId: data.batch_operation_id,
              result,
            },
            result: String(result.status),
          });
        }
        await tx.insert(inbox).values({
          messageId: input.messageId,
          handler: messageHandler,
          eventName: input.eventName,
          correlationId: input.correlationId,
          payload: input.payload,
          result: 'RESULTS_APPLIED',
        });
        await tx
          .update(outbox)
          .set({
            publishedAt: sql`coalesce(${outbox.publishedAt}, now())`,
            lastError: null,
          })
          .where(
            and(
              eq(outbox.messageId, input.causationId),
              eq(outbox.eventName, 'catalog.bulk.upsert.requested'),
            ),
          );
        return { processed: true, result: 'RESULTS_APPLIED' };
      });
    } catch (error) {
      if (error instanceof BulkDomainError) throw error;
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

  async findImportAdmissionIntent(
    batchId: string,
    ownerSub: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const [ownedBatch] = await this.db
        .select({ id: batchJobs.id })
        .from(batchJobs)
        .where(
          and(eq(batchJobs.batchId, batchId), eq(batchJobs.ownerSub, ownerSub)),
        )
        .limit(1);
      if (!ownedBatch) return null;
      const [receipt] = await this.db
        .select({ payload: inbox.payload })
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, batchId),
            eq(inbox.handler, 'bulk.import.admission'),
          ),
        )
        .limit(1);
      return (receipt?.payload as Record<string, unknown> | undefined) ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findBatchByOwnerAndCorrelation(
    ownerSub: string,
    correlationId: string,
  ): Promise<typeof batchJobs.$inferSelect | null> {
    try {
      const [batch] = await this.db
        .select()
        .from(batchJobs)
        .where(
          and(
            eq(batchJobs.ownerSub, ownerSub),
            eq(batchJobs.correlationId, correlationId),
          ),
        )
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

  async loadBatchSnapshot(
    batchId: string,
    ownerSub: string,
    executor: BulkDatabase | BulkTx = this.db,
  ): Promise<{
    batch: typeof batchJobs.$inferSelect;
    rows: Array<{
      row: typeof batchRows.$inferSelect;
      steps: Array<typeof rowDomainSteps.$inferSelect>;
    }>;
  } | null> {
    try {
      const result = await executor
        .select({ batch: batchJobs, row: batchRows, step: rowDomainSteps })
        .from(batchJobs)
        .leftJoin(batchRows, eq(batchRows.batchJobId, batchJobs.id))
        .leftJoin(rowDomainSteps, eq(rowDomainSteps.batchRowId, batchRows.id))
        .where(
          and(eq(batchJobs.batchId, batchId), eq(batchJobs.ownerSub, ownerSub)),
        )
        .orderBy(
          asc(batchRows.createdAt),
          asc(batchRows.id),
          asc(rowDomainSteps.domain),
        );
      const first = result[0];
      if (!first) return null;
      const rows = new Map<
        string,
        {
          row: typeof batchRows.$inferSelect;
          steps: Array<typeof rowDomainSteps.$inferSelect>;
        }
      >();
      for (const item of result) {
        if (!item.row) continue;
        let rowResult = rows.get(item.row.id);
        if (!rowResult) {
          rowResult = { row: item.row, steps: [] };
          rows.set(item.row.id, rowResult);
        }
        if (item.step) rowResult.steps.push(item.step);
      }
      return { batch: first.batch, rows: [...rows.values()] };
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async getRetryEligibility(
    batchId: string,
    ownerSub: string,
  ): Promise<{
    protocolo: 'BULK_RETRY_V1';
    elegible: boolean;
    pasos: Array<{ row_id: string; dominio: 'CATALOGO' }>;
    motivo_bloqueo:
      | 'LOTE_NO_TERMINAL'
      | 'SIN_PASOS_REINTENTABLES'
      | 'RESULTADO_INCIERTO'
      | 'PROTOCOLO_DOMINIO_NO_HABILITADO'
      | null;
  }> {
    return this.calculateRetryEligibility(batchId, ownerSub, this.db);
  }

  private async calculateRetryEligibility(
    batchId: string,
    ownerSub: string,
    executor: BulkDatabase | BulkTx,
  ): Promise<{
    protocolo: 'BULK_RETRY_V1';
    elegible: boolean;
    pasos: Array<{ row_id: string; dominio: 'CATALOGO' }>;
    motivo_bloqueo:
      | 'LOTE_NO_TERMINAL'
      | 'SIN_PASOS_REINTENTABLES'
      | 'RESULTADO_INCIERTO'
      | 'PROTOCOLO_DOMINIO_NO_HABILITADO'
      | null;
  }> {
    const blocked = (
      motivo_bloqueo:
        | 'LOTE_NO_TERMINAL'
        | 'SIN_PASOS_REINTENTABLES'
        | 'RESULTADO_INCIERTO'
        | 'PROTOCOLO_DOMINIO_NO_HABILITADO',
    ) => ({
      protocolo: 'BULK_RETRY_V1' as const,
      elegible: false,
      pasos: [],
      motivo_bloqueo,
    });
    try {
      const snapshot = await this.loadBatchSnapshot(
        batchId,
        ownerSub,
        executor,
      );
      if (!snapshot) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
      const { batch, rows } = snapshot;
      if (batch.status !== 'COMPLETED') return blocked('LOTE_NO_TERMINAL');
      if (process.env.BULK_RETRY_CATALOG_V1_ENABLED !== 'true')
        return blocked('PROTOCOLO_DOMINIO_NO_HABILITADO');
      if (rows.length === 0) return blocked('SIN_PASOS_REINTENTABLES');
      if (
        rows.some(({ steps }) =>
          steps.some((step) => !['COMPLETED', 'FAILED'].includes(step.status)),
        )
      )
        return blocked('RESULTADO_INCIERTO');

      const [admission] = await executor
        .select({ payload: inbox.payload })
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, batch.batchId),
            eq(inbox.handler, 'bulk.import.admission'),
          ),
        )
        .limit(1);
      const intentRows = Array.isArray(admission?.payload.rows)
        ? admission.payload.rows.filter(
            (value): value is Record<string, unknown> =>
              typeof value === 'object' && value !== null,
          )
        : [];
      const originalCommands = Array.isArray(admission?.payload.catalogCommands)
        ? admission.payload.catalogCommands.filter(
            (value): value is Record<string, unknown> =>
              typeof value === 'object' && value !== null,
          )
        : [];
      const v3Commands = originalCommands.filter((command) => {
        const data = command.data as Record<string, unknown> | undefined;
        return (
          command.schema_version === 3 &&
          data?.batch_id === batch.batchId &&
          data.batch_operation_id === command.operation_id &&
          typeof data.content_ref === 'object' &&
          data.content_ref !== null
        );
      });
      if (v3Commands.length !== 1)
        return blocked('PROTOCOLO_DOMINIO_NO_HABILITADO');
      const v3Command = v3Commands[0]!;
      const [manifest] = await executor
        .select({ contentRef: fileManifests.contentRef })
        .from(fileManifests)
        .where(eq(fileManifests.id, batch.inputFileId))
        .limit(1);
      if (
        !manifest ||
        admission?.payload.contentRef !== manifest.contentRef ||
        !matchesBulkStorageReference(
          manifest.contentRef,
          process.env.BULK_STORAGE_BUCKET,
        )
      )
        return blocked('RESULTADO_INCIERTO');

      const operationRows = new Map<string, Record<string, unknown>>();
      for (const intentRow of intentRows) {
        if (
          typeof intentRow.rowOperationId !== 'string' ||
          typeof intentRow.rowId !== 'string' ||
          intentRow.rowOperationId !== intentRow.rowId ||
          operationRows.has(intentRow.rowOperationId)
        )
          return blocked('RESULTADO_INCIERTO');
        operationRows.set(intentRow.rowOperationId, intentRow);
      }
      if (operationRows.size !== rows.length)
        return blocked('RESULTADO_INCIERTO');
      const grouped = new Map<string, typeof rows>();
      for (const persisted of rows) {
        const intentRow = operationRows.get(persisted.row.rowId);
        if (!intentRow || typeof intentRow.skuBase !== 'string')
          return blocked('RESULTADO_INCIERTO');
        grouped.set(intentRow.skuBase, [
          ...(grouped.get(intentRow.skuBase) ?? []),
          persisted,
        ]);
      }

      const commandData = v3Command.data as Record<string, unknown>;
      const contentRef = commandData.content_ref as
        Record<string, unknown> | undefined;
      if (
        !contentRef ||
        typeof contentRef.content_id !== 'string' ||
        typeof contentRef.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(contentRef.sha256) ||
        !Number.isSafeInteger(contentRef.byte_length) ||
        Number(contentRef.byte_length) < 1
      )
        return blocked('RESULTADO_INCIERTO');
      const contentDocumentResult = await executor.execute(sql`
        SELECT content_id::text AS "contentId",
               batch_id::text AS "batchId",
               batch_operation_id::text AS "batchOperationId",
               content_ref AS "contentRef",
               sha256,
               byte_length AS "byteLength",
               content_type AS "contentType"
        FROM bulk.content_documents
        WHERE content_id = ${contentRef.content_id}::uuid
        FOR UPDATE
      `);
      const contentDocument = contentDocumentResult.rows[0] as
        | {
            contentId: string;
            batchId: string;
            batchOperationId: string;
            contentRef: string;
            sha256: string;
            byteLength: number;
            contentType: string;
          }
        | undefined;
      if (
        !contentDocument ||
        contentDocument.batchId !== batch.batchId ||
        contentDocument.batchOperationId !== v3Command.operation_id
      )
        return blocked('RESULTADO_INCIERTO');
      if (
        contentDocument.contentId !== contentRef.content_id ||
        contentDocument.sha256 !== contentRef.sha256 ||
        contentDocument.byteLength !== contentRef.byte_length ||
        contentDocument.contentType !== contentRef.content_type ||
        !matchesBulkStorageReference(
          contentDocument.contentRef,
          process.env.BULK_STORAGE_BUCKET,
        )
      )
        return blocked('RESULTADO_INCIERTO');
      const candidates: Array<{ row_id: string; dominio: 'CATALOGO' }> = [];
      let uncertainResult = false;
      for (const family of grouped.values()) {
        const familySteps: Array<{ row_id: string; dominio: 'CATALOGO' }> = [];
        let eligible = true;
        for (const persisted of family) {
          const { row, steps } = persisted;
          const catalogStep = steps.find((step) => step.domain === 'CATALOGO');
          if (
            !row.requiredDomains.includes('CATALOGO') ||
            row.appliedDomains.length > 0 ||
            row.status === 'COMPLETED' ||
            catalogStep?.status !== 'FAILED'
          ) {
            eligible = false;
            break;
          }
          const attempts = await executor
            .select()
            .from(domainAttempts)
            .where(
              and(
                eq(domainAttempts.batchRowId, row.id),
                eq(domainAttempts.domain, 'CATALOGO'),
              ),
            )
            .orderBy(desc(domainAttempts.attemptNumber))
            .for('update');
          const current = attempts[0];
          if (
            !current ||
            attempts.length !== current.attemptNumber ||
            attempts.some(
              (attempt, index) =>
                attempt.attemptNumber !== current.attemptNumber - index,
            ) ||
            current.businessOperationId !== v3Command.operation_id ||
            current.status !== 'REJECTED' ||
            current.effectState !== 'NONE' ||
            !current.retriable ||
            !current.receiptMessageId
          ) {
            uncertainResult = true;
            eligible = false;
            break;
          }
          if (
            (current.attemptNumber === 1 &&
              (current.previousAttemptId !== null ||
                current.commandAttemptId !== null)) ||
            (current.attemptNumber > 1 &&
              (!current.previousAttemptId || !current.commandAttemptId))
          ) {
            uncertainResult = true;
            eligible = false;
            break;
          }
          if (current.attemptNumber > 1) {
            const previous = attempts[1];
            const [command] = await executor
              .select()
              .from(retryCommands)
              .where(
                eq(retryCommands.commandAttemptId, current.commandAttemptId!),
              )
              .for('update')
              .limit(1);
            if (
              !previous ||
              previous.attemptId !== current.previousAttemptId ||
              previous.status !== 'REJECTED' ||
              previous.effectState !== 'NONE' ||
              !previous.retriable ||
              !command ||
              command.batchJobId !== batch.id ||
              command.domain !== 'CATALOGO' ||
              command.familyKey !== operationRows.get(row.rowId)?.skuBase ||
              command.businessOperationId !== v3Command.operation_id
            ) {
              uncertainResult = true;
              eligible = false;
              break;
            }
          }
          familySteps.push({ row_id: row.rowId, dominio: 'CATALOGO' });
        }
        if (eligible && familySteps.length === family.length)
          candidates.push(...familySteps);
      }
      if (candidates.length === 0)
        return blocked(
          uncertainResult ? 'RESULTADO_INCIERTO' : 'SIN_PASOS_REINTENTABLES',
        );
      return {
        protocolo: 'BULK_RETRY_V1',
        elegible: true,
        pasos: candidates,
        motivo_bloqueo: null,
      };
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

  /** Admit one durable retry intent; transport publication remains an Outbox concern. */
  async requeueBatch(
    batchId: string,
    ownerSub: string,
    correlationId?: string,
    motivo: string | null = null,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(batchJobs)
          .where(
            and(
              eq(batchJobs.batchId, batchId),
              eq(batchJobs.ownerSub, ownerSub),
            ),
          )
          .for('update')
          .limit(1);
        if (!batch) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        if (!correlationId) {
          throw new BulkPersistenceError(
            'NOT_CONFIGURED',
            new Error('RETRY_PROTOCOL_NOT_APPROVED'),
          );
        }
        const [existingRequest] = await tx
          .select()
          .from(batchResumeRequests)
          .where(
            and(
              eq(batchResumeRequests.batchJobId, batch.id),
              eq(batchResumeRequests.correlationId, correlationId),
            ),
          )
          .for('update')
          .limit(1);
        const intentHash = createHash('sha256')
          .update(
            canonicalJson({
              protocol: 'BULK_RETRY_V1',
              batch_id: batchId,
              owner_sub: ownerSub,
              correlation_id: correlationId,
              motivo,
            }),
          )
          .digest('hex');
        if (existingRequest) {
          if (existingRequest.intentHash !== intentHash)
            throw new BulkPersistenceError(
              'UNIQUE_CONFLICT',
              new Error('IDEMPOTENCY_CONFLICT'),
            );
          return existingRequest.acceptedResponse;
        }
        if (batch.status !== 'COMPLETED') {
          throw new BulkPersistenceError(
            'CHECK_VIOLATION',
            new Error('BATCH_TRANSITION_NOT_ALLOWED'),
          );
        }
        const lockedRows = await tx
          .select()
          .from(batchRows)
          .where(eq(batchRows.batchJobId, batch.id))
          .orderBy(asc(batchRows.rowId))
          .for('update');
        for (const row of lockedRows)
          await tx
            .select({ id: rowDomainSteps.id })
            .from(rowDomainSteps)
            .where(eq(rowDomainSteps.batchRowId, row.id))
            .orderBy(asc(rowDomainSteps.domain))
            .for('update');
        const eligibility = await this.calculateRetryEligibility(
          batchId,
          ownerSub,
          tx,
        );
        if (!eligibility.elegible || eligibility.pasos.length === 0)
          throw new BulkPersistenceError(
            'CHECK_VIOLATION',
            new Error('RETRY_NOT_ELIGIBLE'),
          );
        const [admission] = await tx
          .select({ payload: inbox.payload })
          .from(inbox)
          .where(
            and(
              eq(inbox.messageId, batch.batchId),
              eq(inbox.handler, 'bulk.import.admission'),
            ),
          )
          .limit(1);
        const commandList = Array.isArray(admission?.payload.catalogCommands)
          ? admission.payload.catalogCommands
          : [];
        const original = commandList.find(
          (value) =>
            typeof value === 'object' &&
            value !== null &&
            Reflect.get(value, 'schema_version') === 3 &&
            Reflect.get(Reflect.get(value, 'data'), 'batch_id') === batchId,
        ) as Record<string, unknown> | undefined;
        if (
          !original ||
          typeof original.message_id !== 'string' ||
          typeof original.operation_id !== 'string'
        )
          throw new BulkPersistenceError(
            'NOT_CONFIGURED',
            new Error('RETRY_PROTOCOL_NOT_APPROVED'),
          );
        const data = original.data as Record<string, unknown>;
        const intentRows = Array.isArray(admission?.payload.rows)
          ? admission.payload.rows
          : [];
        const eligibleIds = new Set(
          eligibility.pasos.map((step) => step.row_id),
        );
        const eligibleIntentRows = intentRows.filter(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' &&
            value !== null &&
            eligibleIds.has(String(Reflect.get(value, 'rowId'))),
        );
        const families = new Map<string, Record<string, unknown>[]>();
        for (const row of eligibleIntentRows) {
          const sku = row.skuBase;
          if (typeof sku !== 'string' || row.rowId !== row.rowOperationId)
            throw new BulkPersistenceError(
              'CHECK_VIOLATION',
              new Error('RETRY_NOT_ELIGIBLE'),
            );
          families.set(sku, [...(families.get(sku) ?? []), row]);
        }
        if (!families.size)
          throw new BulkPersistenceError(
            'CHECK_VIOLATION',
            new Error('RETRY_NOT_ELIGIBLE'),
          );
        const acceptedResponse = {
          batch_id: batch.batchId,
          status: 'QUEUED',
          template_version: 2,
          correlation_id: batch.correlationId,
        };
        const [request] = await tx
          .insert(batchResumeRequests)
          .values({
            batchJobId: batch.id,
            ownerSub,
            correlationId,
            intentHash,
            acceptedResponse,
          })
          .returning();
        if (!request) throw new Error('Resume request insert returned no row');
        let reopened = 0;
        const reopenedRowIds = new Set<string>();
        for (const [familyKey, selectedRows] of [...families.entries()].sort(
          ([a], [b]) => a.localeCompare(b),
        )) {
          const rows = selectedRows.sort((a, b) =>
            String(a.rowOperationId).localeCompare(String(b.rowOperationId)),
          );
          const current = [];
          for (const row of rows) {
            const persisted = lockedRows.find(
              (candidate) => candidate.rowId === row.rowId,
            );
            if (!persisted) throw new Error('Retry row missing');
            const [attempt] = await tx
              .select()
              .from(domainAttempts)
              .where(
                and(
                  eq(domainAttempts.batchRowId, persisted.id),
                  eq(domainAttempts.domain, 'CATALOGO'),
                ),
              )
              .orderBy(desc(domainAttempts.attemptNumber))
              .for('update')
              .limit(1);
            if (
              !attempt ||
              !attempt.retriable ||
              attempt.status !== 'REJECTED' ||
              attempt.effectState !== 'NONE'
            )
              throw new BulkPersistenceError(
                'CHECK_VIOLATION',
                new Error('RETRY_NOT_ELIGIBLE'),
              );
            current.push({ row, persisted, attempt });
          }
          const latest = current[0]!.attempt;
          if (
            current.some(
              ({ attempt }) =>
                attempt.attemptNumber !== latest.attemptNumber ||
                attempt.commandAttemptId !== latest.commandAttemptId,
            )
          )
            throw new BulkPersistenceError(
              'CHECK_VIOLATION',
              new Error('RETRY_NOT_ELIGIBLE'),
            );
          const previousMessageId = latest.commandAttemptId
            ? (
                await tx
                  .select({ messageId: retryCommands.messageId })
                  .from(retryCommands)
                  .where(
                    eq(retryCommands.commandAttemptId, latest.commandAttemptId),
                  )
                  .limit(1)
              )[0]?.messageId
            : original.message_id;
          if (!previousMessageId)
            throw new BulkPersistenceError(
              'CHECK_VIOLATION',
              new Error('RESULTADO_INCIERTO'),
            );
          const commandAttemptId = randomUUID();
          const messageId = randomUUID();
          const retryRows = current.map(({ row, attempt }) => ({
            row_operation_id: String(row.rowOperationId),
            attempt_id: randomUUID(),
            previous_attempt_id: attempt.attemptId,
          }));
          const payload = {
            message_id: messageId,
            schema_version: 4,
            occurred_at: new Date().toISOString(),
            correlation_id: batch.correlationId,
            causation_id: previousMessageId,
            operation_id: original.operation_id,
            producer: 'bulk-svc',
            kind: 'command',
            name: 'catalog.bulk.upsert.requested',
            data: {
              ...data,
              retry: {
                protocol: 'BULK_RETRY_V1',
                command_attempt_id: commandAttemptId,
                attempt_number: latest.attemptNumber + 1,
                previous_command_message_id: previousMessageId,
                rows: retryRows,
              },
            },
          };
          const payloadHash = createHash('sha256')
            .update(canonicalJson(payload))
            .digest('hex');
          await tx.insert(retryCommands).values({
            commandAttemptId,
            resumeRequestId: request.id,
            batchJobId: batch.id,
            domain: 'CATALOGO',
            familyKey,
            businessOperationId: String(original.operation_id),
            attemptNumber: latest.attemptNumber + 1,
            messageId,
            previousMessageId,
            payloadHash,
          });
          await tx.insert(outbox).values({
            messageId,
            eventName: 'catalog.bulk.upsert.requested',
            kind: 'command',
            schemaVersion: 4,
            correlationId: batch.correlationId,
            causationId: previousMessageId,
            operationId: String(original.operation_id),
            occurredAt: new Date(payload.occurred_at),
            payload,
          });
          for (let index = 0; index < current.length; index++) {
            const entry = current[index]!;
            await tx.insert(domainAttempts).values({
              attemptId: retryRows[index]!.attempt_id,
              batchRowId: entry.persisted.id,
              domain: 'CATALOGO',
              businessOperationId: String(original.operation_id),
              attemptNumber: latest.attemptNumber + 1,
              previousAttemptId: entry.attempt.attemptId,
              commandAttemptId,
              status: 'PENDING',
              effectState: 'UNKNOWN',
              retriable: false,
            });
            const steps = await tx
              .select()
              .from(rowDomainSteps)
              .where(eq(rowDomainSteps.batchRowId, entry.persisted.id))
              .for('update');
            for (const step of steps)
              if (
                step.domain === 'CATALOGO' ||
                (step.status === 'FAILED' &&
                  step.errorCode === 'DEPENDENCY_REJECTED')
              )
                await tx
                  .update(rowDomainSteps)
                  .set({
                    status: 'PENDING',
                    errorCode: null,
                    errorDetail: null,
                    updatedAt: new Date(),
                  })
                  .where(eq(rowDomainSteps.id, step.id));
            await tx
              .update(batchRows)
              .set({
                status: 'PENDING',
                failedDomain: null,
                errorCode: null,
                errorDetail: null,
                needsReconciliation: false,
                updatedAt: new Date(),
              })
              .where(eq(batchRows.id, entry.persisted.id));
            reopened++;
            reopenedRowIds.add(entry.persisted.rowId);
          }
        }
        await tx
          .update(batchJobs)
          .set({
            status: 'QUEUED',
            completedRows: lockedRows.filter(
              (row) => row.status === 'COMPLETED',
            ).length,
            failedRows: Math.max(0, batch.failedRows - reopened),
            needsReconciliation: lockedRows.some(
              (row) =>
                row.needsReconciliation && !reopenedRowIds.has(row.rowId),
            ),
            updatedAt: new Date(),
          })
          .where(eq(batchJobs.id, batch.id));
        return acceptedResponse;
      });
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
        .values({
          exportId: input.exportId,
          ownerSub: input.ownerSub,
          format: input.format,
        })
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

  async findOwnedExportJobByExportId(
    exportId: string,
    ownerSub: string,
  ): Promise<typeof exportJobs.$inferSelect | null> {
    try {
      const [job] = await this.db
        .select()
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            eq(exportJobs.ownerSub, ownerSub),
          ),
        )
        .limit(1);
      return job ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async listQueuedExportJobs(): Promise<Array<typeof exportJobs.$inferSelect>> {
    try {
      return await this.db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.status, 'QUEUED'))
        .orderBy(asc(exportJobs.createdAt));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async requeueStaleProcessingExports(
    staleBefore: Date,
  ): Promise<Array<typeof exportJobs.$inferSelect>> {
    try {
      return await this.db
        .update(exportJobs)
        .set({ status: 'QUEUED', claimToken: null, leaseUntil: null })
        .where(
          and(
            eq(exportJobs.status, 'PROCESSING'),
            sql`(${exportJobs.leaseUntil} IS NOT NULL AND ${exportJobs.leaseUntil} <= now()) OR (${exportJobs.leaseUntil} IS NULL AND ${exportJobs.updatedAt} <= ${staleBefore})`,
          ),
        )
        .returning();
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async claimQueuedExportJob(
    exportId: string,
  ): Promise<{ job: typeof exportJobs.$inferSelect; fence: string } | null> {
    try {
      const [claimed] = await this.db
        .update(exportJobs)
        .set({
          status: 'PROCESSING',
          claimToken: randomUUID(),
          leaseUntil: sql`now() + interval '60 seconds'`,
        })
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            eq(exportJobs.status, 'QUEUED'),
          ),
        )
        .returning({
          job: exportJobs,
          fence: exportJobs.claimToken,
        });
      return claimed?.fence ? { ...claimed, fence: claimed.fence } : null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async isExportClaimCurrent(
    exportId: string,
    fence: string,
  ): Promise<boolean> {
    try {
      const [claimed] = await this.db
        .select({ fence: exportJobs.claimToken })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            eq(exportJobs.status, 'PROCESSING'),
            sql`${exportJobs.leaseUntil} > now()`,
          ),
        )
        .limit(1);
      return claimed?.fence === fence;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async renewExportClaim(exportId: string, fence: string): Promise<boolean> {
    try {
      const [renewed] = await this.db
        .update(exportJobs)
        .set({ leaseUntil: sql`now() + interval '60 seconds'` })
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            eq(exportJobs.status, 'PROCESSING'),
            eq(exportJobs.claimToken, fence),
            sql`${exportJobs.leaseUntil} > now()`,
          ),
        )
        .returning({ id: exportJobs.id });
      return Boolean(renewed);
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async failProcessingExportJob(
    exportId: string,
    fence: string,
  ): Promise<typeof exportJobs.$inferSelect | null> {
    try {
      const [failed] = await this.db
        .update(exportJobs)
        .set({ status: 'FAILED_GENERAL' })
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            eq(exportJobs.status, 'PROCESSING'),
            eq(exportJobs.claimToken, fence),
            sql`${exportJobs.leaseUntil} > now()`,
          ),
        )
        .returning();
      return failed ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findFileManifest(id: string): Promise<
    | (typeof fileManifests.$inferSelect & {
        metadata: Record<string, unknown>;
      })
    | null
  > {
    try {
      const [manifest] = await this.db
        .select({
          id: fileManifests.id,
          role: fileManifests.role,
          format: fileManifests.format,
          contentRef: fileManifests.contentRef,
          metadata: sql<
            Record<string, unknown>
          >`coalesce(to_jsonb(file_manifests)->'metadata', '{}'::jsonb)`,
          createdAt: fileManifests.createdAt,
          updatedAt: fileManifests.updatedAt,
        })
        .from(fileManifests)
        .where(eq(fileManifests.id, id))
        .limit(1);
      return manifest ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async findContentDocument(contentId: string) {
    try {
      const [document] = await this.db
        .select({
          contentId: contentDocuments.contentId,
          batchId: contentDocuments.batchId,
          batchOperationId: contentDocuments.batchOperationId,
          contentRef: contentDocuments.contentRef,
          sha256: contentDocuments.sha256,
          byteLength: contentDocuments.byteLength,
          contentType: contentDocuments.contentType,
        })
        .from(contentDocuments)
        .where(eq(contentDocuments.contentId, contentId))
        .limit(1);
      return document ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  /** Reconciles an upload after an uncertain completion response. Any durable manifest reference wins. */
  async isExportArtifactReferenced(contentRef: string): Promise<boolean> {
    try {
      const result = await this.db.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM bulk.file_manifests
          WHERE content_ref = ${contentRef}
        ) OR EXISTS (
          SELECT 1
          FROM bulk.export_jobs AS job
          JOIN bulk.file_manifests AS manifest ON manifest.id = job.output_file_id
          WHERE job.status = 'COMPLETED' AND manifest.content_ref = ${contentRef}
        ) AS referenced
      `);
      const rows = (
        result as unknown as { rows?: Array<{ referenced: boolean }> }
      ).rows;
      if (!rows || typeof rows[0]?.referenced !== 'boolean')
        throw new Error('Artifact reconciliation returned no durable result');
      return rows[0].referenced;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  /** Stores an uncertain completion's object reference in the existing Inbox ledger. */
  async recordExportArtifactForReconciliation(input: {
    exportId: string;
    fence: string;
    contentRef: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.db
        .insert(inbox)
        .values({
          messageId: input.contentRef,
          handler: 'bulk.export-artifact-reconciliation',
          eventName: 'bulk.export.artifact.reconciliation-required',
          correlationId: input.exportId,
          payload: {
            export_id: input.exportId,
            claim_token: input.fence,
            content_ref: input.contentRef,
            reason: input.reason,
          },
          result: 'PENDING_RECONCILIATION',
        })
        .onConflictDoNothing({
          target: [inbox.messageId, inbox.handler],
        });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async transitionExportJob(
    exportId: string,
    from: BulkJobStatus[],
    to: BulkJobStatus,
  ): Promise<typeof exportJobs.$inferSelect | null> {
    try {
      const allowed =
        (to === 'PROCESSING' && from.length === 1 && from[0] === 'QUEUED') ||
        (to === 'FAILED_GENERAL' &&
          from.length === 1 &&
          from[0] === 'PROCESSING');
      if (!allowed) inconsistent('Invalid export job state transition');
      const [job] = await this.db
        .update(exportJobs)
        .set({ status: to })
        .where(
          and(
            eq(exportJobs.exportId, exportId),
            inArray(exportJobs.status, from),
          ),
        )
        .returning();
      return job ?? null;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async completeExportJob(
    exportId: string,
    resultFile: Omit<FileManifestInput, 'role'>,
    fence: string,
    snapshot: ExportSnapshotMetadata,
  ): Promise<typeof exportJobs.$inferSelect | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const [claimed] = await tx
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.exportId, exportId))
          .for('update')
          .limit(1);
        if (!claimed) throw new BulkPersistenceError('FOREIGN_KEY_VIOLATION');
        const job = claimed;
        if (job.status !== 'PROCESSING' || job.claimToken !== fence)
          return null;
        if (resultFile.format !== job.format)
          inconsistent('Export output format must match the requested format');
        if (
          !matchesBulkStorageReference(
            resultFile.contentRef,
            process.env.BULK_STORAGE_BUCKET,
          )
        )
          inconsistent(
            'Export output must reference a configured Bulk Storage object',
          );
        if (
          !matchesExportObjectIdentity(
            resultFile.contentRef,
            exportId,
            fence,
            resultFile.format,
            process.env.BULK_STORAGE_BUCKET,
          ) ||
          Date.parse(snapshot.requestedAt) !== job.createdAt.getTime()
        )
          inconsistent('Export manifest identity or requested_at is invalid');
        // This checks adapter compatibility only. The caller must upload via
        // BulkStorageService.put(), which verifies the configured bucket ACL.
        const [manifest] = await tx
          .insert(fileManifests)
          .values({
            role: 'RESULTADO_EXPORTACION',
            format: resultFile.format,
            contentRef: resultFile.contentRef,
          })
          .returning({ id: fileManifests.id });
        if (!manifest)
          throw new Error('Output manifest insert returned no row');
        const metadata = {
          export_id: exportId,
          requested_at: snapshot.requestedAt,
          catalog_observed_at: snapshot.catalogObservedAt,
          pricing_observed_at: snapshot.pricingObservedAt,
          inventory_observed_at: snapshot.inventoryObservedAt,
          catalog_version: snapshot.catalogVersion,
          pricing_version: snapshot.pricingVersion,
          inventory_version: snapshot.inventoryVersion,
        };
        await tx.execute(sql`
          UPDATE bulk.file_manifests
          SET metadata = ${JSON.stringify(metadata)}::jsonb
          WHERE id = ${manifest.id}
        `);
        const [updated] = await tx
          .update(exportJobs)
          .set({
            status: 'COMPLETED',
            outputFileId: manifest.id,
            completedAt: new Date(),
          })
          .where(
            and(
              eq(exportJobs.id, job.id),
              eq(exportJobs.status, 'PROCESSING'),
              eq(exportJobs.claimToken, fence),
              sql`${exportJobs.leaseUntil} > now()`,
            ),
          )
          .returning();
        if (!updated)
          throw new Error('Locked export row changed during completion');
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
    onlyDue = false,
  ): Promise<Array<typeof outbox.$inferSelect>> {
    try {
      return await this.db
        .select()
        .from(outbox)
        .where(
          onlyDue
            ? sql`${outbox.publishedAt} IS NULL AND ${outbox.lastError} IS DISTINCT FROM 'CATALOG_ROUTE_REVIEW_REQUIRED' AND (coalesce(${outbox.lastError}, '') NOT LIKE 'AWAITING_CATALOG_RESULT:%' OR substring(${outbox.lastError} from 25)::timestamptz <= now())`
            : sql`${outbox.publishedAt} IS NULL`,
        )
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

  async deferOutboxUntilCatalogResult(
    messageId: string,
    attempts: number,
  ): Promise<void> {
    try {
      const parked = attempts >= 8;
      const retryAt = new Date(
        Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)),
      ).toISOString();
      await this.db
        .update(outbox)
        .set({
          attempts,
          lastError: parked
            ? 'CATALOG_ROUTE_REVIEW_REQUIRED'
            : `AWAITING_CATALOG_RESULT:${retryAt}`,
        })
        .where(
          and(
            eq(outbox.messageId, messageId),
            sql`${outbox.publishedAt} IS NULL`,
          ),
        );
    } catch (error) {
      throw persistenceError(error);
    }
  }

  /** Reactivates one parked Catalog command after externally verified topology. */
  async reactivateParkedCatalogOutbox(input: {
    messageId: string;
    operatorIdentity: string;
    approvalReference: string;
    reason: string;
    bindingEvidence: string;
    consumerEvidence: string;
  }): Promise<'REACTIVATED' | 'RESULT_ALREADY_RECORDED' | 'NOT_PARKED'> {
    const operatorIdentity = input.operatorIdentity.trim();
    const approvalReference = input.approvalReference.trim();
    const reason = input.reason.trim();
    const bindingEvidence = input.bindingEvidence.trim();
    const consumerEvidence = input.consumerEvidence.trim();
    if (
      !operatorIdentity ||
      !approvalReference ||
      !reason ||
      !bindingEvidence ||
      !consumerEvidence
    )
      inconsistent(
        'Recovery requires operator, approval, reason, and binding/consumer evidence',
      );
    try {
      return await this.db.transaction(async (tx) => {
        const [message] = await tx
          .select()
          .from(outbox)
          .where(eq(outbox.messageId, input.messageId))
          .for('update')
          .limit(1);
        if (!message || message.eventName !== 'catalog.bulk.upsert.requested')
          return 'NOT_PARKED';

        const [priorResult] = await tx
          .select({ id: inbox.id })
          .from(inbox)
          .where(
            and(
              sql`${inbox.handler} IN ('bulk.catalog.bulk-upsert.result', 'bulk.contract-result-replay')`,
              eq(inbox.correlationId, message.correlationId),
              sql`${inbox.payload}->>'causation_id' = ${message.messageId}`,
            ),
          )
          .limit(1);
        if (priorResult) return 'RESULT_ALREADY_RECORDED';
        if (
          message.publishedAt !== null ||
          message.lastError !== 'CATALOG_ROUTE_REVIEW_REQUIRED'
        )
          return 'NOT_PARKED';

        const [principal] = await tx
          .execute(sql`SELECT current_user AS actor`)
          .then(
            (result) =>
              (result as unknown as { rows: Array<{ actor: string }> }).rows,
          );
        if (!principal?.actor)
          throw new Error('Unable to record recovery database principal');
        const auditHandler = `bulk.catalog.outbox-recovery:${message.attempts}`;
        await tx
          .insert(inbox)
          .values({
            messageId: message.messageId,
            handler: auditHandler,
            eventName: 'bulk.catalog.outbox.recovery-authorized',
            correlationId: message.correlationId,
            payload: {
              message_id: message.messageId,
              database_principal: principal.actor,
              operator_identity: operatorIdentity,
              approval_reference: approvalReference,
              reason,
              binding_evidence: bindingEvidence,
              consumer_evidence: consumerEvidence,
              attempts: message.attempts,
            },
            result: 'REACTIVATED',
          })
          .onConflictDoNothing({ target: [inbox.messageId, inbox.handler] });
        // Use a fixed due instant so application/PostgreSQL clock skew cannot
        // leave an authorized recovery waiting behind the normal backoff.
        const retryAt = '2000-01-01T00:00:00.000Z';
        const [updated] = await tx
          .update(outbox)
          .set({ lastError: `AWAITING_CATALOG_RESULT:${retryAt}` })
          .where(
            and(
              eq(outbox.id, message.id),
              sql`${outbox.publishedAt} IS NULL`,
              eq(outbox.lastError, 'CATALOG_ROUTE_REVIEW_REQUIRED'),
            ),
          )
          .returning({ id: outbox.id });
        return updated ? 'REACTIVATED' : 'NOT_PARKED';
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

  async persistPendingContractResult(
    input: PendingContractResult,
  ): Promise<{ processed: boolean; result: string }> {
    return this.processInboxOnce(
      {
        messageId: input.messageId,
        handler: 'bulk.contract-result-replay',
        eventName: input.eventName,
        correlationId: input.correlationId,
        payload: input.payload,
      },
      async () => 'PENDING_REPLAY',
    );
  }

  async listPendingContractResults(
    limit = 100,
    eventNames?: string[],
  ): Promise<PendingContractResult[]> {
    try {
      if (eventNames && eventNames.length === 0) return [];
      const rows = await this.db
        .select({
          messageId: inbox.messageId,
          eventName: inbox.eventName,
          correlationId: inbox.correlationId,
          payload: inbox.payload,
        })
        .from(inbox)
        .where(
          and(
            eq(inbox.handler, 'bulk.contract-result-replay'),
            eq(inbox.result, 'PENDING_REPLAY'),
            ...(eventNames ? [inArray(inbox.eventName, eventNames)] : []),
          ),
        )
        .orderBy(asc(inbox.createdAt))
        .limit(Math.max(1, Math.min(limit, 500)));
      return rows.map((row) => ({
        messageId: row.messageId,
        eventName: row.eventName,
        correlationId: row.correlationId ?? '',
        payload: row.payload,
      }));
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async countPendingContractResults(eventNames: string[]): Promise<number> {
    if (eventNames.length === 0) return 0;
    try {
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(inbox)
        .where(
          and(
            eq(inbox.handler, 'bulk.contract-result-replay'),
            eq(inbox.result, 'PENDING_REPLAY'),
            inArray(inbox.eventName, eventNames),
          ),
        );
      return row?.count ?? 0;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  async markContractResultReplayed(input: {
    messageId: string;
    eventName: string;
    correlationId: string;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    try {
      const [updated] = await this.db
        .update(inbox)
        .set({ result: 'REPLAYED' })
        .where(
          and(
            eq(inbox.messageId, input.messageId),
            eq(inbox.handler, 'bulk.contract-result-replay'),
            eq(inbox.eventName, input.eventName),
            eq(inbox.correlationId, input.correlationId),
            eq(inbox.result, 'PENDING_REPLAY'),
            sql`${inbox.payload} = ${JSON.stringify(input.payload)}::jsonb`,
          ),
        )
        .returning({ id: inbox.id });
      if (updated) return true;
      const [existing] = await this.db
        .select({ result: inbox.result })
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, input.messageId),
            eq(inbox.handler, 'bulk.contract-result-replay'),
          ),
        )
        .limit(1);
      return existing?.result === 'REPLAYED';
    } catch (error) {
      throw persistenceError(error);
    }
  }
}

async function findActiveRunStart(
  tx: BulkTx,
  batch: typeof batchJobs.$inferSelect,
): Promise<Date> {
  const [latestRequeue] = await tx
    .select({ createdAt: inbox.createdAt })
    .from(inbox)
    .where(
      and(
        eq(inbox.handler, 'bulk.batch.requeue'),
        sql`${inbox.payload}->>'batchId' = ${batch.batchId}`,
      ),
    )
    .orderBy(desc(inbox.createdAt))
    .limit(1);
  return latestRequeue?.createdAt ?? batch.createdAt;
}

function matchesExportObjectIdentity(
  contentRef: string,
  exportId: string,
  fence: string,
  format: BulkFileFormat,
  bucket: string | undefined,
): boolean {
  if (
    !bucket ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      fence,
    )
  )
    return false;
  const prefix = `supabase://${bucket}/exports/${exportId}/${fence}/`;
  return new RegExp(
    `^${escapeRegExp(prefix)}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${format.toLowerCase()}$`,
    'i',
  ).test(contentRef);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  if (batch.status === 'COMPLETED' || batch.status === 'FAILED_GENERAL')
    inconsistent(
      'A terminal batch requires explicit eligible requeue before workflow updates',
    );
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
