import { createSign, generateKeyPairSync } from 'node:crypto';
import { BulkServiceBearerGuard } from './bulk-service-bearer.guard.js';

describe('Bulk internal service bearer authorization', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const original = {
    issuer: process.env.G7_JWT_ISSUER,
    key: process.env.G7_JWT_PUBLIC_KEY,
    mode: process.env.G6_SECURITY_MODE,
  };
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
    process.env.G7_JWT_ISSUER = 'bulk-service-test-issuer';
    process.env.G7_JWT_PUBLIC_KEY = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    delete process.env.G7_JWT_JWKS_URL;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries({
      G7_JWT_ISSUER: original.issuer,
      G7_JWT_PUBLIC_KEY: original.key,
      G6_SECURITY_MODE: original.mode,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.G7_JWT_JWKS_URL;
  });

  function context(claimOverrides: Record<string, unknown> = {}) {
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT' });
    const claims = encode({
      iss: 'bulk-service-test-issuer',
      sub: 'catalog-svc',
      client_id: 'catalog-svc',
      tipo: 'servicio',
      aud: 'api-productos',
      scope: 'carga-masiva:contenidos:leer',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      jti: 'service-token-id',
      ...claimOverrides,
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const token = `${header}.${claims}.${signer.sign(keys.privateKey, 'base64url')}`;
    const request = { headers: { authorization: `Bearer ${token}` } };
    return { switchToHttp: () => ({ getRequest: () => request }) } as never;
  }

  it('accepts only the catalog service identity, audience and content-read scope', async () => {
    await expect(
      new BulkServiceBearerGuard().canActivate(context()),
    ).resolves.toBe(true);
    await expect(
      new BulkServiceBearerGuard().canActivate(
        context({ scope: 'catalogo:leer' }),
      ),
    ).rejects.toThrow('SCOPE_INSUFICIENTE');
    await expect(
      new BulkServiceBearerGuard().canActivate(
        context({ client_id: 'another-service' }),
      ),
    ).rejects.toThrow('SCOPE_INSUFICIENTE');
    await expect(
      new BulkServiceBearerGuard().canActivate(
        context({ aud: 'another-audience' }),
      ),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });
});
