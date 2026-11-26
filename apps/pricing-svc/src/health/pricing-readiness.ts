import { Inject, Injectable, Optional } from '@nestjs/common';
import { PricingServiceBusRuntime } from '../messaging/service-bus-relay.js';
import { PricingDatabase } from '../persistence/pricing.database.js';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';
import { PricingOutboxRelay } from '../messaging/outbox-relay.js';
import { PricingInboxConsumer } from '../messaging/inbox-consumer.js';

@Injectable()
export class PricingReadiness {
  constructor(
    @Inject(PricingDatabase) private readonly database: PricingDatabase,
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
    @Inject(PricingOutboxRelay) private readonly relay?: PricingOutboxRelay,
    @Inject(PricingInboxConsumer)
    private readonly consumer?: PricingInboxConsumer,
    @Optional()
    @Inject(PricingServiceBusRuntime)
    private readonly serviceBus?: PricingServiceBusRuntime,
  ) {}

  check(): Promise<boolean> {
    if (!this.config.auth) return Promise.resolve(false);
    if (this.config.serviceBus && !this.serviceBus?.available)
      return Promise.resolve(false);
    if (
      this.config.amqpUrl &&
      (!this.consumer?.available || !this.relay?.available)
    )
      return Promise.resolve(false);
    return this.database.check();
  }
}
