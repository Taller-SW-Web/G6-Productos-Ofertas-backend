/** Temporary academic Phase 1 exception authorized by the operator on 2026-11-06.
 * Exact read routes only; explicit runtime selection, no inferred principal or IP.
 * Pricing prevalidation remains excluded until its real handler can be certified.
 */
export const PHASE1_PUBLIC_READS = [
  {
    operationId: 'obtenerContextoSku',
    method: 'GET',
    path: '/api/v1/productos/skus/{sku}/contexto',
  },
  {
    operationId: 'listarProductos',
    method: 'GET',
    path: '/api/v1/productos',
  },
  {
    operationId: 'obtenerProducto',
    method: 'GET',
    path: '/api/v1/productos/{productoId}',
  },
  {
    operationId: 'consultarDatosFisicos',
    method: 'POST',
    path: '/api/v1/productos/datos-fisicos/consulta',
  },
  {
    operationId: 'obtenerProductoPorSlug',
    method: 'GET',
    path: '/api/v1/productos/por-slug/{slug}',
  },
  {
    operationId: 'obtenerPreparacionProducto',
    method: 'GET',
    path: '/api/v1/productos/{productoId}/preparacion',
  },
  {
    operationId: 'listarVariantesProducto',
    method: 'GET',
    path: '/api/v1/productos/{productoId}/variantes',
  },
  {
    operationId: 'obtenerVariante',
    method: 'GET',
    path: '/api/v1/productos/{productoId}/variantes/{variantId}',
  },
  {
    operationId: 'resolverCodigoBarras',
    method: 'POST',
    path: '/api/v1/productos/codigos-barras/resolver',
  },
] as const;

export const PHASE1_PUBLIC_OPERATION_IDS = new Set<string>(
  PHASE1_PUBLIC_READS.map((route) => route.operationId),
);

export interface Phase1Request {
  readonly method?: string;
  readonly path?: string;
  readonly headers: { readonly authorization?: unknown };
}

export function isPhase1PublicRead(
  _request: Phase1Request,
  _mode: string | undefined,
  _enabled: readonly string[] = [],
  _operationId?: string,
): boolean {
  return false;
}
