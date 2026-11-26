import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BulkPersistenceRepository } from '../persistence/bulk.repository.js';
import { CatalogBulkResultConsumer } from './catalog-bulk-result-consumer.js';
import {
  BulkServiceBus,
  bulkCommandQueueForEvent,
  createBulkServiceBus,
} from './bulk-service-bus.js';

const pollIntervalMs = 2000;
const recoveryDelayMs = 2000;

type BulkSubscription = ReturnType<BulkServiceBus['subscribeCatalogResults']>;
export type BulkServiceBusState =
  'NOT_CONFIGURED' | 'CONNECTING' | 'READY' | 'RECOVERING' | 'TOPOLOGY_BLOCKED';

@Injectable()
export class BulkServiceBusRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BulkServiceBusRuntime.name);
  private readonly bus?: BulkServiceBus;
  private readonly required: boolean;
  private subscriptions: BulkSubscription[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private connected = false;
  private failures = 0;
  private retryAfter = 0;

  constructor(
    private readonly repository: BulkPersistenceRepository,
    private readonly results: CatalogBulkResultConsumer,
  ) {
    this.required = process.env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS';
    this.bus = createBulkServiceBus(process.env);
  }

  get enabled(): boolean {
    return this.required;
  }

  getOperationalState(): BulkServiceBusState {
    if (!this.required) return 'NOT_CONFIGURED';
    if (this.stopped) return 'RECOVERING';
    if (this.connected) return 'READY';
    return this.failures ? 'RECOVERING' : 'CONNECTING';
  }

  async onModuleInit(): Promise<void> {
    if (!this.required || !this.bus) return;
    this.timer = setInterval(() => void this.runCycle(), pollIntervalMs);
    this.timer.unref();
    await this.runCycle();
  }

  private runCycle(): Promise<void> {
    if (!this.required || !this.bus || this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const running = this.flush().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async flush(): Promise<void> {
    const bus = this.bus;
    if (!bus || this.stopped || Date.now() < this.retryAfter) return;
    try {
      if (this.subscriptions.length === 0) {
        this.subscriptions = [
          bus.subscribeCatalogResults(this.results, () =>
            this.scheduleRecovery(),
          ),
          bus.subscribePricingResults(this.results, () =>
            this.scheduleRecovery(),
          ),
          bus.subscribeInventoryResults(this.results, () =>
            this.scheduleRecovery(),
          ),
        ];
      }
      await bus.verifySender(AbortSignal.timeout(5000));
      await Promise.all(
        this.subscriptions.map((sub) => sub.probe(AbortSignal.timeout(5000))),
      );
      const pending =
        await this.repository.claimPendingServiceBusDeliveries(20);
      for (const item of pending) {
        const leaseToken = item.delivery.leaseToken;
        if (!leaseToken) continue;
        try {
          await bus.publishCommand(
            bulkCommandQueueForEvent(item.eventName),
            {
              messageId: item.messageId,
              correlationId: item.correlationId,
              eventName: item.eventName,
              payload: item.payload,
            },
            AbortSignal.timeout(5000),
          );
          await this.repository.markServiceBusDeliveryPublished(
            item.messageId,
            leaseToken,
          );
        } catch {
          await this.repository.releaseServiceBusDelivery(
            item.messageId,
            leaseToken,
            'SERVICE_BUS_PUBLISH_UNCONFIRMED',
            item.delivery.attempts,
          );
          throw new Error('BULK_SERVICE_BUS_PUBLISH_FAILED');
        }
      }
      this.connected = true;
      this.failures = 0;
      this.retryAfter = 0;
    } catch {
      this.connected = false;
      this.failures = Math.min(this.failures + 1, 8);
      this.retryAfter =
        Date.now() + Math.min(30_000, 250 * 2 ** (this.failures - 1));
      this.logger.warn(
        'Bulk Service Bus no disponible; entregas durables pendientes se reintentarán con backoff.',
      );
      if (this.subscriptions.length > 0) {
        await Promise.all(
          this.subscriptions.map((sub) => sub.close().catch(() => undefined)),
        );
        this.subscriptions = [];
      }
      this.scheduleRecovery();
    }
  }

  private scheduleRecovery(): void {
    this.connected = false;
    if (this.recoveryTimer || this.stopped) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.runCycle();
    }, recoveryDelayMs);
    this.recoveryTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    await this.running?.catch(() => undefined);
    await Promise.all(
      this.subscriptions.map((sub) => sub.close().catch(() => undefined)),
    );
    await this.bus?.close().catch(() => undefined);
    await this.bus?.close().catch(() => undefined);
  }
}
