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
import { CatalogMutationController } from './catalog-mutation.controller.js';
import {
  CATALOG_PRODUCT_CREATION_POLICY,
  CatalogMutationService,
} from './catalog-mutation.service.js';
import { approvedCatalogProductPolicy } from './catalog-product.policy.js';
import { CatalogMasterClient } from './catalog-master.client.js';
import { CatalogMessageService } from './catalog-message.service.js';
import {
  CATALOG_AMQP_SETTINGS,
  CatalogAmqpRuntime,
  readCatalogAmqpConfig,
} from './catalog-amqp.js';
import {
  CATALOG_PREPARATION_CONFIG,
  preparationTimeout,
} from './catalog-messages.js';
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
    CatalogMutationController,
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
    CatalogMutationService,
    {
      provide: CATALOG_PRODUCT_CREATION_POLICY,
      useValue: approvedCatalogProductPolicy,
    },
    CatalogMasterClient,
    CatalogMessageService,
    CatalogAmqpRuntime,
    {
      provide: CATALOG_AMQP_SETTINGS,
      useFactory: () => ({ connection: readCatalogAmqpConfig() }),
    },
    {
      provide: CATALOG_PREPARATION_CONFIG,
      useFactory: () => ({ timeoutMs: preparationTimeout() }),
    },
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
        { provide: CATALOG_AMQP_SETTINGS, useValue: config.amqp },
        { provide: CATALOG_PREPARATION_CONFIG, useValue: config.preparation },
        { provide: CATALOG_POSTGRES_CONFIG, useValue: config.database },
      ],
    };
  }
}
