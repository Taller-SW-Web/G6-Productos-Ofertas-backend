import { ManagedIdentityCredential } from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from '@azure/service-bus';
import {
  assertCatalogPublication,
  InvalidCatalogMessage,
  parseCatalogMessage,
  type CatalogEnvelope,
} from './catalog-messages.js';
import type { CatalogMessageService } from './catalog-message.service.js';
import {
  readCatalogH5Destinations,
  readCatalogMessagingProvider,
} from './catalog-messaging.config.js';

export const catalogDestinations = {
  'pricing.product.initialization.requested': ['g6.pricing.from.catalog'],
  'inventory.sku.initialization.requested': ['g6.inventory.from.catalog'],
  'catalog.product.deactivated': [
    'g6.promotions.from.catalog',
    'g6.combos.from.catalog',
  ],
  'catalog.sku.deactivated': [
    'g6.inventory.from.catalog',
    'g6.pricing.from.catalog',
    'g6.promotions.from.catalog',
    'g6.combos.from.catalog',
  ],
  'catalog.master.deactivation.checked': ['g6.taxonomy.from.catalog'],
  'catalog.bulk.upsert.completed': ['g6.bulk.from.catalog'],
  'catalog.bulk.upsert.rejected': ['g6.bulk.from.catalog'],
} as const;

const producerByQueue = {
  'g6.catalog.from.taxonomy': 'taxonomy-svc',
  'g6.catalog.from.bulk': 'bulk-svc',
  'g6.catalog.from.pricing': 'pricing-svc',
  'g6.catalog.from.inventory': 'inventory-svc',
} as const;

type IncomingQueue = keyof typeof producerByQueue;
export const catalogIncomingQueues = Object.keys(
  producerByQueue,
) as IncomingQueue[];
export const taxonomyRequestQueue = 'g6.catalog.from.taxonomy';
export const bulkRequestQueue = 'g6.catalog.from.bulk';
export const taxonomyReplyQueue =
  catalogDestinations['catalog.master.deactivation.checked'][0];
const maximumMessageBytes = 256 * 1024;

function decodeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new InvalidCatalogMessage();
  }
}

export function destinationsFor(message: CatalogEnvelope): readonly string[] {
  assertCatalogPublication(message);
  if (!Object.hasOwn(catalogDestinations, message.name))
    throw new InvalidCatalogMessage();
  return catalogDestinations[message.name as keyof typeof catalogDestinations];
}

export class CatalogServiceBus {
  private readonly senders = new Map<
    string,
    ReturnType<ServiceBusClient['createSender']>
  >();

  constructor(
    private readonly client: Pick<
      ServiceBusClient,
      'createSender' | 'createReceiver' | 'close'
    >,
  ) {}

  async publish(
    destination: string,
    envelope: CatalogEnvelope,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (!destinationsFor(envelope).includes(destination))
      throw new InvalidCatalogMessage();
    const sender = this.getSender(destination);
    const message = {
      body: Buffer.from(JSON.stringify(envelope)),
      contentType: 'application/json',
      messageId: envelope.message_id,
      correlationId: envelope.correlation_id,
      subject: envelope.name,
    };
    const batch = await sender.createMessageBatch({
      maxSizeInBytes: maximumMessageBytes,
      abortSignal,
    });
    if (!batch.tryAddMessage(message))
      throw new Error('SERVICE_BUS_MESSAGE_TOO_LARGE');
    await sender.sendMessages(batch, { abortSignal });
  }

  subscribe(
    queue: IncomingQueue,
    service: Pick<CatalogMessageService, 'consume'>,
    reportError: () => void,
  ) {
    return this.subscribeWithProbe(queue, service, reportError).close;
  }

  subscribeWithProbe(
    queue: IncomingQueue,
    service: Pick<CatalogMessageService, 'consume'>,
    reportError: () => void,
  ) {
    if (!Object.hasOwn(producerByQueue, queue))
      throw new InvalidCatalogMessage();
    const receiver = this.client.createReceiver(queue, {
      receiveMode: 'peekLock',
      skipParsingBodyAsJson: true,
    });
    let subscription: ReturnType<typeof receiver.subscribe>;
    try {
      subscription = receiver.subscribe(
        {
          processMessage: async (received: ServiceBusReceivedMessage) => {
            try {
              if (
                received.contentType !== 'application/json' ||
                !(received.body instanceof Uint8Array) ||
                received.body.byteLength > maximumMessageBytes
              )
                throw new InvalidCatalogMessage();
              const envelope = parseCatalogMessage(decodeJson(received.body));
              if (
                envelope.producer !== producerByQueue[queue] ||
                received.messageId !== envelope.message_id ||
                received.correlationId !== envelope.correlation_id ||
                received.subject !== envelope.name
              )
                throw new InvalidCatalogMessage();
              await service.consume(envelope);
            } catch (error) {
              if (
                error instanceof InvalidCatalogMessage ||
                error instanceof SyntaxError
              ) {
                await receiver.deadLetterMessage(received, {
                  deadLetterReason: 'INVALID_CATALOG_MESSAGE',
                  deadLetterErrorDescription:
                    'Envelope or routing metadata failed validation.',
                });
              } else {
                console.error(`[catalog-service-bus] consume error on ${queue}:`, error instanceof Error ? error.stack ?? error.message : String(error));
                reportError();
                await receiver.abandonMessage(received);
              }
              return;
            }
            // A failed settlement after commit is allowed to redeliver to the same Inbox.
            await receiver.completeMessage(received);
          },
          processError: async () => {
            reportError();
          },
        },
        { autoCompleteMessages: false },
      );
    } catch (error) {
      void receiver.close().catch(() => undefined);
      throw error;
    }
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

  private getSender(destination: string) {
    let sender = this.senders.get(destination);
    if (!sender) {
      sender = this.client.createSender(destination);
      this.senders.set(destination, sender);
    }
    return sender;
  }

  async verifySender(
    destination: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    await this.getSender(destination).createMessageBatch({
      maxSizeInBytes: maximumMessageBytes,
      abortSignal,
    });
  }

  close() {
    return this.client.close();
  }
}

/** Separate construction boundary for a dedicated H5 process or test harness. */
function createIsolatedHttpCatalogBusClient(baseUrl: string) {
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
              if (res.status === 204 || !res.ok) return;
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

export function createCatalogServiceBus(
  env: NodeJS.ProcessEnv,
): CatalogServiceBus | undefined {
  const provider = readCatalogMessagingProvider(env);
  if (provider !== 'AZURE_SERVICE_BUS') return undefined;
  readCatalogH5Destinations(env);
  if (
    env.CATALOG_AMQP_ENABLED === 'true' ||
    (env.CATALOG_AMQP_ENABLED !== undefined &&
      env.CATALOG_AMQP_ENABLED !== 'false')
  )
    throw new Error(
      'Proveedor H5 inválido o RabbitMQ habilitado en el mismo proceso.',
    );
  if (env.NODE_ENV === 'test' && env.G6_ISOLATED_SERVICE_BUS_URL) {
    return new CatalogServiceBus(
      createIsolatedHttpCatalogBusClient(env.G6_ISOLATED_SERVICE_BUS_URL) as never,
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
  return new CatalogServiceBus(
    new ServiceBusClient(
      namespace,
      clientId
        ? new ManagedIdentityCredential({ clientId })
        : new ManagedIdentityCredential(),
      { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
    ),
  );
}
