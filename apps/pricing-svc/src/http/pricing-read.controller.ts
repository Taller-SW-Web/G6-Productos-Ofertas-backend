import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { PricingReads } from './pricing-reads.js';
import { PricingReadGuard, uuid } from './pricing-read.guard.js';
import { PricingHttpError, PricingHttpFilter } from './pricing-http.error.js';

function page(query: Record<string, unknown>) {
  if (Object.keys(query).some((key) => !['pagina', 'tamanio'].includes(key)))
    throw new PricingHttpError(400, 'VALIDACION');
  const parse = (value: unknown, fallback: number, maximum: number) => {
    if (value === undefined) return fallback;
    if (
      typeof value !== 'string' ||
      !/^[1-9]\d*$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) > maximum
    )
      throw new PricingHttpError(400, 'VALIDACION');
    return Number(value);
  };
  const tamanio = parse(query.tamanio, 20, 200);
  return {
    pagina: parse(
      query.pagina,
      1,
      Math.floor(Number.MAX_SAFE_INTEGER / tamanio),
    ),
    tamanio,
  };
}

@Controller('api/v1/precios')
@UseGuards(PricingReadGuard)
@UseFilters(PricingHttpFilter)
export class PricingReadController {
  constructor(@Inject(PricingReads) private readonly reads: PricingReads) {}

  @Get('productos/:productoId')
  product(
    @Param('productoId') productId: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (Object.keys(query).length)
      throw new PricingHttpError(400, 'VALIDACION');
    return this.reads.product(productId);
  }

  @Get('productos/:productoId/programaciones')
  productSchedules(
    @Param('productoId') productId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const { pagina, tamanio } = page(query);
    return this.reads.schedules({ productId }, pagina, tamanio);
  }

  @Get('skus/:sku/programaciones')
  skuSchedules(
    @Param('sku') sku: string,
    @Query() query: Record<string, unknown>,
  ) {
    const { pagina, tamanio } = page(query);
    return this.reads.schedules({ sku }, pagina, tamanio);
  }

  @Get('importaciones/:batchId')
  imported(
    @Param('batchId') batchId: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (!uuid.test(batchId) || Object.keys(query).length)
      throw new PricingHttpError(400, 'VALIDACION');
    return this.reads.imported(batchId);
  }
}
