import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PricingReadiness } from './pricing-readiness.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PricingReadiness) private readonly readiness: PricingReadiness,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok', service: 'pricing-svc' };
  }
  @Get('ready')
  async ready() {
    if (!(await this.readiness.check())) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        service: 'pricing-svc',
      });
    }
    return { status: 'ready', service: 'pricing-svc' };
  }
}
