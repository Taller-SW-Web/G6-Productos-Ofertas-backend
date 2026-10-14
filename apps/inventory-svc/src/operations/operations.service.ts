import { Injectable } from '@nestjs/common';
import {
  ConsultaOperacionInventario,
  OperacionInventarioTipo,
  OperacionInventarioEstado,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';
import { DrizzleOperationsRepository } from '../repositories/drizzle/drizzle-operations.repository.js';
import { DrizzleReservationsRepository } from '../repositories/drizzle/drizzle-reservations.repository.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class OperationsService {
  constructor(
    private readonly operationsRepository: DrizzleOperationsRepository,
    private readonly reservationsRepository: DrizzleReservationsRepository,
  ) {}

  /**
   * Consulta el resultado durable persistido de una operación de inventario (GET /api/v1/inventario/operaciones/{operationId})
   */
  async consultarOperacion(
    operationId: string,
    correlationId?: string,
  ): Promise<ConsultaOperacionInventario> {
    if (!UUID_REGEX.test(operationId)) {
      throw ProblemDetailsException.validation(
        'operationId debe ser un UUID válido',
        correlationId,
      );
    }

    const op = await this.operationsRepository.findByOperationId(operationId);

    if (!op) {
      throw ProblemDetailsException.operacionNoEncontrada(
        'Operación de inventario no encontrada',
        correlationId,
      );
    }

    let expiresAt: string | null = null;
    if (op.reservation_id) {
      const res = await this.reservationsRepository.findByReservationId(
        op.reservation_id,
      );
      if (res?.expires_at) {
        expiresAt = new Date(res.expires_at).toISOString();
      }
    }

    // Mapear tipos y estados al contrato OpenAPI
    const opTypeMap: Record<string, OperacionInventarioTipo> = {
      RESERVA: 'RESERVAR',
      CONSUMO: 'CONFIRMAR_CONSUMO',
      LIBERACION: 'LIBERAR',
      REINTEGRO: 'REINTEGRAR',
      CONCILIACION_OFFLINE: 'CONCILIAR_OFFLINE',
    };

    const statusMap: Record<string, OperacionInventarioEstado> = {
      RECIBIDO: 'ACCEPTED',
      APLICADO: 'COMPLETED',
      RECHAZADO: 'REJECTED',
      REQUIRES_REVIEW: 'REQUIRES_REVIEW',
    };

    const operationType: OperacionInventarioTipo =
      opTypeMap[op.operation_type] ?? 'RESERVAR';
    const status: OperacionInventarioEstado =
      statusMap[op.status] ?? 'COMPLETED';

    const result: ConsultaOperacionInventario = {
      operation_id: op.operation_id || operationId,
      order_id: op.order_id || '',
      operation_type: operationType,
      status,
      reservation_id: op.reservation_id || null,
      expires_at: expiresAt,
      result_code: op.result_code || null,
      accepted_at: op.accepted_at
        ? new Date(op.accepted_at).toISOString()
        : new Date().toISOString(),
      completed_at: op.applied_at
        ? new Date(op.applied_at).toISOString()
        : null,
    };

    return result;
  }
}
