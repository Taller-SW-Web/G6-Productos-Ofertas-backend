import { Inject, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { AbsoluteStockAdjustmentService } from '../bulk/absolute-stock-adjustment.service.js';
import {
  INBOX_REPOSITORY,
  LOCATIONS_REPOSITORY,
  OPERATIONS_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IInboxRepository } from '../repositories/interfaces/inbox.repository.interface.js';
import type { ILocationsRepository } from '../repositories/interfaces/locations.repository.interface.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type { IStockBalanceRepository } from '../repositories/interfaces/stock-balance.repository.interface.js';
import type { IDatabaseClient } from '../database/database.interface.js';
import { loadInventoryConfig } from '../config/inventory.config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INITIALIZATION = 'inventory.sku.initialization.requested';
const SKU_DEACTIVATED = 'catalog.sku.deactivated';
const BULK_STOCK_ADJUST = 'inventory.bulk.stock.adjust.requested';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export class InventoryMessageError extends Error {
  constructor(
    public readonly reason:
      'INVALID_MESSAGE' | 'BLOCKED_CONTRACT' | 'FEATURE_DISABLED',
  ) {
    super(reason);
  }
}
interface Initialization {
  message_id: string;
  operation_id: string;
  correlation_id: string;
  data: {
    sku: string;
    product_id: string;
    variant_id?: string | null;
    default_location_id?: string | null;
  };
}
interface InitializationResult {
  sku: string;
  product_id: string;
  variant_id: string | null;
  status: 'INITIALIZED' | 'REJECTED';
  code: string | null;
  completed_at: string;
}

@Injectable()
export class InventoryCommandService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    @Inject(INBOX_REPOSITORY) private readonly inbox: IInboxRepository,
    @Inject(OPERATIONS_REPOSITORY)
    private readonly operations: IOperationsRepository,
    @Inject(LOCATIONS_REPOSITORY)
    private readonly locations: ILocationsRepository,
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stock: IStockBalanceRepository,
    @Optional()
    private readonly absoluteStockAdjustment?: AbsoluteStockAdjustmentService,
  ) {}

  async process(
    payload: unknown,
  ): Promise<{ duplicate: boolean; status?: InitializationResult['status'] }> {
    if (record(payload) && payload.name === BULK_STOCK_ADJUST) {
      return { duplicate: await this.processBulkStockAdjust(payload) };
    }
    if (record(payload) && payload.name === SKU_DEACTIVATED) {
      if (!loadInventoryConfig().catalogSkuDeactivationEnabled) {
        throw new InventoryMessageError('FEATURE_DISABLED');
      }
      return { duplicate: await this.processSkuDeactivated(payload) };
    }
    const message = this.validate(payload);
    const fingerprint = this.idempotency.computeFingerprint({
      name: INITIALIZATION,
      producer: 'catalog-svc',
      data: {
        sku: message.data.sku,
        product_id: message.data.product_id,
        variant_id: message.data.variant_id ?? null,
        default_location_id: message.data.default_location_id ?? null,
      },
    });
    return this.database.transaction(async (client) => {
      await this.operations.lockIdempotencyKey(
        client,
        `inbox:${message.message_id}`,
      );
      const delivery = await this.inbox.register(client, {
        message_id: message.message_id,
        message_type: INITIALIZATION,
        source: 'catalog-svc',
        payload,
      });
      if (
        this.idempotency.computeFingerprint(delivery.payload) !==
        this.idempotency.computeFingerprint(payload)
      ) {
        throw new InventoryMessageError('INVALID_MESSAGE');
      }
      if (delivery.status === 'PROCESSED') return { duplicate: true };
      await this.operations.lockIdempotencyKey(client, message.operation_id);
      const existing = await this.operations.findByOperationIdOrIdempotencyKey(
        message.operation_id,
        message.operation_id,
        client,
      );
      let result: InitializationResult;
      if (existing) {
        if (
          existing.operation_id !== message.operation_id ||
          existing.intention !== INITIALIZATION ||
          existing.client_id !== 'catalog-svc' ||
          existing.request_fingerprint !== fingerprint
        ) {
          result = this.result(message, 'REJECTED', 'IDEMPOTENCY_CONFLICT');
        } else {
          const previous: unknown =
            typeof existing.result_payload === 'string'
              ? JSON.parse(existing.result_payload)
              : existing.result_payload;
          if (
            !record(previous) ||
            !['INITIALIZED', 'REJECTED'].includes(String(previous.status)) ||
            previous.sku !== message.data.sku ||
            previous.product_id !== message.data.product_id ||
            previous.variant_id !== (message.data.variant_id ?? null) ||
            (previous.code !== null && typeof previous.code !== 'string') ||
            typeof previous.completed_at !== 'string' ||
            !Number.isFinite(Date.parse(previous.completed_at)) ||
            existing.status !==
              (previous.status === 'INITIALIZED' ? 'APLICADO' : 'RECHAZADO')
          ) {
            throw new Error(
              'Resultado durable de inicialización inconsistente',
            );
          }
          result = previous as unknown as InitializationResult;
        }
      } else {
        const locationId = message.data.default_location_id;
        const active = locationId
          ? await this.locations.findActive(client)
          : [];
        if (!locationId) {
          // SPEC-001 permits registering a SKU without creating a balance.
          // Never infer the default location from the current inventory.
          result = this.result(message, 'INITIALIZED', null);
        } else if (!active.some((candidate) => candidate.id === locationId)) {
          result = this.result(message, 'REJECTED', 'UBICACION_NO_ENCONTRADA');
        } else {
          await this.stock.initializeZero(client, message.data.sku, locationId);
          result = this.result(message, 'INITIALIZED', null);
          // SPEC-015 §26 starts at version 0 without a stock movement.
          // StockChanged requires version >= 1; emit it on the first actual
          // adjustment/reservation, not for the zero-balance initialization.
        }
        await this.operations.create(client, {
          operation_type: 'INICIALIZACION_SKU',
          idempotency_key: message.operation_id,
          operation_id: message.operation_id,
          intention: INITIALIZATION,
          client_id: 'catalog-svc',
          status: result.status === 'INITIALIZED' ? 'APLICADO' : 'RECHAZADO',
          result_code: result.code,
          request_fingerprint: fingerprint,
          request_payload: JSON.stringify(message.data),
          result_payload: JSON.stringify(result),
          correlation_id: message.correlation_id,
        });
      }
      await this.enqueueResult(client, message, result);
      await this.inbox.markProcessed(client, message.message_id);
      return { duplicate: false, status: result.status };
    });
  }

  private async processBulkStockAdjust(
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const data = record(payload.data) ? payload.data : null;
    if (
      payload.kind !== 'command' ||
      payload.producer !== 'bulk-svc' ||
      payload.name !== BULK_STOCK_ADJUST ||
      ![1, 2].includes(Number(payload.schema_version)) ||
      typeof payload.schema_version !== 'number' ||
      typeof payload.message_id !== 'string' ||
      !UUID.test(payload.message_id) ||
      typeof payload.operation_id !== 'string' ||
      !UUID.test(payload.operation_id) ||
      typeof payload.correlation_id !== 'string' ||
      !UUID.test(payload.correlation_id) ||
      typeof payload.occurred_at !== 'string' ||
      !Number.isFinite(Date.parse(payload.occurred_at)) ||
      !data ||
      typeof data.operation_id !== 'string' ||
      !UUID.test(data.operation_id) ||
      typeof data.batch_id !== 'string' ||
      !UUID.test(data.batch_id) ||
      typeof data.row_operation_id !== 'string' ||
      !UUID.test(data.row_operation_id) ||
      typeof data.sku !== 'string' ||
      !data.sku.trim() ||
      typeof data.location_id !== 'string' ||
      !UUID.test(data.location_id) ||
      typeof data.target_on_hand !== 'number' ||
      !Number.isSafeInteger(data.target_on_hand) ||
      data.target_on_hand < 0 ||
      typeof data.expected_stock_version !== 'number' ||
      !Number.isSafeInteger(data.expected_stock_version) ||
      data.expected_stock_version < 0 ||
      data.reason !== 'BULK_INITIAL_STOCK' ||
      typeof data.requested_at !== 'string' ||
      !Number.isFinite(Date.parse(data.requested_at))
    ) {
      throw new InventoryMessageError('INVALID_MESSAGE');
    }
    if (!this.absoluteStockAdjustment) {
      throw new Error(
        'AbsoluteStockAdjustmentService no disponible en InventoryCommandService',
      );
    }

    const messageId = payload.message_id;
    const operationId = payload.operation_id;
    const correlationId = payload.correlation_id;
    const sku = data.sku.trim();
    const locationId = data.location_id;
    const dataOperationId = data.operation_id;
    const batchId = data.batch_id;
    const rowOperationId = data.row_operation_id;
    const targetOnHand = data.target_on_hand;
    const expectedStockVersion = data.expected_stock_version;
    const adjustmentService = this.absoluteStockAdjustment;

    return this.database.transaction(async (client) => {
      await this.operations.lockIdempotencyKey(client, `inbox:${messageId}`);
      const delivery = await this.inbox.register(client, {
        message_id: messageId,
        message_type: BULK_STOCK_ADJUST,
        source: 'bulk-svc',
        payload,
      });
      if (delivery.status === 'PROCESSED') {
        if (
          this.idempotency.computeFingerprint(delivery.payload) !==
          this.idempotency.computeFingerprint(payload)
        ) {
          throw new InventoryMessageError('INVALID_MESSAGE');
        }
        return true;
      }

      let resultEvent:
        | 'inventory.bulk.stock.adjust.completed'
        | 'inventory.bulk.stock.adjust.rejected';
      let resultData: Record<string, unknown>;

      try {
        const adjustment = await adjustmentService.applyInTransaction(client, {
          operation_id: dataOperationId,
          sku,
          location_id: locationId,
          expected_stock_version: expectedStockVersion,
          target_on_hand: targetOnHand,
          correlation_id: correlationId,
        });

        if (
          adjustment.status !== 'APPLIED' &&
          adjustment.code === 'SKU_LOCATION_NOT_FOUND'
        ) {
          console.error(
            JSON.stringify({
              level: 'warn',
              service: 'inventory-svc',
              event: BULK_STOCK_ADJUST,
              message_id: messageId,
              correlation_id: correlationId,
              sku,
              location_id: locationId,
              reason: 'SKU_LOCATION_NOT_INITIALIZED_YET',
            }),
          );
          throw new Error('SKU_LOCATION_NOT_INITIALIZED_YET');
        }
        if (adjustment.status === 'APPLIED') {
          resultEvent = 'inventory.bulk.stock.adjust.completed';
          resultData = {
            operation_id: dataOperationId,
            batch_id: batchId,
            row_operation_id: rowOperationId,
            sku: adjustment.sku,
            location_id: adjustment.location_id,
            applied_on_hand: adjustment.on_hand,
            stock_version: adjustment.stock_version,
            completed_at: new Date().toISOString(),
          };
        } else {
          resultEvent = 'inventory.bulk.stock.adjust.rejected';
          resultData = {
            operation_id: dataOperationId,
            batch_id: batchId,
            row_operation_id: rowOperationId,
            sku: adjustment.sku,
            location_id: adjustment.location_id,
            code: adjustment.code ?? 'REJECTED',
            detail: `Ajuste absoluto rechazado: ${adjustment.code ?? 'REJECTED'}`,
            rejected_at: new Date().toISOString(),
          };
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'SKU_LOCATION_NOT_INITIALIZED_YET'
        ) {
          throw error;
        }
        if (
          !(error instanceof Error) ||
          error.message !== 'Conflicto de idempotencia en ajuste absoluto'
        ) {
          // Un fallo técnico tras mutar el saldo debe revertir toda la transacción;
          // no puede persistirse como rechazo comercial de R10.
          throw error;
        }
        resultEvent = 'inventory.bulk.stock.adjust.rejected';
        resultData = {
          operation_id: dataOperationId,
          batch_id: batchId,
          row_operation_id: rowOperationId,
          sku,
          location_id: locationId,
          code: 'IDEMPOTENCY_CONFLICT',
          detail:
            error instanceof Error
              ? error.message
              : 'Conflicto de idempotencia en ajuste absoluto',
          rejected_at: new Date().toISOString(),
        };
      }

      await this.outbox.enqueue(client, {
        event_id: crypto.randomUUID(),
        event_type: resultEvent,
        aggregate_type: 'bulk_stock_adjust',
        aggregate_id: batchId,
        correlation_id: correlationId,
        payload: {
          message_id: crypto.randomUUID(),
          schema_version: 1,
          occurred_at: new Date().toISOString(),
          correlation_id: correlationId,
          causation_id: messageId,
          operation_id: operationId,
          producer: 'inventory-svc',
          kind: 'result',
          name: resultEvent,
          data: resultData,
        },
      });
      await this.inbox.markProcessed(client, messageId);
      return false;
    });
  }

  private validate(payload: unknown): Initialization {
    if (!record(payload)) throw new InventoryMessageError('INVALID_MESSAGE');
    if (
      payload.name !== INITIALIZATION ||
      payload.kind !== 'command' ||
      payload.producer !== 'catalog-svc' ||
      ![1, 2].includes(Number(payload.schema_version)) ||
      typeof payload.schema_version !== 'number' ||
      !['message_id', 'operation_id', 'correlation_id'].every(
        (key) =>
          typeof payload[key] === 'string' && UUID.test(payload[key] as string),
      ) ||
      typeof payload.occurred_at !== 'string' ||
      !Number.isFinite(Date.parse(payload.occurred_at)) ||
      !record(payload.data)
    ) {
      throw new InventoryMessageError('INVALID_MESSAGE');
    }
    const data = payload.data;
    if (
      typeof data.sku !== 'string' ||
      !data.sku.trim() ||
      typeof data.product_id !== 'string' ||
      !data.product_id.trim() ||
      (data.variant_id != null && typeof data.variant_id !== 'string') ||
      (data.default_location_id != null &&
        (typeof data.default_location_id !== 'string' ||
          !UUID.test(data.default_location_id)))
    ) {
      throw new InventoryMessageError('INVALID_MESSAGE');
    }
    return payload as unknown as Initialization;
  }

  private async processSkuDeactivated(
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const data = payload.data;
    const requiredEnvelope =
      typeof payload.message_id === 'string' &&
      UUID.test(payload.message_id) &&
      typeof payload.correlation_id === 'string' &&
      UUID.test(payload.correlation_id) &&
      typeof payload.operation_id === 'string' &&
      UUID.test(payload.operation_id) &&
      typeof payload.occurred_at === 'string' &&
      Number.isFinite(Date.parse(payload.occurred_at));
    if (
      payload.name !== SKU_DEACTIVATED ||
      payload.kind !== 'event' ||
      payload.producer !== 'catalog-svc' ||
      payload.schema_version !== 1 ||
      !requiredEnvelope ||
      !record(data) ||
      Object.keys(data).sort().join(',') !==
        'changed_at,product_id,sku,sku_version' ||
      typeof data.sku !== 'string' ||
      !data.sku.trim() ||
      typeof data.product_id !== 'string' ||
      !UUID.test(data.product_id) ||
      !Number.isSafeInteger(data.sku_version) ||
      Number(data.sku_version) < 1 ||
      typeof data.changed_at !== 'string' ||
      !Number.isFinite(Date.parse(data.changed_at))
    ) {
      throw new InventoryMessageError('INVALID_MESSAGE');
    }

    const sku = data.sku;
    const productId = data.product_id;
    const skuVersion = Number(data.sku_version);
    const changedAt = new Date(data.changed_at).toISOString();
    return this.database.transaction(async (client) => {
      await this.operations.lockIdempotencyKey(
        client,
        `inbox:${String(payload.message_id)}`,
      );
      const delivery = await this.inbox.register(client, {
        message_id: String(payload.message_id),
        message_type: SKU_DEACTIVATED,
        source: 'catalog-svc',
        payload,
      });
      if (
        this.idempotency.computeFingerprint(delivery.payload) !==
        this.idempotency.computeFingerprint(payload)
      ) {
        throw new InventoryMessageError('INVALID_MESSAGE');
      }
      if (delivery.status === 'PROCESSED') return true;

      // Reservations use the same lock to serialize their active-SKU check
      // with the authoritative Catalog version update.
      await this.operations.lockIdempotencyKey(client, `sku-active:${sku}`);
      const current = await client.query<{
        product_id: string;
        sku_version: number;
        active: boolean;
        changed_at: string | Date;
      }>(
        `SELECT product_id, sku_version, active, changed_at
           FROM inventory.sku_lifecycle
          WHERE sku_id = $1
          FOR UPDATE`,
        [sku],
      );
      const previous = current.rows[0];
      if (previous && previous.product_id !== productId) {
        throw new InventoryMessageError('INVALID_MESSAGE');
      }
      if (previous && Number(previous.sku_version) > skuVersion) {
        await this.inbox.markProcessed(client, String(payload.message_id));
        return false;
      }
      if (previous && Number(previous.sku_version) === skuVersion) {
        const previousChangedAt = new Date(previous.changed_at).toISOString();
        if (previous.active || previousChangedAt !== changedAt) {
          throw new InventoryMessageError('INVALID_MESSAGE');
        }
        await this.inbox.markProcessed(client, String(payload.message_id));
        return false;
      }
      await client.query(
        `INSERT INTO inventory.sku_lifecycle
           (sku_id, product_id, sku_version, active, changed_at, updated_at)
         VALUES ($1, $2, $3, false, $4, now())
         ON CONFLICT (sku_id) DO UPDATE
           SET product_id = EXCLUDED.product_id,
               sku_version = EXCLUDED.sku_version,
               active = false,
               changed_at = EXCLUDED.changed_at,
               updated_at = now()
         WHERE inventory.sku_lifecycle.sku_version < EXCLUDED.sku_version`,
        [sku, productId, skuVersion, changedAt],
      );
      await this.inbox.markProcessed(client, String(payload.message_id));
      return false;
    });
  }

  private result(
    message: Initialization,
    status: InitializationResult['status'],
    code: string | null,
  ): InitializationResult {
    return {
      sku: message.data.sku,
      product_id: message.data.product_id,
      variant_id: message.data.variant_id ?? null,
      status,
      code,
      completed_at: new Date().toISOString(),
    };
  }

  private async enqueueResult(
    client: IDatabaseClient,
    message: Initialization,
    result: InitializationResult,
  ): Promise<void> {
    const name =
      result.status === 'INITIALIZED'
        ? 'inventory.sku.initialization.completed'
        : 'inventory.sku.initialization.rejected';
    const payload = this.outbox.createMessageEnvelope({
      eventName: name,
      kind: 'result',
      operationId: message.operation_id,
      correlationId: message.correlation_id,
      causationId: message.message_id,
      data: { ...result },
    });
    await this.outbox.enqueue(client, {
      event_id: String(payload.message_id),
      event_type: name,
      aggregate_type: 'stock',
      aggregate_id: message.data.sku,
      correlation_id: message.correlation_id,
      payload,
    });
  }
}
