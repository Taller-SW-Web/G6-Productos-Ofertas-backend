import {
  BadRequestException,
  ForbiddenException,
  Controller,
  Get,
  Headers,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CommercialService } from './commercial.service.js';
import { isCorrelationId } from './correlation.js';
import { parseProductQuery } from './catalog-query.js';
import {
  CatalogAuthGuard,
  RequireCatalogIdentity,
  type CatalogPrincipal,
} from './catalog-auth.js';

@Controller('api/v1/productos')
@UseGuards(CatalogAuthGuard)
export class CommercialController {
  constructor(private readonly service: CommercialService) {}
  private validateCorrelation(value?: string): void {
    if (value !== undefined && !isCorrelationId(value))
      throw new BadRequestException();
  }
  @Get()
  @RequireCatalogIdentity({
    demoRead: true,
    identity: 'either',
    scope: 'catalogo:leer',
    allowedClients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
  })
  list(
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
    @Req()
    request?: Request & {
      catalogPrincipal?: CatalogPrincipal;
      catalogDemoRead?: boolean;
    },
  ) {
    this.validateCorrelation(correlationId);
    if (
      query.estado !== undefined &&
      !request?.catalogDemoRead &&
      (request?.catalogPrincipal?.kind !== 'user' ||
        !request.catalogPrincipal.roles.includes('GESTOR_COMERCIAL'))
    )
      throw new ForbiddenException();
    const administrativeState =
      request?.catalogDemoRead ||
      (request?.catalogPrincipal?.kind === 'user' &&
        request.catalogPrincipal.roles.includes('GESTOR_COMERCIAL'));
    return this.service.list(
      parseProductQuery(query),
      correlationId,
      administrativeState,
      {
        authorization: request?.headers.authorization,
        user: request?.catalogPrincipal?.kind === 'user',
      },
    );
  }
  @Get('por-slug/:slug')
  @RequireCatalogIdentity({
    demoRead: true,
    identity: 'either',
    scope: 'catalogo:leer',
    allowedClients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
  })
  detail(
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
    @Headers('x-correlation-id') correlationId?: string,
    @Req() request?: Request & { catalogPrincipal?: CatalogPrincipal },
  ) {
    this.validateCorrelation(correlationId);
    return this.service.detail(
      slug,
      parseProductQuery(query, true),
      correlationId,
      {
        authorization: request?.headers.authorization,
        user: request?.catalogPrincipal?.kind === 'user',
      },
    );
  }
}
