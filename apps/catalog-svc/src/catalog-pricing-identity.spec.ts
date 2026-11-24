import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogPricingIdentityProvider,
  CatalogIdentityAcquisitionError,
} from './catalog-pricing-identity.js';
import type { CatalogConfig } from './config.js';
import { CatalogTokenVerifier } from './catalog-auth.js';

describe('service identity retry classification', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [503, 'TRANSIENT'],
    [401, 'PERMANENT'],
    [403, 'PERMANENT'],
    [500, 'UNKNOWN'],
  ] as const)(
    'classifies token endpoint HTTP %i as %s without broad 5xx retry inference',
    async (status, classification) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('{}', {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      const config = {
        serviceCredentials: {
          tokenUrl: 'https://identity.example.test/token',
          clientSecret: 'test-secret',
        },
        security: {
          issuer: 'https://identity.example.test',
          jwksUrl: 'https://identity.example.test/jwks',
        },
      } as CatalogConfig;
      const provider = new CatalogPricingIdentityProvider(
        config,
        new CatalogTokenVerifier(undefined),
      );
      await expect(
        provider.authorizationForBulkRetry(AbortSignal.timeout(1000)),
      ).rejects.toMatchObject<CatalogIdentityAcquisitionError>({
        classification,
      });
    },
  );

  it('classifies an explicit request timeout as transient', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')),
    );
    const provider = new CatalogPricingIdentityProvider(
      {
        serviceCredentials: {
          tokenUrl: 'https://identity.example.test/token',
          clientSecret: 'test-secret',
        },
        security: {
          issuer: 'https://identity.example.test',
          jwksUrl: 'https://identity.example.test/jwks',
        },
      } as CatalogConfig,
      new CatalogTokenVerifier(undefined),
    );
    await expect(
      provider.authorizationForBulkRetry(AbortSignal.timeout(1000)),
    ).rejects.toMatchObject<CatalogIdentityAcquisitionError>({
      classification: 'TRANSIENT',
    });
  });
});
