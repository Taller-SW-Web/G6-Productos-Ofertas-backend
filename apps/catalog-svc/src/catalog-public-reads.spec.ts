import { readCatalogReadDemo } from './catalog-read-demo.js';
import { readCatalogSecurityConfig } from './catalog-auth.js';

describe('G7-only Catalog configuration rejects PUBLIC_READ_ONLY and demo bypasses', () => {
  it('rejects a simulated issuer configured as the G7 issuer or outside test', () => {
    expect(() =>
      readCatalogSecurityConfig({
        NODE_ENV: 'test',
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SIMULATED_AUTH_ISSUER: 'https://g7.test/auth',
        SIMULATED_AUTH_JWKS_URL: 'https://simulator.test/keys',
        SECURITY_ISSUER: 'https://g7.test/auth',
      }),
    ).toThrow(/independiente/);
    expect(() =>
      readCatalogSecurityConfig({
        NODE_ENV: 'production',
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SIMULATED_AUTH_ISSUER: 'https://sim.test/auth',
        SIMULATED_AUTH_JWKS_URL: 'https://sim.test/keys',
      }),
    ).toThrow();
  });

  it('rejects PUBLIC_READ_ONLY and any non-empty CATALOG_PUBLIC_OPERATION_IDS', () => {
    expect(() =>
      readCatalogReadDemo({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        G6_READ_ONLY_DEMO_ENABLED: 'false',
      }),
    ).toThrow();
    expect(() =>
      readCatalogReadDemo({
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        CATALOG_PUBLIC_OPERATION_IDS: 'listarProductos',
      }),
    ).toThrow();
  });

  it('rejects legacy demo flags and accepts G7_AUTHENTICATED or test-only SIMULATED_AUTH', () => {
    for (const flag of [
      'G6_READ_ONLY_DEMO_ENABLED',
      'GATEWAY_DEMO_NO_AUTH_ENABLED',
      'CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED',
    ])
      expect(() =>
        readCatalogReadDemo({
          G6_SECURITY_MODE: 'G7_AUTHENTICATED',
          [flag]: 'true',
        }),
      ).toThrow();
    expect(
      readCatalogReadDemo({
        NODE_ENV: 'test',
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
      }),
    ).toMatchObject({ enabled: false, securityMode: 'SIMULATED_AUTH' });
    expect(
      readCatalogReadDemo({
        NODE_ENV: 'production',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      }),
    ).toMatchObject({
      enabled: false,
      securityMode: 'G7_AUTHENTICATED',
      publicOperations: [],
    });
  });
});
