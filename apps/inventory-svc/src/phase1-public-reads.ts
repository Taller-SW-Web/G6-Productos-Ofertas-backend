/** Temporary academic Phase 1 exception authorized by the operator on 2026-11-06.
 * Exact read routes only; explicit runtime selection, no inferred principal or IP.
 * Pricing prevalidation remains excluded until its real handler can be certified.
 */
export const PHASE1_PUBLIC_READS = [
  {
    operationId: 'consultarDisponibilidad',
    method: 'GET',
    path: '/api/v1/inventario/disponibilidad',
  },
  {
    operationId: 'obtenerUmbralesInventario',
    method: 'GET',
    path: '/api/v1/inventario/umbrales',
  },
  {
    operationId: 'obtenerDashboardInventario',
    method: 'GET',
    path: '/api/v1/inventario/dashboard',
  },
  {
    operationId: 'listarTrasladosInventario',
    method: 'GET',
    path: '/api/v1/inventario/traslados',
  },
  {
    operationId: 'obtenerTrasladoInventario',
    method: 'GET',
    path: '/api/v1/inventario/traslados/{trasladoId}',
  },
  {
    operationId: 'consultarDisponibilidadComercial',
    method: 'GET',
    path: '/api/v1/inventario/disponibilidad/comercial',
  },
  {
    operationId: 'consultarOperacionInventario',
    method: 'GET',
    path: '/api/v1/inventario/operaciones/{operationId}',
  },
  {
    operationId: 'verificarCantidadComercial',
    method: 'POST',
    path: '/api/v1/inventario/disponibilidad/comercial/verificar',
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
