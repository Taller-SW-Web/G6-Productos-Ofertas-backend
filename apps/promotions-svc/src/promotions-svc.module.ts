import { Module } from '@nestjs/common';
import { PromotionsSvcController } from './promotions-svc.controller.js';
import { PromotionsSvcService } from './promotions-svc.service.js';
import { couponProviders } from './coupons/coupon-providers.js';
import {
  PromotionsConfigService,
  readPromotionsEnvironment,
  validatePromotionsConfiguration,
} from './infrastructure/config/promotions-config.js';
import {
  PROMOTIONS_DEPENDENCY_PROBES,
  PromotionsReadinessService,
} from './health/promotions-readiness.service.js';
import { nativePromotionsDependencyProbes } from './health/promotions-dependency-probes.js';

@Module({
  imports: [],
  controllers: [PromotionsSvcController],
  providers: [
    ...couponProviders,
    PromotionsSvcService,
    {
      provide: PromotionsConfigService,
      useFactory: () =>
        new PromotionsConfigService(
          validatePromotionsConfiguration(readPromotionsEnvironment()),
        ),
    },
    {
      provide: PROMOTIONS_DEPENDENCY_PROBES,
      inject: [PromotionsConfigService],
      useFactory: nativePromotionsDependencyProbes,
    },
    PromotionsReadinessService,
  ],
})
export class PromotionsSvcModule {}
