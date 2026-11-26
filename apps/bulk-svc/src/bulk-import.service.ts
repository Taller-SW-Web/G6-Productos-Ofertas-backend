import { Injectable } from '@nestjs/common';
import { Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  buildCatalogBulkCommands,
  stableUuid,
  type CatalogBulkCommand,
  type CatalogBulkRow,
} from './messaging/catalog-bulk-upsert.js';
import {
  parseBulkTemplate,
  type ParsedBulkTemplate,
} from './domain/bulk-template-v2.js';
import {
  BulkDomainError,
  mapBulkPersistenceError,
} from './domain/bulk.errors.js';
import {
  validateBulkImport,
  type NormalizedBulkRow,
} from './domain/bulk.validation.js';
import { BulkPersistenceError } from './persistence/bulk.persistence.errors.js';
import {
  BulkPersistenceRepository,
  type DomainResultInput,
} from './persistence/bulk.repository.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';

@Injectable()
export class BulkImportService {
  constructor(
    private readonly repository: BulkPersistenceRepository,
    @Optional() private readonly storage?: BulkStorageService,
  ) {}

  async receiveImport(input: {
    bytes: Buffer;
    format: 'CSV' | 'XLSX';
    templateVersion: number;
    ownerSub: string;
    correlationId: string;
    contentRef: string;
    batchId?: string;
    parsed?: ParsedBulkTemplate;
  }) {
    if (input.templateVersion !== 2)
      throw new BulkDomainError(
        'PLANTILLA_INCOMPATIBLE',
        'template_version debe ser 2.',
      );
    const batchId = input.batchId ?? randomUUID();
    const parsedFile =
      input.parsed ?? parseBulkTemplate(input.bytes, input.format);
    const envDefaultLocation =
      process.env.BULK_DEFAULT_LOCATION_ID &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        process.env.BULK_DEFAULT_LOCATION_ID,
      )
        ? process.env.BULK_DEFAULT_LOCATION_ID
        : null;
    const parsed = {
      ...parsedFile,
      rows: parsedFile.rows.map((row) => {
        const rowId = stableUuid(
          `${batchId}:bulk-row:${row.rowNumber}:${row.rowId}`,
        );
        return {
          ...row,
          rowId,
          rowOperationId: rowId,
          defaultLocationId: row.defaultLocationId ?? envDefaultLocation,
        };
      }),
    };
    const commandV2 =
      parsed.mode === 'ACTUALIZACION' &&
      parsed.rows.some((row) => row.variant !== null);
    const rows: NormalizedBulkRow[] = parsed.rows.map((row) => ({
      rowId: row.rowId,
      productId: row.productId,
      mode: row.mode,
      skuIdentityRequired: true,
      skuBase: row.skuBase,
      variantSkus: row.skuVariant ? [row.skuVariant] : [],
      precioRegular:
        typeof row.product.precioBaseInicial === 'number'
          ? row.product.precioBaseInicial
          : null,
      stockInicial: row.stockInicial,
      defaultLocationId: row.defaultLocationId,
    }));
    const result = await this.createImport({
      batchId,
      correlationId: input.correlationId,
      contentRef: input.contentRef,
      format: input.format,
      templateVersion: parsed.templateVersion,
      ownerSub: input.ownerSub,
      rows,
      intentRows: parsed.rows,
      catalogCommandVersion: catalogV3EmissionEnabled() ? 3 : commandV2 ? 2 : 1,
    });
    return { ...result, parsed };
  }

  async getSnapshot(batchId: string, ownerSub: string) {
    const snapshot = await this.repository.loadBatchSnapshot(batchId, ownerSub);
    if (!snapshot)
      throw new BulkDomainError('BATCH_NOT_FOUND', 'El lote no existe.');
    return snapshot;
  }

  async getRetryEligibility(batchId: string, ownerSub: string) {
    try {
      return await this.repository.getRetryEligibility(batchId, ownerSub);
    } catch (error) {
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'FOREIGN_KEY_VIOLATION'
      )
        throw new BulkDomainError('BATCH_NOT_FOUND', 'El lote no existe.', {
          cause: error,
        });
      throw mapBulkPersistenceError(error);
    }
  }

  async findByOwnerAndCorrelation(ownerSub: string, correlationId: string) {
    try {
      return await this.repository.findBatchByOwnerAndCorrelation(
        ownerSub,
        correlationId,
      );
    } catch (error) {
      throw mapBulkPersistenceError(error);
    }
  }

  async createImport(input: {
    batchId: string;
    ownerSub: string;
    correlationId: string;
    contentRef: string;
    format: string;
    templateVersion: number;
    rows: NormalizedBulkRow[];
    intentRows?: unknown[];
    catalogCommandVersion?: 1 | 2 | 3;
  }) {
    const normalized = validateBulkImport(input);
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      !uuid.test(input.batchId) ||
      !uuid.test(input.correlationId) ||
      !input.contentRef
    ) {
      throw new BulkDomainError(
        'INVALID_INPUT',
        'batch_id, correlation_id o referencia del archivo son inválidos.',
      );
    }
    const persistedRows = normalized.map((row) => ({
      rowId: row.rowId,
      requiredDomains: row.requiredDomains,
    }));
    const catalogRows = (input.intentRows ?? []).map((value) => {
      if (typeof value !== 'object' || value === null) {
        throw new BulkDomainError(
          'INVALID_INPUT',
          'La intención normalizada de Catalog está incompleta.',
        );
      }
      const row = value as Record<string, unknown>;
      return {
        row_number: Number(row.rowNumber),
        row_operation_id: String(row.rowOperationId),
        producto_id: typeof row.productId === 'string' ? row.productId : null,
        sku_base: String(row.skuBase),
        product: row.product as Record<string, unknown>,
        variant_id: typeof row.variantId === 'string' ? row.variantId : null,
        variant: (row.variant as Record<string, unknown> | null) ?? null,
        ...(input.catalogCommandVersion === 2 &&
        typeof row.skuVariant === 'string'
          ? { sku_variante: row.skuVariant }
          : {}),
      } satisfies CatalogBulkRow;
    });
    let priorAdmission: Record<string, unknown> | null;
    try {
      priorAdmission = await this.repository.findImportAdmissionIntent(
        input.batchId,
        input.ownerSub,
      );
    } catch (error) {
      throw mapBulkPersistenceError(error);
    }
    const persistedCommands = Array.isArray(priorAdmission?.catalogCommands)
      ? priorAdmission.catalogCommands
      : null;
    let contentDocument:
      | {
          contentId: string;
          batchId: string;
          batchOperationId: string;
          contentRef: string;
          sha256: string;
          byteLength: number;
        }
      | undefined;
    if (input.catalogCommandVersion === 3 && !persistedCommands) {
      if (!catalogV3EmissionEnabled() || !this.storage || !catalogRows.length)
        throw new BulkDomainError(
          'STORAGE_UNAVAILABLE',
          'La emisión Bulk V3 está deshabilitada o el almacenamiento privado no está configurado.',
        );
      const documentBytes = Buffer.from(
        JSON.stringify({ rows: catalogRows }),
        'utf8',
      );
      const sha256 = createHash('sha256').update(documentBytes).digest('hex');
      const contentId = stableUuid(`${input.batchId}:catalog-bulk-v3-content`);
      const contentRef = await this.storage.put(
        documentBytes,
        'application/json',
        `imports/${input.batchId}/catalog-${sha256}.json`,
      );
      contentDocument = {
        contentId,
        batchId: input.batchId,
        batchOperationId: stableUuid(
          `${input.batchId}:catalog-bulk-upsert:0:operation`,
        ),
        contentRef,
        sha256,
        byteLength: documentBytes.length,
      };
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const commands: CatalogBulkCommand[] = persistedCommands
      ? persistedCommands.map((value) => {
          const envelope = value as CatalogBulkCommand['envelope'];
          return { envelope, serialized: JSON.stringify(envelope) };
        })
      : catalogRows.length
        ? buildCatalogBulkCommands({
            batchId: input.batchId,
            correlationId: input.correlationId,
            rows: catalogRows,
            schemaVersion: input.catalogCommandVersion ?? 1,
            ...(contentDocument
              ? {
                  contentReference: {
                    content_id: contentDocument.contentId,
                    sha256: contentDocument.sha256,
                    byte_length: contentDocument.byteLength,
                    content_type: 'application/json' as const,
                  },
                }
              : {}),
            occurredAt: now,
          })
        : [];

    const persistedInventoryCommands = Array.isArray(
      priorAdmission?.inventoryCommands,
    )
      ? (priorAdmission.inventoryCommands as Array<Record<string, unknown>>)
      : null;
    const inventoryCommands: Array<Record<string, unknown>> =
      persistedInventoryCommands ??
      normalized.flatMap((row, rowIndex) => {
        if (
          !row.requiredDomains.includes('INVENTARIO') ||
          row.inventoryAdjustment !== 'REQUIRED' ||
          !row.defaultLocationId ||
          row.stockInicial === null ||
          row.stockInicial === undefined ||
          row.vendibleSkus.length === 0
        ) {
          return [];
        }
        const intentRow = Array.isArray(input.intentRows)
          ? (input.intentRows[rowIndex] as Record<string, unknown> | undefined)
          : undefined;
        const expectedStockVersion =
          intentRow &&
          typeof intentRow.expectedStockVersion === 'number' &&
          Number.isSafeInteger(intentRow.expectedStockVersion) &&
          intentRow.expectedStockVersion >= 0
            ? intentRow.expectedStockVersion
            : 0;
        return row.vendibleSkus.map((sku) => {
          const operationId = stableUuid(
            `${input.batchId}:inventory-bulk-adjust:${row.rowId}:${sku}:operation`,
          );
          return {
            message_id: stableUuid(
              `${input.batchId}:inventory-bulk-adjust:${row.rowId}:${sku}:message`,
            ),
            schema_version: 1,
            occurred_at: nowIso,
            correlation_id: input.correlationId,
            operation_id: operationId,
            producer: 'bulk-svc',
            kind: 'command',
            name: 'inventory.bulk.stock.adjust.requested',
            data: {
              operation_id: operationId,
              batch_id: input.batchId,
              row_operation_id: row.rowId,
              sku,
              location_id: row.defaultLocationId,
              target_on_hand: row.stockInicial,
              expected_stock_version: expectedStockVersion,
              reason: 'BULK_INITIAL_STOCK',
              requested_at: nowIso,
            },
          };
        });
      });

    const persistedPricingCommands = Array.isArray(
      priorAdmission?.pricingCommands,
    )
      ? (priorAdmission.pricingCommands as Array<Record<string, unknown>>)
      : null;
    const pricingItems = normalized.flatMap((row, rowIndex) => {
      if (
        !row.requiredDomains.includes('PRICING') ||
        row.precioRegular === null ||
        row.precioRegular === undefined ||
        row.precioRegular <= 0 ||
        row.vendibleSkus.length === 0
      ) {
        return [];
      }
      const intentRow = Array.isArray(input.intentRows)
        ? (input.intentRows[rowIndex] as Record<string, unknown> | undefined)
        : undefined;
      const rowNumber =
        intentRow &&
        typeof intentRow.rowNumber === 'number' &&
        Number.isSafeInteger(intentRow.rowNumber)
          ? intentRow.rowNumber
          : rowIndex + 2;
      const channelId =
        intentRow &&
        typeof intentRow.channelId === 'string' &&
        intentRow.channelId.trim()
          ? intentRow.channelId.trim()
          : null;
      const precioOferta =
        intentRow &&
        typeof intentRow.precioOferta === 'number' &&
        Number.isFinite(intentRow.precioOferta) &&
        intentRow.precioOferta > 0
          ? intentRow.precioOferta.toFixed(2)
          : null;
      const currency =
        intentRow &&
        typeof intentRow.currency === 'string' &&
        /^[A-Z]{3}$/.test(intentRow.currency)
          ? intentRow.currency
          : 'PEN';
      const validFrom =
        intentRow && typeof intentRow.validFrom === 'string'
          ? intentRow.validFrom
          : null;
      const validUntil =
        intentRow && typeof intentRow.validUntil === 'string'
          ? intentRow.validUntil
          : null;
      return row.vendibleSkus.map((sku) => ({
        row_number: rowNumber,
        row_operation_id: row.rowId,
        sku,
        channel_id: channelId,
        precio_regular: row.precioRegular!.toFixed(2),
        precio_oferta: precioOferta,
        currency,
        valid_from: validFrom,
        valid_until: validUntil,
        motivo_cambio: 'BULK_PRICE_APPLY',
      }));
    });
    // Keep a Catalog family independent: a rejected family must not delay the
    // price command of another family, nor publish prices before its own upsert.
    const pricingFamilies = new Map<string, typeof pricingItems>();
    const pricingFamilyByRow = new Map(
      normalized.map((row) => [row.rowId, row.skuBase]),
    );
    for (const item of pricingItems) {
      const family = pricingFamilyByRow.get(item.row_operation_id)!;
      const items = pricingFamilies.get(family) ?? [];
      items.push(item);
      pricingFamilies.set(family, items);
    }
    const pricingCommands: Array<Record<string, unknown>> =
      persistedPricingCommands ??
      [...pricingFamilies.values()].map((items, index) => ({
        message_id: stableUuid(
          `${input.batchId}:pricing-bulk-apply:${index}:message`,
        ),
        schema_version: 1,
        occurred_at: nowIso,
        correlation_id: input.correlationId,
        operation_id: stableUuid(
          `${input.batchId}:pricing-bulk-apply:${index}:operation`,
        ),
        producer: 'bulk-svc',
        kind: 'command',
        name: 'pricing.bulk.price.apply.requested',
        data: {
          batch_id: input.batchId,
          batch_operation_id: stableUuid(
            `${input.batchId}:pricing-bulk-apply:${index}:batch-operation`,
          ),
          items,
        },
      }));

    const allOutboxCommands = [
      ...commands.map(({ envelope }) => ({
        messageId: envelope.message_id,
        eventName: envelope.name,
        kind: envelope.kind,
        schemaVersion: envelope.schema_version,
        correlationId: envelope.correlation_id,
        operationId: envelope.operation_id,
        occurredAt: new Date(envelope.occurred_at),
        payload: envelope as unknown as Record<string, unknown>,
      })),
      ...inventoryCommands.map((envelope) => ({
        messageId: String(envelope.message_id),
        eventName: String(envelope.name),
        kind: 'command' as const,
        schemaVersion: Number(envelope.schema_version ?? 1),
        correlationId: String(envelope.correlation_id),
        operationId: String(envelope.operation_id),
        occurredAt: new Date(String(envelope.occurred_at)),
        payload: envelope,
      })),
      ...pricingCommands.map((envelope) => ({
        messageId: String(envelope.message_id),
        eventName: String(envelope.name),
        kind: 'command' as const,
        schemaVersion: Number(envelope.schema_version ?? 1),
        correlationId: String(envelope.correlation_id),
        operationId: String(envelope.operation_id),
        occurredAt: new Date(String(envelope.occurred_at)),
        payload: envelope,
      })),
    ];

    try {
      return await this.repository.createImportBatch({
        batchId: input.batchId,
        ownerSub: input.ownerSub,
        correlationId: input.correlationId,
        templateVersion: input.templateVersion,
        inputFile: {
          format: input.format as 'CSV' | 'XLSX',
          contentRef: input.contentRef,
        },
        rows: persistedRows,
        catalogCommands: allOutboxCommands,
        ...(contentDocument ? { contentDocument } : {}),
        admissionIntent: {
          format: input.format,
          templateVersion: input.templateVersion,
          contentRef: input.contentRef,
          rows: input.intentRows ?? normalized,
          catalogCommands: commands.map(({ envelope }) => envelope),
          inventoryCommands,
          pricingCommands,
        },
      });
    } catch (error) {
      throw mapBulkPersistenceError(error);
    }
  }

  async applyDomainResult(input: DomainResultInput) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.operationId,
      )
    ) {
      throw new BulkDomainError(
        'INVALID_INPUT',
        'operation_id tiene formato inválido.',
      );
    }
    if (!input.messageId || !input.correlationId || !input.eventName) {
      throw new BulkDomainError(
        'INVALID_INPUT',
        'El resultado no contiene su identidad técnica completa.',
      );
    }
    try {
      return await this.repository.recordDomainResult(input);
    } catch (error) {
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'CHECK_VIOLATION'
      ) {
        throw new BulkDomainError(
          'DEPENDENCY_PENDING',
          'El estado durable del lote no permite reanudación; consulte el snapshot antes de solicitar una nueva operación.',
          { cause: error },
        );
      }
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'NOT_CONFIGURED'
      ) {
        throw new BulkDomainError(
          'DEPENDENCY_PENDING',
          'BLOQUEADO_ESPECÍFICO: no existe un protocolo homologado que emita un nuevo intento para las filas fallidas; el estado durable se conserva.',
          { cause: error },
        );
      }
      throw mapBulkPersistenceError(error);
    }
  }

  async resumeBatch(
    batchId: string,
    ownerSub: string,
    correlationId?: string,
    motivo: string | null = null,
  ) {
    try {
      return await this.repository.requeueBatch(
        batchId,
        ownerSub,
        correlationId,
        motivo,
      );
    } catch (error) {
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'FOREIGN_KEY_VIOLATION'
      ) {
        throw new BulkDomainError('BATCH_NOT_FOUND', 'El lote no existe.', {
          cause: error,
        });
      }
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'CHECK_VIOLATION'
      ) {
        throw new BulkDomainError('RETRY_NOT_ELIGIBLE', error.message, {
          cause: error,
        });
      }
      if (
        error instanceof BulkPersistenceError &&
        error.code === 'NOT_CONFIGURED'
      ) {
        throw new BulkDomainError(
          'RETRY_PROTOCOL_NOT_APPROVED',
          'El protocolo de reanudación no está aprobado.',
          { cause: error },
        );
      }
      throw mapBulkPersistenceError(error);
    }
  }
}

/** The claim-check stays closed unless an operator records both approval gates. */
export function catalogV3EmissionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env.BULK_CATALOG_V3_ENABLED === 'true' &&
    env.BULK_CATALOG_V3_AUTHORIZATION_VERIFIED === 'true'
  );
}
