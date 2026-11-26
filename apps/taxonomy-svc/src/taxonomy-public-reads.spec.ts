import {
  readTaxonomyPublicReadConfig,
  readTaxonomyDemoConfig,
  readTaxonomySecurityConfig,
} from './taxonomy-auth.js';

describe('G7-only Taxonomy configuration rejects PUBLIC_READ_ONLY and demo bypasses', () => {
  it('rejects a simulated issuer configured as the G7 issuer or outside test', () => {
    expect(() =>
      readTaxonomySecurityConfig({
        NODE_ENV: 'test',
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SIMULATED_AUTH_ISSUER: 'https://g7.test/auth',
        SIMULATED_AUTH_JWKS_URL: 'https://simulator.test/keys',
        SECURITY_ISSUER: 'https://g7.test/auth',
      }),
    ).toThrow(/independiente/);
    expect(() =>
      readTaxonomySecurityConfig({
        NODE_ENV: 'production',
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SIMULATED_AUTH_ISSUER: 'https://sim.test/auth',
        SIMULATED_AUTH_JWKS_URL: 'https://sim.test/keys',
      }),
    ).toThrow();
  });

  it('rejects PUBLIC_READ_ONLY and any non-empty TAXONOMY_PUBLIC_OPERATION_IDS', () => {
    expect(() =>
      readTaxonomyPublicReadConfig({
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      }),
    ).toThrow();
    expect(() =>
      readTaxonomyPublicReadConfig({
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        TAXONOMY_PUBLIC_OPERATION_IDS: 'listarCategorias,listarMarcas',
      }),
    ).toThrow();
  });

  it('accepts test-only simulated auth and rejects legacy bypasses', () => {
    expect(
      readTaxonomyPublicReadConfig({
        NODE_ENV: 'test',
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
      }),
    ).toMatchObject({ securityMode: 'SIMULATED_AUTH' });
    expect(() =>
      readTaxonomyDemoConfig({
        NODE_ENV: 'test',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        ALLOW_DEMO_UNAUTHENTICATED: 'true',
      }),
    ).toThrow();
    expect(
      readTaxonomyPublicReadConfig({
        NODE_ENV: 'production',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      }),
    ).toMatchObject({
      securityMode: 'G7_AUTHENTICATED',
      publicOperations: [],
    });
  });
});
