import { ReadinessController as CommercialReadinessController } from './readiness.controller.js';
import { DynamicModule, Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { APP_FILTER } from '@nestjs/core';
import { CATALOG_POSTGRES_CONFIG, Database } from './database.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { PostgresCatalogWriteRepository } from './postgres-catalog-write.repository.js';
import { CatalogTransactionManager } from './catalog-transaction.js';
import { CommercialService } from './commercial.service.js';
import { CommercialController } from './commercial.controller.js';
import {
  COMMERCIAL_ELIGIBILITY,
  PendingCommercialEligibility,
} from './commercial-eligibility.js';
import {
  CATALOG_TAXONOMY_CONFIG,
  readTaxonomyConfig,
} from './taxonomy-config.js';
import { TaxonomyClient } from './taxonomy.client.js';
import { ProblemFilter } from './problem.filter.js';
import { CatalogConfig } from './config.js';
import { CATALOG_DATABASE, ReadinessController } from './readiness.js';
import { CatalogQueryRepository } from './catalog-query.repository.js';
import { CatalogQueryService } from './catalog-query.service.js';
import { CatalogQueryController } from './catalog-query.controller.js';
import {
  CATALOG_SECURITY_CONFIG,
  CatalogAuthGuard,
  CatalogTokenVerifier,
  readCatalogSecurityConfig,
} from './catalog-auth.js';

@Module({
  imports: [],
  controllers: [
    AppController,
    CommercialController,
    CatalogQueryController,
    ReadinessController,
  ],
  providers: [
    AppService,
    Database,
    CatalogTransactionManager,
    PostgresCatalogRepository,
    CatalogQueryRepository,
    PostgresCatalogWriteRepository,
    CommercialService,
    CatalogQueryService,
    TaxonomyClient,
    CatalogTokenVerifier,
    CatalogAuthGuard,
    {
      provide: CATALOG_SECURITY_CONFIG,
      useFactory: () => readCatalogSecurityConfig(process.env),
    },
    {
      provide: CATALOG_TAXONOMY_CONFIG,
      useFactory: () => readTaxonomyConfig(process.env),
    },
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
        { provide: CATALOG_TAXONOMY_CONFIG, useValue: config.taxonomy },
        { provide: CATALOG_SECURITY_CONFIG, useValue: config.security },
        { provide: CATALOG_POSTGRES_CONFIG, useValue: config.database },
      ],
    };
  }
}
