import { Module } from '@nestjs/common';
import { TaxonomySvcController } from './taxonomy-svc.controller.js';
import { TaxonomySvcService } from './taxonomy-svc.service.js';

@Module({
  imports: [],
  controllers: [TaxonomySvcController],
  providers: [TaxonomySvcService],
})
export class TaxonomySvcModule {}
