import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';
import type { CatalogBulkResultConsumer } from './catalog-bulk-result-consumer.js';

export const BULK_TO_CATALOG_QUEUE = 'g6.catalog.from.bulk';
export const CATALOG_TO_BULK_QUEUE = 'g6.bulk.from.catalog';
export const BULK_TO_PRICING_QUEUE = 'g6.pricing.from.bulk';
export const PRICING_TO_BULK_QUEUE = 'g6.bulk.from.pricing';
export const BULK_TO_INVENTORY_QUEUE = 'g6.inventory.from.bulk';
export const INVENTORY_TO_BULK_QUEUE = 'g6.bulk.from.inventory';
export const SERVICE_BUS_MAX_MESSAGE_BYTES = 256 * 1024;

export function bulkCommandQueueForEvent(eventName: string): string {
  if (eventName === 'pricing.bulk.price.apply.requested')
    return BULK_TO_PRICING_QUEUE;
  if (eventName === 'inventory.bulk.stock.adjust.requested')
    return BULK_TO_INVENTORY_QUEUE;
  return BULK_TO_CATALOG_QUEUE;
}

type ServiceBusClientLike = Pick<
  ServiceBusClient,
  'createSender' | 'createReceiver' | 'close'
>;

function decodeEnvelopeBody(body: unknown): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return undefined;
}

export class BulkServiceBus {
  constructor(private readonly client: ServiceBusClientLike) {}

  async publishCommand(
    queue: string,
    input: {
      messageId: string;
      correlationId: string;
      eventName: string;
      payload: Record<string, unknown>;
    },
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const sender = this.client.createSender(queue);
    const batch = await sender.createMessageBatch({
      maxSizeInBytes: SERVICE_BUS_MAX_MESSAGE_BYTES,
      abortSignal,
    });
    const added = batch.tryAddMessage({
      body: Buffer.from(JSON.stringify(input.payload), 'utf8'),
      contentType: 'application/json',
      messageId: input.messageId,
      correlationId: input.correlationId,
      subject: input.eventName,
    });
    if (!added) throw new Error('SERVICE_BUS_MESSAGE_TOO_LARGE');
    await sender.sendMessages(batch, { abortSignal });
  }

  publishCatalogCommand(
    input: {
      messageId: string;
      correlationId: string;
      eventName: string;
      payload: Record<string, unknown>;
    },
    abortSignal?: AbortSignal,
  ): Promise<void> {
    return this.publishCommand(BULK_TO_CATALOG_QUEUE, input, abortSignal);
  }

  publishPricingCommand(
    input: {
      messageId: string;
      correlationId: string;
      eventName: string;
      payload: Record<string, unknown>;
    },
    abortSignal?: AbortSignal,
  ): Promise<void> {
    return this.publishCommand(BULK_TO_PRICING_QUEUE, input, abortSignal);
  }

  publishInventoryCommand(
    input: {
      messageId: string;
      correlationId: string;
      eventName: string;
      payload: Record<string, unknown>;
    },
    abortSignal?: AbortSignal,
  ): Promise<void> {
    return this.publishCommand(BULK_TO_INVENTORY_QUEUE, input, abortSignal);
  }

  subscribeQueueResults(
    queue: string,
    consumer: Pick<CatalogBulkResultConsumer, 'consumeServiceBusMessage'>,
    reportError: () => void,
  ) {
    const receiver = this.client.createReceiver(queue, {
      receiveMode: 'peekLock',
      skipParsingBodyAsJson: true,
    });
    const subscription = receiver.subscribe(
      {
        processMessage: async (received: ServiceBusReceivedMessage) => {
          const body = decodeEnvelopeBody(received.body);
          try {
            if (!body || body.byteLength > SERVICE_BUS_MAX_MESSAGE_BYTES)
              throw new Error('INVALID_SERVICE_BUS_CATALOG_RESULT');
            if (typeof received.messageId !== 'string' || !received.messageId)
              throw new Error('INVALID_SERVICE_BUS_MESSAGE_ID');
            await consumer.consumeServiceBusMessage({
              messageId: received.messageId,
              correlationId:
                typeof received.correlationId === 'string'
                  ? received.correlationId
                  : undefined,
              subject: received.subject,
              contentType: received.contentType,
              body,
            });
          } catch {
            reportError();
            await receiver.abandonMessage(received);
            return;
          }
          // Catalog Inbox/Outbox persistence completed before settlement.
          await receiver.completeMessage(received);
        },
        processError: async () => reportError(),
      },
      { autoCompleteMessages: false },
    );
    return {
      probe: (abortSignal: AbortSignal) =>
        receiver.peekMessages(1, { abortSignal }),
      close: async () => {
        try {
          await subscription.close();
        } finally {
          await receiver.close();
        }
      },
    };
  }

  subscribeCatalogResults(
    consumer: Pick<CatalogBulkResultConsumer, 'consumeServiceBusMessage'>,
    reportError: () => void,
  ) {
    return this.subscribeQueueResults(
      CATALOG_TO_BULK_QUEUE,
      consumer,
      reportError,
    );
  }

  subscribePricingResults(
    consumer: Pick<CatalogBulkResultConsumer, 'consumeServiceBusMessage'>,
    reportError: () => void,
  ) {
    return this.subscribeQueueResults(
      PRICING_TO_BULK_QUEUE,
      consumer,
      reportError,
    );
  }

  subscribeInventoryResults(
    consumer: Pick<CatalogBulkResultConsumer, 'consumeServiceBusMessage'>,
    reportError: () => void,
  ) {
    return this.subscribeQueueResults(
      INVENTORY_TO_BULK_QUEUE,
      consumer,
      reportError,
    );
  }

  async verifySender(abortSignal: AbortSignal): Promise<void> {
    const sender = this.client.createSender(BULK_TO_CATALOG_QUEUE);
    await sender.createMessageBatch({
      maxSizeInBytes: SERVICE_BUS_MAX_MESSAGE_BYTES,
      abortSignal,
    });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function createIsolatedHttpServiceBusClient(
  baseUrl: string,
): ServiceBusClientLike {
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname)
  ) {
    throw new Error('G6_ISOLATED_SERVICE_BUS_URL debe ser HTTP loopback.');
  }
  const origin = parsed.origin;
  const timers = new Set<ReturnType<typeof setInterval>>();
  return {
    createSender(queue: string) {
      return {
        async createMessageBatch() {
          const messages: Array<Record<string, unknown>> = [];
          return {
            tryAddMessage(msg: {
              body: unknown;
              contentType?: string;
              messageId?: string;
              correlationId?: string;
              subject?: string;
            }) {
              const rawBody =
                msg.body instanceof Uint8Array
                  ? Buffer.from(msg.body).toString('utf8')
                  : typeof msg.body === 'string'
                    ? msg.body
                    : JSON.stringify(msg.body);
              messages.push({
                body: rawBody,
                contentType: msg.contentType,
                messageId: msg.messageId,
                correlationId: msg.correlationId,
                subject: msg.subject,
              });
              return true;
            },
            _messages: messages,
          } as never;
        },
        async sendMessages(batch: unknown) {
          const items =
            (batch as { _messages?: Array<Record<string, unknown>> })
              ._messages ?? [];
          for (const item of items) {
            const res = await fetch(
              `${origin}/queues/${encodeURIComponent(queue)}/messages`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(item),
              },
            );
            if (!res.ok) throw new Error(`ISOLATED_BUS_SEND_FAILED_${res.status}`);
          }
        },
      } as never;
    },
    createReceiver(queue: string) {
      return {
        subscribe(handlers: {
          processMessage: (msg: ServiceBusReceivedMessage) => Promise<void>;
          processError: (args: { error: Error }) => Promise<void>;
        }) {
          let active = true;
          const timer = setInterval(async () => {
            if (!active) return;
            try {
              const res = await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/receive`,
                { method: 'POST' },
              );
              if (res.status === 204) return;
              if (!res.ok) return;
              const msg = (await res.json()) as {
                deliveryId: string;
                body: string;
                contentType?: string;
                messageId?: string;
                correlationId?: string;
                subject?: string;
                deliveryCount?: number;
              };
              await handlers.processMessage({
                body: Buffer.from(msg.body, 'utf8'),
                contentType: msg.contentType,
                messageId: msg.messageId,
                correlationId: msg.correlationId,
                subject: msg.subject,
                deliveryCount: msg.deliveryCount ?? 1,
                _deliveryId: msg.deliveryId,
              } as unknown as ServiceBusReceivedMessage);
            } catch (error) {
              await handlers.processError({
                error: error instanceof Error ? error : new Error(String(error)),
              });
            }
          }, 250);
          timer.unref();
          timers.add(timer);
          return {
            async close() {
              active = false;
              clearInterval(timer);
              timers.delete(timer);
            },
          };
        },
        async peekMessages() {
          const res = await fetch(
            `${origin}/queues/${encodeURIComponent(queue)}/peek`,
          );
          if (!res.ok) throw new Error(`ISOLATED_BUS_PEEK_FAILED_${res.status}`);
          return (await res.json()) as ServiceBusReceivedMessage[];
        },
        async completeMessage(message: ServiceBusReceivedMessage) {
          const deliveryId = (message as unknown as { _deliveryId?: string })
            ._deliveryId;
          if (!deliveryId) return;
          await fetch(
            `${origin}/queues/${encodeURIComponent(queue)}/complete/${encodeURIComponent(deliveryId)}`,
            { method: 'POST' },
          );
        },
        async abandonMessage(message: ServiceBusReceivedMessage) {
          const deliveryId = (message as unknown as { _deliveryId?: string })
            ._deliveryId;
          if (!deliveryId) return;
          await fetch(
            `${origin}/queues/${encodeURIComponent(queue)}/abandon/${encodeURIComponent(deliveryId)}`,
            { method: 'POST' },
          );
        },
        async deadLetterMessage(
          message: ServiceBusReceivedMessage,
          options?: { deadLetterReason?: string; deadLetterErrorDescription?: string },
        ) {
          const deliveryId = (message as unknown as { _deliveryId?: string })
            ._deliveryId;
          if (!deliveryId) return;
          await fetch(
            `${origin}/queues/${encodeURIComponent(queue)}/deadletter/${encodeURIComponent(deliveryId)}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(options ?? {}),
            },
          );
        },
        async close() {
          for (const t of timers) clearInterval(t);
          timers.clear();
        },
      } as never;
    },
    async close() {
      for (const t of timers) clearInterval(t);
      timers.clear();
    },
  };
}

export function createBulkServiceBus(
  env: NodeJS.ProcessEnv,
): BulkServiceBus | undefined {
  const provider = env.MESSAGING_PROVIDER ?? 'RABBITMQ';
  if (provider === 'RABBITMQ') return undefined;
  if (provider !== 'AZURE_SERVICE_BUS')
    throw new Error(
      'MESSAGING_PROVIDER debe ser RABBITMQ o AZURE_SERVICE_BUS.',
    );
  if (env.BULK_AMQP_ENABLED === 'true')
    throw new Error('Bulk no permite AMQP y Service Bus en el mismo proceso.');

  if (env.NODE_ENV === 'test' && env.G6_ISOLATED_SERVICE_BUS_URL) {
    return new BulkServiceBus(
      createIsolatedHttpServiceBusClient(env.G6_ISOLATED_SERVICE_BUS_URL),
    );
  }

  const clientId = env.AZURE_CLIENT_ID;
  const validIdentity =
    clientId &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId) &&
    clientId !== '00000000-0000-0000-0000-000000000000';
  if (
    (clientId !== undefined && !validIdentity) ||
    (env.NODE_ENV === 'production' &&
      (!validIdentity ||
        env.G6_SECURITY_MODE !== 'G7_AUTHENTICATED' ||
        env.G6_SERVICE_BUS_PRODUCTION_ENABLED !== 'true'))
  )
    throw new Error(
      'H5 en producción requiere habilitación, G7 e identidad administrada asignada.',
    );

  const namespace = env.SERVICE_BUS_NAMESPACE_FQDN;
  if (
    !namespace ||
    !/^[a-z][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$/i.test(namespace)
  )
    throw new Error('SERVICE_BUS_NAMESPACE_FQDN inválido.');
  const client = new ServiceBusClient(
    namespace,
    clientId
      ? new ManagedIdentityCredential({ clientId })
      : new ManagedIdentityCredential(),
    { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
  );
  return new BulkServiceBus(client);
}
