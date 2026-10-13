import { Controller, Get } from '@nestjs/common';
import { PriceAuditSvcService } from './price-audit-svc.service.js';

@Controller()
export class PriceAuditSvcController {
  constructor(private readonly Service: PriceAuditSvcService) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }
}
