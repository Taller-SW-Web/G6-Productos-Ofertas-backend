import {
  Inject,
  Injectable,
  HttpException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { COMMERCIAL_ELIGIBILITY } from './commercial-eligibility.js';
import type { CommercialEligibilityPolicy } from './commercial-eligibility.js';
import type {
  ProductQuery,
  ProductDetail,
  ProductPage,
} from './commercial.types.js';
import { PostgresCatalogRepository } from './postgres-catalog.repository.js';
import { TaxonomyClient } from './taxonomy.client.js';

@Injectable()
export class CommercialService {
  constructor(
    private readonly repository: PostgresCatalogRepository,
    @Inject(COMMERCIAL_ELIGIBILITY)
    private readonly eligibility: CommercialEligibilityPolicy,
    private readonly taxonomy: TaxonomyClient,
  ) {}
  async list(
    query: ProductQuery,
    correlationId?: string,
    administrativeState = false,
  ): Promise<ProductPage> {
    if (query.precioMin !== undefined || query.precioMax !== undefined) {
      // Falta semántica de precio por producto y frontera Pricing aprobada.
      throw new ServiceUnavailableException();
    }
    if (query.categoriaId !== undefined)
      await this.taxonomy.category(query.categoriaId, correlationId);
    if (query.marcaId !== undefined)
      await this.taxonomy.brand(query.marcaId, correlationId);
    const isAdministrativeState =
      query.estado !== undefined && query.estado !== 'ACTIVO';
    if (isAdministrativeState && !administrativeState)
      throw new ForbiddenException();
    const selection = isAdministrativeState
      ? undefined
      : await this.eligibility.resolve(query.canal);
    return this.repository.listCandidates(query, selection);
  }
  async detail(
    slug: string,
    query: ProductQuery,
    correlationId?: string,
  ): Promise<ProductDetail> {
    const selection = await this.eligibility.resolve(query.canal);
    const product = await this.repository.findCandidateBySlug(
      slug,
      selection,
      query.canal,
    );
    if (!product)
      throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
    try {
      return {
        ...product,
        marca: await this.taxonomy.brand(product.marca_id, correlationId),
      };
    } catch {
      // La marca obligatoria no se fabrica ni se reemplaza por el ID.
      throw new ServiceUnavailableException();
    }
  }

  async productById(
    productId: string,
    canal: ProductQuery['canal'],
    correlationId?: string,
  ): Promise<ProductDetail> {
    const selection = await this.eligibility.resolve(canal);
    const product = await this.repository.findCandidateByProductId(
      productId,
      selection,
      canal,
    );
    if (!product)
      throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
    try {
      return {
        ...product,
        marca: await this.taxonomy.brand(product.marca_id, correlationId),
      };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
