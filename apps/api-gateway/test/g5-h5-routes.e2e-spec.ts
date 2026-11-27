import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  readGatewaySettings,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { G5_H5_ROUTES } from '../src/routing/g5-h5-routes.js';
import { createSignedIdentity } from './support/signed-identity.js';

describe('G5 H5 routes behind authenticated Gateway opt-in', () => {
  let app: INestApplication;
  const upstream = vi.fn();
  const settings = {
    securityMode: 'G7_AUTHENTICATED',
    g5H5Enabled: false,
    upstreams: {
      'catalog-svc': 'https://catalog.fixture.test',
      'inventory-svc': 'https://inventory.fixture.test',
      'promotions-svc': 'https://promotions.fixture.test',
    },
    demoNoAuthEnabled: false,
    publicOperations: [],
    timeoutMs: 3000,
    maxBytes: 10000,
  } satisfies GatewaySettings;
  const signed = createSignedIdentity(settings);
  const token = (scope: string) =>
    signed.token({ sub: 'modulo-ventas', scope });

  beforeAll(async () => {
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
  afterAll(async () => app?.close());
  beforeEach(() => {
    settings.g5H5Enabled = false;
    settings.publicOperations.splice(0);
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects opt-in without configured G7 and keeps candidate routes off by default', async () => {
    expect(() =>
      readGatewaySettings({
        GATEWAY_G5_H5_ENABLED: 'true',
        G6_SECURITY_MODE: 'PUBLIC_READ_ONLY',
      }),
    ).toThrow();
    expect(() =>
      readGatewaySettings({ GATEWAY_G5_H5_ENABLED: 'true' }),
    ).toThrow();
    await request(app.getHttpServer())
      .post('/api/v1/cupones/consumos')
      .expect(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('enforces G7 JWT on reads even when publicOperations has legacy entries, while H5 mutations require G7 JWT and scope', async () => {
    settings.g5H5Enabled = true;
    settings.publicOperations.push('listarProductos');
    upstream.mockResolvedValue(Response.json({ items: [] }, { status: 200 }));

    await request(app.getHttpServer()).get('/api/v1/productos').expect(401);
    expect(upstream).not.toHaveBeenCalled();

    const g1Token = signed.token({
      sub: 'modulo-marketplace',
      scope: 'catalogo:leer',
    });
    await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${g1Token}`)
      .expect(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][1].headers.authorization).toBe(
      `Bearer ${g1Token}`,
    );

    const noRoleToken = signed.token({
      sub: randomUUID(),
      tipo: 'acceso',
      roles: [],
      scope: '',
    });
    await request(app.getHttpServer())
      .get('/api/v1/productos')
      .set('Authorization', `Bearer ${noRoleToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/promociones/evaluar')
      .send({})
      .expect(401);
    expect(upstream).toHaveBeenCalledTimes(1);

    upstream.mockReset();
    await request(app.getHttpServer())
      .post('/api/v1/cupones/consumos')
      .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/cupones/consumos')
      .set('Authorization', 'Bearer ' + token('cupones:operaciones:leer'))
      .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
      .send({})
      .expect(403);
    expect(upstream).not.toHaveBeenCalled();

    upstream.mockResolvedValue(Response.json({}, { status: 202 }));
    await request(app.getHttpServer())
      .post('/api/v1/cupones/consumos')
      .set('Authorization', 'Bearer ' + token('cupones:consumir'))
      .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
      .send({})
      .expect(202);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('protects the existing Inventory reservation contract without enabling coupon routes', async () => {
    const path = '/api/v1/inventario/reservas';
    await request(app.getHttpServer()).post(path).send({}).expect(401);
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', 'Bearer ' + token('inventario:operaciones:leer'))
      .send({})
      .expect(403);
    expect(upstream).not.toHaveBeenCalled();

    upstream.mockResolvedValue(
      Response.json(
        {
          type: 'about:blank',
          status: 404,
          code: 'OPERACION_INVENTARIO_NO_ENCONTRADA',
        },
        {
          status: 404,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );
    await request(app.getHttpServer())
      .get(
        '/api/v1/inventario/operaciones/11111111-1111-4111-8111-111111111111',
      )
      .set('Authorization', 'Bearer ' + token('inventario:operaciones:leer'))
      .expect(404);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('forwards 202 with the opaque order location, retry header and idempotency key', async () => {
    settings.g5H5Enabled = true;
    const location =
      '/api/v1/cupones/operaciones/11111111-1111-4111-8111-111111111111?order_id=PED+1';
    upstream.mockResolvedValue(
      Response.json(
        {},
        { status: 202, headers: { Location: location, 'Retry-After': '2' } },
      ),
    );
    await request(app.getHttpServer())
      .post('/api/v1/cupones/consumos')
      .set('Authorization', 'Bearer ' + token('cupones:consumir'))
      .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
      .send({})
      .expect(202)
      .expect('Location', location)
      .expect('Retry-After', '2');
    const [url, options] = upstream.mock.calls[0];
    expect(url.href).toBe(
      'https://promotions.fixture.test/api/v1/cupones/consumos',
    );
    expect(options.headers['idempotency-key']).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('forwards all four operations only for their exact G7 client and scope', async () => {
    settings.g5H5Enabled = true;
    for (const route of G5_H5_ROUTES) {
      const successStatus = Number(
        Object.keys(route.responses).find(
          (status) => Number(status) >= 200 && Number(status) < 300,
        ),
      );
      upstream.mockResolvedValue(Response.json({}, { status: successStatus }));
      const path = route.path.replace(
        /\{[^}]+\}/g,
        '11111111-1111-4111-8111-111111111111',
      );
      const client = request(app.getHttpServer());
      const send =
        route.method === 'POST' ? client.post(path) : client.get(path);
      const operationToken = token(route.scope!);
      if (route.method === 'POST')
        await send
          .set('Authorization', `Bearer ${operationToken}`)
          .set('Idempotency-Key', '11111111-1111-4111-8111-111111111111')
          .send({})
          .expect(successStatus);
      else
        await send
          .set('Authorization', `Bearer ${operationToken}`)
          .expect(successStatus);

      const unauthorizedClient = request(app.getHttpServer());
      const wrongClientRequest =
        route.method === 'POST'
          ? unauthorizedClient.post(path)
          : unauthorizedClient.get(path);
      await wrongClientRequest
        .set(
          'Authorization',
          `Bearer ${signed.token({ sub: 'modulo-marketplace', scope: route.scope })}`,
        )
        .expect(403);
    }
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it('insists on each operation scope and never proxies the private Inventory reader', async () => {
    settings.g5H5Enabled = true;
    for (const route of G5_H5_ROUTES) {
      const path = route.path.replace(
        /\{[^}]+\}/g,
        '11111111-1111-4111-8111-111111111111',
      );
      const client = request(app.getHttpServer());
      const send =
        route.method === 'POST' ? client.post(path) : client.get(path);
      await send
        .set('Authorization', 'Bearer ' + token('cupones:validar'))
        .expect(403);
    }
    await request(app.getHttpServer())
      .get(
        '/api/v1/interno/inventario/reservas/11111111-1111-4111-8111-111111111111/evidencia-cupon',
      )
      .set(
        'Authorization',
        'Bearer ' + token('inventario:reservas:estado:leer'),
      )
      .expect(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
