import { Inject, Injectable } from '@nestjs/common';
import { PricingDatabase } from '../persistence/pricing.database.js';
import { PRICING_CONFIG, type PricingConfig } from '../config/environment.js';

@Injectable()
export class PricingReadiness {
  constructor(
    @Inject(PricingDatabase) private readonly database: PricingDatabase,
    @Inject(PRICING_CONFIG) private readonly config: PricingConfig,
  ) {}

  check(): Promise<boolean> {
    if (!this.config.auth) return Promise.resolve(false);
    return this.database.check();
  }
}
