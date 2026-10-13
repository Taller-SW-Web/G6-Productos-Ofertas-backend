import { Controller, Get } from '@nestjs/common';
import { ApiGatewayService } from './api-gateway.service.js';

@Controller()
export class ApiGatewayController {
  constructor(private readonly Service: ApiGatewayService) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }
}