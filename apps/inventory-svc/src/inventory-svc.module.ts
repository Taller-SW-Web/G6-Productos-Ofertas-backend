import { Module } from '@nestjs/common';
import { InventorySvcController } from './inventory-svc.controller.js';
import { InventorySvcService } from './inventory-svc.service.js';

@Module({
  imports: [],
  controllers: [InventorySvcController],
  providers: [InventorySvcService],
})
export class InventorySvcModule {}
