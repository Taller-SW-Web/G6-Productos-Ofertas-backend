import { Module } from '@nestjs/common';
import { PromotionsSvcController } from './promotions-svc.controller.js';
import { PromotionsSvcService } from './promotions-svc.service.js';
import {
  PromotionsConfigService,
  readPromotionsEnvironment,
  validatePromotionsConfiguration,
} from './infrastructure/config/promotions-config.js';
import {
  PROMOTIONS_DEPENDENCY_PROBES,
  PromotionsReadinessService,
} from './health/promotions-readiness.service.js';

@Module({
  imports: [],
  controllers: [PromotionsSvcController],
  providers: [
    PromotionsSvcService,
    {
      provide: PromotionsConfigService,
      useFactory: () =>
        new PromotionsConfigService(
          validatePromotionsConfiguration(readPromotionsEnvironment()),
        ),
    },
    // Real adapters belong to #71 (DB) and #75 (broker). Missing is not healthy.
    { provide: PROMOTIONS_DEPENDENCY_PROBES, useValue: Object.freeze({}) },
    PromotionsReadinessService,
  ],
})
export class PromotionsSvcModule {}
