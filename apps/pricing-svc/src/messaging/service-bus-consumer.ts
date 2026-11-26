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
    private readonly initialization: Pick<PricingProductInitialization, 'consume'>,
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
          error instanceof Error ? error.message : 'Invalid Service Bus message',
      });
      return 'dead-lettered';
    }

    try {
      if (this.queue === BULK_TO_PRICING_QUEUE) {
        if (payload.name !== 'pricing.bulk.price.apply.requested') {
          throw new Error('UNEXPECTED_EVENT_NAME');
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
  private readonly receivers: ServiceBusReceiver[] = [];
  private readonly subscriptions: Array<{ close(): Promise<void> }> = [];
  private readonly logger = new Logger(PricingServiceBusConsumer.name);

  constructor(
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    private readonly initialization: PricingProductInitialization,
    private readonly deactivation: CatalogSkuDeactivated,
    @Optional() private readonly bulkApply?: BulkPriceApplyService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.serviceBus || !this.bulkApply) return;
    this.client = new ServiceBusClient(
      this.config.serviceBus.namespace,
      this.config.serviceBus.managedIdentityClientId
        ? new ManagedIdentityCredential({
            clientId: this.config.serviceBus.managedIdentityClientId,
          })
        : new DefaultAzureCredential(),
      { retryOptions: { maxRetries: 0, timeoutInMs: 5000 } },
    );

    for (const queue of [CATALOG_TO_PRICING_QUEUE, BULK_TO_PRICING_QUEUE]) {
      const receiver = this.client.createReceiver(queue, {
        receiveMode: 'peekLock',
        skipParsingBodyAsJson: true,
      });
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
            this.available = false;
            this.logger.warn(`Service Bus consumer error on ${queue}`);
          },
        },
        { autoCompleteMessages: false },
      );
      this.receivers.push(receiver);
      this.subscriptions.push(sub);
    }
    this.available = true;
  }

  async onModuleDestroy(): Promise<void> {
    this.available = false;
    await Promise.all(
      this.subscriptions.map((sub) => sub.close().catch(() => undefined)),
    );
    await Promise.all(
      this.receivers.map((rec) => rec.close().catch(() => undefined)),
    );
    await this.client?.close().catch(() => undefined);
  }
}
