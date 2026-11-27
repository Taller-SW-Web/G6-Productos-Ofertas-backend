import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CatalogAuthGuard, RequireCatalogIdentity } from './catalog-auth.js';
import { CatalogQueryService } from './catalog-query.service.js';
import { isCorrelationId } from './correlation.js';

@Controller('interno/productos/skus')
@UseGuards(CatalogAuthGuard)
export class CatalogInternalSkuController {
  constructor(private readonly service: CatalogQueryService) {}

  @Post('filtrar')
  @HttpCode(200)
  @RequireCatalogIdentity({
    identity: 'service',
    scope: 'catalogo:leer',
    allowedClients: ['inventory-svc'],
  })
  filterSellableSkus(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (correlationId !== undefined && !isCorrelationId(correlationId))
      throw new BadRequestException({ code: 'VALIDACION' });
    return this.service.filterSellableSkus(body);
  }
}
