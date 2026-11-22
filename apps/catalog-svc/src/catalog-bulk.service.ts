import {
  HttpException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { translatePostgresFailure } from './database-errors.js';
import { Database, type CatalogTransaction } from './database.js';
import {
  bulkRetryAttemptReceipts,
  bulkRetryCommandReceipts,
  inbox,
  outbox,
  products,
  variants,
} from './catalog.schema.js';
import { CatalogMutationService } from './catalog-mutation.service.js';
import {
  catalogError,
  object,
  parseMutation,
} from './catalog-mutation.input.js';
import {
  envelope,
  initialBulkAttemptId,
  InvalidCatalogMessage,
  UUID,
  type CatalogEnvelope,
} from './catalog-messages.js';
import {
  CatalogIdentityAcquisitionError,
  CatalogPricingIdentityProvider,
} from './catalog-pricing-identity.js';
import { CatalogConfig } from './config.js';
import { CatalogTokenVerifier } from './catalog-auth.js';
import {
  CatalogBulkContentClient,
  type CatalogBulkContentReference,
} from './catalog-bulk-content.js';

/** Existing G7 flow, with only the scope already published for Taxonomy reads. */
@Injectable()
export class CatalogBulkIdentity extends CatalogPricingIdentityProvider {
  constructor(
    @Optional() @Inject(CatalogConfig) config: CatalogConfig | undefined,
    verifier: CatalogTokenVerifier,
  ) {
    super(config, verifier);
  }
  protected override get scope(): string {
    return 'catalogo:leer';
  }
}
export interface BulkRow {
  row_number: number;
  row_operation_id: string;
  producto_id: string | null;
  sku_base: string;
  product: Record<string, unknown>;
  variant_id?: string | null;
  sku_variante?: string | null;
  variant: Record<string, unknown> | null;
}
export interface BulkRequest {
  batch_id: string;
  batch_operation_id: string;
  template_version: 2;
  mode: 'ALTA' | 'ACTUALIZACION';
  rows: BulkRow[];
}
export interface BulkRowResult extends Record<string, unknown> {
  row_number: number;
  row_operation_id: string;
  product_id: string | null;
  sku_base: string;
  status: 'COMPLETED' | 'REJECTED';
  code: string | null;
}
export function canonicalBulk(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalBulk).join(',') + ']';
  if (object(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalBulk(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function keys(value: Record<string, unknown>, expected: string[]) {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((k) => Object.hasOwn(value, k))
  );
}
export function parseBulkRequest(message: CatalogEnvelope): BulkRequest {
  const d = message.data;
  if (
    ![1, 2].includes(message.schema_version) ||
    !keys(d, [
      'batch_id',
      'batch_operation_id',
      'template_version',
      'mode',
      'rows',
    ]) ||
    !UUID.test(String(d.batch_id)) ||
    !UUID.test(String(d.batch_operation_id)) ||
    message.operation_id !== d.batch_operation_id ||
    d.template_version !== 2 ||
    !['ALTA', 'ACTUALIZACION'].includes(String(d.mode)) ||
    !Array.isArray(d.rows) ||
    !d.rows.length ||
    d.rows.length > 5000 ||
    Buffer.byteLength(JSON.stringify(message), 'utf8') > 1048576
  )
    catalogError(400, 'VALIDACION');
  const operations = new Set<string>(),
    numbers = new Set<number>(),
    finishedFamilies = new Set<string>();
  let family: string | undefined;
  for (const row of d.rows as unknown[]) {
    if (
      !object(row) ||
      !keys(row, [
        'row_number',
        'row_operation_id',
        'producto_id',
        'sku_base',
        'product',
        ...(message.schema_version === 1 || Object.hasOwn(row, 'variant_id')
          ? ['variant_id']
          : []),
        ...(message.schema_version === 2 && Object.hasOwn(row, 'sku_variante')
          ? ['sku_variante']
          : []),
        'variant',
      ]) ||
      (message.schema_version === 2 &&
        ['variant_id', 'sku_variante'].some(
          (key) =>
            Object.hasOwn(row, key) &&
            row[key] !== null &&
            (typeof row[key] !== 'string' || row[key].length === 0),
        )) ||
      !Number.isSafeInteger(row.row_number) ||
      Number(row.row_number) < 2 ||
      typeof row.row_operation_id !== 'string' ||
      !UUID.test(row.row_operation_id) ||
      typeof row.sku_base !== 'string' ||
      !row.sku_base ||
      !object(row.product) ||
      !(row.variant === null || object(row.variant)) ||
      (d.mode === 'ALTA'
        ? row.producto_id !== null ||
          (message.schema_version === 1
            ? row.variant_id !== null
            : row.variant_id != null || row.sku_variante != null)
        : typeof row.producto_id !== 'string' ||
          !row.producto_id ||
          (row.variant === null
            ? message.schema_version === 1
              ? row.variant_id !== null
              : row.variant_id != null || row.sku_variante != null
            : message.schema_version === 1
              ? typeof row.variant_id !== 'string' || !row.variant_id
              : typeof row.variant_id !== 'string' &&
                typeof row.sku_variante !== 'string'))
    )
      catalogError(400, 'VALIDACION');
    const r = row as unknown as BulkRow;
    if (
      operations.has(r.row_operation_id.toLowerCase()) ||
      numbers.has(r.row_number)
    )
      catalogError(400, 'VALIDACION');
    operations.add(r.row_operation_id.toLowerCase());
    numbers.add(r.row_number);
    if (r.sku_base !== family) {
      if (family !== undefined) finishedFamilies.add(family);
      if (finishedFamilies.has(r.sku_base)) catalogError(400, 'VALIDACION');
      family = r.sku_base;
    }
  }
  return d as unknown as BulkRequest;
}
function rejection(row: BulkRow, code: string): BulkRowResult {
  return {
    row_number: row.row_number,
    row_operation_id: row.row_operation_id,
    product_id: row.producto_id,
    sku_base: row.sku_base,
    status: 'REJECTED',
    code,
  };
}
export function businessCode(error: unknown): string | undefined {
  const failure = translatePostgresFailure(error);
  if (
    failure?.failure === 'unique' ||
    (failure?.failure === 'deferred_constraint' && failure.sqlState === '23505')
  ) {
    switch (failure.constraintName) {
      case 'uq_sku_identity_sku':
      case 'uq_products_sku_base':
      case 'uq_variants_sku':
        return 'SKU_DUPLICADO';
      case 'uq_variants_product_combination':
        return 'COMBINACION_DUPLICADA';
      case 'uq_products_slug':
        return 'SLUG_DUPLICADO';
      default:
        // An unknown UNIQUE may protect transport/persistence, not user input.
        // Preserve the technical failure and roll back the chunk before ACK.
        return;
    }
  }
  if (
    failure &&
    ['check', 'foreign_key', 'not_null', 'deferred_constraint'].includes(
      failure.failure,
    )
  )
    return 'VALIDACION';
  if (!(error instanceof HttpException) || error.getStatus() >= 500) return;
  const response = error.getResponse();
  return object(response) && typeof response.code === 'string'
    ? response.code
    : 'VALIDACION';
}
const COMMAND = 'catalog.bulk.command.v1',
  ROW = 'catalog.bulk.row.v1',
  DELIVERY = 'catalog.bulk.delivery.v1';

@Injectable()
export class CatalogBulkService {
  constructor(
    private readonly database: Database,
    private readonly mutations: CatalogMutationService,
    private readonly identity: CatalogBulkIdentity,
    @Optional() private readonly contentClient?: CatalogBulkContentClient,
  ) {}
  private async lock(tx: CatalogTransaction, key: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
  private async previous(tx: CatalogTransaction, id: string, handler: string) {
    return (
      await tx
        .select()
        .from(inbox)
        .where(and(eq(inbox.message_id, id), eq(inbox.handler, handler)))
        .limit(1)
    )[0];
  }
  private async remember(
    tx: CatalogTransaction,
    id: string,
    handler: string,
    message: CatalogEnvelope,
    payload: Record<string, unknown>,
  ) {
    await tx.insert(inbox).values({
      message_id: id,
      handler,
      event_name: message.name,
      correlation_id: message.correlation_id,
      operation_id: message.operation_id,
      payload,
      result: 'APPLIED',
    });
  }
  private semantic(request: BulkRequest, row: BulkRow) {
    return { batch_id: request.batch_id, mode: request.mode, row };
  }
  private async family(
    tx: CatalogTransaction,
    request: BulkRequest,
    rows: BulkRow[],
    authorization: string,
    correlationId: string,
  ): Promise<BulkRowResult[]> {
    const first = rows[0];
    if (
      rows.some(
        (r) =>
          canonicalBulk(r.product) !== canonicalBulk(first.product) ||
          r.producto_id !== first.producto_id,
      )
    )
      catalogError(400, 'VALIDACION');
    for (const row of rows) {
      parseMutation(
        row.product,
        request.mode === 'ALTA' ? 'createProduct' : 'updateProduct',
      );
      if (
        request.mode === 'ACTUALIZACION' &&
        row.variant &&
        !Number.isSafeInteger(row.variant.catalogVersion)
      )
        catalogError(400, 'VALIDACION');
      if (row.variant)
        parseMutation(
          row.variant,
          request.mode === 'ALTA' ? 'createVariant' : 'updateVariant',
        );
    }
    const actor = { authorization, correlationId };
    const targets = new Map<BulkRow, string>();
    let id: string;
    if (request.mode === 'ALTA') {
      if (
        first.product.skuBase !== first.sku_base ||
        typeof first.product.tieneVariantes !== 'boolean' ||
        (first.product.tieneVariantes
          ? rows.some((r) => r.variant === null)
          : rows.length !== 1 || first.variant !== null)
      )
        catalogError(400, 'VALIDACION');
      const created = await this.mutations.createProduct(
        first.product,
        actor,
        tx,
      );
      id = created.product_id;
      for (const row of rows)
        if (row.variant)
          await this.mutations.createVariant(id, row.variant, actor, tx, true);
    } else {
      id = first.producto_id!;
      const parent = (
        await tx
          .select()
          .from(products)
          .where(sql`${products.id}::text = ${id}`)
          .for('update')
      )[0];
      if (!parent) catalogError(404, 'PRODUCTO_NO_ENCONTRADO');
      if (
        parent.sku_base !== first.sku_base ||
        (parent.tiene_variantes
          ? rows.some((r) => r.variant === null)
          : rows.length !== 1 || first.variant !== null) ||
        (first.product.tipoProductoId !== undefined &&
          first.product.tipoProductoId !== parent.tipo_producto_id)
      )
        catalogError(400, 'VALIDACION');
      // Parent intent/version is shared by the family and is applied exactly once.
      if (!Number.isSafeInteger(first.product.catalogVersion))
        catalogError(400, 'VALIDACION');
      for (const row of rows)
        if (row.variant) {
          const child = (
            await tx
              .select()
              .from(variants)
              .where(
                and(
                  typeof row.sku_variante === 'string'
                    ? eq(variants.sku, row.sku_variante)
                    : sql`${variants.id}::text = ${row.variant_id}`,
                  eq(variants.product_id, id),
                ),
              )
              .for('update')
          )[0];
          if (!child) catalogError(404, 'VARIANTE_NO_ENCONTRADA');
          if (row.variant_id != null && row.variant_id !== child.id)
            catalogError(400, 'VALIDACION');
          // Keep the original row untouched for existing Inbox/operation receipts.
          targets.set(row, child.id);
        }
      if (
        new Set(targets.values()).size !== rows.filter((r) => r.variant).length
      )
        catalogError(400, 'VALIDACION');
      await this.mutations.update(id, undefined, first.product, actor, tx);
      for (const row of rows)
        if (row.variant)
          await this.mutations.update(
            id,
            targets.get(row)!,
            row.variant,
            actor,
            tx,
            true,
          );
    }
    return rows.map((r) => ({
      row_number: r.row_number,
      row_operation_id: r.row_operation_id,
      product_id: id,
      sku_base: r.sku_base,
      status: 'COMPLETED',
      code: null,
    }));
  }
  private async consumeRetryV4(
    tx: CatalogTransaction,
    message: CatalogEnvelope,
    request: BulkRequest,
  ): Promise<'APPLIED' | 'DUPLICATE'> {
    if (
      process.env.CATALOG_BULK_RETRY_V1_ENABLED !== 'true' ||
      process.env.CATALOG_BULK_RESULT_V2_ENABLED !== 'true'
    )
      throw new ServiceUnavailableException();
    const retry = message.data.retry as {
      command_attempt_id: string;
      attempt_number: number;
      previous_command_message_id: string;
      rows: Array<{
        row_operation_id: string;
        attempt_id: string;
        previous_attempt_id: string;
      }>;
    };
    const retryPayloadHash = createHash('sha256')
      .update(canonicalBulk(message.data))
      .digest('hex');
    await this.lock(tx, 'bulk-retry-command:' + retry.command_attempt_id);
    const [existingCommand] = await tx
      .select()
      .from(bulkRetryCommandReceipts)
      .where(
        eq(bulkRetryCommandReceipts.commandAttemptId, retry.command_attempt_id),
      )
      .for('update')
      .limit(1);
    if (existingCommand) {
      if (
        existingCommand.messageId !== message.message_id ||
        existingCommand.payloadHash !== retryPayloadHash
      )
        throw new InvalidCatalogMessage();
      return 'DUPLICATE';
    }
    const requestedIds = retry.rows.map((row) => row.row_operation_id).sort();
    const selectedRows = request.rows.filter((row) =>
      requestedIds.includes(row.row_operation_id),
    );
    const familyKey = selectedRows[0]?.sku_base;
    if (!familyKey) throw new InvalidCatalogMessage();
    const familyRows = request.rows
      .filter((row) => row.sku_base === familyKey)
      .sort((a, b) => a.row_operation_id.localeCompare(b.row_operation_id));
    if (
      familyRows.length !== requestedIds.length ||
      selectedRows.length !== requestedIds.length ||
      familyRows.some(
        (row, index) => row.row_operation_id !== requestedIds[index],
      )
    )
      throw new InvalidCatalogMessage();
    const reference = message.data.content_ref as CatalogBulkContentReference;
    const priorAttempts: Array<{
      retryRow: (typeof retry.rows)[number];
      previous: typeof bulkRetryAttemptReceipts.$inferSelect;
      original: typeof bulkRetryAttemptReceipts.$inferSelect;
      row: BulkRequest['rows'][number];
    }> = [];
    for (const retryRow of [...retry.rows].sort((a, b) =>
      a.row_operation_id.localeCompare(b.row_operation_id),
    )) {
      await this.lock(
        tx,
        'bulk-row:' + retryRow.row_operation_id.toLowerCase(),
      );
      const attempts = await tx
        .select()
        .from(bulkRetryAttemptReceipts)
        .where(
          eq(
            bulkRetryAttemptReceipts.rowOperationId,
            retryRow.row_operation_id,
          ),
        )
        .orderBy(desc(bulkRetryAttemptReceipts.attemptNumber))
        .for('update');
      const previous = attempts[0];
      const row = familyRows.find(
        (candidate) => candidate.row_operation_id === retryRow.row_operation_id,
      );
      const expectedIntent = row
        ? createHash('sha256')
            .update(canonicalBulk(this.semantic(request, row)))
            .digest('hex')
        : '';
      if (
        !previous ||
        attempts.length !== previous.attemptNumber ||
        attempts.some(
          (attempt, index) =>
            attempt.attemptNumber !== previous.attemptNumber - index,
        ) ||
        previous.attemptId !== retryRow.previous_attempt_id ||
        previous.attemptNumber + 1 !== retry.attempt_number ||
        previous.batchId !== request.batch_id ||
        previous.batchOperationId !== request.batch_operation_id ||
        previous.payloadHash !== reference.sha256 ||
        previous.intentHash !== expectedIntent ||
        previous.status !== 'REJECTED' ||
        previous.effectState !== 'NONE' ||
        !previous.retriable
      )
        throw new InvalidCatalogMessage();
      const originalId = previous.originalAttemptId ?? previous.attemptId;
      const [original] = await tx
        .select()
        .from(bulkRetryAttemptReceipts)
        .where(eq(bulkRetryAttemptReceipts.attemptId, originalId))
        .for('update')
        .limit(1);
      const [priorResult] = await tx
        .select()
        .from(outbox)
        .where(eq(outbox.message_id, previous.receiptMessageId))
        .limit(1);
      const priorDelivery = await this.previous(
        tx,
        retry.previous_command_message_id,
        DELIVERY,
      );
      const priorCommand = priorDelivery?.payload as
        CatalogEnvelope | undefined;
      const priorRows = Array.isArray(priorResult?.payload.results)
        ? priorResult.payload.results
        : [];
      const priorRow = priorRows.find(
        (candidate) =>
          object(candidate) &&
          candidate.attempt_id === previous.attemptId &&
          candidate.row_operation_id === previous.rowOperationId,
      );
      if (
        !original ||
        original.attemptNumber !== 1 ||
        original.batchOperationId !== request.batch_operation_id ||
        original.payloadHash !== reference.sha256 ||
        !priorResult ||
        !priorDelivery ||
        priorDelivery.correlation_id !== priorResult.correlation_id ||
        priorCommand?.data.batch_id !== request.batch_id ||
        priorCommand?.data.batch_operation_id !== request.batch_operation_id ||
        priorResult.schema_version !== 2 ||
        priorResult.causation_id !== retry.previous_command_message_id ||
        priorResult.payload.command_attempt_id !== previous.commandAttemptId ||
        priorResult.event_name !== 'catalog.bulk.upsert.completed' ||
        !object(priorRow) ||
        priorRow.status !== 'REJECTED' ||
        priorRow.effect_state !== 'NONE' ||
        priorRow.retriable !== true
      )
        throw new InvalidCatalogMessage();
      priorAttempts.push({ retryRow, previous, original, row: row! });
    }
    await this.lock(tx, 'bulk-family:' + familyKey);
    let authorization: string | undefined;
    let temporaryIdentityFailure = false;
    try {
      authorization = await this.identity.authorizationForBulkRetry(
        AbortSignal.timeout(5000),
      );
    } catch (error) {
      if (
        error instanceof CatalogIdentityAcquisitionError &&
        error.classification === 'TRANSIENT'
      )
        temporaryIdentityFailure = true;
      else throw new ServiceUnavailableException();
    }
    let rowResults: BulkRowResult[];
    if (temporaryIdentityFailure) {
      rowResults = familyRows.map((row) =>
        rejection(row, 'CATALOG_AUTH_TEMPORARY_UNAVAILABLE'),
      );
    } else {
      if (!authorization || !/^Bearer [^\s]+$/i.test(authorization))
        throw new ServiceUnavailableException();
      try {
        rowResults = await tx.transaction(async (familyTx) => {
          const applied = await this.family(
            familyTx,
            request,
            familyRows,
            authorization!,
            message.correlation_id,
          );
          await familyTx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          await familyTx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
          return applied;
        });
      } catch (error) {
        const code = businessCode(error);
        if (!code) throw error;
        rowResults = familyRows.map((row) => rejection(row, code));
      }
    }
    const receiptMessageId = randomUUID();
    const v2Results = rowResults.map((rowResult) => {
      const prior = priorAttempts.find(
        ({ retryRow }) =>
          retryRow.row_operation_id === rowResult.row_operation_id,
      )!;
      return {
        ...rowResult,
        attempt_id: prior.retryRow.attempt_id,
        attempt_number: retry.attempt_number,
        effect_state:
          rowResult.status === 'COMPLETED'
            ? 'APPLIED'
            : temporaryIdentityFailure
              ? 'NONE'
              : 'NONE',
        retriable:
          temporaryIdentityFailure &&
          rowResult.code === 'CATALOG_AUTH_TEMPORARY_UNAVAILABLE',
      };
    });
    const resultData = {
      batch_id: request.batch_id,
      batch_operation_id: request.batch_operation_id,
      command_attempt_id: retry.command_attempt_id,
      results: v2Results,
    };
    const result = envelope(
      'catalog.bulk.upsert.completed',
      resultData,
      message.correlation_id,
      request.batch_operation_id,
      message.message_id,
      2,
      receiptMessageId,
    );
    // The attempt receipt has a foreign key to this command attempt. Persist
    // the command receipt first; both records and the result Outbox remain in
    // the same transaction, so this does not expose a partial completion.
    await tx.insert(bulkRetryCommandReceipts).values({
      commandAttemptId: retry.command_attempt_id,
      messageId: message.message_id,
      batchId: request.batch_id,
      batchOperationId: request.batch_operation_id,
      previousCommandMessageId: retry.previous_command_message_id,
      payloadHash: retryPayloadHash,
      resultMessageId: result.message_id,
      resultPayload: result.data,
      completedAt: new Date(),
    });
    for (const entry of priorAttempts) {
      const rowResult = v2Results.find(
        (candidate) =>
          candidate.row_operation_id === entry.retryRow.row_operation_id,
      )!;
      await tx.insert(bulkRetryAttemptReceipts).values({
        attemptId: entry.retryRow.attempt_id,
        commandAttemptId: retry.command_attempt_id,
        batchId: request.batch_id,
        batchOperationId: request.batch_operation_id,
        rowOperationId: entry.retryRow.row_operation_id,
        previousAttemptId: entry.previous.attemptId,
        originalAttemptId: entry.original.attemptId,
        receiptMessageId,
        attemptNumber: retry.attempt_number,
        payloadHash: reference.sha256,
        intentHash: entry.previous.intentHash,
        status: rowResult.status,
        effectState: rowResult.effect_state,
        retriable: rowResult.retriable,
        errorCode: rowResult.code,
      });
    }
    await tx.insert(outbox).values({
      message_id: result.message_id,
      event_name: result.name,
      kind: result.kind,
      schema_version: result.schema_version,
      correlation_id: result.correlation_id,
      operation_id: result.operation_id,
      causation_id: result.causation_id,
      occurred_at: new Date(result.occurred_at),
      payload: result.data,
    });
    await this.remember(tx, message.message_id, DELIVERY, message, message);
    return 'APPLIED';
  }
  async consume(message: CatalogEnvelope): Promise<'APPLIED' | 'DUPLICATE'> {
    // These IDs are required to issue a causal contractual rejection at all.
    if (
      !UUID.test(String(message.data.batch_id)) ||
      !UUID.test(String(message.data.batch_operation_id)) ||
      (message.operation_id != null && !UUID.test(message.operation_id)) ||
      (message.schema_version === 4 &&
        message.operation_id !== message.data.batch_operation_id) ||
      (message.schema_version === 3 &&
        message.operation_id != null &&
        message.operation_id !== message.data.batch_operation_id) ||
      (message.schema_version !== 3 &&
        message.schema_version !== 4 &&
        !UUID.test(String(message.operation_id)))
    )
      throw new InvalidCatalogMessage();
    let claimRequest: BulkRequest | null | undefined;
    if (message.schema_version === 3 || message.schema_version === 4) {
      const reference = message.data.content_ref as CatalogBulkContentReference;
      if (!this.contentClient) throw new ServiceUnavailableException();
      const document = await this.contentClient.getDocument(reference);
      if (
        !object(document) ||
        Object.keys(document).length !== 1 ||
        !Array.isArray(document.rows)
      )
        throw new InvalidCatalogMessage();
      const materialized = {
        ...message,
        operation_id: String(message.data.batch_operation_id),
        schema_version: 2,
        data: {
          batch_id: message.data.batch_id,
          batch_operation_id: message.data.batch_operation_id,
          template_version: message.data.template_version,
          mode: message.data.mode,
          rows: document.rows,
        },
      } as CatalogEnvelope;
      try {
        claimRequest = parseBulkRequest(materialized);
      } catch (error) {
        if (!businessCode(error)) throw error;
        claimRequest = null;
      }
    }
    return this.database.transaction(async (tx) => {
      await this.lock(tx, 'bulk-delivery:' + message.message_id.toLowerCase());
      await this.lock(
        tx,
        'bulk-command:' + String(message.data.batch_operation_id).toLowerCase(),
      );
      const delivered = await this.previous(tx, message.message_id, DELIVERY);
      if (delivered) {
        if (canonicalBulk(delivered.payload) !== canonicalBulk(message))
          throw new InvalidCatalogMessage();
        return 'DUPLICATE';
      }
      if (message.schema_version === 4) {
        if (!claimRequest) throw new InvalidCatalogMessage();
        return this.consumeRetryV4(tx, message, claimRequest);
      }
      const old = await this.previous(
        tx,
        String(message.data.batch_operation_id),
        COMMAND,
      );
      let result: Record<string, unknown>, name: string;
      let resultSchemaVersion: 1 | 2 = 1;
      const replyMessageId = randomUUID();
      let requestForV2: BulkRequest | undefined;
      let newlyProcessed = false;
      if (
        old &&
        canonicalBulk(old.payload.input) !== canonicalBulk(message.data)
      ) {
        name = 'catalog.bulk.upsert.rejected';
        result = {
          batch_id: message.data.batch_id,
          batch_operation_id: message.data.batch_operation_id,
          code: 'IDEMPOTENCY_CONFLICT',
          detail: 'La identidad del comando ya corresponde a otra intención.',
        };
      } else if (old) {
        name = String(old.payload.name);
        result = old.payload.result as Record<string, unknown>;
        if (old.payload.schema_version === 2) resultSchemaVersion = 2;
      } else {
        let request: BulkRequest | undefined = claimRequest ?? undefined;
        if (claimRequest === undefined) {
          try {
            request = parseBulkRequest(message);
          } catch (error) {
            if (!businessCode(error)) throw error;
          }
        }
        if (!request) {
          name = 'catalog.bulk.upsert.rejected';
          result = {
            batch_id: message.data.batch_id,
            batch_operation_id: message.data.batch_operation_id,
            code: 'VALIDACION',
            detail: 'El comando no cumple el contrato de entrada.',
          };
        } else {
          requestForV2 = request;
          for (const id of request.rows.map((r) => r.row_operation_id).sort())
            await this.lock(tx, 'bulk-row:' + id.toLowerCase());
          for (const sku of [
            ...new Set(request.rows.map((r) => r.sku_base)),
          ].sort())
            await this.lock(tx, 'bulk-family:' + sku);
          const results: BulkRowResult[] = [];
          const groups = new Map<string, BulkRow[]>();
          for (const row of request.rows)
            groups.set(row.sku_base, [
              ...(groups.get(row.sku_base) ?? []),
              row,
            ]);
          let authorization: string | undefined;
          let temporaryIdentityFailure = false;
          for (const rows of groups.values()) {
            const previous = await Promise.all(
              rows.map((r) => this.previous(tx, r.row_operation_id, ROW)),
            );
            const conflict = previous.some(
              (p, i) =>
                p &&
                canonicalBulk(p.payload.input) !==
                  canonicalBulk(this.semantic(request, rows[i])),
            );
            let applied: BulkRowResult[];
            if (
              conflict ||
              (previous.some(Boolean) && !previous.every(Boolean))
            )
              applied = rows.map((r, i) =>
                previous[i] &&
                canonicalBulk(previous[i]!.payload.input) ===
                  canonicalBulk(this.semantic(request, r))
                  ? (previous[i]!.payload.result as BulkRowResult)
                  : rejection(r, 'IDEMPOTENCY_CONFLICT'),
              );
            else if (previous.every(Boolean))
              applied = previous.map((p) => p!.payload.result as BulkRowResult);
            else {
              if (authorization === undefined && !temporaryIdentityFailure) {
                try {
                  authorization = await this.identity.authorizationForBulkRetry(
                    AbortSignal.timeout(5000),
                  );
                } catch (error) {
                  if (
                    error instanceof CatalogIdentityAcquisitionError &&
                    error.classification === 'TRANSIENT' &&
                    message.schema_version === 3 &&
                    process.env.CATALOG_BULK_RESULT_V2_ENABLED === 'true'
                  )
                    temporaryIdentityFailure = true;
                  else throw new ServiceUnavailableException();
                }
              }
              if (temporaryIdentityFailure) {
                // Identity acquisition is before the family savepoint and before any mutation.
                applied = rows.map((r) =>
                  rejection(r, 'CATALOG_AUTH_TEMPORARY_UNAVAILABLE'),
                );
              } else {
                if (!authorization || !/^Bearer [^\s]+$/i.test(authorization))
                  throw new ServiceUnavailableException();
                try {
                  applied = await tx.transaction(async (familyTx) => {
                    // No human identity is created: only a verified G6 service token goes to Taxonomy.
                    const results = await this.family(
                      familyTx,
                      request!,
                      rows,
                      authorization!,
                      message.correlation_id,
                    );
                    await familyTx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
                    await familyTx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
                    return results;
                  });
                } catch (error) {
                  const code = businessCode(error);
                  if (!code) throw error;
                  applied = rows.map((r) => rejection(r, code));
                }
              }
            }
            for (let i = 0; i < rows.length; i++)
              if (!previous[i])
                await this.remember(
                  tx,
                  rows[i].row_operation_id,
                  ROW,
                  message,
                  {
                    input: this.semantic(request, rows[i]),
                    result: applied[i],
                  },
                );
            results.push(...applied);
          }
          name = 'catalog.bulk.upsert.completed';
          result = {
            batch_id: request.batch_id,
            batch_operation_id: request.batch_operation_id,
            results,
          };
        }
        newlyProcessed = true;
      }
      const emitInitialV2 =
        newlyProcessed &&
        message.schema_version === 3 &&
        process.env.CATALOG_BULK_RESULT_V2_ENABLED === 'true';
      if (emitInitialV2) {
        resultSchemaVersion = 2;
        const contentReference = message.data.content_ref as
          Record<string, unknown> | undefined;
        if (
          !contentReference ||
          typeof contentReference.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(contentReference.sha256)
        )
          throw new InvalidCatalogMessage();
        if (name === 'catalog.bulk.upsert.completed' && requestForV2) {
          const priorResults = result.results as BulkRowResult[];
          const attempts = priorResults.map((rowResult) => {
            const source = requestForV2!.rows.find(
              (row) => row.row_operation_id === rowResult.row_operation_id,
            );
            if (!source) throw new InvalidCatalogMessage();
            const intentHash = createHash('sha256')
              .update(canonicalBulk(this.semantic(requestForV2!, source)))
              .digest('hex');
            return {
              ...rowResult,
              attempt_id: initialBulkAttemptId(
                requestForV2!.batch_operation_id,
                source.row_operation_id,
              ),
              attempt_number: 1,
              effect_state:
                rowResult.status === 'COMPLETED' ? 'APPLIED' : 'NONE',
              retriable:
                rowResult.status === 'REJECTED' &&
                rowResult.code === 'CATALOG_AUTH_TEMPORARY_UNAVAILABLE',
              payload_hash: contentReference.sha256 as string,
              intent_hash: intentHash,
            };
          });
          for (const attempt of attempts)
            await tx.insert(bulkRetryAttemptReceipts).values({
              attemptId: attempt.attempt_id,
              commandAttemptId: null,
              batchId: requestForV2.batch_id,
              batchOperationId: requestForV2.batch_operation_id,
              rowOperationId: attempt.row_operation_id,
              previousAttemptId: null,
              originalAttemptId: null,
              receiptMessageId: replyMessageId,
              attemptNumber: 1,
              payloadHash: attempt.payload_hash,
              intentHash: attempt.intent_hash,
              status: attempt.status,
              effectState: attempt.effect_state,
              retriable: attempt.retriable,
              errorCode: attempt.code,
            });
          result = {
            batch_id: result.batch_id,
            batch_operation_id: result.batch_operation_id,
            command_attempt_id: null,
            results: attempts.map(
              ({
                payload_hash: _payloadHash,
                intent_hash: _intentHash,
                ...item
              }) => item,
            ),
          };
        } else {
          result = { ...result, command_attempt_id: null };
        }
      }
      if (newlyProcessed)
        await this.remember(
          tx,
          String(message.data.batch_operation_id),
          COMMAND,
          message,
          {
            input: message.data,
            name,
            result,
            schema_version: resultSchemaVersion,
          },
        );
      const reply = envelope(
        name,
        result,
        message.correlation_id,
        String(message.data.batch_operation_id),
        message.message_id,
        resultSchemaVersion,
        replyMessageId,
      );
      await tx.insert(outbox).values({
        message_id: reply.message_id,
        event_name: reply.name,
        kind: reply.kind,
        schema_version: reply.schema_version,
        correlation_id: reply.correlation_id,
        operation_id: reply.operation_id,
        causation_id: reply.causation_id,
        occurred_at: new Date(reply.occurred_at),
        payload: reply.data,
      });
      await this.remember(tx, message.message_id, DELIVERY, message, message);
      return 'APPLIED';
    });
  }
}
