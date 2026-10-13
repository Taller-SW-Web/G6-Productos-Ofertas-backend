import { Controller, Get } from '@nestjs/common';
import { CombosSvcService } from './combos-svc.service.js';

@Controller()
export class CombosSvcController {
  constructor(private readonly Service: CombosSvcService) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }
}