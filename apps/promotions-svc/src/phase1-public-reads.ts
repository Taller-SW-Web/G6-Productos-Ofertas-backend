/** Temporary academic Phase 1 exception authorized by the operator on 2026-11-06.
 * Exact read routes only; explicit runtime selection, no inferred principal or IP.
 * Pricing prevalidation remains excluded until its real handler can be certified.
 */
export const PHASE1_PUBLIC_READS = [
  {
    operationId: 'listarPromociones',
    method: 'GET',
    path: '/api/v1/promociones',
  },
  {
    operationId: 'evaluarPromociones',
    method: 'POST',
    path: '/api/v1/promociones/evaluar',
  },
  {
    operationId: 'validarCupon',
    method: 'POST',
    path: '/api/v1/cupones/validar',
  },
  {
    operationId: 'obtenerRecomendaciones',
    method: 'GET',
    path: '/api/v1/recomendaciones',
  },
  {
    operationId: 'listarCupones',
    method: 'GET',
    path: '/api/v1/cupones',
  },
  {
    operationId: 'obtenerCuponAdmin',
    method: 'GET',
    path: '/api/v1/cupones/{cuponId}',
  },
  {
    operationId: 'obtenerPromocionAdmin',
    method: 'GET',
    path: '/api/v1/promociones/{promocionId}',
  },
  {
    operationId: 'listarReglasRecomendacion',
    method: 'GET',
    path: '/api/v1/recomendaciones/reglas',
  },
  {
    operationId: 'obtenerReglaRecomendacion',
    method: 'GET',
    path: '/api/v1/recomendaciones/reglas/{reglaId}',
  },
  {
    operationId: 'listarPromocionesAdmin',
    method: 'GET',
    path: '/api/v1/promociones/administracion',
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
