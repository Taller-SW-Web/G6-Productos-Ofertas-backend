import { randomUUID } from 'node:crypto';
import type {
  ProcessErrorArgs,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from '@azure/service-bus';
import {
  CombosServiceBus,
  readCombosServiceBus,
  type CombosEventQueue,
  type ServiceBusClientLike,
} from './combos-service-bus.js';
import { CombosEventConsumer } from './combos-event-consumer.js';
import {
  InboxMessageConflictError,
  type CombosRepository,
} from '../persistence/combos.repository.js';
import { CombosSvcService } from '../combos-svc.service.js';
import { CombosDatabase } from '../persistence/combos.database.js';

function makeSbMessage(
  envelope: Record<string, unknown>,
  overrides: Partial<ServiceBusReceivedMessage> = {},
): ServiceBusReceivedMessage {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');
  return {
    body,
    messageId: String(envelope.message_id ?? 'msg-1'),
    correlationId: String(envelope.correlation_id ?? 'corr-1'),
    subject: String(envelope.name ?? 'catalog.sku.deactivated'),
    contentType: 'application/json',
    deliveryCount: 1,
    applicationProperties: {
      producer: envelope.producer as string,
      schema_version: envelope.schema_version as number,
      route_version: 1,
    },
    ...overrides,
  } as unknown as ServiceBusReceivedMessage;
}

function makeFakeReceiver() {
  let handlers: {
    processMessage: (msg: ServiceBusReceivedMessage) => Promise<void>;
    processError: (args: ProcessErrorArgs) => Promise<void>;
  } | null = null;
  const receiver = {
    isClosed: false,
    peekMessages: vi.fn(async () => []),
    completeMessage: vi.fn(async () => undefined),
    abandonMessage: vi.fn(async () => undefined),
    deadLetterMessage: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      receiver.isClosed = true;
    }),
    subscribe: vi.fn((h) => {
      handlers = h;
      return {
        close: vi.fn(async () => {
          handlers = null;
        }),
      };
    }),
    emitMessage: async (msg: ServiceBusReceivedMessage) => {
      if (!handlers) throw new Error('NOT_SUBSCRIBED');
      await handlers.processMessage(msg);
    },
    emitError: async (error: unknown, errorSource = 'receive') => {
      if (!handlers) throw new Error('NOT_SUBSCRIBED');
      await handlers.processError({
        error: error as Error,
        errorSource: errorSource as ProcessErrorArgs['errorSource'],
        entityPath: 'queue',
        fullyQualifiedNamespace: 'g6-sb.servicebus.windows.net',
      });
    },
  };
  return receiver;
}

describe('readCombosServiceBus (COR-06 / T08)', () => {
  it('returns undefined when H4/disabled without requiring Azure variables', () => {
    expect(readCombosServiceBus({})).toBeUndefined();
    expect(
      readCombosServiceBus({
        MESSAGING_PROVIDER: 'RABBITMQ',
        COMBOS_SERVICE_BUS_EVENTS_ENABLED: 'false',
      }),
    ).toBeUndefined();
  });

  it('returns disabled config when MESSAGING_PROVIDER=AZURE_SERVICE_BUS and flag is false without requiring namespace', () => {
    expect(
      readCombosServiceBus({
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        COMBOS_SERVICE_BUS_EVENTS_ENABLED: 'false',
      }),
    ).toEqual({ provider: 'AZURE_SERVICE_BUS', enabled: false });
  });

  it('fails closed when H5 is enabled with missing or invalid config or RabbitMQ coexistence', () => {
    expect(() =>
      readCombosServiceBus({
        MESSAGING_PROVIDER: 'RABBITMQ',
        COMBOS_SERVICE_BUS_EVENTS_ENABLED: 'true',
      }),
    ).toThrow(/COMBOS_SERVICE_BUS_CONFIGURATION_INVALID/);

    expect(() =>
      readCombosServiceBus({
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        COMBOS_SERVICE_BUS_EVENTS_ENABLED: 'true',
        SERVICE_BUS_NAMESPACE_FQDN: 'invalid.example.com',
      }),
    ).toThrow(/COMBOS_SERVICE_BUS_CONFIGURATION_INVALID/);

    expect(() =>
      readCombosServiceBus({
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        COMBOS_SERVICE_BUS_EVENTS_ENABLED: 'true',
        SERVICE_BUS_NAMESPACE_FQDN: 'g6combosdev.servicebus.windows.net',
        COMBOS_AMQP_ENABLED: 'true',
      }),
    ).toThrow(/COMBOS_SERVICE_BUS_CONFIGURATION_INVALID/);

    expect(() =>
      readCombosServiceBus({
        NODE_ENV: 'production',
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        COMBOS_SERVICE_BUS_EVENTS_ENABLED: 'true',
        SERVICE_BUS_NAMESPACE_FQDN: 'g6combosdev.servicebus.windows.net',
        G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        // Missing AZURE_CLIENT_ID in production
      }),
    ).toThrow(/COMBOS_SERVICE_BUS_CONFIGURATION_INVALID/);
  });

  it('accepts valid production configuration with managed identity', () => {
    const clientId = randomUUID();
    expect(
      readCombosServiceBus({
        NODE_ENV: 'production',
        MESSAGING_PROVIDER: 'AZURE_SERVICE_BUS',
        COMBOS_SERVICE_BUS_EVENTS_ENABLED: 'true',
        SERVICE_BUS_NAMESPACE_FQDN: 'g6combosprod.servicebus.windows.net',
        AZURE_CLIENT_ID: clientId,
        G6_SERVICE_BUS_PRODUCTION_ENABLED: 'true',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      }),
    ).toEqual({
      provider: 'AZURE_SERVICE_BUS',
      enabled: true,
      namespace: 'g6combosprod.servicebus.windows.net',
      clientId,
    });
  });
});

describe('CombosServiceBus runtime (COM-SB-01 / COR-05 / T08 / T11)', () => {
  it('starts two independent peekLock receivers, tracks per-queue readiness, and closes idempotently', async () => {
    const receivers = new Map<CombosEventQueue, ReturnType<typeof makeFakeReceiver>>([
      ['g6.combos.from.catalog', makeFakeReceiver()],
      ['g6.combos.from.inventory', makeFakeReceiver()],
    ]);
    const client: ServiceBusClientLike = {
      createReceiver: vi.fn(
        (queue: string) =>
          receivers.get(queue as CombosEventQueue) as unknown as ServiceBusReceiver,
      ),
      close: vi.fn(async () => undefined),
    };
    const bus = new CombosServiceBus(
      {
        provider: 'AZURE_SERVICE_BUS',
        enabled: true,
        namespace: 'g6combosdev.servicebus.windows.net',
        clientId: randomUUID(),
      },
      async () => undefined,
      { clientFactory: () => client, probeIntervalMs: 60_000 },
    );

    await bus.start();
    // Idempotent second start
    await bus.start();
    expect(client.createReceiver).toHaveBeenCalledTimes(2);
    expect(bus.available).toBe(true);
    expect(bus.getQueueStates()['g6.combos.from.catalog']).toMatchObject({
      phase: 'SUBSCRIBED',
      linkReady: true,
      subscribed: true,
      ready: true,
    });
    expect(bus.getQueueStates()['g6.combos.from.inventory']).toMatchObject({
      phase: 'SUBSCRIBED',
      linkReady: true,
      subscribed: true,
      ready: true,
    });

    // Error on one queue marks overall readiness not_ready without false READY
    await receivers
      .get('g6.combos.from.inventory')!
      .emitError(Object.assign(new Error('UnauthorizedAccess'), { code: 'UnauthorizedAccess' }));
    expect(bus.available).toBe(false);
    expect(bus.getQueueStates()['g6.combos.from.catalog'].ready).toBe(true);
    expect(bus.getQueueStates()['g6.combos.from.inventory']).toMatchObject({
      phase: 'DEGRADED',
      linkReady: false,
      ready: false,
      lastErrorCode: 'UnauthorizedAccess',
    });

    await bus.close();
    await bus.close();
    expect(bus.available).toBe(false);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('recovers a degraded queue without duplicate subscriptions or orphaned receivers (COM-AUD-02)', async () => {
    const created: ReturnType<typeof makeFakeReceiver>[] = [];
    const client: ServiceBusClientLike = {
      createReceiver: vi.fn(() => {
        const rx = makeFakeReceiver();
        created.push(rx);
        return rx as unknown as ServiceBusReceiver;
      }),
      close: vi.fn(async () => undefined),
    };
    const bus = new CombosServiceBus(
      {
        provider: 'AZURE_SERVICE_BUS',
        enabled: true,
        namespace: 'g6combosdev.servicebus.windows.net',
        clientId: randomUUID(),
      },
      async () => undefined,
      { clientFactory: () => client, probeIntervalMs: 20 },
    );

    await bus.start();
    expect(created).toHaveLength(2);
    await created[1]!.emitError(
      Object.assign(new Error('ConnectionLost'), { code: 'ConnectionLost' }),
    );
    expect(bus.available).toBe(false);

    // Wait for probe recovery cycle
    await new Promise((r) => setTimeout(r, 60));
    expect(created[1]!.close).toHaveBeenCalled();
    expect(bus.available).toBe(true);
    expect(bus.getQueueStates()['g6.combos.from.inventory']).toMatchObject({
      phase: 'SUBSCRIBED',
      linkReady: true,
      subscribed: true,
      ready: true,
      lastErrorCode: null,
    });

    await bus.close();
  });

  it('starts in degraded NOT_READY state when RBAC/link fails initially and recovers automatically without restart (COM-AUD-11)', async () => {
    const catalogRx = makeFakeReceiver();
    let inventoryAttempts = 0;
    const client: ServiceBusClientLike = {
      createReceiver: vi.fn((queue: string) => {
        if (queue === 'g6.combos.from.catalog') {
          return catalogRx as unknown as ServiceBusReceiver;
        }
        inventoryAttempts += 1;
        const rx = makeFakeReceiver();
        if (inventoryAttempts === 1) {
          rx.peekMessages.mockRejectedValueOnce(
            Object.assign(new Error('RBAC denied'), {
              code: 'UnauthorizedAccess',
            }),
          );
        }
        return rx as unknown as ServiceBusReceiver;
      }),
      close: vi.fn(async () => undefined),
    };
    const bus = new CombosServiceBus(
      {
        provider: 'AZURE_SERVICE_BUS',
        enabled: true,
        namespace: 'g6combosdev.servicebus.windows.net',
        clientId: randomUUID(),
      },
      async () => undefined,
      { clientFactory: () => client, probeIntervalMs: 20, maxBackoffMs: 40 },
    );

    await bus.start();
    expect(bus.available).toBe(false);
    expect(bus.getQueueStates()['g6.combos.from.catalog'].ready).toBe(true);
    expect(bus.getQueueStates()['g6.combos.from.inventory']).toMatchObject({
      phase: 'DEGRADED',
      linkReady: false,
      subscribed: false,
      ready: false,
      lastErrorCode: 'UnauthorizedAccess',
    });

    // Wait for backoff probe recovery without restarting the service
    await new Promise((r) => setTimeout(r, 80));
    expect(bus.available).toBe(true);
    expect(bus.getQueueStates()['g6.combos.from.inventory']).toMatchObject({
      phase: 'SUBSCRIBED',
      linkReady: true,
      subscribed: true,
      ready: true,
      lastErrorCode: null,
    });

    await bus.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});

describe('CombosEventConsumer Service Bus delivery & settlement (T03 / T06 / T07 / T10)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('accepts non-UUID message_id and correlation_id (COR-02) and completes valid R05/R12 deliveries', async () => {
    const processEvent = vi.fn(async () => 'PROCESSED' as const);
    const consumer = new CombosEventConsumer({
      processEvent,
    } as unknown as CombosRepository);
    const receiver = makeFakeReceiver();

    const skuMsg = makeSbMessage({
      message_id: 'catalog:sku:SKU-1:v2',
      schema_version: 1,
      occurred_at: '2026-11-25T10:00:00Z',
      correlation_id: 'opaque-corr-123',
      causation_id: null,
      operation_id: null,
      producer: 'catalog-svc',
      kind: 'event',
      name: 'catalog.sku.deactivated',
      data: {
        sku: 'SKU-1',
        product_id: 'PROD-1',
        sku_version: 2,
        changed_at: '2026-11-25T10:00:00Z',
      },
    });

    await consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      receiver as unknown as ServiceBusReceiver,
      skuMsg,
    );
    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(receiver.completeMessage).toHaveBeenCalledWith(skuMsg);
    expect(
      consumer.getObservabilitySnapshot().queues['g6.combos.from.catalog']
        .completed,
    ).toBe(1);
  });

  it('dead-letters oversized (>256KB), wrong-queue, invalid JSON, and incompatible applicationProperties messages (T10)', async () => {
    const processEvent = vi.fn(async () => 'PROCESSED' as const);
    const consumer = new CombosEventConsumer({
      processEvent,
    } as unknown as CombosRepository);
    const receiver = makeFakeReceiver();

    // 1. Wrong queue (inventory event on catalog queue)
    const wrongQueueMsg = makeSbMessage({
      message_id: 'inv-1',
      schema_version: 2,
      occurred_at: '2026-11-25T10:00:00Z',
      correlation_id: 'corr-1',
      producer: 'inventory-svc',
      kind: 'event',
      name: 'inventory.stock.changed',
      data: {
        sku: 'SKU-1',
        location_id: randomUUID(),
        on_hand: 5,
        reserved: 0,
        blocked: 0,
        available: 5,
        estado: 'DISPONIBLE',
        stock_version: 1,
        updated_at: '2026-11-25T10:00:00Z',
      },
    });
    await consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      receiver as unknown as ServiceBusReceiver,
      wrongQueueMsg,
    );
    expect(receiver.deadLetterMessage).toHaveBeenLastCalledWith(
      wrongQueueMsg,
      expect.objectContaining({ deadLetterReason: 'EVENT_NOT_ALLOWED_FOR_QUEUE' }),
    );

    // 2. Oversized > 256 KB
    const oversizedMsg = makeSbMessage(
      {
        message_id: 'big-1',
        schema_version: 1,
        occurred_at: '2026-11-25T10:00:00Z',
        correlation_id: 'corr-1',
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku: 'SKU-1',
          product_id: 'PROD-1',
          sku_version: 1,
          changed_at: '2026-11-25T10:00:00Z',
        },
      },
      { body: Buffer.alloc(256 * 1024 + 1, 'a') },
    );
    await consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      receiver as unknown as ServiceBusReceiver,
      oversizedMsg,
    );
    expect(receiver.deadLetterMessage).toHaveBeenLastCalledWith(
      oversizedMsg,
      expect.objectContaining({ deadLetterReason: 'MESSAGE_TOO_LARGE' }),
    );

    // 3. Incompatible applicationProperties
    const badPropsMsg = makeSbMessage(
      {
        message_id: 'props-1',
        schema_version: 1,
        occurred_at: '2026-11-25T10:00:00Z',
        correlation_id: 'corr-1',
        producer: 'catalog-svc',
        kind: 'event',
        name: 'catalog.sku.deactivated',
        data: {
          sku: 'SKU-1',
          product_id: 'PROD-1',
          sku_version: 1,
          changed_at: '2026-11-25T10:00:00Z',
        },
      },
      { applicationProperties: { producer: 'other-svc' } },
    );
    await consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      receiver as unknown as ServiceBusReceiver,
      badPropsMsg,
    );
    expect(receiver.deadLetterMessage).toHaveBeenLastCalledWith(
      badPropsMsg,
      expect.objectContaining({
        deadLetterReason: 'INCOMPATIBLE_APPLICATION_PROPERTIES',
      }),
    );
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('dead-letters InboxMessageConflictError and completes duplicate without second effect (T06)', async () => {
    const processEvent = vi
      .fn()
      .mockResolvedValueOnce('DUPLICATE')
      .mockRejectedValueOnce(new InboxMessageConflictError());
    const consumer = new CombosEventConsumer({
      processEvent,
    } as unknown as CombosRepository);
    const receiver = makeFakeReceiver();
    const msg = makeSbMessage({
      message_id: 'dup-1',
      schema_version: 1,
      occurred_at: '2026-11-25T10:00:00Z',
      correlation_id: 'corr-1',
      producer: 'catalog-svc',
      kind: 'event',
      name: 'catalog.sku.deactivated',
      data: {
        sku: 'SKU-1',
        product_id: 'PROD-1',
        sku_version: 1,
        changed_at: '2026-11-25T10:00:00Z',
      },
    });

    await consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      receiver as unknown as ServiceBusReceiver,
      msg,
    );
    expect(receiver.completeMessage).toHaveBeenCalledTimes(1);
    expect(
      consumer.getObservabilitySnapshot().queues['g6.combos.from.catalog']
        .duplicateInbox,
    ).toBe(1);

    await consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      receiver as unknown as ServiceBusReceiver,
      msg,
    );
    expect(receiver.deadLetterMessage).toHaveBeenCalledWith(
      msg,
      expect.objectContaining({
        deadLetterReason: 'COMBOS_MESSAGE_ID_CONFLICT',
      }),
    );
    expect(
      consumer.getObservabilitySnapshot().queues['g6.combos.from.catalog']
        .identityConflict,
    ).toBe(1);
  });

  it('abandons catalog.product.deactivated conservatively on Catalog 404/401/503 without swallowing SKU_NO_ENCONTRADO (COM-SB-04 / T03)', async () => {
    process.env.COMBOS_CATALOG_URL = 'https://catalog.internal.svc';
    process.env.NODE_ENV = 'test';
    process.env.COMBOS_TEST_EPHEMERAL = '1';
    process.env.COMBOS_CATALOG_SERVICE_BEARER = 'test-token';

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'SKU_NO_ENCONTRADO' }), {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    const processEvent = vi.fn(
      async (input: { resolveProductSkus?: (skus: string[]) => Promise<string[]> }) => {
        if (input.resolveProductSkus) {
          await input.resolveProductSkus(['SKU-1']);
        }
        return 'PROCESSED' as const;
      },
    );
    const consumer = new CombosEventConsumer({
      processEvent,
    } as unknown as CombosRepository);
    const receiver = makeFakeReceiver();
    const msg = makeSbMessage({
      message_id: 'prod-1',
      schema_version: 1,
      occurred_at: '2026-11-25T10:00:00Z',
      correlation_id: randomUUID(),
      producer: 'catalog-svc',
      kind: 'event',
      name: 'catalog.product.deactivated',
      data: {
        product_id: 'PROD-1',
        product_version: 1,
        changed_at: '2026-11-25T10:00:00Z',
      },
    });

    // 404 SKU_NO_ENCONTRADO must NOT completeMessage
    await consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      receiver as unknown as ServiceBusReceiver,
      msg,
    );
    expect(receiver.abandonMessage).toHaveBeenCalledTimes(1);
    expect(receiver.completeMessage).not.toHaveBeenCalled();

    // 403 SERVICE_AUTHORIZATION_FAILED must set catalogAuthBlocked and abandon
    await consumer.processServiceBusDelivery(
      'g6.combos.from.catalog',
      receiver as unknown as ServiceBusReceiver,
      msg,
    );
    expect(receiver.abandonMessage).toHaveBeenCalledTimes(2);
    expect(consumer.getObservabilitySnapshot().catalogResolution).toMatchObject({
      authBlocked: true,
      lastErrorReason: 'SERVICE_AUTHORIZATION_FAILED',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('propagates settlement errors instead of swallowing completeMessage failures (T07)', async () => {
    const processEvent = vi.fn(async () => 'PROCESSED' as const);
    const consumer = new CombosEventConsumer({
      processEvent,
    } as unknown as CombosRepository);
    const receiver = makeFakeReceiver();
    receiver.completeMessage.mockRejectedValueOnce(new Error('LOCK_LOST'));
    const msg = makeSbMessage({
      message_id: 'ack-lost-1',
      schema_version: 1,
      occurred_at: '2026-11-25T10:00:00Z',
      correlation_id: 'corr-1',
      producer: 'catalog-svc',
      kind: 'event',
      name: 'catalog.sku.deactivated',
      data: {
        sku: 'SKU-1',
        product_id: 'PROD-1',
        sku_version: 1,
        changed_at: '2026-11-25T10:00:00Z',
      },
    });

    await expect(
      consumer.processServiceBusDelivery(
        'g6.combos.from.catalog',
        receiver as unknown as ServiceBusReceiver,
        msg,
      ),
    ).rejects.toThrow('LOCK_LOST');
    expect(
      consumer.getObservabilitySnapshot().queues['g6.combos.from.catalog']
        .settlementFailures,
    ).toBe(1);
  });
});

describe('CombosSvcService.readiness (COR-05 / COM-AUD-07)', () => {
  it('reports service_bus, postgres_permissions, and per-queue status in H5 mode without false ready', async () => {
    const db = {
      readyDetailed: vi.fn(async () => ({
        available: true,
        permissionsOk: true,
      })),
      ready: vi.fn(async () => true),
    } as unknown as CombosDatabase;
    const service = new CombosSvcService(
      db,
      {} as CombosRepository,
    );

    const notReady = await service.readiness({
      transport: 'AZURE_SERVICE_BUS',
      status: 'not_ready',
      queues: {
        'g6.combos.from.catalog': {
          queue: 'g6.combos.from.catalog',
          phase: 'SUBSCRIBED',
          linkReady: true,
          subscribed: true,
          ready: true,
          lastErrorCode: null,
          lastCheckedAt: null,
        },
        'g6.combos.from.inventory': {
          queue: 'g6.combos.from.inventory',
          phase: 'DEGRADED',
          linkReady: false,
          subscribed: false,
          ready: false,
          lastErrorCode: 'UnauthorizedAccess',
          lastCheckedAt: null,
        },
      },
    });
    expect(notReady).toEqual({
      status: 'error',
      service: 'combos-svc',
      transport: 'AZURE_SERVICE_BUS',
      dependencies: {
        postgres: 'ok',
        postgres_permissions: 'ok',
        service_bus: 'error',
      },
      queues: {
        'g6.combos.from.catalog': {
          status: 'ok',
          link_ready: true,
          subscribed: true,
          last_error_code: null,
        },
        'g6.combos.from.inventory': {
          status: 'error',
          link_ready: false,
          subscribed: false,
          last_error_code: 'UnauthorizedAccess',
        },
      },
    });

    (db.readyDetailed as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      available: true,
      permissionsOk: false,
    });
    const missingPerms = await service.readiness({
      transport: 'AZURE_SERVICE_BUS',
      status: 'ready',
    });
    expect(missingPerms).toEqual({
      status: 'error',
      service: 'combos-svc',
      transport: 'AZURE_SERVICE_BUS',
      dependencies: {
        postgres: 'ok',
        postgres_permissions: 'error',
        service_bus: 'ok',
      },
    });
  });

  it('requires every individual PostgreSQL privilege via CombosDatabase.readyDetailed (COM-AUD-10)', async () => {
    const db = new CombosDatabase();
    const queries: string[] = [];
    vi.spyOn(db, 'query').mockImplementation(async (fn) => {
      const client = {
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          return { rows: [{ ok: false }] };
        }),
      } as unknown as import('pg').PoolClient;
      return fn(client);
    });

    await expect(db.readyDetailed()).resolves.toEqual({
      available: true,
      permissionsOk: false,
    });
    await expect(db.ready()).resolves.toBe(false);
    const privQuery = queries.find((q) => q.includes('has_table_privilege')) ?? '';
    expect(privQuery).toContain("has_schema_privilege(current_user, 'combos', 'USAGE')");
    expect(privQuery).toContain("has_table_privilege(current_user, 'combos.component_projection', 'INSERT')");
    expect(privQuery).toContain("has_table_privilege(current_user, 'combos.component_projection', 'UPDATE')");
    expect(privQuery).toContain("has_table_privilege(current_user, 'combos.inbox', 'INSERT')");
  });
});
