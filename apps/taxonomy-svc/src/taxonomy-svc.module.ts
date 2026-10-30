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
import { TaxonomyWriteRepository } from './persistence/taxonomy-write.repository.js';
import { TaxonomyWriteService } from './taxonomy-write.service.js';
import type { TaxonomyWriteUnitOfWork } from './persistence/taxonomy-write.unit-of-work.js';

export interface OpcionesModuloTaxonomy {
  databaseUrl?: string;
}

@Module({
  imports: [],
  controllers: [TaxonomySvcController, TaxonomyController, ReadinessController],
  providers: [
    TaxonomySvcService,
    TaxonomyWriteService,
    Database,
    TaxonomyWriteRepository,
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
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'TaxonomySvcModule.forRoot con databaseUrl no está permitido en runtime productivo; use iniciarTaxonomySvc con Database y las garantías obligatorias de TLS e identidad.',
      );
    }
    return {
      module: TaxonomySvcModule,
      providers: [
        proveedorDeRepositorio(opciones.databaseUrl),
        {
          provide: TaxonomyWriteRepository,
          useFactory: (repositorio: TaxonomyWriteUnitOfWork) =>
            new TaxonomyWriteRepository(repositorio),
          inject: [TAXONOMY_REPOSITORY],
        },
      ],
    };
  }
}
