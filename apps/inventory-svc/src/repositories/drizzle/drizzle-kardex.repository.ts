import { Injectable } from '@nestjs/common';
import { IDatabaseClient } from '../../database/database.interface.js';
import {
  IKardexRepository,
  NewKardexMovement,
} from '../interfaces/kardex.repository.interface.js';

@Injectable()
export class DrizzleKardexRepository implements IKardexRepository {
  async createMovement(
    client: IDatabaseClient,
    movement: NewKardexMovement,
  ): Promise<void> {
    const sql = `
      INSERT INTO inventory.kardex (
        sku_id, location_id, operation_type, operation_id, reservation_id,
        quantity, on_hand_before, on_hand_after, reserved_before, reserved_after,
        blocked_before, blocked_after, stock_version, correlation_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14
      )
    `;
    await client.query(sql, [
      movement.sku_id,
      movement.location_id,
      movement.operation_type,
      movement.operation_id ?? null,
      movement.reservation_id ?? null,
      movement.quantity,
      movement.on_hand_before,
      movement.on_hand_after,
      movement.reserved_before,
      movement.reserved_after,
      movement.blocked_before,
      movement.blocked_after,
      movement.stock_version,
      movement.correlation_id ?? null,
    ]);
  }
}
