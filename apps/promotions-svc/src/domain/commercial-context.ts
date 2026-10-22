import type { RecommendationCandidate } from './promotion-rules.js';
export interface BasketRequest {
  channel_id: string;
  lines: { sku: string; quantity: number; product_id?: string | null }[];
  at?: string | null;
  coupon_code?: string | null;
  customer_ref?: string | null;
}
export interface ResolvedLine {
  sku: string;
  productId: string;
  quantity: number;
  regular: string;
  offer: string | null;
  currency: string;
  active: boolean;
  channelEligible: boolean;
}
export interface ResolvedBasket {
  lines: ResolvedLine[];
}
export interface CommercialContext {
  basket(request: BasketRequest, at: string): Promise<ResolvedBasket>;
  recommendationOrigin(
    productId: string,
    channel: string,
  ): Promise<{ active: boolean; channelEligible: boolean; categoryId: string }>;
  recommendationProducts(
    ids: readonly string[],
    channel: string,
  ): Promise<
    ReadonlyMap<
      string,
      Pick<
        RecommendationCandidate,
        'active' | 'channelEligible' | 'availability' | 'currentPrice'
      >
    >
  >;
}
export const COMMERCIAL_CONTEXT = Symbol('COMMERCIAL_CONTEXT');
export class CommercialDependencyError extends Error {
  constructor(
    readonly operation: string,
    readonly owner: string,
    readonly unblock: string,
  ) {
    super('COMMERCIAL_CONTEXT_UNAVAILABLE');
  }
}
// Explicit integration gate, never substituted with production arrays or invented snapshot fields.
// Catalog/Pricing GenericData payloads have no agreed typed adapter yet. Recommendations
// additionally require D-REC-01/02. An authenticated adapter must replace this provider.
export const blockedCommercialContext: CommercialContext = {
  basket: async () => {
    throw new CommercialDependencyError(
      'evaluarPromociones/validarCupon',
      'Catálogo/Pricing + integración G6',
      'adaptador con identidad autorizada, precios vigentes SKU/canal y elegibilidad verificable',
    );
  },
  recommendationOrigin: async () => {
    throw new CommercialDependencyError(
      'obtenerRecomendaciones',
      'Catálogo + integración G6',
      'adaptador contractual autenticado para origen/categoría y elegibilidad de canal',
    );
  },
  recommendationProducts: async () => {
    throw new CommercialDependencyError(
      'obtenerRecomendaciones',
      'Catálogo/Pricing/Inventario + arquitectura G6',
      'adaptador autenticado para productos simples; en productos con múltiples SKU resolver D-REC-01/02 sin agregarlos por inferencia',
    );
  },
};
