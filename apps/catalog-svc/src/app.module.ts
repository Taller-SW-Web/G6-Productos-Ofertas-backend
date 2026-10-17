import { DynamicModule, Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CatalogConfig } from './config.js';
import { PostgresReadiness } from './postgres-readiness.js';
import {
  CATALOG_DATABASE,
  ReadinessController,
  UnconfiguredDatabase,
} from './readiness.js';

@Module({
  imports: [],
  controllers: [AppController, ReadinessController],
  providers: [
    AppService,
    { provide: CATALOG_DATABASE, useClass: UnconfiguredDatabase },
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
          useFactory: () => new PostgresReadiness(config),
        },
      ],
    };
  }
}
