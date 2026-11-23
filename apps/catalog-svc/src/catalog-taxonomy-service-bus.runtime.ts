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
  createCatalogServiceBus,
  taxonomyReplyQueue,
  taxonomyRequestQueue,
  type CatalogServiceBus,
} from './catalog-service-bus.js';
import { relayCatalogDelivery } from './catalog-service-bus-relay.js';

@Injectable()
export class CatalogTaxonomyServiceBusRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CatalogTaxonomyServiceBusRuntime.name);
  private bus?: CatalogServiceBus;
  private subscription?: ReturnType<CatalogServiceBus['subscribeWithProbe']>;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private connected = false;
  private stopping = false;

  constructor(
    private readonly database: Database,
    private readonly messages: CatalogMessageService,
  ) {}

  get ready(): boolean {
    return !this.bus || (this.connected && !this.stopping);
  }

  async onApplicationBootstrap(): Promise<void> {
    const env = process.env;
    if (env.MESSAGING_PROVIDER !== 'AZURE_SERVICE_BUS') return;
    if (env.CATALOG_H5_DESTINATIONS?.trim() !== taxonomyReplyQueue)
      throw new Error('CATALOG_H5_TAXONOMY_ROUTE_REQUIRED');
    this.bus = createCatalogServiceBus(env);
    if (!this.bus) throw new Error('CATALOG_H5_SERVICE_BUS_REQUIRED');

    const result = await this.database.read((db) =>
      db.execute(sql`
        SELECT to_regclass('catalog.outbox_delivery') IS NOT NULL
          AND has_table_privilege(current_user, to_regclass('catalog.outbox_delivery'), 'SELECT')
          AND has_table_privilege(current_user, to_regclass('catalog.outbox_delivery'), 'INSERT')
          AND has_column_privilege(current_user, to_regclass('catalog.outbox_delivery'), 'lease_token', 'UPDATE')
          AND EXISTS (
            SELECT FROM pg_trigger
            WHERE tgname = 'trg_catalog_taxonomy_reply_transport'
              AND tgrelid = 'catalog.outbox'::regclass
              AND tgenabled IN ('O', 'A')
          ) AS ready
      `),
    );
    if (result.rows[0]?.ready !== true)
      throw new Error('CATALOG_H5_TAXONOMY_STORAGE_NOT_READY');

    this.subscription = this.bus.subscribeWithProbe(
      taxonomyRequestQueue,
      { consume: (envelope) => this.messages.consume(envelope, true) },
      () => {
        this.connected = false;
      },
    );
    this.schedule(this.bus, this.subscription);
  }

  private schedule(
    bus: CatalogServiceBus,
    subscription: ReturnType<CatalogServiceBus['subscribeWithProbe']>,
  ): void {
    this.running = this.poll(bus, subscription).finally(() => {
      if (this.stopping) return;
      this.timer = setTimeout(() => this.schedule(bus, subscription), 2000);
      this.timer.unref();
    });
  }

  private async poll(
    bus: CatalogServiceBus,
    subscription: ReturnType<CatalogServiceBus['subscribeWithProbe']>,
  ): Promise<void> {
    try {
      if (!this.connected) {
        await Promise.all([
          subscription.probe(AbortSignal.timeout(5000)),
          bus.verifySender(taxonomyReplyQueue, AbortSignal.timeout(5000)),
        ]);
      }
      const result = await relayCatalogDelivery(
        this.database,
        bus,
        taxonomyReplyQueue,
      );
      this.connected = result !== 'RETRY' && !this.stopping;
    } catch {
      this.connected = false;
      this.logger.warn('CATALOG_H5_TAXONOMY_TRANSPORT_UNAVAILABLE');
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    clearTimeout(this.timer);
    try {
      await this.subscription?.close();
    } finally {
      await this.running;
      await this.bus?.close();
    }
  }
}
