import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { IDatabaseClient } from '../database/database.interface.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { KardexService } from '../kardex/kardex.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { loadInventoryConfig } from '../config/inventory.config.js';
import {
  CrearReservaRequest,
  OperacionReservaRequest,
  LiberarReservaRequest,
  OperacionInventarioAceptada,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly idempotencyService: IdempotencyService,
    private readonly kardexService: KardexService,
    private readonly outboxService: OutboxService,
  ) {}

  /**
   * Solicita una reserva de stock para un pedido CREADO (POST /api/v1/inventario/reservas)
   */
  async solicitarReserva(
    dto: CrearReservaRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
  ): Promise<OperacionInventarioAceptada> {
    const correlationId = correlationIdHeader || randomUUID();
    const idempotencyKey = idempotencyKeyHeader || dto.operation_id;

    // 1. Validaciones estructurales y de tipos
    this.validarCrearReservaInput(dto, correlationId);

    // 2. Cálculo de huella semántica (SHA-256)
    const fingerprint = this.idempotencyService.computeFingerprint({
      order_id: dto.order_id,
      channel_id: dto.channel_id,
      lines: dto.lines,
    });

    // 3. Comprobación de idempotencia previa
    const existingOp = await this.databaseService.query(
      `SELECT id, operation_id, idempotency_key, request_fingerprint, status, result_payload, reservation_id 
       FROM inventory.inventory_operations 
       WHERE operation_id = $1 OR idempotency_key = $2`,
      [dto.operation_id, idempotencyKey],
    );

    if (existingOp.rows.length > 0) {
      const op = existingOp.rows[0];
      if (
        this.idempotencyService.isMatchingFingerprint(
          op.request_fingerprint,
          fingerprint,
        )
      ) {
        // Reintento idéntico idempotente: responder sin nuevos efectos
        return {
          operation_id: dto.operation_id,
          order_id: dto.order_id,
          operation_type: 'RESERVAR',
          status: 'ACCEPTED',
          correlation_id: correlationId,
        };
      } else {
        // Misma identidad con contenido distinto -> conflicto
        throw ProblemDetailsException.idempotencyConflict(
          'La operación o Idempotency-Key ya fue utilizada con otra intención o contenido.',
          correlationId,
        );
      }
    }

    // 4. Resolución de ubicación para cada línea
    const resolvedLines = await this.resolverUbicaciones(dto, correlationId);

    // 5. Ejecución transaccional con bloqueo de filas (SELECT ... FOR UPDATE)
    const config = loadInventoryConfig();
    const ttlSeconds = config.reservationTtlSeconds;

    return await this.databaseService.transaction<OperacionInventarioAceptada>(
      async (client) => {
        // Agrupar líneas por (sku_id, location_id)
        const lineMap = new Map<
          string,
          { sku: string; location_id: string; quantity: number }
        >();
        for (const line of resolvedLines) {
          const key = `${line.sku}:::${line.location_id}`;
          const existing = lineMap.get(key);
          if (existing) {
            existing.quantity += line.quantity;
          } else {
            lineMap.set(key, {
              sku: line.sku,
              location_id: line.location_id,
              quantity: line.quantity,
            });
          }
        }

        const groupedLines = Array.from(lineMap.values());

        // Ordenar por sku y location_id para evitar deadlocks de bloqueo concurrente
        groupedLines.sort((a, b) => {
          const c = a.sku.localeCompare(b.sku);
          return c !== 0 ? c : a.location_id.localeCompare(b.location_id);
        });

        // Bloquear y consultar saldos actuales
        const balanceMap = new Map<
          string,
          {
            sku_id: string;
            location_id: string;
            on_hand: number;
            reserved: number;
            blocked: number;
            available: number;
            stock_version: bigint | number;
          }
        >();

        for (const item of groupedLines) {
          const balanceRes = await client.query(
            `SELECT sku_id, location_id, on_hand, reserved, blocked, available, stock_version
           FROM inventory.stock_balance
           WHERE sku_id = $1 AND location_id = $2
           FOR UPDATE`,
            [item.sku, item.location_id],
          );

          if (balanceRes.rows.length === 0) {
            // No existe registro para el SKU en esa ubicación
            return this.registrarRechazo(
              client,
              dto,
              idempotencyKey,
              fingerprint,
              correlationId,
              'STOCK_INSUFICIENTE',
            );
          }

          const row = balanceRes.rows[0];
          balanceMap.set(`${item.sku}:::${item.location_id}`, {
            sku_id: row.sku_id,
            location_id: row.location_id,
            on_hand: Number(row.on_hand),
            reserved: Number(row.reserved),
            blocked: Number(row.blocked),
            available: Number(row.available),
            stock_version: Number(row.stock_version),
          });
        }

        // Verificar disponibilidad para todas las líneas (atomicidad: todo o nada)
        for (const item of groupedLines) {
          const bal = balanceMap.get(`${item.sku}:::${item.location_id}`)!;
          const currentAvailable = Math.max(
            0,
            bal.on_hand - bal.reserved - bal.blocked,
          );
          if (currentAvailable < item.quantity) {
            // Saldo insuficiente: registrar rechazo durable y outbox
            return this.registrarRechazo(
              client,
              dto,
              idempotencyKey,
              fingerprint,
              correlationId,
              'STOCK_INSUFICIENTE',
            );
          }
        }

        // Saldo suficiente para todas las líneas: aplicar reserva
        const reservationId = randomUUID();
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

        const acceptedResponse: OperacionInventarioAceptada = {
          operation_id: dto.operation_id,
          order_id: dto.order_id,
          operation_type: 'RESERVAR',
          status: 'ACCEPTED',
          correlation_id: correlationId,
        };

        // 5.1. Insertar en inventory.reservations
        const resReservation = await client.query(
          `INSERT INTO inventory.reservations (
          reservation_id, status, expires_at, idempotency_key, intention,
          correlation_id, order_id, operation_id, request_fingerprint, accepted_payload
        ) VALUES ($1, 'ACTIVA', $2, $3, 'reservar', $4, $5, $6, $7, $8)
        RETURNING id`,
          [
            reservationId,
            expiresAt.toISOString(),
            idempotencyKey,
            correlationId,
            dto.order_id,
            dto.operation_id,
            fingerprint,
            JSON.stringify(acceptedResponse),
          ],
        );

        const reservationPk = resReservation.rows[0].id;

        // 5.2. Insertar líneas y actualizar stock_balance y Kardex
        for (const item of groupedLines) {
          const bal = balanceMap.get(`${item.sku}:::${item.location_id}`)!;

          await client.query(
            `INSERT INTO inventory.reservation_lines (
            reservation_id, sku_id, location_id, quantity
          ) VALUES ($1, $2, $3, $4)`,
            [reservationPk, item.sku, item.location_id, item.quantity],
          );

          const newReserved = bal.reserved + item.quantity;
          const newStockVersion = Number(bal.stock_version) + 1;

          await client.query(
            `UPDATE inventory.stock_balance
           SET reserved = $1, stock_version = $2
           WHERE sku_id = $3 AND location_id = $4`,
            [newReserved, newStockVersion, item.sku, item.location_id],
          );

          // Movimiento en Kardex
          await this.kardexService.recordMovement(client, {
            sku_id: item.sku,
            location_id: item.location_id,
            operation_type: 'RESERVA',
            operation_id: dto.operation_id,
            reservation_id: reservationId,
            quantity: item.quantity,
            on_hand_before: bal.on_hand,
            on_hand_after: bal.on_hand,
            reserved_before: bal.reserved,
            reserved_after: newReserved,
            blocked_before: bal.blocked,
            blocked_after: bal.blocked,
            stock_version: newStockVersion,
            correlation_id: correlationId,
          });
        }

        // 5.3. Registrar la operación en inventory.inventory_operations
        await client.query(
          `INSERT INTO inventory.inventory_operations (
          operation_type, idempotency_key, intention, status,
          order_id, reservation_id, accepted_at, applied_at,
          operation_id, request_fingerprint, request_payload, result_payload, correlation_id
        ) VALUES (
          'RESERVA', $1, 'reservar', 'APLICADO',
          $2, $3, now(), now(),
          $4, $5, $6, $7, $8
        )`,
          [
            idempotencyKey,
            dto.order_id,
            reservationId,
            dto.operation_id,
            fingerprint,
            JSON.stringify(dto),
            JSON.stringify(acceptedResponse),
            correlationId,
          ],
        );

        // 5.4. Registro en Outbox: inventory.reservation.created
        const createdEventPayload = this.outboxService.createMessageEnvelope({
          eventName: 'inventory.reservation.created',
          kind: 'event',
          operationId: dto.operation_id,
          correlationId,
          data: {
            order_id: dto.order_id,
            reservation_id: reservationId,
            expires_at: expiresAt.toISOString(),
            decided_at: new Date().toISOString(),
            lines: dto.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
          },
        });

        await this.outboxService.enqueue(client, {
          event_id: randomUUID(),
          event_type: 'inventory.reservation.created',
          aggregate_type: 'reservation',
          aggregate_id: reservationId,
          correlation_id: correlationId,
          payload: createdEventPayload,
        });

        // Evento de cambio de stock
        for (const item of groupedLines) {
          const bal = balanceMap.get(`${item.sku}:::${item.location_id}`)!;
          const stockChangedPayload = this.outboxService.createMessageEnvelope({
            eventName: 'inventory.stock.changed',
            kind: 'event',
            operationId: dto.operation_id,
            correlationId,
            data: {
              sku: item.sku,
              location_id: item.location_id,
              on_hand: bal.on_hand,
              reserved: bal.reserved + item.quantity,
              available: Math.max(
                0,
                bal.on_hand - (bal.reserved + item.quantity) - bal.blocked,
              ),
            },
          });

          await this.outboxService.enqueue(client, {
            event_id: randomUUID(),
            event_type: 'inventory.stock.changed',
            aggregate_type: 'stock',
            aggregate_id: item.sku,
            correlation_id: correlationId,
            payload: stockChangedPayload,
          });
        }

        return acceptedResponse;
      },
    );
  }

  /**
   * Confirma el consumo definitivo de una reserva activa (POST /api/v1/inventario/reservas/{reservaId}/confirmar)
   */
  async confirmarReserva(
    reservaId: string,
    dto: OperacionReservaRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
  ): Promise<OperacionInventarioAceptada> {
    const correlationId = correlationIdHeader || randomUUID();
    const idempotencyKey = idempotencyKeyHeader || dto.operation_id;

    if (!UUID_REGEX.test(reservaId)) {
      throw ProblemDetailsException.validation(
        'reservaId debe ser un UUID válido',
        correlationId,
      );
    }
    if (!dto || !UUID_REGEX.test(dto.operation_id)) {
      throw ProblemDetailsException.validation(
        'operation_id debe ser un UUID válido',
        correlationId,
      );
    }
    if (
      !dto.order_id ||
      typeof dto.order_id !== 'string' ||
      dto.order_id.trim().length === 0
    ) {
      throw ProblemDetailsException.validation(
        'order_id es obligatorio',
        correlationId,
      );
    }

    const fingerprint = this.idempotencyService.computeFingerprint({
      reservaId,
      order_id: dto.order_id,
      operation_id: dto.operation_id,
      intention: 'confirmar_consumo',
    });

    return await this.databaseService.transaction<OperacionInventarioAceptada>(
      async (client) => {
        // Comprobar idempotencia previa para operation_id
        const existingOp = await client.query(
          `SELECT id, operation_id, request_fingerprint, status, result_payload 
         FROM inventory.inventory_operations 
         WHERE operation_id = $1`,
          [dto.operation_id],
        );

        if (existingOp.rows.length > 0) {
          const op = existingOp.rows[0];
          if (
            this.idempotencyService.isMatchingFingerprint(
              op.request_fingerprint,
              fingerprint,
            )
          ) {
            return {
              operation_id: dto.operation_id,
              order_id: dto.order_id,
              operation_type: 'CONFIRMAR_CONSUMO',
              status: 'ACCEPTED',
              correlation_id: correlationId,
            };
          } else {
            throw ProblemDetailsException.idempotencyConflict(
              'operation_id ya utilizado con otra intención',
              correlationId,
            );
          }
        }

        // Bloquear reserva
        const resReserva = await client.query(
          `SELECT id, reservation_id, status, expires_at, order_id 
         FROM inventory.reservations 
         WHERE reservation_id = $1 
         FOR UPDATE`,
          [reservaId],
        );

        if (resReserva.rows.length === 0) {
          throw ProblemDetailsException.reservaNoEncontrada(
            'Reserva no encontrada',
            correlationId,
          );
        }

        const reserva = resReserva.rows[0];

        if (reserva.order_id && reserva.order_id !== dto.order_id) {
          throw ProblemDetailsException.validation(
            'order_id no coincide con la reserva',
            correlationId,
          );
        }

        if (reserva.status === 'CONSUMIDA') {
          throw ProblemDetailsException.reservaNoActiva(
            'La reserva ya ha sido consumida',
            correlationId,
          );
        }
        if (reserva.status === 'LIBERADA') {
          throw ProblemDetailsException.reservaNoActiva(
            'La reserva ya ha sido liberada',
            correlationId,
          );
        }
        if (
          reserva.status === 'EXPIRADA' ||
          new Date(reserva.expires_at) < new Date()
        ) {
          if (reserva.status !== 'EXPIRADA') {
            await this.expirarReservaInterna(
              client,
              reserva.id,
              reserva.reservation_id,
              dto.order_id,
              correlationId,
            );
          }
          throw ProblemDetailsException.reservaExpirada(
            'La reserva está expirada',
            correlationId,
          );
        }

        // Transición a CONSUMIDA
        await client.query(
          `UPDATE inventory.reservations 
         SET status = 'CONSUMIDA', consumed_at = now() 
         WHERE id = $1`,
          [reserva.id],
        );

        // Cargar líneas de reserva
        const linesRes = await client.query(
          `SELECT sku_id, location_id, quantity 
         FROM inventory.reservation_lines 
         WHERE reservation_id = $1`,
          [reserva.id],
        );

        for (const line of linesRes.rows) {
          const qty = Number(line.quantity);

          const balRes = await client.query(
            `SELECT on_hand, reserved, blocked, stock_version 
           FROM inventory.stock_balance 
           WHERE sku_id = $1 AND location_id = $2 
           FOR UPDATE`,
            [line.sku_id, line.location_id],
          );

          if (balRes.rows.length > 0) {
            const bal = balRes.rows[0];
            const onHand = Number(bal.on_hand);
            const reserved = Number(bal.reserved);
            const blocked = Number(bal.blocked);
            const newOnHand = onHand - qty;
            const newReserved = Math.max(0, reserved - qty);
            const newVersion = Number(bal.stock_version) + 1;

            await client.query(
              `UPDATE inventory.stock_balance 
             SET on_hand = $1, reserved = $2, stock_version = $3 
             WHERE sku_id = $4 AND location_id = $5`,
              [
                newOnHand,
                newReserved,
                newVersion,
                line.sku_id,
                line.location_id,
              ],
            );

            // Kardex de consumo definitivo
            await this.kardexService.recordMovement(client, {
              sku_id: line.sku_id,
              location_id: line.location_id,
              operation_type: 'CONSUMO',
              operation_id: dto.operation_id,
              reservation_id: reservaId,
              quantity: -qty,
              on_hand_before: onHand,
              on_hand_after: newOnHand,
              reserved_before: reserved,
              reserved_after: newReserved,
              blocked_before: blocked,
              blocked_after: blocked,
              stock_version: newVersion,
              correlation_id: correlationId,
            });
          }
        }

        const acceptedResponse: OperacionInventarioAceptada = {
          operation_id: dto.operation_id,
          order_id: dto.order_id,
          operation_type: 'CONFIRMAR_CONSUMO',
          status: 'ACCEPTED',
          correlation_id: correlationId,
        };

        // Registro durable de operación
        await client.query(
          `INSERT INTO inventory.inventory_operations (
          operation_type, idempotency_key, intention, status,
          order_id, reservation_id, accepted_at, applied_at,
          operation_id, request_fingerprint, request_payload, result_payload, correlation_id
        ) VALUES (
          'CONSUMO', $1, 'confirmar_consumo', 'APLICADO',
          $2, $3, now(), now(),
          $4, $5, $6, $7, $8
        )`,
          [
            idempotencyKey,
            dto.order_id,
            reservaId,
            dto.operation_id,
            fingerprint,
            JSON.stringify(dto),
            JSON.stringify(acceptedResponse),
            correlationId,
          ],
        );

        // Outbox: inventory.reservation.consumed & inventory.consumption.completed
        const consumedEvent = this.outboxService.createMessageEnvelope({
          eventName: 'inventory.reservation.consumed',
          kind: 'event',
          operationId: dto.operation_id,
          correlationId,
          data: {
            order_id: dto.order_id,
            reservation_id: reservaId,
            decided_at: new Date().toISOString(),
            reason_code: null,
          },
        });

        await this.outboxService.enqueue(client, {
          event_id: randomUUID(),
          event_type: 'inventory.reservation.consumed',
          aggregate_type: 'reservation',
          aggregate_id: reservaId,
          correlation_id: correlationId,
          payload: consumedEvent,
        });

        const completedResult = this.outboxService.createMessageEnvelope({
          eventName: 'inventory.consumption.completed',
          kind: 'result',
          operationId: dto.operation_id,
          correlationId,
          data: {
            order_id: dto.order_id,
            reservation_id: reservaId,
            decided_at: new Date().toISOString(),
            result_code: null,
          },
        });

        await this.outboxService.enqueue(client, {
          event_id: randomUUID(),
          event_type: 'inventory.consumption.completed',
          aggregate_type: 'reservation',
          aggregate_id: reservaId,
          correlation_id: correlationId,
          payload: completedResult,
        });

        return acceptedResponse;
      },
    );
  }

  /**
   * Libera una reserva por pago no completado o anulación (POST /api/v1/inventario/reservas/{reservaId}/liberar)
   */
  async liberarReserva(
    reservaId: string,
    dto: LiberarReservaRequest,
    correlationIdHeader?: string,
    idempotencyKeyHeader?: string,
  ): Promise<OperacionInventarioAceptada> {
    const correlationId = correlationIdHeader || randomUUID();
    const idempotencyKey = idempotencyKeyHeader || dto.operation_id;

    if (!UUID_REGEX.test(reservaId)) {
      throw ProblemDetailsException.validation(
        'reservaId debe ser un UUID válido',
        correlationId,
      );
    }
    if (!dto || !UUID_REGEX.test(dto.operation_id)) {
      throw ProblemDetailsException.validation(
        'operation_id debe ser un UUID válido',
        correlationId,
      );
    }
    if (
      !dto.order_id ||
      typeof dto.order_id !== 'string' ||
      dto.order_id.trim().length === 0
    ) {
      throw ProblemDetailsException.validation(
        'order_id es obligatorio',
        correlationId,
      );
    }
    const validReasons = [
      'PAGO_NO_COMPLETADO',
      'ANULACION',
      'EXPIRACION_FORZADA',
      'OTRO',
    ];
    if (!dto.reason || !validReasons.includes(dto.reason)) {
      throw ProblemDetailsException.validation(
        'Motivo de liberación inválido',
        correlationId,
      );
    }

    const fingerprint = this.idempotencyService.computeFingerprint({
      reservaId,
      order_id: dto.order_id,
      operation_id: dto.operation_id,
      reason: dto.reason,
      intention: 'liberar_reserva',
    });

    return await this.databaseService.transaction<OperacionInventarioAceptada>(
      async (client) => {
        // Idempotencia
        const existingOp = await client.query(
          `SELECT id, operation_id, request_fingerprint, status, result_payload 
         FROM inventory.inventory_operations 
         WHERE operation_id = $1`,
          [dto.operation_id],
        );

        if (existingOp.rows.length > 0) {
          const op = existingOp.rows[0];
          if (
            this.idempotencyService.isMatchingFingerprint(
              op.request_fingerprint,
              fingerprint,
            )
          ) {
            return {
              operation_id: dto.operation_id,
              order_id: dto.order_id,
              operation_type: 'LIBERAR',
              status: 'ACCEPTED',
              correlation_id: correlationId,
            };
          } else {
            throw ProblemDetailsException.idempotencyConflict(
              'operation_id ya utilizado con otra intención',
              correlationId,
            );
          }
        }

        // Bloquear reserva
        const resReserva = await client.query(
          `SELECT id, reservation_id, status, expires_at, order_id 
         FROM inventory.reservations 
         WHERE reservation_id = $1 
         FOR UPDATE`,
          [reservaId],
        );

        if (resReserva.rows.length === 0) {
          throw ProblemDetailsException.reservaNoEncontrada(
            'Reserva no encontrada',
            correlationId,
          );
        }

        const reserva = resReserva.rows[0];

        if (reserva.status === 'LIBERADA') {
          throw ProblemDetailsException.reservaNoActiva(
            'La reserva ya se encuentra liberada',
            correlationId,
          );
        }
        if (reserva.status !== 'ACTIVA') {
          throw ProblemDetailsException.reservaNoActiva(
            `No es posible liberar una reserva en estado ${reserva.status}`,
            correlationId,
          );
        }

        // Transición a LIBERADA
        await client.query(
          `UPDATE inventory.reservations 
         SET status = 'LIBERADA', released_at = now() 
         WHERE id = $1`,
          [reserva.id],
        );

        // Cargar líneas y revertir reserved en stock_balance
        const linesRes = await client.query(
          `SELECT sku_id, location_id, quantity 
         FROM inventory.reservation_lines 
         WHERE reservation_id = $1`,
          [reserva.id],
        );

        for (const line of linesRes.rows) {
          const qty = Number(line.quantity);

          const balRes = await client.query(
            `SELECT on_hand, reserved, blocked, stock_version 
           FROM inventory.stock_balance 
           WHERE sku_id = $1 AND location_id = $2 
           FOR UPDATE`,
            [line.sku_id, line.location_id],
          );

          if (balRes.rows.length > 0) {
            const bal = balRes.rows[0];
            const onHand = Number(bal.on_hand);
            const reserved = Number(bal.reserved);
            const blocked = Number(bal.blocked);
            const newReserved = Math.max(0, reserved - qty);
            const newVersion = Number(bal.stock_version) + 1;

            await client.query(
              `UPDATE inventory.stock_balance 
             SET reserved = $1, stock_version = $2 
             WHERE sku_id = $3 AND location_id = $4`,
              [newReserved, newVersion, line.sku_id, line.location_id],
            );

            // Kardex de liberación
            await this.kardexService.recordMovement(client, {
              sku_id: line.sku_id,
              location_id: line.location_id,
              operation_type: 'LIBERACION',
              operation_id: dto.operation_id,
              reservation_id: reservaId,
              quantity: -qty,
              on_hand_before: onHand,
              on_hand_after: onHand,
              reserved_before: reserved,
              reserved_after: newReserved,
              blocked_before: blocked,
              blocked_after: blocked,
              stock_version: newVersion,
              correlation_id: correlationId,
            });
          }
        }

        const acceptedResponse: OperacionInventarioAceptada = {
          operation_id: dto.operation_id,
          order_id: dto.order_id,
          operation_type: 'LIBERAR',
          status: 'ACCEPTED',
          correlation_id: correlationId,
        };

        // Registro durable de operación
        await client.query(
          `INSERT INTO inventory.inventory_operations (
          operation_type, idempotency_key, intention, status,
          order_id, reservation_id, accepted_at, applied_at,
          operation_id, request_fingerprint, request_payload, result_payload, correlation_id
        ) VALUES (
          'LIBERACION', $1, 'liberar_reserva', 'APLICADO',
          $2, $3, now(), now(),
          $4, $5, $6, $7, $8
        )`,
          [
            idempotencyKey,
            dto.order_id,
            reservaId,
            dto.operation_id,
            fingerprint,
            JSON.stringify(dto),
            JSON.stringify(acceptedResponse),
            correlationId,
          ],
        );

        // Outbox: inventory.reservation.released
        const releasedEvent = this.outboxService.createMessageEnvelope({
          eventName: 'inventory.reservation.released',
          kind: 'event',
          operationId: dto.operation_id,
          correlationId,
          data: {
            order_id: dto.order_id,
            reservation_id: reservaId,
            decided_at: new Date().toISOString(),
            reason_code: dto.reason,
          },
        });

        await this.outboxService.enqueue(client, {
          event_id: randomUUID(),
          event_type: 'inventory.reservation.released',
          aggregate_type: 'reservation',
          aggregate_id: reservaId,
          correlation_id: correlationId,
          payload: releasedEvent,
        });

        return acceptedResponse;
      },
    );
  }

  private async expirarReservaInterna(
    client: IDatabaseClient,
    reservationPk: string,
    reservationId: string,
    orderId: string,
    correlationId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE inventory.reservations 
       SET status = 'EXPIRADA', expired_at = now() 
       WHERE id = $1`,
      [reservationPk],
    );

    const linesRes = await client.query(
      `SELECT sku_id, location_id, quantity 
       FROM inventory.reservation_lines 
       WHERE reservation_id = $1`,
      [reservationPk],
    );

    for (const line of linesRes.rows) {
      const qty = Number(line.quantity);
      const balRes = await client.query(
        `SELECT on_hand, reserved, blocked, stock_version 
         FROM inventory.stock_balance 
         WHERE sku_id = $1 AND location_id = $2 
         FOR UPDATE`,
        [line.sku_id, line.location_id],
      );

      if (balRes.rows.length > 0) {
        const bal = balRes.rows[0];
        const newReserved = Math.max(0, Number(bal.reserved) - qty);
        const newVersion = Number(bal.stock_version) + 1;

        await client.query(
          `UPDATE inventory.stock_balance 
           SET reserved = $1, stock_version = $2 
           WHERE sku_id = $3 AND location_id = $4`,
          [newReserved, newVersion, line.sku_id, line.location_id],
        );

        await this.kardexService.recordMovement(client, {
          sku_id: line.sku_id,
          location_id: line.location_id,
          operation_type: 'EXPIRACION',
          reservation_id: reservationId,
          quantity: -qty,
          on_hand_before: Number(bal.on_hand),
          on_hand_after: Number(bal.on_hand),
          reserved_before: Number(bal.reserved),
          reserved_after: newReserved,
          blocked_before: Number(bal.blocked),
          blocked_after: Number(bal.blocked),
          stock_version: newVersion,
          correlation_id: correlationId,
        });
      }
    }
  }

  private async registrarRechazo(
    client: IDatabaseClient,
    dto: CrearReservaRequest,
    idempotencyKey: string,
    fingerprint: string,
    correlationId: string,
    resultCode: string,
  ): Promise<OperacionInventarioAceptada> {
    const rejectedPayload = {
      status: 'REJECTED',
      result_code: resultCode,
    };

    await client.query(
      `INSERT INTO inventory.inventory_operations (
        operation_type, idempotency_key, intention, status, result_code,
        order_id, accepted_at, applied_at,
        operation_id, request_fingerprint, request_payload, result_payload, correlation_id
      ) VALUES (
        'RESERVA', $1, 'reservar', 'RECHAZADO', $2,
        $3, now(), now(),
        $4, $5, $6, $7, $8
      )`,
      [
        idempotencyKey,
        resultCode,
        dto.order_id,
        dto.operation_id,
        fingerprint,
        JSON.stringify(dto),
        JSON.stringify(rejectedPayload),
        correlationId,
      ],
    );

    const rejectedEvent = this.outboxService.createMessageEnvelope({
      eventName: 'inventory.reservation.rejected',
      kind: 'result',
      operationId: dto.operation_id,
      correlationId,
      data: {
        order_id: dto.order_id,
        result_code: resultCode,
        decided_at: new Date().toISOString(),
      },
    });

    await this.outboxService.enqueue(client, {
      event_id: randomUUID(),
      event_type: 'inventory.reservation.rejected',
      aggregate_type: 'reservation',
      aggregate_id: dto.operation_id,
      correlation_id: correlationId,
      payload: rejectedEvent,
    });

    // Se responde 202 Accepted indicando que el comando fue recibido
    // (el rechazo definitivo de negocio queda en inventory_operations y AsyncAPI)
    return {
      operation_id: dto.operation_id,
      order_id: dto.order_id,
      operation_type: 'RESERVAR',
      status: 'ACCEPTED',
      correlation_id: correlationId,
    };
  }

  private async resolverUbicaciones(
    dto: CrearReservaRequest,
    correlationId: string,
  ): Promise<Array<{ sku: string; quantity: number; location_id: string }>> {
    const result: Array<{
      sku: string;
      quantity: number;
      location_id: string;
    }> = [];

    // Cargar ubicaciones activas
    const locRes = await this.databaseService.query(
      `SELECT id, code, active FROM inventory.locations WHERE active = true`,
    );
    const activeLocations = locRes.rows;

    for (const line of dto.lines) {
      if (line.location_id) {
        if (!UUID_REGEX.test(line.location_id)) {
          throw ProblemDetailsException.validation(
            `location_id inválido: ${line.location_id}`,
            correlationId,
          );
        }
        const exists = activeLocations.some(
          (loc: any) => loc.id === line.location_id,
        );
        if (!exists) {
          throw ProblemDetailsException.validation(
            `Ubicación no encontrada o inactiva: ${line.location_id}`,
            correlationId,
          );
        }
        result.push({
          sku: line.sku,
          quantity: line.quantity,
          location_id: line.location_id,
        });
      } else {
        // location_id no proporcionado: consultar ruta de cumplimiento comercial
        const routeRes = await this.databaseService.query(
          `SELECT location_id FROM inventory.commercial_fulfillment_routes 
           WHERE channel_id = $1 AND active = true`,
          [dto.channel_id],
        );

        if (routeRes.rows.length === 1) {
          result.push({
            sku: line.sku,
            quantity: line.quantity,
            location_id: routeRes.rows[0].location_id,
          });
        } else if (activeLocations.length === 1) {
          // Única ubicación inequívoca permitida por SPEC-015 §7.2
          result.push({
            sku: line.sku,
            quantity: line.quantity,
            location_id: activeLocations[0].id,
          });
        } else {
          // Múltiples ubicaciones y sin ruta unívoca: prohibido seleccionar implícitamente
          throw ProblemDetailsException.validation(
            `No se puede determinar una ubicación inequívoca para el canal ${dto.channel_id}. Especifique location_id en cada línea.`,
            correlationId,
          );
        }
      }
    }

    return result;
  }

  private validarCrearReservaInput(
    dto: CrearReservaRequest,
    correlationId: string,
  ): void {
    if (!dto) {
      throw ProblemDetailsException.validation(
        'El cuerpo de la solicitud no puede estar vacío',
        correlationId,
      );
    }
    if (
      !dto.order_id ||
      typeof dto.order_id !== 'string' ||
      dto.order_id.trim().length === 0
    ) {
      throw ProblemDetailsException.validation(
        'order_id es obligatorio y debe ser texto no vacío',
        correlationId,
      );
    }
    if (!dto.operation_id || !UUID_REGEX.test(dto.operation_id)) {
      throw ProblemDetailsException.validation(
        'operation_id debe ser un UUID válido',
        correlationId,
      );
    }
    const canalesValidos = ['MARKETPLACE', 'CHATBOT', 'RETAIL'];
    if (!dto.channel_id || !canalesValidos.includes(dto.channel_id)) {
      throw ProblemDetailsException.validation(
        'channel_id inválido (debe ser MARKETPLACE, CHATBOT o RETAIL)',
        correlationId,
      );
    }
    if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
      throw ProblemDetailsException.validation(
        'lines debe ser una lista con al menos un elemento',
        correlationId,
      );
    }

    for (const [idx, line] of dto.lines.entries()) {
      if (
        !line.sku ||
        typeof line.sku !== 'string' ||
        line.sku.trim().length === 0
      ) {
        throw ProblemDetailsException.validation(
          `Línea ${idx + 1}: sku es obligatorio`,
          correlationId,
        );
      }
      if (
        typeof line.quantity !== 'number' ||
        !Number.isInteger(line.quantity) ||
        line.quantity <= 0
      ) {
        throw ProblemDetailsException.cantidadInvalida(
          `Línea ${idx + 1}: quantity debe ser un entero positivo mayor a cero`,
          correlationId,
        );
      }
    }
  }
}
