import { Module } from '@nestjs/common';
import { PricingSvcController } from './pricing-svc.controller.js';
import { PricingSvcService } from './pricing-svc.service.js';

@Module({
  imports: [],
  controllers: [PricingSvcController],
  providers: [PricingSvcService],
})
export class PricingSvcModule {}
