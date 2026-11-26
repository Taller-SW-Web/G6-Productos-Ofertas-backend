import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { ServiceBusClient, type ServiceBusSender } from '@azure/service-bus';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import {
  PricingDeliveryStore,
  PRICING_APPROVED_DESTINATIONS,
} from './service-bus-deliveries.js';
import { pricingEnvelope } from './outbox-relay.js';

type SenderLike = Pick<ServiceBusSender, 'createMessageBatch' | 'sendMessages'>;

export class PricingServiceBusRelay {
  private readonly resolveSender: (destination: string) => SenderLike;

  constructor(
    private readonly store: Pick<PricingDeliveryStore, 'claim' | 'finish'>,
    senderOrResolver: SenderLike | ((destination: string) => SenderLike),
  ) {
    this.resolveSender =
      typeof senderOrResolver === 'function'
        ? senderOrResolver
        : () => senderOrResolver;
  }

  async publishOne(): Promise<'empty' | 'sent' | 'pending' | 'lease-lost'> {
    const claim = await this.store.claim();
    if (!claim) return 'empty';
    let confirmed = false;
    try {
      if (!PRICING_APPROVED_DESTINATIONS.has(claim.destination))
        throw new Error('SERVICE_BUS_ROUTE_NOT_APPROVED');
      const sender = this.resolveSender(claim.destination);
      // The SDK JSON-serializes non-binary bodies. Send canonical UTF-8 bytes
      // to avoid wrapping the envelope in a second JSON string.
      const body = pricingEnvelope(claim.row);
      // tryAddMessage accounts for AMQP properties/encoding, not only JSON bytes.
      const batch = await sender.createMessageBatch({
        maxSizeInBytes: 256 * 1024,
      });
      if (
        !batch.tryAddMessage({
          body,
          messageId: claim.row.messageId,
          correlationId: claim.row.correlationId,
          subject: claim.row.eventName,
          contentType: 'application/json',
          applicationProperties: {
            producer: 'pricing-svc',
            schema_version: claim.row.schemaVersion,
            route_version: 1,
          },
        })
      )
        throw new Error('SERVICE_BUS_MESSAGE_TOO_LARGE');
      await sender.sendMessages(batch, {
        abortSignal: AbortSignal.timeout(10_000),
      });
      confirmed = true;
    } catch {
      // A timeout can occur after the broker accepted the batch; retain its ID.
    }
    const updated = await this.store.finish(claim, confirmed);
    return !updated ? 'lease-lost' : confirmed ? 'sent' : 'pending';
  }
}

@Injectable()
export class PricingServiceBusRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  available = false;
  private client?: ServiceBusClient;
  private senders = new Map<string, ServiceBusSender>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = false;
  private readonly logger = new Logger(PricingServiceBusRuntime.name);

  constructor(
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    @Inject(PricingRepository) private readonly repository: PricingRepository,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.serviceBus) return;
    this.client = new ServiceBusClient(
      this.config.serviceBus.namespace,
      this.config.serviceBus.managedIdentityClientId
        ? new ManagedIdentityCredential({
            clientId: this.config.serviceBus.managedIdentityClientId,
          })
        : new DefaultAzureCredential(),
      {
        retryOptions: { maxRetries: 0, timeoutInMs: 5000 },
      },
    );
    const client = this.client;
    for (const destination of PRICING_APPROVED_DESTINATIONS) {
      this.senders.set(destination, client.createSender(destination));
    }
    const relay = new PricingServiceBusRelay(
      new PricingDeliveryStore(this.repository),
      (destination) => {
        const sender = this.senders.get(destination);
        if (!sender) throw new Error('SERVICE_BUS_ROUTE_NOT_APPROVED');
        return sender;
      },
    );
    const tick = () => {
      this.active = (async () => {
        // Establish links and check sender authorization even with no pending rows.
        for (const sender of this.senders.values()) {
          await sender.createMessageBatch({ maxSizeInBytes: 256 * 1024 });
        }
        const result = await relay.publishOne();
        this.available = result === 'empty' || result === 'sent';
      })()
        .catch(() => {
          this.available = false;
        })
        .finally(() => {
          if (!this.available) this.logger.warn('SERVICE_BUS_PRICING_PENDING');
          if (!this.stopped) this.timer = setTimeout(tick, 1000);
        });
    };
    tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
    this.available = false;
    try {
      await Promise.all(
        [...this.senders.values()].map((sender) =>
          sender.close().catch(() => undefined),
        ),
      );
      this.senders.clear();
    } finally {
      await this.client?.close();
    }
  }
}
