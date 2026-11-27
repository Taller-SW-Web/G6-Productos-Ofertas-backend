import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import {
  OPERATIONS_REPOSITORY,
  STOCK_BALANCE_REPOSITORY,
} from '../repositories/interfaces/repository.tokens.js';
import type { IOperationsRepository } from '../repositories/interfaces/operations.repository.interface.js';
import type {
  IStockBalanceRepository,
  StockBalanceEntity,
} from '../repositories/interfaces/stock-balance.repository.interface.js';
import type {
  ConciliacionOfflineRequest,
  ConciliacionOfflineResponse,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Context supplied only by a future trusted store-to-location resolver. */
export interface AuthorizedOfflineStoreContext {
  client_id: 'modulo-ventas';
  actor_ref: string;
  store_ref: string;
  location_id: string;
  authorized: true;
}

@Injectable()
export class OfflineReconciliationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly kardex: KardexService,
    private readonly outbox: OutboxService,
    @Inject(OPERATIONS_REPOSITORY)
    private readonly operations: IOperationsRepository,
    @Inject(STOCK_BALANCE_REPOSITORY)
    private readonly stock: IStockBalanceRepository,
  ) {}

  /**
   * Resolves a trusted store-to-location binding from G6's persisted
   * `inventory.locations` table and optional JWT `store_ref` claim, then
   * executes `reconcileResolvedSale`.
   */
  async reconcileFromAuthorizedRequest(
    clientId: string,
    tokenPayload: Record<string, unknown> | undefined,
    request: ConciliacionOfflineRequest,
    correlationId?: string,
  ): Promise<ConciliacionOfflineResponse> {
    if (clientId !== 'modulo-ventas') {
      throw ProblemDetailsException.scopeInsuficiente(
        'Solo modulo-ventas puede conciliar ventas offline',
        correlationId,
      );
    }
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      !UUID.test(String(request.operation_id ?? '')) ||
      typeof request.order_id !== 'string' ||
      !request.order_id.trim() ||
      typeof request.offline_sale_id !== 'string' ||
      !request.offline_sale_id.trim() ||
      request.channel_id !== 'RETAIL' ||
      typeof request.occurred_at !== 'string' ||
      !Number.isFinite(Date.parse(request.occurred_at)) ||
      !Array.isArray(request.lines) ||
      request.lines.length === 0
    ) {
      throw ProblemDetailsException.validation(
        'Payload de conciliación offline inválido',
        correlationId,
      );
    }

    const requestedLocationIds = new Set<string>();
    for (const line of request.lines) {
      if (
        !line ||
        typeof line.sku !== 'string' ||
        !line.sku.trim() ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0 ||
        !UUID.test(String(line.location_id ?? ''))
      ) {
        throw ProblemDetailsException.validation(
          'Cada línea debe incluir sku, quantity > 0 y location_id UUID válido',
          correlationId,
        );
      }
      requestedLocationIds.add(line.location_id);
    }
    if (requestedLocationIds.size !== 1) {
      throw ProblemDetailsException.validation(
        'Todas las líneas de una venta offline deben pertenecer a una única ubicación',
        correlationId,
      );
    }
    const requestedLocationId = [...requestedLocationIds][0]!;

    const claimStoreRef =
      typeof tokenPayload?.store_ref === 'string' &&
      tokenPayload.store_ref.trim().length > 0
        ? tokenPayload.store_ref.trim()
        : undefined;
    const bodyStoreRef =
      typeof request.store_ref === 'string' &&
      request.store_ref.trim().length > 0
        ? request.store_ref.trim()
        : undefined;
    if (!claimStoreRef) {
      throw ProblemDetailsException.scopeInsuficiente(
        'El token de modulo-ventas debe incluir un claim store_ref autorizado',
        correlationId,
      );
    }
    if (bodyStoreRef && claimStoreRef !== bodyStoreRef) {
      throw ProblemDetailsException.scopeInsuficiente(
        'store_ref del request no coincide con el claim autorizado',
        correlationId,
      );
    }

    const locationResult = await this.database.query<{
      id: string;
      code: string;
      type: string;
      external_ref: string | null;
    }>(
      `SELECT id, code, type, external_ref
         FROM inventory.locations
        WHERE active = true
          AND (external_ref = $1 OR code = $1)
        LIMIT 1`,
      [claimStoreRef],
    );

    const resolvedLocation = locationResult.rows[0];
    if (!resolvedLocation) {
      throw ProblemDetailsException.scopeInsuficiente(
        'No existe un vínculo tienda→ubicación activo y autorizado en G6',
        correlationId,
      );
    }
    if (resolvedLocation.id !== requestedLocationId) {
      throw ProblemDetailsException.validation(
        'location_id de las líneas no coincide con la ubicación vinculada a la tienda',
        correlationId,
      );
    }

    const actorRef =
      typeof tokenPayload?.sub === 'string' && tokenPayload.sub.trim()
        ? tokenPayload.sub.trim()
        : clientId;

    const context: AuthorizedOfflineStoreContext = {
      client_id: 'modulo-ventas',
      actor_ref: actorRef,
      store_ref:
        claimStoreRef ?? resolvedLocation.external_ref ?? resolvedLocation.code,
      location_id: resolvedLocation.id,
      authorized: true,
    };

    try {
      return await this.reconcileResolvedSale(clientId, request, context);
    } catch (error) {
      if (error instanceof ProblemDetailsException) throw error;
      if (error instanceof RangeError) {
        throw ProblemDetailsException.validation(error.message, correlationId);
      }
      const message =
        error instanceof Error
          ? error.message
          : 'Error en conciliación offline';
      if (
        message.includes('ya fue conciliada con otro contenido') ||
        message.includes('operation_id ya utilizado')
      ) {
        throw ProblemDetailsException.idempotencyConflict(
          message,
          correlationId,
        );
      }
      if (message.includes('Contexto de tienda/ubicación no autorizado')) {
        throw ProblemDetailsException.scopeInsuficiente(message, correlationId);
      }
      if (message.includes('Ubicación resuelta no activa')) {
        throw ProblemDetailsException.validation(message, correlationId);
      }
      throw error;
    }
  }

  /**
   * Domain engine for the contractual Ventas caller.
   */
  async reconcileResolvedSale(
    clientId: string,
    request: ConciliacionOfflineRequest,
    context: AuthorizedOfflineStoreContext,
  ): Promise<ConciliacionOfflineResponse> {
    this.validate(clientId, request, context);
    const fingerprint = this.idempotency.computeFingerprint({
      client_id: clientId,
      offline_sale_id: request.offline_sale_id,
      order_id: request.order_id,
      channel_id: request.channel_id,
      occurred_at: new Date(request.occurred_at).toISOString(),
      store_ref: context.store_ref,
      resolved_location_id: context.location_id,
      lines: request.lines.map((line) => ({
        sku: line.sku,
        quantity: line.quantity,
        location_id: context.location_id,
      })),
    });
    const saleKey = `offline-sale:${clientId}:${request.offline_sale_id}`;
    const operationKey = `offline-operation:${request.operation_id}`;

    return this.database.transaction(async (client) => {
      await this.operations.lockIdempotencyKey(client, saleKey);
      const location = await client.query<{ id: string }>(
        `SELECT id FROM inventory.locations
          WHERE id = $1 AND active = true
          FOR SHARE`,
        [context.location_id],
      );
      if (location.rowCount !== 1) {
        throw new Error('Ubicación resuelta no activa');
      }

      const existing = await client.query<{
        operation_id: string;
        request_fingerprint: string;
        result_payload: unknown;
      }>(
        `SELECT operation_id, request_fingerprint, result_payload
           FROM inventory.offline_sale_reconciliations
          WHERE client_id = $1 AND offline_sale_id = $2
          FOR UPDATE`,
        [clientId, request.offline_sale_id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_fingerprint !== fingerprint) {
          throw new Error(
            'La venta offline ya fue conciliada con otro contenido',
          );
        }
        return this.parseResult(existing.rows[0].result_payload);
      }

      await this.operations.lockIdempotencyKey(client, operationKey);
      const operation = await this.operations.findByOperationIdOrIdempotencyKey(
        request.operation_id,
        operationKey,
        client,
      );
      if (operation) {
        throw new Error('operation_id ya utilizado para otra conciliación');
      }

      const lines: ConciliacionOfflineResponse['lines'] = [];
      for (const line of [...request.lines].sort((a, b) =>
        a.sku.localeCompare(b.sku),
      )) {
        const balance = await this.stock.findBySkuAndLocationForUpdate(
          client,
          line.sku,
          context.location_id,
        );
        const result = this.applyLine(
          line.sku,
          context.location_id,
          line.quantity,
          balance,
        );
        if (balance && result.applied_quantity > 0) {
          const nextVersion = balance.stock_version + 1;
          const affected = await this.stock.updateStock(
            client,
            line.sku,
            context.location_id,
            {
              on_hand: result.on_hand,
              stock_version: nextVersion,
            },
          );
          if (affected !== 1) {
            throw new Error(
              'La conciliación offline no actualizó exactamente un saldo',
            );
          }
          result.stock_version = nextVersion;
          await this.kardex.recordMovement(client, {
            sku_id: line.sku,
            location_id: context.location_id,
            operation_type: 'CONCILIACION_OFFLINE',
            operation_id: request.operation_id,
            quantity: -result.applied_quantity,
            on_hand_before: balance.on_hand,
            on_hand_after: result.on_hand,
            reserved_before: balance.reserved,
            reserved_after: balance.reserved,
            blocked_before: balance.blocked,
            blocked_after: balance.blocked,
            stock_version: nextVersion,
            correlation_id: request.operation_id,
          });
          await this.outbox.stockChanged(client, {
            sku: line.sku,
            location_id: context.location_id,
            on_hand: result.on_hand,
            reserved: result.reserved,
            blocked: result.blocked,
            stock_version: nextVersion,
            operationId: request.operation_id,
            correlationId: request.operation_id,
          });
        }
        lines.push(result);
      }

      const completedAt = new Date().toISOString();
      const response: ConciliacionOfflineResponse = {
        operation_id: request.operation_id,
        order_id: request.order_id,
        offline_sale_id: request.offline_sale_id,
        status: lines.some((line) => line.unresolved_quantity > 0)
          ? 'REQUIRES_REVIEW'
          : 'COMPLETED',
        lines,
        completed_at: completedAt,
      };
      await this.operations.create(client, {
        operation_type: 'CONCILIACION_OFFLINE',
        idempotency_key: saleKey,
        intention: 'conciliarVentaOffline',
        status:
          response.status === 'COMPLETED' ? 'APLICADO' : 'REQUIRES_REVIEW',
        operation_id: request.operation_id,
        client_id: clientId,
        order_id: request.order_id,
        request_fingerprint: fingerprint,
        request_payload: JSON.stringify({
          request,
          store_ref: context.store_ref,
          resolved_location_id: context.location_id,
        }),
        result_payload: JSON.stringify(response),
        correlation_id: request.operation_id,
      });
      await client.query(
        `INSERT INTO inventory.offline_sale_reconciliations
           (client_id, offline_sale_id, operation_id, order_id,
            request_fingerprint, request_payload, result_payload, status, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          clientId,
          request.offline_sale_id,
          request.operation_id,
          request.order_id,
          fingerprint,
          JSON.stringify({ request, store_ref: context.store_ref }),
          JSON.stringify(response),
          response.status,
          completedAt,
        ],
      );
      return response;
    });
  }

  private validate(
    clientId: string,
    request: ConciliacionOfflineRequest,
    context: AuthorizedOfflineStoreContext,
  ): void {
    if (
      clientId !== 'modulo-ventas' ||
      context?.client_id !== 'modulo-ventas' ||
      context.authorized !== true ||
      typeof context.actor_ref !== 'string' ||
      !context.actor_ref.trim() ||
      typeof context.store_ref !== 'string' ||
      !context.store_ref.trim() ||
      !UUID.test(context.location_id)
    ) {
      throw new Error('Contexto de tienda/ubicación no autorizado');
    }
    if (
      !request ||
      !UUID.test(request.operation_id) ||
      typeof request.order_id !== 'string' ||
      !request.order_id.trim() ||
      typeof request.offline_sale_id !== 'string' ||
      !request.offline_sale_id.trim() ||
      request.channel_id !== 'RETAIL' ||
      typeof request.occurred_at !== 'string' ||
      !Number.isFinite(Date.parse(request.occurred_at)) ||
      !Array.isArray(request.lines) ||
      request.lines.length === 0
    ) {
      throw new RangeError('Entrada de conciliación offline inválida');
    }
    const seen = new Set<string>();
    for (const line of request.lines) {
      if (
        !line ||
        typeof line.sku !== 'string' ||
        !line.sku.trim() ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0 ||
        !UUID.test(line.location_id) ||
        line.location_id !== context.location_id
      ) {
        throw new RangeError('La línea no corresponde a la ubicación resuelta');
      }
      const key = `${line.sku}:::${line.location_id}`;
      if (seen.has(key))
        throw new RangeError('La venta contiene líneas duplicadas');
      seen.add(key);
    }
  }

  private applyLine(
    sku: string,
    locationId: string,
    requested: number,
    balance: StockBalanceEntity | null,
  ): ConciliacionOfflineResponse['lines'][number] {
    const onHand = balance?.on_hand ?? 0;
    const reserved = balance?.reserved ?? 0;
    const blocked = balance?.blocked ?? 0;
    const available = Math.max(0, onHand - reserved - blocked);
    const applied = Math.min(requested, available);
    return {
      sku,
      location_id: locationId,
      requested_quantity: requested,
      applied_quantity: applied,
      unresolved_quantity: requested - applied,
      on_hand: onHand - applied,
      reserved,
      blocked,
      available: available - applied,
      stock_version: balance?.stock_version ?? 0,
    };
  }

  private parseResult(value: unknown): ConciliacionOfflineResponse {
    const result = typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !result ||
      typeof result !== 'object' ||
      !('status' in result) ||
      !['COMPLETED', 'REQUIRES_REVIEW'].includes(String(result.status)) ||
      !('lines' in result) ||
      !Array.isArray(result.lines)
    ) {
      throw new Error(
        'Resultado durable de conciliación offline inconsistente',
      );
    }
    return result as ConciliacionOfflineResponse;
  }
}
