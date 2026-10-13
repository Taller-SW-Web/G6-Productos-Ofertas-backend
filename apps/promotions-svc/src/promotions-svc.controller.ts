import { Controller, Get } from '@nestjs/common';
import { PromotionsSvcService } from './promotions-svc.service.js';

@Controller()
export class PromotionsSvcController {
  constructor(private readonly Service: PromotionsSvcService) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }
}
