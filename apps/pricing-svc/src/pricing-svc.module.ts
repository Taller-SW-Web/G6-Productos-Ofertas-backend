import { Module, type DynamicModule } from '@nestjs/common';
import { PricingSvcController } from './pricing-svc.controller.js';
import { PricingSvcService } from './pricing-svc.service.js';
import { PRICING_CONFIG, validateEnvironment } from './config/environment.js';
import { HealthController } from './health/health.controller.js';
import { PricingReadiness } from './health/pricing-readiness.js';
import { PricingDatabase } from './persistence/pricing.database.js';
import { PricingRepository } from './persistence/pricing.repository.js';
import { PricingReadController } from './http/pricing-read.controller.js';
import { PricingReads } from './http/pricing-reads.js';
import { PricingReadGuard } from './http/pricing-read.guard.js';
import { PricingMutations } from './application/pricing-mutations.js';

@Module({
  imports: [],
  controllers: [PricingSvcController, HealthController, PricingReadController],
  providers: [
    PricingSvcService,
    PricingReadiness,
    PricingDatabase,
    PricingRepository,
    PricingReads,
    PricingReadGuard,
    PricingMutations,
    {
      provide: PRICING_CONFIG,
      useFactory: () => validateEnvironment(process.env),
    },
  ],
  exports: [PricingRepository, PricingMutations],
})
export class PricingSvcModule {
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    return {
      module: PricingSvcModule,
      providers: [
        { provide: PRICING_CONFIG, useValue: validateEnvironment(env) },
      ],
    };
  }
}
