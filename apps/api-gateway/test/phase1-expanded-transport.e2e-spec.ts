import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import { CONTRACT_ROUTES } from '../src/routing/contract-routes.js';
import { PHASE1_INTERNAL_READ_ROUTES } from '../src/routing/phase1-internal-read-routes.js';
import { isEligiblePublicRead } from '../src/routing/gateway-public-reads.js';
import { createSignedIdentity } from './support/signed-identity.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';

// This fixture certifies Gateway selection and transport, not upstream business
// responses, PostgreSQL, storage, AMQP, or cloud deployment.
describe('Expanded Phase 1 Gateway HTTP transport', () => {
  const routes = [...CONTRACT_ROUTES, ...PHASE1_INTERNAL_READ_ROUTES].filter(
    isEligiblePublicRead,
  );
  let provider: Server;
  let app: INestApplication;
  let signed: ReturnType<typeof createSignedIdentity>;
  const received: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    body: string;
  }> = [];
  beforeAll(async () => {
    provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      const route = routes.find(
        (r) =>
          r.method === req.method &&
          r.path.replace(/[{][^}]+[}]/g, 'fixture') === req.url,
      );
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      const type = route.responses['200'].types[0];
      res.writeHead(200, { 'content-type': type });
      res.end(type === 'application/json' ? '{}' : 'transport fixture');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing provider');
    const issuer = 'https://security.test/issuer';
    const jwksUrl = 'https://security.test/jwks';
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
      AUTH_ISSUER: issuer,
      AUTH_JWKS_URL: jwksUrl,
    };
    for (const service of new Set(routes.map((r) => r.service)))
      env['GATEWAY_' + service.replaceAll('-', '_').toUpperCase() + '_URL'] =
        'http://127.0.0.1:' + address.port;
    expect(() =>
      readGatewaySettings({
        ...env,
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
        GATEWAY_PUBLIC_OPERATION_IDS: routes
          .map((r) => r.operationId)
          .join(','),
      }),
    ).toThrow(
      'Invalid Gateway configuration; review upstream origins, auth configuration and public operation allowlist',
    );
    const settings = readGatewaySettings(env);
    signed = createSignedIdentity(settings);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === jwksUrl)
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [signed.key] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      return originalFetch(input, init);
    }) as typeof fetch;
    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .overrideProvider(GatewayIdentity)
      .useValue(new GatewayIdentity(settings))
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider)
      await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  it('confirma cero rutas públicas anónimas bajo política universal G7', () => {
    expect(routes).toHaveLength(0);
  });
  for (const route of routes)
    it(
      route.operationId +
        ' forwards under G7_AUTHENTICATED without fabricating identity',
      async () => {
        const path = route.path.replace(/[{][^}]+[}]/g, 'fixture');
        const start = received.length;
        const client = request(app.getHttpServer());
        const token = signed.token({
          sub: '00000000-0000-4000-8000-000000000001',
          tipo: 'acceso',
          aud: ['api-productos'],
          roles: [
            'GESTOR_COMERCIAL',
            'OPERADOR_INVENTARIO',
            'CATALOGO_ADMIN',
            'PROMOCIONES_ADMIN',
            'PRECIOS_ADMIN',
            'COMBOS_ADMIN',
            'AUDITOR',
            'ADMINISTRADOR',
          ],
        });
        const call =
          route.method === 'POST'
            ? client
                .post(path)
                .set('Authorization', `Bearer ${token}`)
                .send({ probe: 'transport-only' })
            : client.get(path).set('Authorization', `Bearer ${token}`);
        await call.expect(200);
        expect(received).toHaveLength(start + 1);
        expect(received.at(-1)).toMatchObject({
          method: route.method,
          url: path,
          body: route.method === 'POST' ? '{"probe":"transport-only"}' : '',
        });
      },
    );
  it('never forwards anonymous mutations, missing prevalidation or an invalid supplied JWT', async () => {
    const start = received.length;
    await request(app.getHttpServer())
      .post('/api/v1/productos')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/precios/importaciones/prevalidar')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    expect(received).toHaveLength(start);
  });

  it('keeps private SKU context outside the external Gateway, even with a valid service JWT', async () => {
    const path = '/api/v1/productos/skus/OPAQUE-001/contexto';
    const start = received.length;
    await request(app.getHttpServer()).get(path).expect(404);
    await request(app.getHttpServer())
      .get(path)
      .set(
        'Authorization',
        `Bearer ${signed.token({
          sub: 'modulo-productos',
          tipo: 'servicio',
          aud: ['api-productos'],
          scope: 'catalogo:leer',
        })}`,
      )
      .expect(404);
    expect(received).toHaveLength(start);
  });
});
