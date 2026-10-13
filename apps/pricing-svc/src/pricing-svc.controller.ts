import { Controller, Get } from '@nestjs/common';
import { PricingSvcService } from './pricing-svc.service.js';

@Controller()
export class PricingSvcController {
  constructor(private readonly Service: PricingSvcService) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }
}