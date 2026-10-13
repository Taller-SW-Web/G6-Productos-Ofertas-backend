import { Controller, Get } from '@nestjs/common';
import { InventorySvcService } from './inventory-svc.service.js';

@Controller()
export class InventorySvcController {
  constructor(private readonly Service: InventorySvcService) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }
}