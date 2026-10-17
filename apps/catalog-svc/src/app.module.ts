import { ReadinessController as CommercialReadinessController } from './readiness.controller.js';
import { DynamicModule, Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { APP_FILTER } from '@nestjs/core';
import { Database } from './database.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { CommercialService } from './commercial.service.js';
import { CommercialController } from './commercial.controller.js';
import {
  COMMERCIAL_ELIGIBILITY,
  PendingCommercialEligibility,
} from './commercial-eligibility.js';
import { TaxonomyClient } from './taxonomy.client.js';
import { ProblemFilter } from './problem.filter.js';
import { CatalogConfig } from './config.js';
import { PostgresReadiness } from './postgres-readiness.js';
import { CATALOG_DATABASE, ReadinessController } from './readiness.js';

@Module({
  imports: [],
  controllers: [AppController, CommercialController, ReadinessController],
  providers: [
    AppService,
    Database,
    PostgresCatalogRepository,
    CommercialService,
    TaxonomyClient,
    CommercialReadinessController,
    {
      provide: CATALOG_DATABASE,
      useFactory: (commercial: CommercialReadinessController) => ({
        check: async () => {
          await commercial.ready();
        },
      }),
      inject: [CommercialReadinessController],
    },
    { provide: COMMERCIAL_ELIGIBILITY, useClass: PendingCommercialEligibility },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule {
  static forRoot(config: CatalogConfig): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: CatalogConfig, useValue: config },
        {
          provide: CATALOG_DATABASE,
          useFactory: (commercial: CommercialReadinessController) => ({
            check: async () => {
              await new PostgresReadiness(config).check();
              await commercial.ready();
            },
          }),
          inject: [CommercialReadinessController],
        },
      ],
    };
  }
}
