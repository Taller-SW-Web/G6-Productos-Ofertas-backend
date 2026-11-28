import { BulkUserBearerGuard } from './bulk-user-bearer.guard.js';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';

function executionContext(
  headers: Record<string, string> = {},
  remoteAddress = '10.0.0.2',
  handlerName = 'unknownOperation',
) {
  const request = {
    headers,
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/plantilla',
    socket: { remoteAddress },
  };
  return {
    request,
    context: {
      getHandler: () => ({ name: handlerName }),
      switchToHttp: () => ({ getRequest: () => request }),
    } as never,
  };
}

describe('Bulk H4 userBearer and reversible demo policy', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    delete process.env.GATEWAY_DEMO_NO_AUTH_ENABLED;
    delete process.env.BULK_DEMO_GATEWAY_IPS;
    delete process.env.G7_JWT_PUBLIC_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.G7_JWT_ISSUER;
    delete process.env.G6_SECURITY_MODE;
    delete process.env.BULK_PUBLIC_OPERATION_IDS;
    delete process.env.SIMULATED_AUTH_ISSUER;
    delete process.env.SIMULATED_AUTH_JWKS_URL;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllGlobals();
  });

  it('D-01/D-09: default is closed and absent credentials never fall back to demo', async () => {
    const { context } = executionContext();
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });

  it('D-02: a malformed or unverifiable bearer is rejected while demo is disabled', async () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'false';
    const { context } = executionContext({ authorization: 'Bearer not-a-jwt' });
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });

  it('accepts G7 human JWT without aud or with api-productos audience, and rejects wrong audiences, expired, wrong issuer, bad signature, service token and insufficient role', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    process.env.G7_JWT_ISSUER = 'audience-test-issuer';

    const signJwt = (
      overrides: Record<string, unknown> = {},
      key = privateKey,
    ) => {
      const encode = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const header = encode({ alg: 'RS256', typ: 'JWT' });
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: 'audience-test-issuer',
        sub: randomUUID(),
        tipo: 'acceso',
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        roles: ['GESTOR_COMERCIAL'],
        ...overrides,
      };
      if (payload.aud === undefined) delete payload.aud;
      const claims = encode(payload);
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      return `${header}.${claims}.${signer.sign(key, 'base64url')}`;
    };

    const guard = new BulkUserBearerGuard();

    // 1) JWT humano G7 sin claim aud (coherente con Catalog/Pricing/Inventory/Audit/APIM) -> PASS
    // 2) JWT humano con aud='api-productos' o ['api-productos', ...] -> PASS
    for (const overrides of [
      { aud: undefined },
      { aud: 'api-productos' },
      { aud: ['api-productos', 'api-otra'] },
    ]) {
      const { context } = executionContext({
        authorization: `Bearer ${signJwt(overrides)}`,
      });
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }

    // 3) Audiencia incorrecta, expirado, issuer incorrecto, firma invalida, token M2M (tipo=servicio) -> 401 TOKEN_INVALIDO
    for (const badToken of [
      signJwt({ aud: 'api-otra' }),
      signJwt({ aud: ['api-otra'] }),
      signJwt({ aud: ['api-productos', 42] }),
      signJwt({ aud: null }),
      signJwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
      signJwt({ iss: 'https://otro-emisor.invalid' }),
      signJwt({}, wrongPrivateKey),
      signJwt({ tipo: 'servicio', aud: 'api-productos', scope: 'catalogo:leer' }),
    ]) {
      const { context } = executionContext({
        authorization: `Bearer ${badToken}`,
      });
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 401,
        message: 'TOKEN_INVALIDO',
      });
    }

    // 4) Rol insuficiente -> 403 SCOPE_INSUFICIENTE (diferenciado de 401)
    const { context: forbiddenCtx } = executionContext({
      authorization: `Bearer ${signJwt({ roles: ['CONSULTA_BASICA'] })}`,
    });
    await expect(guard.canActivate(forbiddenCtx)).rejects.toMatchObject({
      status: 403,
      message: 'SCOPE_INSUFICIENTE',
    });
  });

  it('rejects an otherwise valid locally signed RS256 token whose nbf is in the future', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    process.env.G7_JWT_ISSUER = 'test-issuer';
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT' });
    const claims = encode({
      iss: 'test-issuer',
      sub: 'unit-test-subject',
      aud: 'api-productos',
      exp: Math.floor(Date.now() / 1000) + 600,
      nbf: Math.floor(Date.now() / 1000) + 600,
      roles: ['GESTOR_COMERCIAL'],
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const { context } = executionContext({
      authorization: `Bearer ${header}.${claims}.${signer.sign(privateKey, 'base64url')}`,
    });
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });

  it('rejects the legacy socket-IP demo bypass even when client identity headers are supplied', async () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
    process.env.BULK_DEMO_GATEWAY_IPS = '10.0.0.2';
    const { context, request } = executionContext({
      authorization: 'Bearer forged',
      'x-user-id': 'admin',
      'x-roles': 'GESTOR_COMERCIAL',
    });
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
    expect(Reflect.get(request, 'user')).toBeUndefined();
  });

  it('D-06 boundary: a non-allowlisted peer cannot use demo mode', async () => {
    process.env.GATEWAY_DEMO_NO_AUTH_ENABLED = 'true';
    process.env.BULK_DEMO_GATEWAY_IPS = '10.0.0.2';
    const { context } = executionContext({}, '198.51.100.20');
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });

  it('rejects anonymous template operation even when PUBLIC_READ_ONLY is configured (H5 G7_AUTHENTICATED)', async () => {
    process.env.G6_SECURITY_MODE = 'PUBLIC_READ_ONLY';
    process.env.BULK_PUBLIC_OPERATION_IDS = 'descargarPlantillaProductos';
    const { context } = executionContext(
      {},
      '10.0.0.2',
      'descargarPlantillaProductos',
    );
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('verifies signed phase 2 JWTs through the independent JWKS and rejects them after switching to G7', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const issuer = 'https://simulated.test/issuer';
    const jwk = {
      ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
      kid: 'bulk-sim-key',
      alg: 'RS256',
      use: 'sig',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))),
    );
    process.env.NODE_ENV = 'test';
    process.env.G6_SECURITY_MODE = 'SIMULATED_AUTH';
    process.env.SIMULATED_AUTH_ISSUER = issuer;
    process.env.SIMULATED_AUTH_JWKS_URL = 'https://simulated.test/jwks';
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'bulk-sim-key' });
    const subject = randomUUID();
    const claims = encode({
      iss: issuer,
      sub: subject,
      aud: 'api-productos',
      tipo: 'acceso',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: randomUUID(),
      roles: ['GESTOR_COMERCIAL'],
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const token = `${header}.${claims}.${signer.sign(privateKey, 'base64url')}`;
    const { context, request } = executionContext({
      authorization: `Bearer ${token}`,
    });
    await expect(new BulkUserBearerGuard().canActivate(context)).resolves.toBe(
      true,
    );
    expect(Reflect.get(request, 'bulkActorSub')).toBe(subject);

    process.env.G6_SECURITY_MODE = 'G7_AUTHENTICATED';
    process.env.G7_JWT_ISSUER = 'https://g7.test/issuer';
    process.env.G7_JWT_PUBLIC_KEY = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    await expect(
      new BulkUserBearerGuard().canActivate(context),
    ).rejects.toThrow('TOKEN_INVALIDO');
  });
});
