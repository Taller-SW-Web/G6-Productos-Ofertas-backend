import { Module } from '@nestjs/common';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';
import { BulkImportService } from './bulk-import.service.js';
import { BulkExportService } from './bulk-export.service.js';
import { BulkContentService } from './bulk-content.service.js';
import {
  parseBulkEnvironment,
  BULK_ENVIRONMENT,
  BULK_READINESS_POOL,
} from './config/bulk-environment.js';
import {
  BulkReadinessService,
  createBulkReadinessPool,
} from './health/bulk-readiness.service.js';
import { bulkDatabaseProvider } from './persistence/bulk.database.js';
import { bulkRepositoryProvider } from './persistence/bulk.repository.js';
import { BulkStorageService } from './storage/bulk-storage.service.js';
import { BulkUserBearerGuard } from './auth/bulk-user-bearer.guard.js';
import { BulkServiceBearerGuard } from './auth/bulk-service-bearer.guard.js';
import { BulkOutboxRelay } from './messaging/bulk-outbox-relay.js';
import {
  BULK_AMQP_URL,
  configuredBulkAmqpUrl,
} from './messaging/bulk-rabbitmq.js';
import {
  BULK_CONTRACT_RESULT_DISPATCHER,
  CatalogBulkResultConsumer,
} from './messaging/catalog-bulk-result-consumer.js';
import { BulkContractResultDispatcherService } from './messaging/bulk-contract-result-dispatcher.js';
import { BulkServiceBusRuntime } from './messaging/bulk-service-bus.runtime.js';
import { BULK_EXPORT_SOURCE } from './export/bulk-export-source.js';
import { HttpBulkExportSource } from './export/http-bulk-export-source.js';

@Module({
  imports: [],
  controllers: [BulkSvcController],
  providers: [
    BulkSvcService,
    BulkImportService,
    BulkExportService,
    BulkContentService,
    {
      provide: BULK_EXPORT_SOURCE,
      useFactory: () => {
        const catalogUrl = process.env.BULK_EXPORT_CATALOG_URL;
        const pricingUrl = process.env.BULK_EXPORT_PRICING_URL;
        const inventoryUrl = process.env.BULK_EXPORT_INVENTORY_URL;
        const tokenUrl = process.env.BULK_EXPORT_TOKEN_URL;
        const clientSecret = process.env.BULK_EXPORT_CLIENT_SECRET;
        if (
          !catalogUrl ||
          !pricingUrl ||
          !inventoryUrl ||
          !tokenUrl ||
          !clientSecret
        ) {
          return null;
        }
        return new HttpBulkExportSource({
          catalogUrl,
          pricingUrl,
          inventoryUrl,
          tokenUrl,
          clientId: process.env.BULK_EXPORT_CLIENT_ID ?? 'bulk-svc',
          clientSecret,
        });
      },
    },
    BulkStorageService,
    BulkUserBearerGuard,
    BulkServiceBearerGuard,
    BulkOutboxRelay,
    BulkContractResultDispatcherService,
    {
      provide: BULK_CONTRACT_RESULT_DISPATCHER,
      useExisting: BulkContractResultDispatcherService,
    },
    CatalogBulkResultConsumer,
    BulkServiceBusRuntime,
    BulkReadinessService,
    bulkDatabaseProvider,
    bulkRepositoryProvider,
    {
      provide: BULK_ENVIRONMENT,
      useFactory: () => parseBulkEnvironment(process.env),
    },
    {
      provide: BULK_AMQP_URL,
      useFactory: () => configuredBulkAmqpUrl(process.env),
    },
    {
      provide: BULK_READINESS_POOL,
      inject: [BULK_ENVIRONMENT],
      useFactory: createBulkReadinessPool,
    },
  ],
})
export class BulkSvcModule {}
