import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import {
  ConsultaOperacionInventario,
  OperacionInventarioTipo,
  OperacionInventarioEstado,
} from '../types/inventory.dto.js';
import { ProblemDetailsException } from '../errors/inventory.errors.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class OperationsService {
  constructor(private readonly databaseService: DatabaseService) {}

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

    const sql = `
      SELECT 
        o.operation_id,
        o.order_id,
        o.operation_type,
        o.status,
        o.result_code,
        o.reservation_id,
        o.accepted_at,
        o.applied_at,
        r.expires_at
      FROM inventory.inventory_operations o
      LEFT JOIN inventory.reservations r ON r.reservation_id = o.reservation_id
      WHERE o.operation_id = $1
      LIMIT 1
    `;

    const res = await this.databaseService.query(sql, [operationId]);

    if (res.rows.length === 0) {
      throw ProblemDetailsException.operacionNoEncontrada(
        'Operación de inventario no encontrada',
        correlationId,
      );
    }

    const row = res.rows[0];

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
      opTypeMap[row.operation_type] ?? 'RESERVAR';
    const status: OperacionInventarioEstado =
      statusMap[row.status] ?? 'COMPLETED';

    const result: ConsultaOperacionInventario = {
      operation_id: row.operation_id,
      order_id: row.order_id || '',
      operation_type: operationType,
      status,
      reservation_id: row.reservation_id || null,
      expires_at: row.expires_at
        ? new Date(row.expires_at).toISOString()
        : null,
      result_code: row.result_code || null,
      accepted_at: row.accepted_at
        ? new Date(row.accepted_at).toISOString()
        : new Date().toISOString(),
      completed_at: row.applied_at
        ? new Date(row.applied_at).toISOString()
        : null,
    };

    return result;
  }
}
