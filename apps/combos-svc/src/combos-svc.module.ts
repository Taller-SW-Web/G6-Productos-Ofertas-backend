import { Module } from '@nestjs/common';
import { CombosSvcController } from './combos-svc.controller.js';
import { CombosSvcService } from './combos-svc.service.js';

@Module({
  imports: [],
  controllers: [CombosSvcController],
  providers: [CombosSvcService],
})
export class CombosSvcModule {}
