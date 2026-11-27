import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceiver,
  type ServiceBusReceivedMessage,
  type ServiceBusSender,
} from '@azure/service-bus';
import {
  catalogTaxonomyQueue,
  taxonomyCatalogQueue,
  taxonomyServiceBusEvents,
  type readTaxonomyServiceBus,
} from '../config/service-bus.js';
import {
  parseChecked,
  TaxonomyMessageIdentityConflict,
  type TaxonomyMessageStore,
} from '../persistence/taxonomy-message.store.js';

type Config = NonNullable<ReturnType<typeof readTaxonomyServiceBus>>;
export const TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES = 240 * 1024;
type Store = Pick<
  TaxonomyMessageStore,
  | 'consumir'
  | 'claimServiceBusDelivery'
  | 'finishServiceBusDelivery'
  | 'verifyServiceBusStorage'
>;

function envelope(row: Record<string, unknown>) {
  const payload = row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const value = payload as Record<string, unknown>;
  const name = row.event_name;
  if (
    typeof name !== 'string' ||
    !(taxonomyServiceBusEvents as readonly string[]).includes(name)
  )
    return;
  const kind = name.endsWith('.requested')
    ? 'command'
    : name.endsWith('.rejected')
      ? 'result'
      : 'event';
  if (
    typeof row.message_id !== 'string' ||
    typeof row.correlation_id !== 'string' ||
    value.message_id !== row.message_id ||
    value.correlation_id !== row.correlation_id ||
    value.name !== name ||
    value.kind !== kind ||
    value.producer !== 'taxonomy-svc' ||
    value.schema_version !== 1 ||
    !value.data ||
    typeof value.data !== 'object' ||
    Array.isArray(value.data)
  )
    return;
  return {
    body: Buffer.from(JSON.stringify(value)),
    messageId: row.message_id,
    correlationId: row.correlation_id,
    contentType: 'application/json',
    subject: name,
    applicationProperties: {
      producer: 'taxonomy-svc',
      schema_version: 1,
      route_version: 1,
    },
  };
}

export async function publishTaxonomyDelivery(
  store: Pick<Store, 'claimServiceBusDelivery' | 'finishServiceBusDelivery'>,
  sender: Pick<ServiceBusSender, 'createMessageBatch' | 'sendMessages'>,
): Promise<boolean> {
  const claim = await store.claimServiceBusDelivery();
  if (!claim) return true;
  const message = envelope(claim.row);
  let outcome: 'sent' | 'pending' | 'terminal' = message
    ? 'pending'
    : 'terminal';
  try {
    if (message) {
      const batch = await sender.createMessageBatch({
        maxSizeInBytes: TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES,
        abortSignal: AbortSignal.timeout(5000),
      });
      if (!batch.tryAddMessage(message)) outcome = 'terminal';
      else {
        await sender.sendMessages(batch, {
          abortSignal: AbortSignal.timeout(10_000),
        });
        outcome = 'sent';
      }
    }
  } catch {
    // A lost send confirmation keeps the claim pending under the same MessageId.
  }
  return (
    (await store.finishServiceBusDelivery(claim, outcome)) && outcome === 'sent'
  );
}

export async function receiveTaxonomyDelivery(
  store: Pick<Store, 'consumir'>,
  receiver: Pick<
    ServiceBusReceiver,
    'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
  >,
  message: ServiceBusReceivedMessage,
): Promise<boolean> {
  let checked: ReturnType<typeof parseChecked>;
  try {
    if (
      !(message.body instanceof Uint8Array) ||
      message.body.byteLength > TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES ||
      message.contentType !== 'application/json'
    )
      throw new Error('INVALID_ENVELOPE');
    checked = parseChecked(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(message.body),
      ),
    );
    const tags = message.applicationProperties ?? {};
    if (
      message.subject !== checked.name ||
      message.messageId !== checked.message_id ||
      message.correlationId !== checked.correlation_id ||
      (Object.hasOwn(tags, 'producer') && tags.producer !== checked.producer) ||
      (Object.hasOwn(tags, 'schema_version') &&
        tags.schema_version !== checked.schema_version) ||
      (Object.hasOwn(tags, 'route_version') && tags.route_version !== 1)
    )
      throw new Error('INVALID_ENVELOPE');
  } catch {
    await receiver.deadLetterMessage(message, {
      deadLetterReason: 'INVALID_TAXONOMY_CHECK_RESULT',
      deadLetterErrorDescription: 'Contract or queue validation failed',
    });
    return true;
  }
  try {
    await store.consumir(checked);
  } catch (error) {
    if (error instanceof TaxonomyMessageIdentityConflict) {
      await receiver.deadLetterMessage(message, {
        deadLetterReason: 'TAXONOMY_MESSAGE_ID_CONFLICT',
        deadLetterErrorDescription:
          'Message identity conflicts with persisted inbox',
      });
      return true;
    }
    await receiver.abandonMessage(message);
    return false;
  }
  await receiver.completeMessage(message);
  return true;
}

function createIsolatedTaxonomyServiceBusClient(
  baseUrl: string,
): ServiceBusClient {
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
            if (!res.ok)
              throw new Error(`ISOLATED_BUS_SEND_FAILED_${res.status}`);
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
                error:
                  error instanceof Error ? error : new Error(String(error)),
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
          if (!res.ok)
            throw new Error(`ISOLATED_BUS_PEEK_FAILED_${res.status}`);
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
          options?: {
            deadLetterReason?: string;
            deadLetterErrorDescription?: string;
          },
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
      } as never;
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
    },
  } as unknown as ServiceBusClient;
}

export class TaxonomyServiceBusRuntime {
  private client?: ServiceBusClient;
  private receiver?: ServiceBusReceiver;
  private sender?: ServiceBusSender;
  private subscription?: { close(): Promise<void> };
  private timer?: ReturnType<typeof setTimeout>;
  private tick?: Promise<void>;
  private readonly deliveries = new Set<Promise<void>>();
  private stopped = false;
  private failures = 0;
  available = false;
  storageAvailable = false;
  brokerAvailable = false;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {
    // Un transporte pausado no constituye una dependencia activa de readiness.
    this.available = !config.enabled;
  }

  start(): void {
    if (!this.config.enabled || this.client || this.stopped) return;
    if (
      process.env.NODE_ENV === 'test' &&
      process.env.G6_ISOLATED_SERVICE_BUS_URL
    ) {
      this.client = createIsolatedTaxonomyServiceBusClient(
        process.env.G6_ISOLATED_SERVICE_BUS_URL,
      );
    } else {
      this.client = new ServiceBusClient(
        this.config.namespace,
        this.config.clientId
          ? new ManagedIdentityCredential({ clientId: this.config.clientId })
          : new DefaultAzureCredential(),
        { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
      );
    }
    const receiver = this.config.receiveEnabled
      ? this.client.createReceiver(catalogTaxonomyQueue, {
          receiveMode: 'peekLock',
          skipParsingBodyAsJson: true,
          maxAutoLockRenewalDurationInMs: 60_000,
        })
      : undefined;
    this.receiver = receiver;
    const sender = this.config.sendEnabled
      ? this.client.createSender(taxonomyCatalogQueue)
      : undefined;
    this.sender = sender;
    this.subscription = receiver?.subscribe(
      {
        processMessage: (message) => {
          const task = receiveTaxonomyDelivery(
            {
              consumir: async (envelope) => {
                try {
                  await this.store.consumir(envelope);
                } catch (error) {
                  if (!(error instanceof TaxonomyMessageIdentityConflict))
                    this.storageAvailable = false;
                  throw error;
                }
              },
            },
            receiver!,
            message,
          )
            .then((settled) => {
              if (!settled) this.markUnavailable();
            })
            .catch(() => this.markUnavailable());
          this.deliveries.add(task);
          void task.then(() => this.deliveries.delete(task));
          return task;
        },
        processError: async () => this.markUnavailable(),
      },
      { autoCompleteMessages: false, maxConcurrentCalls: 1 },
    );
    const cycle = () => {
      const failures = this.failures;
      let phase: 'postgres' | 'service_bus' = 'postgres';
      this.tick = this.store
        .verifyServiceBusStorage()
        .then(() => {
          this.storageAvailable = true;
          phase = 'service_bus';
        })
        .then(() =>
          receiver?.peekMessages(1, { abortSignal: AbortSignal.timeout(5000) }),
        )
        .then(() =>
          sender?.createMessageBatch({
            maxSizeInBytes: TAXONOMY_SERVICE_BUS_MAX_BATCH_BYTES,
            abortSignal: AbortSignal.timeout(5000),
          }),
        )
        .then(() => {
          phase = 'postgres';
          return sender ? publishTaxonomyDelivery(this.store, sender) : true;
        })
        .then((ready) => {
          this.brokerAvailable =
            ready && this.failures === failures && !this.stopped;
          this.available = this.storageAvailable && this.brokerAvailable;
        })
        .catch((error) => {
          console.error(`[taxonomy-sb] cycle error (${phase}):`, error);
          if (phase === 'postgres') this.storageAvailable = false;
          this.markUnavailable();
        })
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(cycle, 1000);
            this.timer.unref();
          }
        });
    };
    cycle();
  }

  private markUnavailable(): void {
    this.available = false;
    this.brokerAvailable = false;
    this.failures++;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.available = false;
    this.storageAvailable = false;
    this.brokerAvailable = false;
    clearTimeout(this.timer);
    await this.subscription?.close().catch(() => undefined);
    await this.tick;
    await Promise.allSettled(this.deliveries);
    await Promise.allSettled([this.receiver?.close(), this.sender?.close()]);
    await this.client?.close();
  }
}
