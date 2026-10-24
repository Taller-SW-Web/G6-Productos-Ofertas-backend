import { Module } from '@nestjs/common';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';
import {
  parseBulkEnvironment,
  BULK_ENVIRONMENT,
  BULK_READINESS_POOL,
} from './config/bulk-environment.js';
import {
  BulkReadinessService,
  createBulkReadinessPool,
} from './health/bulk-readiness.service.js';

@Module({
  imports: [],
  controllers: [BulkSvcController],
  providers: [
    BulkSvcService,
    BulkReadinessService,
    {
      provide: BULK_ENVIRONMENT,
      useFactory: () => parseBulkEnvironment(process.env),
    },
    {
      provide: BULK_READINESS_POOL,
      inject: [BULK_ENVIRONMENT],
      useFactory: createBulkReadinessPool,
    },
  ],
})
export class BulkSvcModule {}
