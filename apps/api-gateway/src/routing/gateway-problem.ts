import type { Response } from 'express';
import type { ContractRoute } from './contract-route.js';

// Gateway validation/auth/availability failures precede the provider operation.
// Keep this closed set separate from per-operation provider response metadata.
const localCodes: Readonly<Record<number, readonly string[]>> = {
  400: ['VALIDACION'],
  401: ['TOKEN_INVALIDO'],
  403: ['SCOPE_INSUFICIENTE'],
  503: ['SERVICIO_NO_DISPONIBLE'],
};

export function gatewayProblem(
  route: ContractRoute,
  status: number,
  code: string,
  source: 'gateway' | 'provider',
): { status: number; code: string } {
  const allowed =
    source === 'gateway'
      ? localCodes[status]?.includes(code)
      : route.responses[String(status)]?.codes.includes(code);
  return allowed ? { status, code } : { status: 500, code: 'ERROR_INTERNO' };
}

export function sendGatewayProblem(
  res: Response,
  route: ContractRoute,
  status: number,
  code: string,
  correlationId: string,
  source: 'gateway' | 'provider',
): void {
  const problem = gatewayProblem(route, status, code, source);
  const titles: Readonly<Record<number, string>> = {
    400: 'Datos de entrada inválidos',
    401: 'No autenticado',
    403: 'Permisos insuficientes',
    413: 'Archivo excede el límite',
    503: 'Servicio no disponible',
  };
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({
      title: titles[problem.status] ?? 'Error interno',
      ...problem,
      correlationId,
    });
}
