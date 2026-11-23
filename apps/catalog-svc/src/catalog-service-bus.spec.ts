import type { ServiceBusClient, ServiceBusMessage } from '@azure/service-bus';
import { randomUUID } from 'node:crypto';
import type { CatalogEnvelope } from './catalog-messages.js';
import {
  CatalogServiceBus,
  createCatalogServiceBus,
  destinationsFor,
} from './catalog-service-bus.js';
import {
  createCatalogBulkConsumer,
  createCatalogTaxonomyConsumer,
} from './catalog-service-bus.runtime.js';
import { readCatalogH5Destinations } from './catalog-messaging.config.js';

function outgoing(): CatalogEnvelope {
  const timestamp = new Date().toISOString();
  return {
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: timestamp,
    correlation_id: randomUUID(),
    causation_id: null,
    operation_id: null,
    producer: 'catalog-svc',
    kind: 'event',
    name: 'catalog.product.deactivated',
    data: {
      product_id: randomUUID(),
      product_version: 1,
      changed_at: timestamp,
    },
  };
}

function bulkRequest(schema_version: 1 | 2 | 3): CatalogEnvelope {
  const operationId = randomUUID();
  const data =
    schema_version === 3
      ? {
          batch_id: randomUUID(),
          batch_operation_id: operationId,
          template_version: 2,
          mode: 'ALTA',
          content_ref: {
            content_id: randomUUID(),
            sha256: 'b'.repeat(64),
            byte_length: 108,
            content_type: 'application/json',
          },
        }
      : {
          batch_id: randomUUID(),
          batch_operation_id: operationId,
          template_version: 2,
          mode: 'ALTA',
          rows: [
            {
              row_number: 2,
              row_operation_id: randomUUID(),
              producto_id: null,
              sku_base: 'SKU-1',
              product: {},
              variant_id: null,
              variant: null,
            },
          ],
        };
  return {
    message_id: randomUUID(),
    schema_version,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: null,
    operation_id: operationId,
    producer: 'bulk-svc',
    kind: 'command',
    name: 'catalog.bulk.upsert.requested',
    data,
  };
}

function bulkResult(
  name: 'catalog.bulk.upsert.completed' | 'catalog.bulk.upsert.rejected',
): CatalogEnvelope {
  const operationId = randomUUID();
  return {
    message_id: randomUUID(),
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    operation_id: operationId,
    producer: 'catalog-svc',
    kind: 'result',
    name,
    data:
      name === 'catalog.bulk.upsert.completed'
        ? {
            batch_id: randomUUID(),
            batch_operation_id: operationId,
            results: [
              {
                row_number: 2,
                row_operation_id: randomUUID(),
                product_id: randomUUID(),
                sku_base: 'SKU-1',
                status: 'COMPLETED',
                code: null,
              },
            ],
          }
        : {
            batch_id: randomUUID(),
            batch_operation_id: operationId,
            code: 'VALIDACION',
            detail: 'Comando inválido.',
          },
  };
}

describe('Catalog Service Bus candidate', () => {
  it('defaults to the existing provider and refuses simultaneous activation', () => {
    expect(createCatalogServiceBus({})).toBeUndefined();
    expect(
      createCatalogServiceBus({
        MESSAGING_PROVIDER: 'RABBITMQ',
        CATALOG_H5_DESTINATIONS: 'g6.taxonomy.from.catalog',
      }),
    ).toBeUndefined();
    expect(readCatalogH5Destinations({})).toEqual([]);
    expect(
      readCatalogH5Destinations({
        CATALOG_H5_DESTINATIONS:
          ' g6.promotions.from.catalog, g6.combos.from.catalog ',
      }),
    ).toEqual(['g6.promotions.from.catalog', 'g6.combos.from.catalog']);
    expect(() =>
      readCatalogH5Destinations({
        CATALOG_H5_DESTINATIONS: 'g6.promotions.from.catalog,other.queue',
      }),
    ).toThrow('destinos no autorizados');
    expect(() =>
      readCatalogH5Destinations({
        CATALOG_H5_DESTINATIONS:
          'g6.promotions.from.catalog,g6.promotions.from.catalog',
      }),
    ).toThrow('destinos no autorizados');
    expect(() =>
      createCatalogServiceBus({
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        CATALOG_AMQP_ENABLED: 'true',
      }),
    ).toThrow('RabbitMQ habilitado');
  });

  it('keeps identity across ambiguous sends and reuses the queue sender', async () => {
    const tryAddMessage = vi
      .fn<(message: ServiceBusMessage) => boolean>()
      .mockReturnValue(true);
    const sendMessages = vi.fn().mockRejectedValueOnce(new Error('timeout'));
    const createSender = vi.fn().mockReturnValue({
      createMessageBatch: vi.fn().mockResolvedValue({ tryAddMessage }),
      sendMessages,
    });
    const client = { createSender } as unknown as ServiceBusClient;
    const bridge = new CatalogServiceBus(client);
    const event = outgoing();
    const queue = 'g6.promotions.from.catalog';
    await expect(bridge.publish(queue, event)).rejects.toThrow('timeout');
    await bridge.publish(queue, event);
    expect(createSender).toHaveBeenCalledTimes(1);
    expect(
      tryAddMessage.mock.calls.map(([sent]) => [
        sent.messageId,
        sent.correlationId,
      ]),
    ).toEqual(Array(2).fill([event.message_id, event.correlation_id]));
    await expect(
      bridge.publish('g6.inventory.from.catalog', event),
    ).rejects.toThrow('INVALID_CATALOG_MESSAGE');
    tryAddMessage.mockReturnValue(false);
    await expect(bridge.publish(queue, event)).rejects.toThrow(
      'SERVICE_BUS_MESSAGE_TOO_LARGE',
    );
    expect(sendMessages).toHaveBeenCalledTimes(2);
  });

  it('settles after consumption, retries SQL failures and rejects an invalid producer', async () => {
    type Handlers = Parameters<
      ReturnType<ServiceBusClient['createReceiver']>['subscribe']
    >[0];
    type Delivery = Parameters<Handlers['processMessage']>[0];
    let handlers!: Handlers;
    const completeMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('lock lost'));
    const abandonMessage = vi.fn();
    const deadLetterMessage = vi.fn();
    const createReceiver = vi.fn().mockReturnValue({
      subscribe: (value: Handlers) => {
        handlers = value;
        return { close: vi.fn() };
      },
      completeMessage,
      abandonMessage,
      deadLetterMessage,
    });
    const bridge = new CatalogServiceBus({
      createReceiver,
    } as unknown as ServiceBusClient);
    const consume = vi.fn().mockResolvedValue('APPLIED');
    bridge.subscribe('g6.catalog.from.inventory', { consume }, vi.fn());
    const event: CatalogEnvelope = {
      ...outgoing(),
      producer: 'inventory-svc',
      kind: 'result',
      name: 'inventory.sku.initialization.completed',
      operation_id: randomUUID(),
      causation_id: randomUUID(),
      data: {
        product_id: randomUUID(),
        sku: 'SKU-1',
        variant_id: null,
        status: 'INITIALIZED',
        completed_at: new Date().toISOString(),
      },
    };
    const delivery = (envelope: CatalogEnvelope) =>
      ({
        body: Buffer.from(JSON.stringify(envelope)),
        messageId: envelope.message_id,
        correlationId: envelope.correlation_id,
        subject: envelope.name,
        contentType: 'application/json',
      }) as Delivery;
    await expect(handlers.processMessage(delivery(event))).rejects.toThrow(
      'lock lost',
    );
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
      completeMessage.mock.invocationCallOrder[0]!,
    );
    expect(abandonMessage).not.toHaveBeenCalled();
    consume.mockResolvedValueOnce('DUPLICATE');
    await handlers.processMessage(delivery(event));
    expect(completeMessage).toHaveBeenCalledTimes(2);
    consume.mockRejectedValueOnce(new Error('SQL unavailable'));
    await handlers.processMessage(delivery(event));
    expect(abandonMessage).toHaveBeenCalledTimes(1);
    await handlers.processMessage(
      delivery({ ...event, producer: 'pricing-svc' }),
    );
    expect(deadLetterMessage).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2, 3] as const)(
    'abandons Bulk V%s commands before consumption when the result route is disabled',
    async (schemaVersion) => {
      type Handlers = Parameters<
        ReturnType<ServiceBusClient['createReceiver']>['subscribe']
      >[0];
      type Delivery = Parameters<Handlers['processMessage']>[0];
      let handlers!: Handlers;
      const completeMessage = vi.fn();
      const abandonMessage = vi.fn();
      const deadLetterMessage = vi.fn();
      const createReceiver = vi.fn().mockReturnValue({
        subscribe: (value: Handlers) => {
          handlers = value;
          return { close: vi.fn() };
        },
        peekMessages: vi.fn().mockResolvedValue([]),
        completeMessage,
        abandonMessage,
        deadLetterMessage,
      });
      const bridge = new CatalogServiceBus({
        createReceiver,
      } as unknown as ServiceBusClient);
      const consume = vi.fn().mockResolvedValue('APPLIED');
      const reportError = vi.fn();
      bridge.subscribeWithProbe(
        'g6.catalog.from.bulk',
        createCatalogBulkConsumer({ consume }, []),
        reportError,
      );
      const event = bulkRequest(schemaVersion);
      const received = {
        body: Buffer.from(JSON.stringify(event)),
        messageId: event.message_id,
        correlationId: event.correlation_id,
        subject: event.name,
        contentType: 'application/json',
      } as Delivery;

      await handlers.processMessage(received);

      expect(consume).not.toHaveBeenCalled();
      expect(completeMessage).not.toHaveBeenCalled();
      expect(abandonMessage).toHaveBeenCalledWith(received);
      expect(deadLetterMessage).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledOnce();
    },
  );

  it('completes a Bulk request only after consumption when the result route is enabled', async () => {
    type Handlers = Parameters<
      ReturnType<ServiceBusClient['createReceiver']>['subscribe']
    >[0];
    type Delivery = Parameters<Handlers['processMessage']>[0];
    let handlers!: Handlers;
    const completeMessage = vi.fn();
    const abandonMessage = vi.fn();
    const deadLetterMessage = vi.fn();
    const createReceiver = vi.fn().mockReturnValue({
      subscribe: (value: Handlers) => {
        handlers = value;
        return { close: vi.fn() };
      },
      peekMessages: vi.fn().mockResolvedValue([]),
      completeMessage,
      abandonMessage,
      deadLetterMessage,
    });
    const bridge = new CatalogServiceBus({
      createReceiver,
    } as unknown as ServiceBusClient);
    const consume = vi.fn().mockResolvedValue('APPLIED');
    const resultRoute = 'g6.bulk.from.catalog';
    bridge.subscribeWithProbe(
      'g6.catalog.from.bulk',
      createCatalogBulkConsumer({ consume }, [resultRoute]),
      vi.fn(),
    );
    const event = bulkRequest(3);
    const received = {
      body: Buffer.from(JSON.stringify(event)),
      messageId: event.message_id,
      correlationId: event.correlation_id,
      subject: event.name,
      contentType: 'application/json',
    } as Delivery;

    await handlers.processMessage(received);

    expect(consume).toHaveBeenCalledWith(event);
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
      completeMessage.mock.invocationCallOrder[0]!,
    );
    expect(completeMessage).toHaveBeenCalledWith(received);
    expect(abandonMessage).not.toHaveBeenCalled();
    expect(deadLetterMessage).not.toHaveBeenCalled();
  });

  it('routes Bulk completed and rejected results to the enabled Bulk destination', async () => {
    const resultRoute = 'g6.bulk.from.catalog';
    expect(
      readCatalogH5Destinations({ CATALOG_H5_DESTINATIONS: resultRoute }),
    ).toContain(resultRoute);
    const tryAddMessage = vi
      .fn<(message: ServiceBusMessage) => boolean>()
      .mockReturnValue(true);
    const sendMessages = vi.fn().mockResolvedValue(undefined);
    const createSender = vi.fn().mockReturnValue({
      createMessageBatch: vi.fn().mockResolvedValue({ tryAddMessage }),
      sendMessages,
    });
    const bridge = new CatalogServiceBus({
      createSender,
    } as unknown as ServiceBusClient);

    for (const name of [
      'catalog.bulk.upsert.completed',
      'catalog.bulk.upsert.rejected',
    ] as const) {
      const result = bulkResult(name);
      expect(destinationsFor(result)).toEqual([resultRoute]);
      await bridge.publish(resultRoute, result);
    }

    expect(createSender).toHaveBeenCalledWith(resultRoute);
    expect(sendMessages).toHaveBeenCalledTimes(2);
    expect(tryAddMessage).toHaveBeenCalledTimes(2);
  });

  it('abandons a valid Taxonomy check when the H5 reply route is disabled', async () => {
    type Handlers = Parameters<
      ReturnType<ServiceBusClient['createReceiver']>['subscribe']
    >[0];
    type Delivery = Parameters<Handlers['processMessage']>[0];
    let handlers!: Handlers;
    const completeMessage = vi.fn();
    const abandonMessage = vi.fn();
    const deadLetterMessage = vi.fn();
    const createReceiver = vi.fn().mockReturnValue({
      subscribe: (value: Handlers) => {
        handlers = value;
        return { close: vi.fn() };
      },
      peekMessages: vi.fn().mockResolvedValue([]),
      completeMessage,
      abandonMessage,
      deadLetterMessage,
    });
    const bridge = new CatalogServiceBus({
      createReceiver,
    } as unknown as ServiceBusClient);
    const consume = vi.fn().mockResolvedValue('APPLIED');
    const reportError = vi.fn();
    bridge.subscribeWithProbe(
      'g6.catalog.from.taxonomy',
      createCatalogTaxonomyConsumer({ consume }, []),
      reportError,
    );
    const event: CatalogEnvelope = {
      message_id: randomUUID(),
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      causation_id: randomUUID(),
      operation_id: randomUUID(),
      producer: 'taxonomy-svc',
      kind: 'command',
      name: 'taxonomy.master.deactivation.check.requested',
      data: {
        entity_type: 'CATEGORY',
        entity_id: randomUUID(),
        version: 1,
      },
    };
    const received = {
      body: Buffer.from(JSON.stringify(event)),
      messageId: event.message_id,
      correlationId: event.correlation_id,
      subject: event.name,
      contentType: 'application/json',
    } as Delivery;

    await handlers.processMessage(received);

    expect(consume).not.toHaveBeenCalled();
    expect(completeMessage).not.toHaveBeenCalled();
    expect(abandonMessage).toHaveBeenCalledWith(received);
    expect(deadLetterMessage).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledOnce();
  });
});
