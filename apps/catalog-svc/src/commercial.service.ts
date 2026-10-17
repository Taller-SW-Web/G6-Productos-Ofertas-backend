import {
  Inject,
  Injectable,
  HttpException,
  ForbiddenException,
  ServiceUnavailableException,
  Optional,
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
import type { TaxonomyIdentity } from './taxonomy.client.js';
import {
  CATALOG_READ_DEMO,
  type CatalogReadDemo,
} from './catalog-read-demo.js';

@Injectable()
export class CommercialService {
  constructor(
    private readonly repository: PostgresCatalogRepository,
    @Inject(COMMERCIAL_ELIGIBILITY)
    private readonly eligibility: CommercialEligibilityPolicy,
    private readonly taxonomy: TaxonomyClient,
    @Optional()
    @Inject(CATALOG_READ_DEMO)
    private readonly readDemo: CatalogReadDemo = { enabled: false },
  ) {}
  async list(
    query: ProductQuery,
    correlationId?: string,
    administrativeState = false,
    identity?: TaxonomyIdentity,
  ): Promise<ProductPage> {
    if (query.precioMin !== undefined || query.precioMax !== undefined) {
      // Falta semántica de precio por producto y frontera Pricing aprobada.
      throw new ServiceUnavailableException();
    }
    if (query.categoriaId !== undefined)
      await this.taxonomy.category(query.categoriaId, correlationId, identity);
    if (query.marcaId !== undefined)
      await this.taxonomy.brand(query.marcaId, correlationId, identity);
    const isAdministrativeState =
      query.estado !== undefined && query.estado !== 'ACTIVO';
    if (isAdministrativeState && !administrativeState)
      throw new ForbiddenException();
    if (this.readDemo.enabled)
      return this.repository.listCandidates(query, undefined, true);
    const selection = isAdministrativeState
      ? undefined
      : await this.eligibility.resolve(query.canal);
    return this.repository.listCandidates(query, selection);
  }
  async detail(
    slug: string,
    query: ProductQuery,
    correlationId?: string,
    identity?: TaxonomyIdentity,
  ): Promise<ProductDetail> {
    const selection = this.readDemo.enabled
      ? undefined
      : await this.eligibility.resolve(query.canal);
    const product = this.readDemo.enabled
      ? await this.repository.findCandidateBySlug(
          slug,
          undefined,
          query.canal,
          true,
        )
      : await this.repository.findCandidateBySlug(slug, selection, query.canal);
    if (!product)
      throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
    try {
      return {
        ...product,
        marca: await this.taxonomy.brand(
          product.marca_id,
          correlationId,
          identity,
        ),
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
    identity?: TaxonomyIdentity,
  ): Promise<ProductDetail> {
    const selection = this.readDemo.enabled
      ? undefined
      : await this.eligibility.resolve(canal);
    const product = this.readDemo.enabled
      ? await this.repository.findCandidateByProductId(
          productId,
          undefined,
          canal,
          true,
        )
      : await this.repository.findCandidateByProductId(
          productId,
          selection,
          canal,
        );
    if (!product)
      throw new HttpException({ code: 'PRODUCTO_NO_ENCONTRADO' }, 404);
    try {
      return {
        ...product,
        marca: await this.taxonomy.brand(
          product.marca_id,
          correlationId,
          identity,
        ),
      };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
