import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IDatabaseClient } from '../database/database.interface.js';
import { DrizzleOutboxRepository } from '../repositories/drizzle/drizzle-outbox.repository.js';

export interface OutboxRecord {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id?: string | null;
  payload: Record<string, unknown>;
}

export interface AsyncApiEnvelopeParams {
  eventName: string;
  kind: 'event' | 'result';
  operationId: string;
  causationId?: string;
  correlationId?: string;
  data: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  constructor(private readonly outboxRepository: DrizzleOutboxRepository) {}

  /**
   * Constructs an AsyncAPI 0.6.0-rc.1 compliant envelope
   */
  createMessageEnvelope(
    params: AsyncApiEnvelopeParams,
  ): Record<string, unknown> {
    const messageId = randomUUID();
    const correlationId = params.correlationId || randomUUID();
    const causationId = params.causationId || params.operationId;

    return {
      message_id: messageId,
      schema_version: 2,
      occurred_at: new Date().toISOString(),
      correlation_id: correlationId,
      causation_id: causationId,
      operation_id: params.operationId,
      producer: 'inventory-svc',
      kind: params.kind,
      name: params.eventName,
      data: params.data,
    };
  }

  /**
   * Enqueues an event into inventory.outbox within the active database transaction
   */
  async enqueue(client: IDatabaseClient, record: OutboxRecord): Promise<void> {
    await this.outboxRepository.enqueue(client, record);
  }
}
