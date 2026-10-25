import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BulkSvcService } from './bulk-svc.service.js';
import { BulkReadinessService } from './health/bulk-readiness.service.js';

@Controller()
export class BulkSvcController {
  constructor(
    private readonly service: BulkSvcService,
    private readonly readiness: BulkReadinessService,
  ) {}

  @Get('health')
  getHealth() {
    return this.service.getHealth();
  }

  @Get('health/readiness')
  async getReadiness(@Res() response: Response) {
    const ready = await this.readiness.check();
    return response
      .status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        status: ready ? 'ready' : 'not_ready',
        service: 'bulk-svc',
      });
  }
}
