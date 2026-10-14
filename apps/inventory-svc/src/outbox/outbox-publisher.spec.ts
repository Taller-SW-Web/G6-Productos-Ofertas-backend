import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  OutboxPublisherService,
  IMessageBrokerPublisher,
} from './outbox-publisher.service.js';
import { DatabaseService } from '../database/database.service.js';
import { InMemoryDatabaseMock } from '../../test/in-memory-database.mock.js';

describe('OutboxPublisherService — Publicación Confiable y Confirmación de Broker', () => {
  let publisherService: OutboxPublisherService;
  let mockDb: InMemoryDatabaseMock;
  let dbService: DatabaseService;

  beforeEach(() => {
    mockDb = new InMemoryDatabaseMock();
    dbService = new DatabaseService();
    dbService.setCustomService(mockDb);
    publisherService = new OutboxPublisherService(dbService);
  });

  it('debe despachar eventos PENDING al broker y marcarlos como PUBLISHED con confirmación', async () => {
    const eventId = randomUUID();
    const opId = randomUUID();

    mockDb.outbox.push({
      id: 'outbox-test-1',
      event_id: eventId,
      event_type: 'inventory.reservation.created',
      aggregate_type: 'reservation',
      aggregate_id: opId,
      payload: {
        message_id: eventId,
        schema_version: 2,
        kind: 'event',
        name: 'inventory.reservation.created',
        operation_id: opId,
        data: { test: true },
      },
      status: 'PENDING',
      created_at: new Date().toISOString(),
    });

    const publishedMessages: any[] = [];
    const mockPublisher: IMessageBrokerPublisher = {
      publish: async (exchange, routingKey, content) => {
        publishedMessages.push({
          exchange,
          routingKey,
          payload: JSON.parse(content.toString()),
        });
        return true; // Confirmed
      },
    };

    publisherService.setCustomPublisher(mockPublisher);

    const result = await publisherService.dispatchPending();

    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0].exchange).toBe('po.events.x');
    expect(publishedMessages[0].routingKey).toBe(
      'inventory.reservation.created',
    );

    const updatedRow = mockDb.outbox.find((o) => o.id === 'outbox-test-1')!;
    expect(updatedRow.status).toBe('PUBLISHED');
    expect(updatedRow.published_at).toBeDefined();
  });

  it('debe aislar errores de conexión del broker sin alterar el estado PENDING de outbox', async () => {
    const eventId = randomUUID();
    mockDb.outbox.push({
      id: 'outbox-test-fail',
      event_id: eventId,
      event_type: 'inventory.reservation.rejected',
      aggregate_type: 'reservation',
      aggregate_id: randomUUID(),
      payload: {
        message_id: eventId,
        schema_version: 2,
        kind: 'result',
        name: 'inventory.reservation.rejected',
        data: { test: true },
      },
      status: 'PENDING',
      created_at: new Date().toISOString(),
    });

    // Simulador de broker caído
    const failingPublisher: IMessageBrokerPublisher = {
      publish: async () => {
        throw new Error('Connection refused by RabbitMQ broker (ECONNREFUSED)');
      },
    };

    publisherService.setCustomPublisher(failingPublisher);

    const result = await publisherService.dispatchPending();

    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);

    // El evento debe conservarse PENDING para posterior reintento durable
    const unpostedRow = mockDb.outbox.find((o) => o.id === 'outbox-test-fail')!;
    expect(unpostedRow.status).toBe('PENDING');
    expect(unpostedRow.published_at).toBeUndefined();
  });
});
