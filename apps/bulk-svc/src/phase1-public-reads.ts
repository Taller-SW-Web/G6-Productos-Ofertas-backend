/** Temporary academic Phase 1 exception authorized by the operator on 2026-11-06.
 * Exact read routes only; explicit runtime selection, no inferred principal or IP.
 * Pricing prevalidation remains excluded until its real handler can be certified.
 */
export const PHASE1_PUBLIC_READS = [
  {
    operationId: 'descargarPlantillaProductos',
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/plantilla',
  },
  {
    operationId: 'obtenerImportacionGeneralProductos',
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/importaciones/{batchId}',
  },
  {
    operationId: 'descargarReporteImportacionGeneral',
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/importaciones/{batchId}/reporte',
  },
  {
    operationId: 'obtenerExportacionGeneralProductos',
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/exportaciones/{exportId}',
  },
  {
    operationId: 'descargarExportacionGeneralProductos',
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/exportaciones/{exportId}/archivo',
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
