import { Module } from '@nestjs/common';
import { PriceAuditSvcController } from './price-audit-svc.controller.js';
import { PriceAuditSvcService } from './price-audit-svc.service.js';

@Module({
  imports: [],
  controllers: [PriceAuditSvcController],
  providers: [PriceAuditSvcService],
})
export class PriceAuditSvcModule {}
