import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service.js';
import { IDatabaseClient } from '../../database/database.interface.js';
import { OutboxRecord } from '../../outbox/outbox.service.js';
import {
  IOutboxRepository,
  OutboxEntity,
} from '../interfaces/outbox.repository.interface.js';

@Injectable()
export class DrizzleOutboxRepository implements IOutboxRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async enqueue(client: IDatabaseClient, record: OutboxRecord): Promise<void> {
    const sql = `
      INSERT INTO inventory.outbox (
        event_id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
    `;
    await client.query(sql, [
      record.event_id,
      record.event_type,
      record.aggregate_type,
      record.aggregate_id,
      record.correlation_id ?? null,
      JSON.stringify(record.payload),
    ]);
  }

  async findPendingForUpdateSkipLocked(
    client: IDatabaseClient,
    limit: number,
  ): Promise<OutboxEntity[]> {
    const sql = `
      SELECT id, event_id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, created_at
      FROM inventory.outbox
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;
    const res = await client.query(sql, [limit]);
    return res.rows.map(this.mapRow);
  }

  async findPending(limit: number): Promise<OutboxEntity[]> {
    const sql = `
      SELECT id, event_id, event_type, aggregate_type, aggregate_id, correlation_id, payload, status, created_at
      FROM inventory.outbox
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT $1
    `;
    const res = await this.databaseService.query(sql, [limit]);
    return res.rows.map(this.mapRow);
  }

  async markAsPublished(id: string, client?: IDatabaseClient): Promise<void> {
    const sql = `
      UPDATE inventory.outbox
      SET status = 'PUBLISHED', published_at = now()
      WHERE id = $1
    `;
    if (client) {
      await client.query(sql, [id]);
    } else {
      await this.databaseService.query(sql, [id]);
    }
  }

  private mapRow(r: any): OutboxEntity {
    return {
      id: r.id,
      event_id: r.event_id,
      event_type: r.event_type,
      aggregate_type: r.aggregate_type,
      aggregate_id: r.aggregate_id,
      correlation_id: r.correlation_id,
      payload:
        typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      status: r.status,
      created_at: r.created_at,
    };
  }
}
