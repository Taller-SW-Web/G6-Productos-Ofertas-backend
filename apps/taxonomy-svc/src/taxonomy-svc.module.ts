import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { ReadinessController } from './health/readiness.controller.js';
import { TAXONOMY_READINESS } from './health/readiness.port.js';
import { proveedorDeRepositorio } from './persistence/persistence.providers.js';
import { TaxonomyController } from './taxonomy.controller.js';
import { TaxonomySvcController } from './taxonomy-svc.controller.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';
import { TAXONOMY_REPOSITORY } from './taxonomy.repository.js';
import { Database } from './database.js';

export interface OpcionesModuloTaxonomy {
  databaseUrl?: string;
}

@Module({
  imports: [],
  controllers: [TaxonomySvcController, TaxonomyController, ReadinessController],
  providers: [
    TaxonomySvcService,
    Database,
    proveedorDeRepositorio(),
    { provide: TAXONOMY_READINESS, useExisting: TAXONOMY_REPOSITORY },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class TaxonomySvcModule {
  static forRoot(opciones: OpcionesModuloTaxonomy = {}): DynamicModule {
    if (!opciones.databaseUrl) {
      return {
        module: TaxonomySvcModule,
      };
    }
    return {
      module: TaxonomySvcModule,
      providers: [proveedorDeRepositorio(opciones.databaseUrl)],
    };
  }
}
