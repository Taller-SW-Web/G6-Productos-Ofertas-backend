import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import {
  ServiceBusClient,
  type ServiceBusReceivedMessage,
  type ServiceBusReceiver,
} from '@azure/service-bus';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { BulkPriceApplyService } from './bulk-price-apply.service.js';
import { CatalogSkuDeactivated } from './catalog-sku-deactivated.js';
import { PricingProductInitialization } from './pricing-initialization.js';
import {
  BULK_TO_PRICING_QUEUE,
  CATALOG_TO_PRICING_QUEUE,
} from './service-bus-deliveries.js';

const MAX_BYTES = 256 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PricingBusSettlement = Pick<
  ServiceBusReceiver,
  'completeMessage' | 'abandonMessage' | 'deadLetterMessage'
>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeBody(body: unknown): Record<string, unknown> {
  const bytes =
    body instanceof Uint8Array
      ? body
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : undefined;
  if (!bytes || bytes.byteLength > MAX_BYTES) {
    throw new Error('INVALID_SERVICE_BUS_BODY');
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  );
  if (!isObject(parsed)) throw new Error('INVALID_SERVICE_BUS_ENVELOPE');
  return parsed;
}

export class PricingServiceBusHandler {
  constructor(
    private readonly queue: string,
    private readonly receiver: PricingBusSettlement,
    private readonly initialization: Pick<
      PricingProductInitialization,
      'consume'
    >,
    private readonly deactivation: Pick<CatalogSkuDeactivated, 'consume'>,
    private readonly bulkApply: Pick<BulkPriceApplyService, 'process'>,
  ) {}

  async handle(
    message: ServiceBusReceivedMessage,
  ): Promise<'completed' | 'abandoned' | 'dead-lettered'> {
    let payload: Record<string, unknown>;
    try {
      payload = decodeBody(message.body);
      if (
        typeof message.messageId !== 'string' ||
        !UUID_RE.test(message.messageId) ||
        payload.message_id !== message.messageId ||
        typeof payload.name !== 'string' ||
        (message.subject !== undefined && message.subject !== payload.name)
      ) {
        throw new Error('INVALID_ENVELOPE');
      }
      const expectedProducer =
        this.queue === BULK_TO_PRICING_QUEUE ? 'bulk-svc' : 'catalog-svc';
      if (payload.producer !== expectedProducer) {
        throw new Error('UNAUTHORIZED_PRODUCER');
      }
    } catch (error) {
      await this.receiver.deadLetterMessage(message, {
        deadLetterReason: 'INVALID_MESSAGE',
        deadLetterErrorDescription:
          error instanceof Error
            ? error.message
            : 'Invalid Service Bus message',
      });
      return 'dead-lettered';
    }

    try {
      if (this.queue === BULK_TO_PRICING_QUEUE) {
        if (payload.name !== 'pricing.bulk.price.apply.requested') {
          await this.receiver.deadLetterMessage(message, {
            deadLetterReason: 'UNEXPECTED_EVENT_NAME',
            deadLetterErrorDescription: `Unexpected event ${String(payload.name)}`,
          });
          return 'dead-lettered';
        }
        await this.bulkApply.process(payload);
      } else if (payload.name === 'pricing.product.initialization.requested') {
        await this.initialization.consume(
          Buffer.from(JSON.stringify(payload), 'utf8'),
        );
      } else if (payload.name === 'catalog.sku.deactivated') {
        await this.deactivation.consume(
          Buffer.from(JSON.stringify(payload), 'utf8'),
        );
      } else {
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: 'UNEXPECTED_EVENT_NAME',
          deadLetterErrorDescription: `Unexpected event ${String(payload.name)}`,
        });
        return 'dead-lettered';
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'PRICING_INVALID_BULK_ENVELOPE' ||
          error.message === 'PRICING_MESSAGE_ID_CONFLICT')
      ) {
        await this.receiver.deadLetterMessage(message, {
          deadLetterReason: error.message,
          deadLetterErrorDescription: error.message,
        });
        return 'dead-lettered';
      }
      await this.receiver.abandonMessage(message);
      return 'abandoned';
    }

    await this.receiver.completeMessage(message);
    return 'completed';
  }
}

@Injectable()
export class PricingServiceBusConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  available = false;
  private client?: ServiceBusClient;
  private stopped = false;
  private readonly queues = [CATALOG_TO_PRICING_QUEUE, BULK_TO_PRICING_QUEUE];
  private readonly receivers = new Map<string, ServiceBusReceiver>();
  private readonly subscriptions = new Map<
    string,
    { close(): Promise<void> }
  >();
  private readonly queueReady = new Map<string, boolean>();
  private readonly recoveryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly logger = new Logger(PricingServiceBusConsumer.name);

  constructor(
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    private readonly initialization: PricingProductInitialization,
    private readonly deactivation: CatalogSkuDeactivated,
    @Optional() private readonly bulkApply?: BulkPriceApplyService,
  ) {}

  private recomputeAvailable(): void {
    this.available =
      !this.stopped &&
      this.queues.every((queue) => this.queueReady.get(queue) === true);
  }

  onApplicationBootstrap(): void {
    if (!this.config.serviceBus || !this.bulkApply) return;
    if (this.config.serviceBus.isolatedBusUrl) {
      const origin = this.config.serviceBus.isolatedBusUrl;
      const timers = new Set<ReturnType<typeof setInterval>>();
      this.client = {
        createReceiver(queue: string) {
          return {
            async peekMessages() {
              const res = await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/peek`,
              );
              if (!res.ok)
                throw new Error(`ISOLATED_BUS_PEEK_FAILED_${res.status}`);
              return (await res.json()) as ServiceBusReceivedMessage[];
            },
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
                    applicationProperties?: Record<string, unknown>;
                    deliveryCount?: number;
                  };
                  await handlers.processMessage({
                    body: Buffer.from(msg.body, 'utf8'),
                    contentType: msg.contentType,
                    messageId: msg.messageId,
                    correlationId: msg.correlationId,
                    subject: msg.subject,
                    applicationProperties: msg.applicationProperties,
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
            async completeMessage(message: ServiceBusReceivedMessage) {
              const id = (message as unknown as { _deliveryId?: string })
                ._deliveryId;
              if (!id) return;
              await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/complete/${encodeURIComponent(id)}`,
                { method: 'POST' },
              );
            },
            async abandonMessage(message: ServiceBusReceivedMessage) {
              const id = (message as unknown as { _deliveryId?: string })
                ._deliveryId;
              if (!id) return;
              await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/abandon/${encodeURIComponent(id)}`,
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
              const id = (message as unknown as { _deliveryId?: string })
                ._deliveryId;
              if (!id) return;
              await fetch(
                `${origin}/queues/${encodeURIComponent(queue)}/deadletter/${encodeURIComponent(id)}`,
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
          } as unknown as ServiceBusReceiver;
        },
        async close() {
          for (const t of timers) clearInterval(t);
          timers.clear();
        },
      } as unknown as ServiceBusClient;
    } else {
      this.client = new ServiceBusClient(
        this.config.serviceBus.namespace,
        this.config.serviceBus.managedIdentityClientId
          ? new ManagedIdentityCredential({
              clientId: this.config.serviceBus.managedIdentityClientId,
            })
          : new DefaultAzureCredential(),
        { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
      );
    }

    for (const queue of this.queues) {
      this.queueReady.set(queue, false);
      void this.openQueue(queue);
    }
  }

  private async openQueue(queue: string): Promise<void> {
    if (this.stopped || !this.client || !this.bulkApply) return;
    try {
      const existingSub = this.subscriptions.get(queue);
      if (existingSub) {
        await existingSub.close().catch(() => undefined);
        this.subscriptions.delete(queue);
      }
      const existingReceiver = this.receivers.get(queue);
      if (existingReceiver) {
        await existingReceiver.close().catch(() => undefined);
        this.receivers.delete(queue);
      }

      const receiver = this.client.createReceiver(queue, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
      await receiver.peekMessages(1);
      if (this.stopped) {
        await receiver.close().catch(() => undefined);
        return;
      }

      const handler = new PricingServiceBusHandler(
        queue,
        receiver,
        this.initialization,
        this.deactivation,
        this.bulkApply,
      );
      const sub = receiver.subscribe(
        {
          processMessage: async (msg) => {
            await handler.handle(msg);
          },
          processError: async () => {
            this.queueReady.set(queue, false);
            this.recomputeAvailable();
            this.logger.warn(`Service Bus consumer error on ${queue}`);
            this.scheduleQueueRecovery(queue);
          },
        },
        { autoCompleteMessages: false },
      );
      this.receivers.set(queue, receiver);
      this.subscriptions.set(queue, sub);
      this.queueReady.set(queue, true);
      this.recomputeAvailable();
    } catch {
      this.queueReady.set(queue, false);
      this.recomputeAvailable();
      this.scheduleQueueRecovery(queue);
    }
  }

  private scheduleQueueRecovery(queue: string): void {
    if (this.stopped || this.recoveryTimers.has(queue)) return;
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(queue);
      void this.openQueue(queue);
    }, 2000);
    timer.unref();
    this.recoveryTimers.set(queue, timer);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.available = false;
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    await Promise.all(
      [...this.subscriptions.values()].map((sub) =>
        sub.close().catch(() => undefined),
      ),
    );
    this.subscriptions.clear();
    await Promise.all(
      [...this.receivers.values()].map((rec) =>
        rec.close().catch(() => undefined),
      ),
    );
    this.receivers.clear();
    await this.client?.close().catch(() => undefined);
  }
}
