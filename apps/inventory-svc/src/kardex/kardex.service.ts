import { Injectable } from '@nestjs/common';
import { IDatabaseClient } from '../database/database.interface.js';

export interface KardexEntry {
  sku_id: string;
  location_id: string;
  operation_type:
    | 'RESERVA'
    | 'CONSUMO'
    | 'LIBERACION'
    | 'EXPIRACION'
    | 'AJUSTE_ABSOLUTO'
    | 'INCIDENCIA_BLOQUEO'
    | 'INCIDENCIA_RESOLUCION'
    | 'REINTEGRO'
    | 'CONCILIACION_OFFLINE'
    | 'RECEPCION_TRASLADO'
    | 'INICIALIZACION_SKU';
  operation_id?: string | null;
  reservation_id?: string | null;
  quantity: number;
  on_hand_before: number;
  on_hand_after: number;
  reserved_before: number;
  reserved_after: number;
  blocked_before: number;
  blocked_after: number;
  stock_version: number | bigint;
  correlation_id?: string | null;
}

@Injectable()
export class KardexService {
  async recordMovement(
    client: IDatabaseClient,
    entry: KardexEntry,
  ): Promise<void> {
    if (entry.quantity === 0) {
      return;
    }

    const sql = `
      INSERT INTO inventory.kardex (
        sku_id, location_id, operation_type, operation_id, reservation_id,
        quantity, on_hand_before, on_hand_after, reserved_before, reserved_after,
        blocked_before, blocked_after, stock_version, correlation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `;

    await client.query(sql, [
      entry.sku_id,
      entry.location_id,
      entry.operation_type,
      entry.operation_id ?? null,
      entry.reservation_id ?? null,
      entry.quantity,
      entry.on_hand_before,
      entry.on_hand_after,
      entry.reserved_before,
      entry.reserved_after,
      entry.blocked_before,
      entry.blocked_after,
      entry.stock_version,
      entry.correlation_id ?? null,
    ]);
  }
}
