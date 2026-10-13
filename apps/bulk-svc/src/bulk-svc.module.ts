import { Module } from '@nestjs/common';
import { BulkSvcController } from './bulk-svc.controller.js';
import { BulkSvcService } from './bulk-svc.service.js';

@Module({
  imports: [],
  controllers: [BulkSvcController],
  providers: [BulkSvcService],
})
export class BulkSvcModule {}
