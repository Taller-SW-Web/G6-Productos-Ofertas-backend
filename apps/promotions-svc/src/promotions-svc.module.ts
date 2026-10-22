import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { PROMOTIONS_CLOCK } from './domain/clock.js';
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
import {
  COMMERCIAL_CONTEXT,
  blockedCommercialContext,
} from './domain/commercial-context.js';
import {
  PromotionsQueryController,
  PromotionsProblemFilter,
} from './http/query-controller.js';
import { PromotionsQueryService } from './http/query-service.js';
import {
  PROMOTIONS_JWKS,
  PromotionsIdentity,
  PromotionsQueryGuard,
  remotePromotionsKeys,
} from './http/promotions-identity.js';

@Module({
  imports: [],
  controllers: [PromotionsSvcController, PromotionsQueryController],
  providers: [
    ...couponProviders,
    { provide: PROMOTIONS_CLOCK, useValue: { now: () => new Date() } },
    PromotionsQueryService,
    PromotionsIdentity,
    PromotionsQueryGuard,
    { provide: APP_FILTER, useClass: PromotionsProblemFilter },
    { provide: COMMERCIAL_CONTEXT, useValue: blockedCommercialContext },
    {
      provide: PROMOTIONS_JWKS,
      inject: [PromotionsConfigService],
      useFactory: remotePromotionsKeys,
    },
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
