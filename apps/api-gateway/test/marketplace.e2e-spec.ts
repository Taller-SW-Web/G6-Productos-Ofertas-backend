import { createServer, type Server, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
} from '../src/routing/gateway-settings.js';
import { createSignedIdentity } from './support/signed-identity.js';

// Transport/authorization regressions with an explicit HTTP test provider.
// Eligibility, PostgreSQL and the G1 BFF are not simulated as production behavior.
describe('consolidated Marketplace forwarding with isolated HTTP provider', () => {
  let app: INestApplication, provider: Server;
  let signed: ReturnType<typeof createSignedIdentity>;
  let calls: { url: string; headers: IncomingMessage['headers'] }[];
  let reply: { status: number; body: unknown };
  const simple = {
    product_id: 'TEST_RUNNING',
    slug: 'test-running',
    name: 'Zapatillas running de prueba',
    categoria_id: 'TEST_CATEGORY',
    tipo_producto_id: 'TEST_TYPE',
    marca_id: 'TEST_BRAND',
    tiene_variantes: false,
    sku_base: '000123',
    images: [],
    attributes: [],
  };
  const paths = [
    '/api/v1/categorias',
    '/api/v1/productos?canal=MARKETPLACE&q=running&pagina=1&tamanio=24',
    '/api/v1/productos/por-slug/test-running?canal=MARKETPLACE',
  ];
  beforeAll(async () => {
    provider = createServer((req, res) => {
      calls.push({ url: req.url!, headers: req.headers });
      res.writeHead(reply.status, {
        'Content-Type':
          reply.status >= 400 ? 'application/problem+json' : 'application/json',
      });
      res.end(JSON.stringify(reply.body));
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    const settings = readGatewaySettings({
      GATEWAY_TAXONOMY_SVC_URL: origin,
      GATEWAY_CATALOG_SVC_URL: origin,
    });
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
    await app.init();
  });
  beforeEach(() => {
    calls = [];
    reply = { status: 200, body: {} };
  });
  afterAll(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider?.listening)
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
  });

  it.each([
    [
      paths[0],
      {
        categories: [
          { categoria_id: 'TEST_CATEGORY', name: 'Running', status: 'ACTIVA' },
        ],
      },
    ],
    [paths[1], { items: [simple], pagina: 1, tamanio: 24, total: 1 }],
    [
      paths[2],
      {
        ...simple,
        marca: { marca_id: 'TEST_BRAND', name: 'Marca de prueba' },
        variants: [],
      },
    ],
    [
      '/api/v1/productos?canal=MARKETPLACE&q=empty&pagina=1&tamanio=24',
      { items: [], pagina: 1, tamanio: 24, total: 0 },
    ],
    [
      '/api/v1/productos/por-slug/test-variants?canal=MARKETPLACE',
      {
        ...simple,
        tiene_variantes: true,
        sku_base: null,
        variants: [
          {
            variant_id: 'TEST_VARIANT',
            sku: '000456',
            identifying_attributes: [],
            non_identifying_attributes: [],
            images: [],
          },
        ],
      },
    ],
  ])('preserves the provider DTO and query on %s', async (path, body) => {
    reply.body = body;
    const correlation = randomUUID();
    const token = signed.token();
    const response = await request(app.getHttpServer())
      .get(String(path))
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', correlation)
      .expect(200);
    expect(response.body).toEqual(body);
    expect(response.headers['x-correlation-id']).toBe(correlation);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(path);
    expect(calls[0].headers.authorization).toBe(`Bearer ${token}`);
    expect(calls[0].headers['x-correlation-id']).toBe(correlation);
  });

  it.each(['missing', 'ineligible'])(
    'preserves contractual 404 for %s slug without empty-success fallback',
    async (slug) => {
      reply = {
        status: 404,
        body: {
          code: 'PRODUCTO_NO_ENCONTRADO',
          detail: 'private-provider-error',
        },
      };
      const response = await request(app.getHttpServer())
        .get(`/api/v1/productos/por-slug/${slug}?canal=MARKETPLACE`)
        .set('Authorization', `Bearer ${signed.token()}`)
        .expect(404);
      expect(response.body.code).toBe('PRODUCTO_NO_ENCONTRADO');
      expect(response.text).not.toContain('private-provider-error');
      expect(calls).toHaveLength(1);
    },
  );

  it.each(paths)(
    'rejects missing and invalid service identity before forwarding %s',
    async (path) => {
      await request(app.getHttpServer()).get(path).expect(401);
      for (const [claims, status] of [
        [{ exp: 1 }, 401],
        [{ aud: ['wrong'] }, 401],
        [{ scope: 'wrong' }, 403],
        [{ sub: 'not-allowed' }, 403],
      ] as const) {
        const response = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${signed.token(claims)}`)
          .expect(status);
        expect(response.body.code).toBe(
          status === 401 ? 'TOKEN_INVALIDO' : 'SCOPE_INSUFICIENTE',
        );
      }
      expect(calls).toHaveLength(0);
    },
  );

  it.each(paths)(
    'preserves specific upstream unavailability on %s',
    async (path) => {
      reply = {
        status: 503,
        body: {
          code: 'SERVICIO_NO_DISPONIBLE',
          detail: 'private-db-or-eligibility',
        },
      };
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${signed.token()}`)
        .expect(503);
      expect(response.body.code).toBe('SERVICIO_NO_DISPONIBLE');
      expect(response.text).not.toContain('private-db-or-eligibility');
    },
  );
});
