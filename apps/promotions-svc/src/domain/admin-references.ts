import { CommercialDependencyError } from './commercial-context.js';

export interface AdminReferenceRequest {
  products: readonly string[];
  skus: readonly string[];
  categories: readonly string[];
}
export interface ActiveAdminReferences {
  products: ReadonlySet<string>;
  skus: ReadonlySet<string>;
  categories: ReadonlySet<string>;
}
// Only an authorized Catalog adapter can distinguish inactive/missing references
// from transport failure. GenericData does not define that projection mapping.
export interface AdminReferences {
  verify(
    request: AdminReferenceRequest,
    signal: AbortSignal,
  ): Promise<ActiveAdminReferences>;
}
export const ADMIN_REFERENCES = Symbol('ADMIN_REFERENCES');
export const blockedAdminReferences: AdminReferences = {
  verify: async () => {
    throw new CommercialDependencyError(
      'referencias administrativas',
      'Catálogo + integración G6/G7',
      'adaptador autorizado que verifique existencia y actividad de productos, SKU y categorías',
    );
  },
};
