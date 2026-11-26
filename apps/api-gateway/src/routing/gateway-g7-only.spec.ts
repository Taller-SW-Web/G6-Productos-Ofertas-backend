import { describe, expect, it } from 'vitest';
import { readGatewaySettings } from './gateway-settings.js';
import { GatewayIdentity, GatewayFailure } from './gateway-identity.js';
import { CONTRACT_ROUTES } from './contract-routes.js';
import { isEligiblePublicRead } from './gateway-public-reads.js';

describe('Gateway G7-only policy (R2)', () => {
  it('rejects PUBLIC_READ_ONLY and non-empty GATEWAY_PUBLIC_OPERATION_IDS', () => {
    expect(() =>
      readGatewaySettings({
        NODE_ENV: 'production',
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      }),
    ).toThrow();
    expect(() =>
      readGatewaySettings({
        NODE_ENV: 'production',
        G6_SECURITY_MODE: 'G7_AUTHENTICATED',
        GATEWAY_PUBLIC_OPERATION_IDS: 'listarProductos',
      }),
    ).toThrow();
    expect(() =>
      readGatewaySettings({
        NODE_ENV: 'production',
        G6_SECURITY_MODE: 'SIMULATED_AUTH',
        SIMULATED_AUTH_ISSUER: 'https://sim.example.test',
        SIMULATED_AUTH_JWKS_URL: 'https://sim.example.test/jwks',
      }),
    ).toThrow();
  });

  it('never marks any route eligible for public read', () => {
    for (const route of CONTRACT_ROUTES) {
      expect(isEligiblePublicRead(route)).toBe(false);
    }
  });

  it('rejects unauthenticated requests to SEO and commercial read routes with 401 TOKEN_INVALIDO', async () => {
    const settings = readGatewaySettings({
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      AUTH_ISSUER: 'https://g7.example.test/auth',
      AUTH_JWKS_URL: 'https://g7.example.test/.well-known/jwks.json',
    });
    const identity = new GatewayIdentity(settings);
    for (const operationId of [
      'obtenerSeoPorSlug',
      'resolverSlugAnterior',
      'listarCategorias',
      'listarProductos',
      'evaluarPromociones',
    ]) {
      const route = CONTRACT_ROUTES.find((r) => r.operationId === operationId);
      expect(route).toBeDefined();
      await expect(identity.authorize(route!, undefined)).rejects.toEqual(
        new GatewayFailure(401, 'TOKEN_INVALIDO'),
      );
    }
  });
});
