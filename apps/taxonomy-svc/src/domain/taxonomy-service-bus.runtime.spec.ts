import { randomUUID } from 'node:crypto';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';
import {
  TaxonomyServiceBusRuntime,
  TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES,
  publishTaxonomyDelivery,
  receiveTaxonomyDelivery,
} from './taxonomy-service-bus.runtime.js';
import { TaxonomyMessageIdentityConflict } from '../persistence/taxonomy-message.store.js';
import {
  catalogTaxonomyQueue,
  readTaxonomyServiceBus,
  taxonomyCatalogQueue,
} from '../config/service-bus.js';

vi.mock('@azure/service-bus', () => ({ ServiceBusClient: vi.fn() }));

describe('Taxonomy H5 feature flags', () => {
  const base = {
    MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
    TAXONOMY_SERVICE_BUS_ENABLED: 'true',
    SERVICE_BUS_NAMESPACE_FQDN: 'g6-taxonomy-local.servicebus.windows.net',
  };
  it('keeps both directions off by default and allows each direction to be disabled independently', () => {
    expect(readTaxonomyServiceBus({})).toBeUndefined();
    expect(readTaxonomyServiceBus(base)).toMatchObject({
      enabled: false,
      sendEnabled: false,
      receiveEnabled: false,
    });
    expect(
      readTaxonomyServiceBus({
        ...base,
        TAXONOMY_SERVICE_BUS_RECEIVE_ENABLED: 'true',
      }),
    ).toMatchObject({ sendEnabled: false, receiveEnabled: true });
    expect(
      readTaxonomyServiceBus({
        ...base,
        TAXONOMY_SERVICE_BUS_SEND_ENABLED: 'true',
      }),
    ).toMatchObject({ sendEnabled: true, receiveEnabled: false });
    expect(
      readTaxonomyServiceBus({
        ...base,
        TAXONOMY_SERVICE_BUS_ENABLED: 'false',
      }),
    ).toMatchObject({
      enabled: false,
      sendEnabled: false,
      receiveEnabled: false,
    });
    expect(() =>
      readTaxonomyServiceBus({
        ...base,
        TAXONOMY_SERVICE_BUS_ENABLED: 'false',
        TAXONOMY_SERVICE_BUS_SEND_ENABLED: 'true',
      }),
    ).toThrow('TAXONOMY_SERVICE_BUS_CONFIGURATION_INVALID');
    expect(() =>
      readTaxonomyServiceBus({
        ...base,
        TAXONOMY_SERVICE_BUS_SEND_ENABLED: 'true',
        RABBITMQ_URL: 'amqp://localhost',
      }),
    ).toThrow('TAXONOMY_SERVICE_BUS_CONFIGURATION_INVALID');
  });
});

describe('Taxonomy R09 settlement', () => {
  function fixture() {
    const body = {
      message_id: randomUUID(),
      correlation_id: randomUUID(),
      operation_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      producer: 'catalog-svc',
      kind: 'result',
      name: 'catalog.master.deactivation.checked',
      data: {
        entity_type: 'BRAND',
        entity_id: randomUUID(),
        version: 1,
        result: 'IN_USE',
      },
    };
    const message = {
      body: Buffer.from(JSON.stringify(body)),
      contentType: 'application/json',
      messageId: body.message_id,
      correlationId: body.correlation_id,
      subject: body.name,
    } as ServiceBusReceivedMessage;
    const receiver = {
      completeMessage: vi.fn(),
      abandonMessage: vi.fn(),
      deadLetterMessage: vi.fn(),
    };
    return { message, receiver };
  }

  it('sends a conflicting message identity to DLQ without completing or retrying it', async () => {
    const { message, receiver } = fixture();
    const consumir = vi
      .fn()
      .mockRejectedValue(new TaxonomyMessageIdentityConflict());
    expect(await receiveTaxonomyDelivery({ consumir }, receiver, message)).toBe(
      true,
    );
    expect(receiver.deadLetterMessage).toHaveBeenCalledWith(
      message,
      expect.objectContaining({
        deadLetterReason: 'TAXONOMY_MESSAGE_ID_CONFLICT',
      }),
    );
    expect(receiver.completeMessage).not.toHaveBeenCalled();
    expect(receiver.abandonMessage).not.toHaveBeenCalled();
  });

  it('abandons transient database failures without moving the message to DLQ', async () => {
    const { message, receiver } = fixture();
    const consumir = vi
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    expect(await receiveTaxonomyDelivery({ consumir }, receiver, message)).toBe(
      false,
    );
    expect(receiver.abandonMessage).toHaveBeenCalledWith(message);
    expect(receiver.deadLetterMessage).not.toHaveBeenCalled();
    expect(receiver.completeMessage).not.toHaveBeenCalled();
  });

  it.each([
    'messageId',
    'correlationId',
    'subject',
    'contentType',
    'oversize',
    'invalidJson',
    'producer',
    'operationId',
  ] as const)(
    'rejects invalid %s before invoking the handler',
    async (invalid) => {
      const { message, receiver } = fixture();
      const altered = { ...message };
      if (invalid === 'messageId') altered.messageId = randomUUID();
      if (invalid === 'correlationId') altered.correlationId = randomUUID();
      if (invalid === 'subject') altered.subject = 'wrong.event';
      if (invalid === 'contentType') altered.contentType = 'text/plain';
      if (invalid === 'oversize')
        altered.body = Buffer.alloc(TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES + 1);
      if (invalid === 'invalidJson') altered.body = Buffer.from('{invalid');
      if (invalid === 'producer' || invalid === 'operationId') {
        const body = JSON.parse(
          Buffer.from(message.body).toString('utf8'),
        ) as Record<string, unknown>;
        if (invalid === 'producer') body.producer = 'otro-servicio';
        else body.operation_id = 'no-es-uuid';
        altered.body = Buffer.from(JSON.stringify(body));
      }
      const consumir = vi.fn();
      expect(
        await receiveTaxonomyDelivery({ consumir }, receiver, altered),
      ).toBe(true);
      expect(consumir).not.toHaveBeenCalled();
      expect(receiver.deadLetterMessage).toHaveBeenCalledOnce();
      expect(receiver.completeMessage).not.toHaveBeenCalled();
      expect(receiver.abandonMessage).not.toHaveBeenCalled();
    },
  );
});

it('limits the encoded batch below 256 KiB and never sends a rejected message', async () => {
  const id = randomUUID();
  const correlation = randomUUID();
  const claim = {
    messageId: id,
    token: randomUUID(),
    row: {
      message_id: id,
      correlation_id: correlation,
      event_name: 'taxonomy.category.updated',
      payload: {
        message_id: id,
        correlation_id: correlation,
        name: 'taxonomy.category.updated',
        kind: 'event',
        producer: 'taxonomy-svc',
        schema_version: 1,
        data: {},
      },
    },
  };
  const store = {
    claimServiceBusDelivery: vi.fn().mockResolvedValue(claim),
    finishServiceBusDelivery: vi.fn().mockResolvedValue(true),
  };
  const sender = {
    createMessageBatch: vi
      .fn()
      .mockResolvedValue({ tryAddMessage: () => false }),
    sendMessages: vi.fn(),
  };
  expect(await publishTaxonomyDelivery(store, sender)).toBe(false);
  expect(sender.createMessageBatch).toHaveBeenCalledWith(
    expect.objectContaining({
      maxSizeInBytes: TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES,
    }),
  );
  expect(store.finishServiceBusDelivery).toHaveBeenCalledWith(
    claim,
    'terminal',
  );
  expect(sender.sendMessages).not.toHaveBeenCalled();
});

it('retries an ambiguous send timeout using the same MessageId', async () => {
  const id = randomUUID();
  const correlation = randomUUID();
  const claim = {
    messageId: id,
    token: randomUUID(),
    row: {
      message_id: id,
      correlation_id: correlation,
      event_name: 'taxonomy.category.updated',
      payload: {
        message_id: id,
        correlation_id: correlation,
        name: 'taxonomy.category.updated',
        kind: 'event',
        producer: 'taxonomy-svc',
        schema_version: 1,
        data: {},
      },
    },
  };
  const store = {
    claimServiceBusDelivery: vi.fn().mockResolvedValue(claim),
    finishServiceBusDelivery: vi.fn().mockResolvedValue(true),
  };
  const tryAddMessage = vi.fn().mockReturnValue(true);
  const sender = {
    createMessageBatch: vi.fn().mockResolvedValue({ tryAddMessage }),
    sendMessages: vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined),
  };
  expect(await publishTaxonomyDelivery(store, sender)).toBe(false);
  expect(store.finishServiceBusDelivery).toHaveBeenNthCalledWith(
    1,
    claim,
    'pending',
  );
  expect(await publishTaxonomyDelivery(store, sender)).toBe(true);
  expect(store.finishServiceBusDelivery).toHaveBeenNthCalledWith(
    2,
    claim,
    'sent',
  );
  expect(tryAddMessage).toHaveBeenCalledTimes(2);
  expect(tryAddMessage.mock.calls[0][0].messageId).toBe(id);
  expect(tryAddMessage.mock.calls[1][0].messageId).toBe(id);
});

describe('Taxonomy H5 transport readiness', () => {
  let runtime: TaxonomyServiceBusRuntime | undefined;

  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('does not require Service Bus readiness when both directions are disabled', () => {
    const config = readTaxonomyServiceBus({
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      TAXONOMY_SERVICE_BUS_ENABLED: 'true',
      SERVICE_BUS_NAMESPACE_FQDN: 'g6-taxonomy-local.servicebus.windows.net',
    });
    if (!config) throw new Error('CONFIG_REQUIRED');
    const verifyServiceBusStorage = vi.fn();
    runtime = new TaxonomyServiceBusRuntime(config, {
      verifyServiceBusStorage,
      claimServiceBusDelivery: vi.fn(),
      finishServiceBusDelivery: vi.fn(),
      consumir: vi.fn(),
    });
    runtime.start();
    expect(runtime.available).toBe(true);
    expect(vi.mocked(ServiceBusClient)).not.toHaveBeenCalled();
    expect(verifyServiceBusStorage).not.toHaveBeenCalled();
  });

  it('accepts an absent namespace only while both directions are disabled', () => {
    const env = {
      MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
      TAXONOMY_SERVICE_BUS_ENABLED: 'true',
    };
    expect(readTaxonomyServiceBus(env)).toMatchObject({ enabled: false });
    expect(() =>
      readTaxonomyServiceBus({
        ...env,
        TAXONOMY_SERVICE_BUS_SEND_ENABLED: 'true',
      }),
    ).toThrow('TAXONOMY_SERVICE_BUS_CONFIGURATION_INVALID');
    expect(() =>
      readTaxonomyServiceBus({
        ...env,
        TAXONOMY_SERVICE_BUS_RECEIVE_ENABLED: 'true',
      }),
    ).toThrow('TAXONOMY_SERVICE_BUS_CONFIGURATION_INVALID');
  });

  it.each([
    { sendEnabled: true, receiveEnabled: false },
    { sendEnabled: false, receiveEnabled: true },
  ])('starts only the enabled direction: %j', async (flags) => {
    const close = vi.fn().mockResolvedValue(undefined);
    const createReceiver = vi.fn().mockReturnValue({
      peekMessages: vi.fn().mockResolvedValue([]),
      subscribe: vi.fn().mockReturnValue({ close }),
      close,
    });
    const createSender = vi.fn().mockReturnValue({
      createMessageBatch: vi.fn().mockResolvedValue({}),
      close,
    });
    vi.mocked(ServiceBusClient).mockImplementation(function () {
      return {
        createReceiver,
        createSender,
        close,
      } as unknown as ServiceBusClient;
    });
    runtime = new TaxonomyServiceBusRuntime(
      {
        namespace: 'g6-taxonomy-local.servicebus.windows.net',
        clientId: undefined,
        enabled: true,
        ...flags,
      },
      {
        verifyServiceBusStorage: vi.fn().mockResolvedValue(undefined),
        claimServiceBusDelivery: vi.fn().mockResolvedValue(undefined),
        finishServiceBusDelivery: vi.fn(),
        consumir: vi.fn(),
      },
    );
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(createSender).toHaveBeenCalledTimes(flags.sendEnabled ? 1 : 0);
    expect(createReceiver).toHaveBeenCalledTimes(flags.receiveEnabled ? 1 : 0);
    expect(runtime.available).toBe(true);
    expect(runtime.storageAvailable).toBe(true);
    expect(runtime.brokerAvailable).toBe(true);
    expect(TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES).toBeLessThan(256 * 1024);
  });

  it('checks storage and both links while idle and recovers in the same process', async () => {
    const namespace = 'g6-taxonomy-local.servicebus.windows.net';
    const verifyServiceBusStorage = vi.fn().mockResolvedValue(undefined);
    const claimServiceBusDelivery = vi.fn().mockResolvedValue(undefined);
    const peekMessages = vi.fn().mockResolvedValue([]);
    const createMessageBatch = vi.fn().mockResolvedValue({});
    const close = vi.fn().mockResolvedValue(undefined);
    const subscribe = vi.fn(
      (_handlers: { processError: () => Promise<void> }) => ({ close }),
    );
    const createReceiver = vi
      .fn()
      .mockReturnValue({ peekMessages, subscribe, close });
    const createSender = vi.fn().mockReturnValue({ createMessageBatch, close });
    vi.mocked(ServiceBusClient).mockImplementation(function () {
      return {
        createReceiver,
        createSender,
        close,
      } as unknown as ServiceBusClient;
    });
    runtime = new TaxonomyServiceBusRuntime(
      {
        namespace,
        enabled: true,
        sendEnabled: true,
        receiveEnabled: true,
        clientId: '12345678-abcd-4321-9876-abcdef123456',
      },
      {
        verifyServiceBusStorage,
        claimServiceBusDelivery,
        finishServiceBusDelivery: vi.fn(),
        consumir: vi.fn(),
      },
    );
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.available).toBe(true);
    expect(createReceiver).toHaveBeenCalledWith(
      catalogTaxonomyQueue,
      expect.anything(),
    );
    expect(createSender).toHaveBeenCalledWith(taxonomyCatalogQueue);
    expect(createMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        maxSizeInBytes: TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES,
      }),
    );

    verifyServiceBusStorage.mockRejectedValueOnce(new Error('storage offline'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(false);
    expect(runtime.storageAvailable).toBe(false);
    expect(runtime.brokerAvailable).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(true);

    claimServiceBusDelivery.mockRejectedValueOnce(
      new Error('database unavailable during claim'),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(false);
    expect(runtime.storageAvailable).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(true);

    createMessageBatch.mockRejectedValueOnce(new Error('sender offline'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(false);
    expect(runtime.storageAvailable).toBe(true);
    expect(runtime.brokerAvailable).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(true);

    peekMessages.mockRejectedValueOnce(new Error('receiver forbidden'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(false);
    expect(runtime.storageAvailable).toBe(true);
    expect(runtime.brokerAvailable).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(true);

    peekMessages.mockImplementationOnce(async () => {
      await subscribe.mock.calls[0][0].processError();
      return [];
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.available).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
