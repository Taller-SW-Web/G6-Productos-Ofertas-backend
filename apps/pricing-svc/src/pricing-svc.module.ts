import { Module, type DynamicModule } from '@nestjs/common';
import { PricingSvcController } from './pricing-svc.controller.js';
import { PricingSvcService } from './pricing-svc.service.js';
import { validateEnvironment } from './config/environment.js';
import { HealthController } from './health/health.controller.js';
import {
  PRICING_CONFIG,
  PricingReadiness,
} from './health/pricing-readiness.js';

@Module({
  imports: [],
  controllers: [PricingSvcController, HealthController],
  providers: [
    PricingSvcService,
    PricingReadiness,
    {
      provide: PRICING_CONFIG,
      useFactory: () => validateEnvironment(process.env),
    },
  ],
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
