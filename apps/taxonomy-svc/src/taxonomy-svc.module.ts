import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { ReadinessController } from './health/readiness.controller.js';
import { TAXONOMY_READINESS } from './health/readiness.port.js';
import { TaxonomyController } from './taxonomy.controller.js';
import { TaxonomySvcController } from './taxonomy-svc.controller.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { UnconfiguredTaxonomyRepository } from './unconfigured-taxonomy.repository.js';

@Module({
  imports: [],
  controllers: [TaxonomySvcController, TaxonomyController, ReadinessController],
  providers: [
    TaxonomySvcService,
    { provide: TAXONOMY_REPOSITORY, useClass: UnconfiguredTaxonomyRepository },
    { provide: TAXONOMY_READINESS, useExisting: TAXONOMY_REPOSITORY },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class TaxonomySvcModule {}
