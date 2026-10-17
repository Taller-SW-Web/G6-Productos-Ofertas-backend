import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';

describe('Marketplace demo anonymous access', () => {
  let provider: Server;
  let app: INestApplication;
  let calls: { method: string; url: string; authorization?: string }[] = [];

  beforeAll(async () => {
    provider = createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Drain the request before returning a response.
      }
      calls.push({
        method: req.method!,
        url: req.url!,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('No test provider address');
    const origin = `http://127.0.0.1:${address.port}`;
    const settings = readGatewaySettings({
      GATEWAY_CATALOG_SVC_URL: origin,
      GATEWAY_TAXONOMY_SVC_URL: origin,
      GATEWAY_DEMO_ANONYMOUS_ENABLED: 'true',
    });
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

  beforeEach(() => {
    calls = [];
  });

  afterAll(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider)
      await new Promise<void>((done) => provider.close(() => done()));
  });

  it.each([
    '/api/v1/categorias',
    '/api/v1/productos?canal=MARKETPLACE',
    '/api/v1/productos/por-slug/demo?canal=MARKETPLACE',
  ])(
    'forwards anonymous GET %s without an Authorization header',
    async (path) => {
      const response = await request(app.getHttpServer()).get(path);

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('GET');
      expect(calls[0].authorization).toBeUndefined();
    },
  );

  it('keeps other reads and writes protected and rejects alternate methods and paths', async () => {
    const protectedRead = await request(app.getHttpServer()).get(
      '/api/v1/productos/11111111-1111-1111-1111-111111111111',
    );
    const protectedWrite = await request(app.getHttpServer())
      .post('/api/v1/categorias')
      .send({});
    const alternateMethod = await request(app.getHttpServer()).delete(
      '/api/v1/categorias',
    );
    const alternatePath = await request(app.getHttpServer()).get(
      '/api/v1/productos/por-slug/demo/extra',
    );

    expect(protectedRead.status).toBe(401);
    expect(protectedWrite.status).toBe(401);
    expect(alternateMethod.status).toBe(404);
    expect(alternatePath.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('does not downgrade a supplied Authorization header to anonymous access', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/categorias')
      .set('Authorization', 'Bearer invalid');

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
