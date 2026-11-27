import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { BulkImportService } from '../bulk-import.service.js';
import type { BulkContractResultDispatcher } from './catalog-bulk-result-consumer.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(seed).digest().subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

@Injectable()
export class BulkContractResultDispatcherService implements BulkContractResultDispatcher {
  constructor(private readonly bulkImportService: BulkImportService) {}

  async dispatch(input: {
    eventName: string;
    messageId: string;
    correlationId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const data = isRecord(input.payload.data) ? input.payload.data : null;
    if (!data) {
      throw new Error(`INVALID_CONTRACT_RESULT_DATA:${input.eventName}`);
    }

    const batchId =
      typeof data.batch_id === 'string' && UUID_RE.test(data.batch_id)
        ? data.batch_id
        : null;
    if (!batchId) {
      throw new Error(`MISSING_BATCH_ID:${input.eventName}`);
    }

    const causationId =
      typeof input.payload.causation_id === 'string' &&
      input.payload.causation_id.length > 0
        ? input.payload.causation_id
        : null;
    const envelopeOperationId =
      typeof input.payload.operation_id === 'string' &&
      UUID_RE.test(input.payload.operation_id)
        ? input.payload.operation_id
        : input.messageId;

    if (
      input.eventName === 'inventory.bulk.stock.adjust.completed' ||
      input.eventName === 'inventory.bulk.stock.adjust.rejected'
    ) {
      const rowId =
        typeof data.row_operation_id === 'string' &&
        UUID_RE.test(data.row_operation_id)
          ? data.row_operation_id
          : null;
      if (!rowId) {
        throw new Error(`MISSING_ROW_OPERATION_ID:${input.eventName}`);
      }
      const operationId =
        typeof data.operation_id === 'string' && UUID_RE.test(data.operation_id)
          ? data.operation_id
          : envelopeOperationId;
      const isCompleted =
        input.eventName === 'inventory.bulk.stock.adjust.completed';
      await this.bulkImportService.applyDomainResult({
        batchId,
        rowId,
        domain: 'INVENTARIO',
        messageId: input.messageId,
        correlationId: input.correlationId,
        operationId,
        causationId,
        eventName: input.eventName,
        action: 'STOCK_ADJUSTMENT',
        skuId: typeof data.sku === 'string' ? data.sku : undefined,
        status: isCompleted ? 'COMPLETED' : 'FAILED',
        errorCode:
          !isCompleted && typeof data.code === 'string' ? data.code : null,
        errorDetail:
          !isCompleted && typeof data.detail === 'string' ? data.detail : null,
      });
      return;
    }

    if (
      input.eventName === 'pricing.bulk.price.apply.completed' ||
      input.eventName === 'pricing.bulk.price.apply.rejected'
    ) {
      const results = Array.isArray(data.results) ? data.results : [];
      for (const item of results) {
        if (!isRecord(item)) continue;
        const rowId =
          typeof item.row_operation_id === 'string' &&
          UUID_RE.test(item.row_operation_id)
            ? item.row_operation_id
            : null;
        if (!rowId) continue;
        const itemCompleted =
          input.eventName === 'pricing.bulk.price.apply.completed' &&
          item.status === 'COMPLETED';
        const errorCode =
          typeof item.code === 'string'
            ? item.code
            : typeof data.code === 'string'
              ? data.code
              : null;
        await this.bulkImportService.applyDomainResult({
          batchId,
          rowId,
          domain: 'PRICING',
          messageId: deterministicUuid(`${input.messageId}:${rowId}`),
          correlationId: input.correlationId,
          operationId: envelopeOperationId,
          causationId,
          eventName: itemCompleted
            ? 'pricing.bulk.price.apply.completed'
            : 'pricing.bulk.price.apply.rejected',
          action: 'PRICE_BULK_APPLY',
          skuId: typeof item.sku === 'string' ? item.sku : undefined,
          status: itemCompleted ? 'COMPLETED' : 'FAILED',
          errorCode: itemCompleted ? null : (errorCode ?? 'PRICING_REJECTED'),
          errorDetail: itemCompleted
            ? null
            : errorCode
              ? `Pricing rechazó fila: ${errorCode}`
              : 'Pricing rechazó la aplicación masiva de precio',
        });
      }
      return;
    }
  }
}
