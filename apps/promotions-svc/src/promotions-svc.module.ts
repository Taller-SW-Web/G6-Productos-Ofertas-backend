import { Module } from '@nestjs/common';
import { PromotionsSvcController } from './promotions-svc.controller.js';
import { PromotionsSvcService } from './promotions-svc.service.js';

@Module({
  imports: [],
  controllers: [PromotionsSvcController],
  providers: [PromotionsSvcService],
})
export class PromotionsSvcModule {}
