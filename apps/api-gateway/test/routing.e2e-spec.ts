import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { CONTRACT_ROUTES } from '../src/routing/contract-routes.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { GatewayReadiness } from '../src/routing/gateway-readiness.js';
import { createSignedIdentity } from './support/signed-identity.js';

describe('Gateway forwarding against isolated HTTP providers', () => {
  let provider: Server;
  let app: INestApplication;
  let settings: GatewaySettings;
  let signed: ReturnType<typeof createSignedIdentity>;
  let calls: {
    method: string;
    url: string;
    headers: Record<string, unknown>;
    body: string;
  }[] = [];
  let reply = {
    status: 200,
    type: 'application/json',
    body: '{"items":[]}',
    delay: 0,
    location: '',
  };

  beforeAll(async () => {
    provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/health/ready') {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (reply.delay)
        await new Promise((done) => setTimeout(done, reply.delay));
      res.writeHead(reply.status, {
        'content-type': reply.type,
        'set-cookie': 'private=secret',
        ...(reply.location ? { location: reply.location } : {}),
      });
      res.end(reply.body);
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string')
      throw new Error('No test provider address');
    const origin = `http://127.0.0.1:${address.port}`;
    settings = {
      upstreams: Object.fromEntries(
        CONTRACT_ROUTES.map((r) => [r.service, origin]),
      ),
      timeoutMs: 250,
      maxBytes: 1024 * 1024,
      publicOperations: CONTRACT_ROUTES.filter((r) => !r.security.length).map(
        (r) => r.operationId,
      ),
    };
    signed = createSignedIdentity(settings);
    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(settings)
      .overrideProvider(GatewayIdentity)
      .useValue(signed.identity)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => {
    calls = [];
    reply = {
      status: 200,
      type: 'application/json',
      body: '{"items":[]}',
      delay: 0,
      location: '',
    };
  });
  afterAll(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider)
      await new Promise<void>((done) => provider.close(() => done()));
  });

  it.each(CONTRACT_ROUTES)(
    '$method $path routes only its contract operation $operationId',
    async (route) => {
      const path = route.path.replace(
        /\{[^}]+\}/g,
        '11111111-1111-1111-1111-111111111111',
      );
      const success = Object.entries(route.responses).find(
        ([status]) => Number(status) >= 200 && Number(status) < 300,
      )!;
      reply.status = Number(success[0]);
      reply.type = success[1].types[0] ?? 'application/json';
      reply.body =
        reply.type === 'application/json' ? '{}' : 'isolated-provider-content';
      const token =
        route.security.includes('serviceBearer') && route.clients?.length
          ? signed.token({
              sub: route.clients[0],
              scope: route.scope,
              aud: [route.audience],
            })
          : signed.token({
              tipo: 'acceso',
              sub: '11111111-1111-1111-1111-111111111111',
              roles: ['GESTOR_COMERCIAL'],
            });
      const agent = request(app.getHttpServer());
      const methods = {
        GET: agent.get.bind(agent),
        POST: agent.post.bind(agent),
        PATCH: agent.patch.bind(agent),
        PUT: agent.put.bind(agent),
        DELETE: agent.delete.bind(agent),
      };
      const send = methods[route.method as keyof typeof methods](
        path + '?pagina=1',
      );
      send.set('Authorization', `Bearer ${token}`);
      for (const header of route.headers)
        if (header.required)
          send.set(
            header.name,
            header.name === 'idempotency-key' ? 'isolated-intent-key' : '1',
          );
      if (route.requestTypes.includes('application/json'))
        send.set('Content-Type', 'application/json').send({ fixture: true });
      const response = await send;
      if (route.introspection) {
        expect(response.status).toBe(503);
        expect(calls).toHaveLength(0);
        return;
      }
      expect(response.status).toBe(reply.status);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: route.method,
        url: path + '?pagina=1',
      });
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );

  it('preserves the contractual body, correlation and idempotency headers', async () => {
    reply.status = 202;
    const correlation = '11111111-1111-1111-1111-111111111111';
    const response = await request(app.getHttpServer())
      .post('/api/v1/inventario/reservas')
      .set(
        'Authorization',
        `Bearer ${signed.token({ sub: 'modulo-ventas', scope: 'inventario:reservar' })}`,
      )
      .set('X-Correlation-Id', correlation)
      .set('Idempotency-Key', 'stable-intent-123')
      .send({ order_id: 'opaque-order' });
    expect(response.status).toBe(202);
    expect(calls[0].headers).toMatchObject({
      'x-correlation-id': correlation,
      'idempotency-key': 'stable-intent-123',
    });
    expect(JSON.parse(calls[0].body)).toEqual({ order_id: 'opaque-order' });
    expect(response.headers['x-correlation-id']).toBe(correlation);
  });
  it('rejects missing auth, wrong clients, missing idempotency and unknown methods before upstream', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/v1/productos')).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/inventario/reservas')
          .set(
            'Authorization',
            `Bearer ${signed.token({ scope: 'inventario:reservar' })}`,
          )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/inventario/reservas')
          .set(
            'Authorization',
            `Bearer ${signed.token({ sub: 'modulo-ventas', scope: 'inventario:reservar' })}`,
          )
      ).status,
    ).toBe(400);
    expect(
      (await request(app.getHttpServer()).delete('/api/v1/productos/abc'))
        .status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it('preserves stable Problem.code while removing secret-bearing upstream diagnostics', async () => {
    reply = {
      ...reply,
      status: 401,
      type: 'application/problem+json',
      body: JSON.stringify({
        code: 'TOKEN_INVALIDO',
        detail: 'postgresql://user:secret@host',
        stack: 'private',
      }),
    };
    const response = await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${signed.token()}`);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('TOKEN_INVALIDO');
    expect(response.text).not.toMatch(/secret|postgresql|private/);
  });
  it('bounds slow upstream and rejects redirects without sending credentials elsewhere', async () => {
    reply.delay = 500;
    const timed = await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${signed.token()}`);
    expect(timed.status).toBe(503);
    reply = {
      ...reply,
      delay: 0,
      status: 302,
      location: 'https://untrusted.test/private',
    };
    const redirect = await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${signed.token()}`);
    expect(redirect.status).toBe(503);
    expect(redirect.headers.location).toBeUndefined();
  });
  it('keeps liveness separate from upstream readiness', async () => {
    reply.status = 503;
    expect((await request(app.getHttpServer()).get('/health')).status).toBe(
      200,
    );
    expect((await app.get(GatewayReadiness).check()).status).toBe('not_ready');
    reply.status = 200;
    expect((await app.get(GatewayReadiness).check()).status).toBe('ready');
  });

  it('forwards multipart bytes without replacing the boundary or parsing business data', async () => {
    reply.status = 202;
    const response = await request(app.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set(
        'Authorization',
        `Bearer ${signed.token({ tipo: 'acceso', sub: '11111111-1111-1111-1111-111111111111', roles: ['GESTOR_COMERCIAL'] })}`,
      )
      .attach(
        'archivo',
        Buffer.from('sku,nombre\nTEST,Zapatilla\n'),
        'fixture.csv',
      );
    expect(response.status).toBe(202);
    expect(calls[0].body).toContain('sku,nombre\nTEST,Zapatilla');
    expect(calls[0].headers['content-type']).toMatch(
      /multipart\/form-data; boundary=/,
    );
  });

  it('bounds incomplete incoming bodies without forwarding or hanging indefinitely', async () => {
    const address = app.getHttpServer<Server>().address();
    if (!address || typeof address === 'string')
      throw new Error('No gateway test port');
    const status = await new Promise<number>((resolve, reject) => {
      const client = httpRequest(
        `http://127.0.0.1:${address.port}/api/v1/inventario/reservas`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${signed.token({ sub: 'modulo-ventas', scope: 'inventario:reservar' })}`,
            'content-type': 'application/json',
            'content-length': '1000',
            'idempotency-key': 'partial-body-test',
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => {
            resolve(response.statusCode!);
            client.destroy();
          });
        },
      );
      client.once('error', reject);
      client.setTimeout(3000, () => {
        client.destroy();
        reject(new Error('Request deadline exceeded'));
      });
      client.write('{');
    });
    expect(status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
