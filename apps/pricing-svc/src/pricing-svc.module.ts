import { Module, type DynamicModule } from '@nestjs/common';
import { PricingSvcController } from './pricing-svc.controller.js';
import { PricingSvcService } from './pricing-svc.service.js';
import { PRICING_CONFIG, validateEnvironment } from './config/environment.js';
import { HealthController } from './health/health.controller.js';
import { PricingReadiness } from './health/pricing-readiness.js';
import { PricingDatabase } from './persistence/pricing.database.js';
import { PricingRepository } from './persistence/pricing.repository.js';

@Module({
  imports: [],
  controllers: [PricingSvcController, HealthController],
  providers: [
    PricingSvcService,
    PricingReadiness,
    PricingDatabase,
    PricingRepository,
    {
      provide: PRICING_CONFIG,
      useFactory: () => validateEnvironment(process.env),
    },
  ],
  exports: [PricingRepository],
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
