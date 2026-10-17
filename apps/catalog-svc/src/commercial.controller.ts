import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  Query,
} from '@nestjs/common';
import { CommercialService } from './commercial.service.js';
import { isCorrelationId } from './correlation.js';
import { parseProductQuery } from './catalog-query.js';

@Controller('api/v1/productos')
export class CommercialController {
  constructor(private readonly service: CommercialService) {}
  private validateCorrelation(value?: string): void {
    if (value !== undefined && !isCorrelationId(value))
      throw new BadRequestException();
  }
  @Get()
  list(
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.validateCorrelation(correlationId);
    return this.service.list(parseProductQuery(query), correlationId);
  }
  @Get('por-slug/:slug')
  detail(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    this.validateCorrelation(correlationId);
    return this.service.detail(
      slug,
      parseProductQuery(query, true),
      correlationId,
    );
  }
}
