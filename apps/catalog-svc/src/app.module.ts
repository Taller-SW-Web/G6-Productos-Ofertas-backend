import { ReadinessController } from './readiness.controller.js';
import { Module } from '@nestjs/common';
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

@Module({
  imports: [],
  controllers: [AppController, CommercialController, ReadinessController],
  providers: [
    AppService,
    Database,
    PostgresCatalogRepository,
    CommercialService,
    TaxonomyClient,
    { provide: COMMERCIAL_ELIGIBILITY, useClass: PendingCommercialEligibility },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule {}
