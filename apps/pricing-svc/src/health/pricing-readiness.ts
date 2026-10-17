import { Inject, Injectable } from '@nestjs/common';
import { PricingDatabase } from '../persistence/pricing.database.js';

@Injectable()
export class PricingReadiness {
  constructor(
    @Inject(PricingDatabase) private readonly database: PricingDatabase,
  ) {}

  check(): Promise<boolean> {
    return this.database.check();
  }
}
