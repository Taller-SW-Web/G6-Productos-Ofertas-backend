import {
  BulkServiceBus,
  CATALOG_TO_BULK_QUEUE,
  SERVICE_BUS_MAX_MESSAGE_BYTES,
  createBulkServiceBus,
} from './bulk-service-bus.js';

describe('BulkServiceBus', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('publishes one durable Catalog delivery with the contract transport identity', async () => {
    const batch = { tryAddMessage: vi.fn().mockReturnValue(true) };
    const sender = {
      createMessageBatch: vi.fn().mockResolvedValue(batch),
      sendMessages: vi.fn().mockResolvedValue(undefined),
    };
    const client = { createSender: vi.fn().mockReturnValue(sender) };
    const bus = new BulkServiceBus(client as never);

    await bus.publishCatalogCommand({
      messageId: 'command-1',
      correlationId: 'correlation-1',
      eventName: 'catalog.bulk.upsert.requested',
      payload: { message_id: 'command-1', schema_version: 3 },
    });

    expect(client.createSender).toHaveBeenCalledWith('g6.catalog.from.bulk');
    expect(sender.createMessageBatch).toHaveBeenCalledWith({
      maxSizeInBytes: SERVICE_BUS_MAX_MESSAGE_BYTES,
      abortSignal: undefined,
    });
    expect(batch.tryAddMessage).toHaveBeenCalledWith({
      body: Buffer.from('{"message_id":"command-1","schema_version":3}'),
      contentType: 'application/json',
      messageId: 'command-1',
      correlationId: 'correlation-1',
      subject: 'catalog.bulk.upsert.requested',
    });
    expect(sender.sendMessages).toHaveBeenCalledWith(batch, {
      abortSignal: undefined,
    });
  });

  it('keeps over-limit messages pending for the claim-check path', async () => {
    const sender = {
      createMessageBatch: vi.fn().mockResolvedValue({
        tryAddMessage: vi.fn().mockReturnValue(false),
      }),
      sendMessages: vi.fn(),
    };
    const bus = new BulkServiceBus({
      createSender: vi.fn().mockReturnValue(sender),
    } as never);

    await expect(
      bus.publishCatalogCommand({
        messageId: 'large',
        correlationId: 'correlation',
        eventName: 'catalog.bulk.upsert.requested',
        payload: { value: 'x'.repeat(SERVICE_BUS_MAX_MESSAGE_BYTES) },
      }),
    ).rejects.toThrow('SERVICE_BUS_MESSAGE_TOO_LARGE');
    expect(sender.sendMessages).not.toHaveBeenCalled();
  });

  it('completes a result only after durable dispatch returns', async () => {
    let processMessage!: (received: unknown) => Promise<void>;
    const receiver = {
      subscribe: vi.fn(
        (handlers: { processMessage: typeof processMessage }) => {
          processMessage = handlers.processMessage;
          return { close: vi.fn().mockResolvedValue(undefined) };
        },
      ),
      peekMessages: vi.fn().mockResolvedValue([]),
      completeMessage: vi.fn().mockResolvedValue(undefined),
      abandonMessage: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const consumer = {
      consumeServiceBusMessage: vi.fn().mockResolvedValue(undefined),
    };
    const bus = new BulkServiceBus({
      createReceiver: vi.fn().mockReturnValue(receiver),
    } as never);
    const subscription = bus.subscribeCatalogResults(
      consumer as never,
      vi.fn(),
    );
    const message = {
      body: Buffer.from('{}'),
      messageId: 'result-1',
      correlationId: 'correlation-1',
      subject: 'catalog.bulk.upsert.completed',
      contentType: 'application/json',
    };

    await processMessage(message);

    expect(receiver.completeMessage).toHaveBeenCalledWith(message);
    expect(receiver.abandonMessage).not.toHaveBeenCalled();
    expect(consumer.consumeServiceBusMessage).toHaveBeenCalledWith({
      messageId: 'result-1',
      correlationId: 'correlation-1',
      subject: 'catalog.bulk.upsert.completed',
      contentType: 'application/json',
      body: message.body,
    });
    expect(CATALOG_TO_BULK_QUEUE).toBe('g6.bulk.from.catalog');
    await subscription.close();
  });

  it('abandons a result when durable persistence fails', async () => {
    let processMessage!: (received: unknown) => Promise<void>;
    const receiver = {
      subscribe: vi.fn(
        (handlers: { processMessage: typeof processMessage }) => {
          processMessage = handlers.processMessage;
          return { close: vi.fn().mockResolvedValue(undefined) };
        },
      ),
      peekMessages: vi.fn().mockResolvedValue([]),
      completeMessage: vi.fn().mockResolvedValue(undefined),
      abandonMessage: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const bus = new BulkServiceBus({
      createReceiver: vi.fn().mockReturnValue(receiver),
    } as never);
    const subscription = bus.subscribeCatalogResults(
      {
        consumeServiceBusMessage: vi
          .fn()
          .mockRejectedValue(new Error('db down')),
      } as never,
      vi.fn(),
    );
    const message = {
      body: Buffer.from('{}'),
      messageId: 'result-1',
      correlationId: 'correlation-1',
      subject: 'catalog.bulk.upsert.completed',
      contentType: 'application/json',
    };

    await processMessage(message);

    expect(receiver.abandonMessage).toHaveBeenCalledWith(message);
    expect(receiver.completeMessage).not.toHaveBeenCalled();
    await subscription.close();
  });

  it('does not create a second H5 runtime when RabbitMQ is selected', () => {
    expect(
      createBulkServiceBus({ MESSAGING_PROVIDER: 'RABBITMQ' }),
    ).toBeUndefined();
    expect(() =>
      createBulkServiceBus({
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        BULK_AMQP_ENABLED: 'true',
        SERVICE_BUS_NAMESPACE_FQDN: 'g6-dev.servicebus.windows.net',
      }),
    ).toThrow('Bulk no permite AMQP y Service Bus en el mismo proceso.');
  });
});
