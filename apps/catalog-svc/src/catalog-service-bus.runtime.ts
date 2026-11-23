import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from './database.js';
import { CatalogMessageService } from './catalog-message.service.js';
import {
  bulkRequestQueue,
  catalogIncomingQueues,
  createCatalogServiceBus,
  taxonomyReplyQueue,
  taxonomyRequestQueue,
  type CatalogServiceBus,
} from './catalog-service-bus.js';
import { readCatalogH5Destinations } from './catalog-messaging.config.js';
import { relayCatalogDelivery } from './catalog-service-bus-relay.js';

const pollIntervalMs = 2000;
const recoveryDelayMs = 2000;

type CatalogSubscription = ReturnType<CatalogServiceBus['subscribeWithProbe']>;

export function createCatalogTaxonomyConsumer(
  messages: Pick<CatalogMessageService, 'consume'>,
  destinations: readonly string[],
): Pick<CatalogMessageService, 'consume'> {
  const replyEnabled = destinations.includes(taxonomyReplyQueue);
  return {
    consume: async (envelope) => {
      if (
        envelope.name === 'taxonomy.master.deactivation.check.requested' &&
        !replyEnabled
      )
        throw new Error('CATALOG_H5_TAXONOMY_REPLY_DISABLED');
      return messages.consume(envelope, replyEnabled);
    },
  };
}

export function createCatalogBulkConsumer(
  messages: Pick<CatalogMessageService, 'consume'>,
  destinations: readonly string[],
): Pick<CatalogMessageService, 'consume'> {
  const replyEnabled = destinations.includes('g6.bulk.from.catalog');
  return {
    consume: async (envelope) => {
      if (envelope.name === 'catalog.bulk.upsert.requested' && !replyEnabled)
        throw new Error('CATALOG_H5_BULK_REPLY_DISABLED');
      return messages.consume(envelope);
    },
  };
}

@Injectable()
export class CatalogServiceBusRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CatalogServiceBusRuntime.name);
  private readonly bus?: CatalogServiceBus;
  private readonly h5Required: boolean;
  private readonly destinations: readonly string[];
  private subscriptions: CatalogSubscription[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private recovery?: Promise<void>;
  private connected = false;
  private stopped = false;
  private recovering = false;
  private failures = 0;

  constructor(
    private readonly database: Database,
    private readonly messages: CatalogMessageService,
  ) {
    const env = process.env;
    this.h5Required = env.MESSAGING_PROVIDER === 'AZURE_SERVICE_BUS';
    this.destinations = this.h5Required ? readCatalogH5Destinations(env) : [];
    this.bus = createCatalogServiceBus(env);
    if (this.h5Required && !this.bus)
      throw new Error('CATALOG_H5_SERVICE_BUS_REQUIRED');
  }

  get required(): boolean {
    return this.h5Required;
  }

  get ready(): boolean {
    return (
      !this.h5Required ||
      (this.connected &&
        !this.stopped &&
        this.subscriptions.length === catalogIncomingQueues.length)
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.h5Required || !this.bus) return;
    this.timer = setInterval(() => void this.runCycle(), pollIntervalMs);
    this.timer.unref();
    await this.runCycle();
  }

  private runCycle(): Promise<void> {
    if (!this.h5Required || !this.bus || this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const running = this.poll().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async poll(): Promise<void> {
    const bus = this.bus;
    if (!bus || this.stopped) return;
    const failures = this.failures;
    try {
      await this.verifyStorage();
      if (
        this.subscriptions.length !== catalogIncomingQueues.length &&
        !this.recovering
      )
        this.openReceivers();

      const activeSubscriptions = [...this.subscriptions];
      try {
        await Promise.all(
          activeSubscriptions.map((subscription) =>
            subscription.probe(AbortSignal.timeout(5000)),
          ),
        );
      } catch {
        this.scheduleReceiverRecovery();
        throw new Error('CATALOG_H5_RECEIVER_PROBE_FAILED');
      }

      for (const destination of this.destinations) {
        await bus.verifySender(destination, AbortSignal.timeout(5000));
      }

      let relayHealthy = true;
      for (const destination of this.destinations) {
        const result = await relayCatalogDelivery(
          this.database,
          bus,
          destination,
        );
        if (result === 'RETRY' || result === 'LEASE_LOST') relayHealthy = false;
      }
      this.connected =
        relayHealthy && this.failures === failures && !this.stopped;
      if (!relayHealthy) this.logger.warn('CATALOG_H5_OUTBOX_DELIVERY_PENDING');
    } catch {
      this.connected = false;
      this.logger.warn('CATALOG_H5_TRANSPORT_UNAVAILABLE');
    }
  }

  private async verifyStorage(): Promise<void> {
    const requiresTaxonomyReply =
      this.destinations.includes(taxonomyReplyQueue);
    const result = await this.database.read((db) =>
      db.execute(sql`
        SELECT
          to_regclass('catalog.outbox_delivery') IS NOT NULL
          AND COALESCE(has_table_privilege(current_user, to_regclass('catalog.outbox_delivery'), 'SELECT'), false)
          AND COALESCE(has_table_privilege(current_user, to_regclass('catalog.outbox_delivery'), 'INSERT'), false)
          AND NOT EXISTS (
            SELECT FROM unnest(ARRAY['attempts','available_at','lease_token','published_at','last_error']) AS cols(name)
            WHERE NOT COALESCE(has_column_privilege(current_user, to_regclass('catalog.outbox_delivery'), cols.name, 'UPDATE'), false)
          )
          AND to_regprocedure('catalog.enqueue_h5_outbox_deliveries()') IS NOT NULL
          AND EXISTS (
            SELECT FROM pg_trigger
            WHERE tgname = 'tr_catalog_outbox_h5_delivery'
              AND tgrelid = to_regclass('catalog.outbox')
              AND tgenabled IN ('O', 'A')
          )
          AND (
            NOT ${requiresTaxonomyReply}
            OR (
              EXISTS (
                SELECT FROM pg_attribute
                WHERE attrelid = to_regclass('catalog.outbox')
                  AND attname = 'delivery_transport'
                  AND NOT attisdropped
              )
              AND to_regprocedure('catalog.mark_taxonomy_reply_transport()') IS NOT NULL
              AND EXISTS (
                SELECT FROM pg_trigger
                WHERE tgname = 'trg_catalog_taxonomy_reply_transport'
                  AND tgrelid = to_regclass('catalog.outbox')
                  AND tgenabled IN ('O', 'A')
              )
            )
          ) AS ready
      `),
    );
    if (result.rows[0]?.ready !== true)
      throw new Error('CATALOG_H5_STORAGE_NOT_READY');
  }

  private openReceivers(): void {
    if (!this.bus || this.stopped) return;
    const opened: CatalogSubscription[] = [];
    try {
      for (const queue of catalogIncomingQueues) {
        const service =
          queue === taxonomyRequestQueue
            ? createCatalogTaxonomyConsumer(this.messages, this.destinations)
            : queue === bulkRequestQueue
              ? createCatalogBulkConsumer(this.messages, this.destinations)
              : this.messages;
        opened.push(
          this.bus.subscribeWithProbe(queue, service, () =>
            this.scheduleReceiverRecovery(),
          ),
        );
      }
      this.subscriptions = opened;
    } catch (error) {
      this.subscriptions = [];
      void Promise.allSettled(
        opened.map((subscription) => subscription.close()),
      );
      throw error;
    }
  }

  private scheduleReceiverRecovery(): void {
    this.connected = false;
    this.failures++;
    if (this.recoveryTimer || this.stopped) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      const recovery = this.recoverReceivers().finally(() => {
        if (this.recovery === recovery) this.recovery = undefined;
      });
      this.recovery = recovery;
    }, recoveryDelayMs);
    this.recoveryTimer.unref();
  }

  private async recoverReceivers(): Promise<void> {
    if (this.recovering || this.stopped || !this.bus) return;
    this.recovering = true;
    try {
      if (this.running) await this.running;
      this.connected = false;
      const previous = this.subscriptions.splice(0);
      await Promise.allSettled(
        previous.map((subscription) => subscription.close()),
      );
      if (this.stopped) return;
      await this.verifyStorage();
      this.openReceivers();
    } catch {
      this.logger.warn('CATALOG_H5_RECEIVER_RECOVERY_FAILURE');
    } finally {
      this.recovering = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    const running = this.running ? [this.running] : [];
    const recovery = this.recovery ? [this.recovery] : [];
    await Promise.allSettled([...running, ...recovery]);
    const subscriptions = this.subscriptions.splice(0);
    await Promise.allSettled(
      subscriptions.map((subscription) => subscription.close()),
    );
    await this.bus?.close();
  }
}
