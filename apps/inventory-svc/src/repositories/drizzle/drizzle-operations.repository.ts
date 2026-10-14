import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import {
  IOperationsRepository,
  OperationEntity,
} from '../interfaces/operations.repository.interface.js';

@Injectable()
export class DrizzleOperationsRepository implements IOperationsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findByOperationIdOrIdempotencyKey(
    operationId: string,
    idempotencyKey: string,
    client?: IDatabaseClient,
  ): Promise<OperationEntity | null> {
    const sql = `
      SELECT id, operation_type, idempotency_key, intention, status,
             order_id, reservation_id, result_code, operation_id,
             request_fingerprint, request_payload, result_payload,
             accepted_at, applied_at, correlation_id
      FROM inventory.inventory_operations
      WHERE operation_id = $1 OR idempotency_key = $2
    `;
    const res = client
      ? await client.query(sql, [operationId, idempotencyKey])
      : await this.databaseService.query(sql, [operationId, idempotencyKey]);

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByOperationId(
    operationId: string,
    client?: IDatabaseClient,
  ): Promise<OperationEntity | null> {
    const sql = `
      SELECT id, operation_type, idempotency_key, intention, status,
             order_id, reservation_id, result_code, operation_id,
             request_fingerprint, request_payload, result_payload,
             accepted_at, applied_at, correlation_id
      FROM inventory.inventory_operations
      WHERE operation_id = $1
    `;
    const res = client
      ? await client.query(sql, [operationId])
      : await this.databaseService.query(sql, [operationId]);

    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async create(
    client: IDatabaseClient,
    op: {
      operation_type: string;
      idempotency_key: string;
      intention: string;
      status: string;
      order_id?: string | null;
      reservation_id?: string | null;
      operation_id?: string | null;
      request_fingerprint?: string | null;
      request_payload?: string | null;
      result_payload?: string | null;
      correlation_id?: string | null;
      result_code?: string | null;
    },
  ): Promise<void> {
    const sql = `
      INSERT INTO inventory.inventory_operations (
        operation_type, idempotency_key, intention, status, result_code,
        order_id, reservation_id, accepted_at, applied_at,
        operation_id, request_fingerprint, request_payload, result_payload, correlation_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, now(), now(),
        $8, $9, $10, $11, $12
      )
    `;
    await client.query(sql, [
      op.operation_type,
      op.idempotency_key,
      op.intention,
      op.status,
      op.result_code ?? null,
      op.order_id ?? null,
      op.reservation_id ?? null,
      op.operation_id ?? null,
      op.request_fingerprint ?? null,
      op.request_payload ?? null,
      op.result_payload ?? null,
      op.correlation_id ?? null,
    ]);
  }

  private mapRow(row: any): OperationEntity {
    return {
      id: row.id,
      operation_type: row.operation_type,
      idempotency_key: row.idempotency_key,
      intention: row.intention,
      status: row.status,
      order_id: row.order_id,
      reservation_id: row.reservation_id,
      result_code: row.result_code,
      operation_id: row.operation_id,
      request_fingerprint: row.request_fingerprint,
      request_payload: row.request_payload,
      result_payload: row.result_payload,
      accepted_at:
        typeof row.accepted_at === 'string'
          ? row.accepted_at
          : (row.accepted_at?.toISOString?.() ?? row.accepted_at),
      applied_at:
        typeof row.applied_at === 'string'
          ? row.applied_at
          : (row.applied_at?.toISOString?.() ?? row.applied_at),
      correlation_id: row.correlation_id,
    };
  }
}
