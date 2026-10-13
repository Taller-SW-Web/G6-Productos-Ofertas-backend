import { Controller, Get } from '@nestjs/common';
import { TaxonomySvcService } from './taxonomy-svc.service.js';

@Controller()
export class TaxonomySvcController {
  constructor(private readonly Service: TaxonomySvcService) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }
}