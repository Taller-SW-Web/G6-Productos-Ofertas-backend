import { Controller, Get } from '@nestjs/common';
import { BulkSvcService } from './bulk-svc.service.js';

@Controller()
export class BulkSvcController {
  constructor(private readonly Service: BulkSvcService) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }
}