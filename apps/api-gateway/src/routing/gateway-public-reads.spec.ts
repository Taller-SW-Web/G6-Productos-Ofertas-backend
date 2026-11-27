import { PHASE1_INTERNAL_READ_ROUTES } from './phase1-internal-read-routes.js';
import { matchContractRoute } from './gateway-proxy.js';
import { readGatewaySettings } from './gateway-settings.js';
import { CONTRACT_ROUTES } from './contract-routes.js';
import { isEligiblePublicRead } from './gateway-public-reads.js';
import { isDemoBypassRoute } from './gateway-identity.js';
import { createSignedIdentity } from '../../test/support/signed-identity.js';

describe('Universal G7 policy and retired Phase 1 public reads', () => {
  it('retires all public reads and rejects PUBLIC_READ_ONLY or allowlists', () => {
    expect(CONTRACT_ROUTES.filter(isEligiblePublicRead)).toEqual([]);
    expect(PHASE1_INTERNAL_READ_ROUTES).toEqual([]);
    expect(
      matchContractRoute('GET', '/api/v1/productos/skus/TEST/contexto'),
    ).toBeUndefined();
    expect(
      CONTRACT_ROUTES.some(
        (route) => route.operationId === 'obtenerContextosSku',
      ),
    ).toBe(false);
    for (const operation of [
      'listarProductos',
      'crearProducto',
      'prevalidarImportacionPrecios',
      'activarProducto',
      'obtenerSeoPorSlug',
    ])
      expect(() =>
        readGatewaySettings({
          G6_SECURITY_MODE: 'G7_AUTHENTICATED',
          GATEWAY_PUBLIC_OPERATION_IDS: operation,
        }),
      ).toThrow();
    expect(() =>
      readGatewaySettings({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      }),
    ).toThrow();
  });

  it('rejects legacy bypasses and SIMULATED_AUTH in production', () => {
    for (const mode of [
      'PUBLIC_READ_ONLY',
      'G7_AUTHENTICATED',
      'SIMULATED_AUTH',
    ])
      for (const flag of [
        'GATEWAY_DEMO_NO_AUTH_ENABLED',
        'G6_READ_ONLY_DEMO_ENABLED',
      ])
        expect(() =>
          readGatewaySettings({
            G6_SECURITY_MODE: mode,
            NODE_ENV: 'production',
            [flag]: 'true',
          }),
        ).toThrow();
    expect(() =>
      readGatewaySettings({
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        NODE_ENV: 'production',
        SIMULATED_AUTH_ISSUER: 'https://sim.example.test',
        SIMULATED_AUTH_JWKS_URL: 'https://sim.example.test/jwks',
      }),
    ).toThrow();
    const settings = readGatewaySettings({
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      G6_READ_ONLY_DEMO_ENABLED: 'false',
    });
    expect(
      isDemoBypassRoute(CONTRACT_ROUTES[0], {
        ...settings,
        demoNoAuthEnabled: true,
      }),
    ).toBe(false);
  });

  it('requires valid G7 JWT on every read, SEO and write route', async () => {
    const settings = readGatewaySettings({
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      AUTH_ISSUER: 'https://g7.example.test/auth',
      AUTH_JWKS_URL: 'https://g7.example.test/.well-known/jwks.json',
    });
    const signed = createSignedIdentity(settings);
    const human =
      'Bearer ' +
      signed.token({
        tipo: 'acceso',
        sub: '00000000-0000-4000-8000-000000000001',
        roles: ['GESTOR_COMERCIAL'],
      });
    const service =
      'Bearer ' +
      signed.token({
        tipo: 'servicio',
        sub: 'modulo-marketplace',
        aud: 'api-productos',
        scope: 'catalogo:leer',
      });
    for (const operation of ['crearProducto', 'obtenerPreparacionProducto']) {
      const route = CONTRACT_ROUTES.find((r) => r.operationId === operation)!;
      await expect(
        signed.identity.authorize(route, human),
      ).resolves.toBeUndefined();
      await expect(
        signed.identity.authorize(route, undefined),
      ).rejects.toMatchObject({ status: 401 });
    }
    const readRoute = CONTRACT_ROUTES.find(
      (r) => r.operationId === 'listarProductos',
    )!;
    await expect(
      signed.identity.authorize(readRoute, undefined),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      signed.identity.authorize(readRoute, 'Bearer invalid'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      signed.identity.authorize(readRoute, service),
    ).resolves.toBeUndefined();
  });
});
