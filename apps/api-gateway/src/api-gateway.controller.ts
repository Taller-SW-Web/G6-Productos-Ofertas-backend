import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiGatewayService } from './api-gateway.service.js';
import { GatewayReadiness } from './routing/gateway-readiness.js';

@Controller()
export class ApiGatewayController {
  constructor(
    private readonly Service: ApiGatewayService,
    private readonly readiness: GatewayReadiness,
  ) {}

  @Get('health')
  getHealth() {
    return this.Service.getHealth();
  }

  @Get('health/ready')
  async getReadiness(@Res() res: Response) {
    const result = await this.readiness.check();
    const isReady =
      result.status === 'ready' &&
      (result.coverage === 'complete' ||
        process.env.GATEWAY_ALLOW_PARTIAL_READINESS === 'true');
    return res
      .status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        ...result,
        status: isReady ? 'ready' : 'not_ready',
        service: 'api-gateway',
      });
  }
}
