import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { parseCommercialQuery } from './commercial-prices.js';
import { PricingReadGuard } from './pricing-read.guard.js';
import { SignedUser } from '../../test/signed-user.js';
describe('Consultas comerciales contractuales', () => {
  it('conserva límite de 100 SKU, canal e instante explícitos', () => {
    expect(
      parseCommercialQuery(
        {
          skus: Array.from({ length: 100 }, (_, i) => 'SKU-' + i).join(','),
          canal: 'RETAIL',
          at: '2026-10-01T00:00:00Z',
        },
        true,
      ).skus,
    ).toHaveLength(100);
  });
  it.each([
    { skus: '' },
    { skus: 'SKU,' },
    { skus: ['SKU'] },
    { skus: Array(101).fill('SKU').join(',') },
    { skus: 'SKU', canal: 'OTHER' },
    { skus: 'SKU', at: '2026-02-30T00:00:00Z' },
    { skus: 'SKU', at: '2026-01-01' },
    { skus: 'SKU', unexpected: 'field' },
  ])('rechaza consulta inválida %j', (query) =>
    expect(() => parseCommercialQuery(query, true)).toThrow(),
  );
});
describe('JWT técnico solo para operationIds comerciales autorizados', () => {
  const identity = new SignedUser();
  let guard: PricingReadGuard;
  beforeAll(async () => {
    await identity.start();
    guard = new PricingReadGuard({
      nodeEnv: 'test',
      port: 3002,
      databaseUrl: 'unused',
      databaseSsl: false,
      auth: { issuer: identity.issuer, jwksUrl: identity.issuer + '/jwks' },
    });
  });
  afterAll(() => identity.stop());
  const token = (extra: Record<string, unknown> = {}) =>
    identity.token({
      tipo: 'servicio',
      sub: 'modulo-marketplace',
      aud: ['api-productos'],
      scope: 'precios:leer',
      roles: undefined,
      jti: undefined,
      iat: undefined,
      ...extra,
    });
  it('admite claims mínimos de servicio y no exige roles humanos', async () => {
    await expect(guard.authorize(token(), true)).resolves.toBeUndefined();
  });
  it('no autoriza el token técnico para una consulta administrativa', async () => {
    await expect(guard.authorize(token(), false)).rejects.toMatchObject({
      status: 401,
    });
  });
  it.each([
    [{ aud: 'another-api' }, 401],
    [{ scope: 'catalogo:leer' }, 403],
    [{ sub: 'modulo-ventas' }, 403],
    [{ exp: 1 }, 401],
    [{ iss: 'https://other.invalid' }, 401],
  ] as const)(
    'rechaza audiencia/scope/cliente/firma temporal inválidos: %j',
    async (extra, status) => {
      await expect(guard.authorize(token(extra), true)).rejects.toMatchObject({
        status,
      });
    },
  );
});
