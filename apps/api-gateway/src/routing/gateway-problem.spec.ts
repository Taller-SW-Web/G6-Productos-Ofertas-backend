import { CONTRACT_ROUTES } from './contract-routes.js';
import { gatewayProblem } from './gateway-problem.js';

describe('Gateway and provider problem boundaries (H-01)', () => {
  const seo = CONTRACT_ROUTES.find(
    (route) => route.operationId === 'obtenerSeoPorSlug',
  )!;
  it.each([
    [400, 'VALIDACION'],
    [401, 'TOKEN_INVALIDO'],
    [403, 'SCOPE_INSUFICIENTE'],
    [503, 'SERVICIO_NO_DISPONIBLE'],
  ] as const)(
    'preserves local %s %s independently of provider status declarations',
    (status, code) => {
      expect(gatewayProblem(seo, status, code, 'gateway')).toEqual({
        status,
        code,
      });
    },
  );
  it('does not expand the provider contract or trust arbitrary local codes', () => {
    expect(seo.responses['403']).toBeUndefined();
    expect(gatewayProblem(seo, 403, 'SCOPE_INSUFICIENTE', 'provider')).toEqual({
      status: 500,
      code: 'ERROR_INTERNO',
    });
    expect(
      gatewayProblem(seo, 400, 'PRIVATE_UPSTREAM_SECRET', 'gateway'),
    ).toEqual({ status: 500, code: 'ERROR_INTERNO' });
  });
  it('accepts only the declared provider import error pair (H-02)', () => {
    const upload = CONTRACT_ROUTES.find(
      (route) => route.operationId === 'crearImportacionGeneralProductos',
    )!;
    expect(
      gatewayProblem(upload, 413, 'ARCHIVO_EXCEDE_LIMITE', 'provider'),
    ).toEqual({ status: 413, code: 'ARCHIVO_EXCEDE_LIMITE' });
    expect(gatewayProblem(upload, 413, 'VALIDACION', 'provider')).toEqual({
      status: 500,
      code: 'ERROR_INTERNO',
    });
  });
});
