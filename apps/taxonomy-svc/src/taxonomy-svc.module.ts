import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { TaxonomyController } from './taxonomy.controller.js';
import { TaxonomySvcController } from './taxonomy-svc.controller.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { UnconfiguredTaxonomyRepository } from './unconfigured-taxonomy.repository.js';

@Module({
  imports: [],
  controllers: [TaxonomySvcController, TaxonomyController],
  providers: [
    TaxonomySvcService,
    { provide: TAXONOMY_REPOSITORY, useClass: UnconfiguredTaxonomyRepository },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class TaxonomySvcModule {}
