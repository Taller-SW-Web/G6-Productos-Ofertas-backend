import { readGatewaySettings } from './gateway-settings.js';
import { createSignedIdentity } from '../../test/support/signed-identity.js';
import { CONTRACT_ROUTES } from './contract-routes.js';
import { GatewayIdentity } from './gateway-identity.js';

describe('Gateway identity from G6/G7 contracts', () => {
  const settings = readGatewaySettings({});
  const signed = createSignedIdentity(settings);
  const product = CONTRACT_ROUTES.find(
    (r) => r.operationId === 'listarProductos',
  )!;
  const reservation = CONTRACT_ROUTES.find(
    (r) => r.operationId === 'solicitarReserva',
  )!;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fetches only configured JWKS, reuses cached keys and fails closed after expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const remote = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ keys: [signed.key] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', remote);
    const identity = new GatewayIdentity({
      ...settings,
      issuer: 'https://isolated.test/issuer',
      jwksUrl: 'https://isolated.test/jwks',
    });
    const token = `Bearer ${signed.token()}`;
    await identity.authorize(product, token);
    remote.mockRejectedValue(new Error('JWKS offline'));
    await identity.authorize(product, token);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0][0]).toBe('https://isolated.test/jwks');
    vi.setSystemTime(Date.now() + 61000);
    await expect(identity.authorize(product, token)).rejects.toMatchObject({
      status: 503,
    });
  });

  it('verifies real RS256 signatures and contractual service claims', async () => {
    await expect(
      signed.identity.authorize(product, `Bearer ${signed.token()}`),
    ).resolves.toBeUndefined();
  });
  it.each([
    { iss: 'https://other.test' },
    { exp: 1 },
    { nbf: Math.floor(Date.now() / 1000) + 600 },
    { iat: undefined },
    { jti: '' },
    { tipo: 'refresh' },
  ])('rejects invalid signed claims %j', async (claims) => {
    await expect(
      signed.verifier.verify(signed.token(claims)),
    ).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALIDO' });
  });
  it.each([
    { alg: 'none' },
    { alg: 'HS256' },
    { kid: 'unknown' },
    { crit: ['unknown'] },
  ])('rejects untrusted token headers %j', async (header) => {
    await expect(
      signed.verifier.verify(signed.token({}, header)),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects tampering and unsigned data', async () => {
    const token = signed.token();
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'modulo-ventas' })).toString(
      'base64url',
    );
    await expect(signed.verifier.verify(parts.join('.'))).rejects.toMatchObject(
      { status: 401 },
    );
    await expect(signed.verifier.verify('not-a-jwt')).rejects.toMatchObject({
      status: 401,
    });
  });
  it('distinguishes wrong audience, scope and client allowlist', async () => {
    await expect(
      signed.identity.authorize(
        product,
        `Bearer ${signed.token({ aud: ['api-despacho'] })}`,
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      signed.identity.authorize(
        product,
        `Bearer ${signed.token({ scope: '' })}`,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      signed.identity.authorize(
        reservation,
        `Bearer ${signed.token({ scope: 'inventario:reservar' })}`,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      signed.identity.authorize(
        reservation,
        `Bearer ${signed.token({ sub: 'modulo-ventas', scope: 'inventario:reservar' })}`,
      ),
    ).resolves.toBeUndefined();
  });
  it('allows the human actor without inventing a service audience', async () => {
    const human = {
      tipo: 'acceso',
      sub: '11111111-1111-1111-1111-111111111111',
      roles: ['GESTOR_COMERCIAL'],
      aud: undefined,
      scope: undefined,
    };
    await expect(
      signed.identity.authorize(product, `Bearer ${signed.token(human)}`),
    ).resolves.toBeUndefined();
    await expect(
      signed.identity.authorize(
        product,
        `Bearer ${signed.token({ ...human, roles: ['CLIENTE'] })}`,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      signed.identity.authorize(reservation, `Bearer ${signed.token(human)}`),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('keeps Pricing mutations closed without required introspection', async () => {
    const pricing = CONTRACT_ROUTES.find(
      (r) => r.operationId === 'actualizarPrecioSku',
    )!;
    const token = signed.token({
      tipo: 'acceso',
      sub: '11111111-1111-1111-1111-111111111111',
      roles: ['GESTOR_COMERCIAL'],
    });
    await expect(
      signed.identity.authorize(pricing, `Bearer ${token}`),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('does not grant anonymous access merely because security is empty', async () => {
    const publicRoute = CONTRACT_ROUTES.find(
      (r) => r.operationId === 'obtenerSeoPorSlug',
    )!;
    await expect(
      signed.identity.authorize(publicRoute, undefined),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('fails closed before forwarding without token or trust configuration', async () => {
    const identity = new GatewayIdentity(settings);
    await expect(identity.authorize(product, undefined)).rejects.toMatchObject({
      status: 401,
    });
    const categories = CONTRACT_ROUTES.find(
      (route) => route.operationId === 'listarCategorias',
    )!;
    await expect(
      identity.authorize(categories, undefined),
    ).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      identity.authorize(product, `Bearer ${signed.token()}`),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('allows only the three exact demo GET operations without Authorization', async () => {
    const demoIdentity = new GatewayIdentity({
      ...settings,
      demoAnonymousEnabled: true,
    });
    const routes = [
      'listarCategorias',
      'listarProductos',
      'obtenerProductoPorSlug',
    ].map((operationId) =>
      CONTRACT_ROUTES.find((route) => route.operationId === operationId)!,
    );
    for (const route of routes) {
      expect(demoIdentity.usesDemoAnonymousAccess(route, undefined)).toBe(true);
      await expect(
        demoIdentity.authorize(route, undefined),
      ).resolves.toBeUndefined();
    }
    for (const route of [
      CONTRACT_ROUTES.find((r) => r.operationId === 'obtenerProducto')!,
      CONTRACT_ROUTES.find((r) => r.operationId === 'crearCategoria')!,
    ]) {
      expect(demoIdentity.usesDemoAnonymousAccess(route, undefined)).toBe(
        false,
      );
      await expect(
        demoIdentity.authorize(route, undefined),
      ).rejects.toMatchObject({
        status: 401,
      });
    }
    expect(demoIdentity.usesDemoAnonymousAccess(routes[0], '')).toBe(false);
    await expect(demoIdentity.authorize(routes[0], '')).rejects.toMatchObject({
      status: 401,
    });
  });
  it('preserves JWT validation when a token is supplied to a demo route', async () => {
    const demoIdentity = new GatewayIdentity({
      ...settings,
      issuer: 'https://isolated.test/issuer',
      jwksUrl: 'https://isolated.test/jwks',
      demoAnonymousEnabled: true,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ keys: [signed.key] }), { status: 200 }),
        ),
    );
    const categories = CONTRACT_ROUTES.find(
      (route) => route.operationId === 'listarCategorias',
    )!;
    expect(
      demoIdentity.usesDemoAnonymousAccess(
        { ...categories, method: 'POST' },
        undefined,
      ),
    ).toBe(false);
    expect(
      demoIdentity.usesDemoAnonymousAccess(
        { ...categories, operationId: 'anotherOperation' },
        undefined,
      ),
    ).toBe(false);
    expect(
      demoIdentity.usesDemoAnonymousAccess(
        categories,
        `Bearer ${signed.token()}`,
      ),
    ).toBe(false);
    await expect(
      demoIdentity.authorize(categories, `Bearer ${signed.token()}`),
    ).resolves.toBeUndefined();
  });
});
