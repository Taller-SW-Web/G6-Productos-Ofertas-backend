import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { CONTRACT_ROUTES } from '../src/routing/contract-routes.js';
import { configureGatewayCors } from '../src/routing/gateway-cors.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { createSignedIdentity } from './support/signed-identity.js';

describe('Gateway observability, correlation, and transport resilience (GW-C03, GW-C04)', () => {
  let provider: Server;
  let app: INestApplication;
  let settings: GatewaySettings;
  let signed: ReturnType<typeof createSignedIdentity>;
  let logs: Record<string, unknown>[];
  let stdoutSpy: jest.SpyInstance;
  let providerHandler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void | Promise<void>;

  beforeAll(async () => {
    provider = createServer((req, res) => {
      void providerHandler(req, res);
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string') {
      throw new Error('No test provider address');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    settings = {
      securityMode: 'G7_AUTHENTICATED',
      upstreams: Object.fromEntries(
        CONTRACT_ROUTES.map((r) => [r.service, origin]),
      ),
      timeoutMs: 250,
      maxBytes: 1024 * 1024,
      publicOperations: [],
      demoNoAuthEnabled: false,
      g5H5Enabled: false,
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
    configureGatewayCors(app, 'https://admin.example.test');
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    logs = [];
    settings.securityMode = 'G7_AUTHENTICATED';
    settings.g5H5Enabled = false;
    const originalWrite = process.stdout.write.bind(process.stdout);
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.event === 'gateway_request') {
              logs.push(parsed);
            }
          } catch {
            // Ignore non-JSON stdout lines
          }
        }
        return originalWrite(
          chunk as string,
          ...(rest as [BufferEncoding?, ((err?: Error | null) => void)?]),
        );
      });
    providerHandler = async (req, res) => {
      for await (const _ of req) {
        // drain
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
  });

  afterEach(() => {
    stdoutSpy?.mockRestore();
  });

  afterAll(async () => {
    await app?.close();
    provider?.closeAllConnections();
    if (provider) {
      await new Promise<void>((done) => provider.close(() => done()));
    }
  });

  it('logs structured correlation and outcome without leaking tokens or payloads', async () => {
    const token = signed.human({ roles: ['GESTOR_COMERCIAL'] });
    const correlationId = randomUUID();

    await request(app.getHttpServer())
      .get('/api/v1/productos/administracion')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', correlationId)
      .set('Cookie', 'session=super-secret-cookie')
      .expect(200)
      .expect('X-Correlation-Id', correlationId);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      service: 'api-gateway',
      event: 'gateway_request',
      operationId: 'listarProductosAdministracion',
      method: 'GET',
      owner: 'catalog-svc',
      status: 200,
      correlationId,
      resultOrigin: 'provider',
      preUpstreamOutcome: null,
    });
    expect(typeof logs[0].durationMs).toBe('number');
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('super-secret-cookie');
    expect(serialized).not.toContain('127.0.0.1');
  });

  it('logs pre-upstream rejections for unknown routes, 401, 403, and unconfigured upstreams', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/interno/productos/skus/filtrar')
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/inventario/alertas')
      .expect(401);
    const badRoleToken = signed.human({ roles: ['CONSULTA'] });
    await request(app.getHttpServer())
      .get('/api/v1/inventario/ubicaciones')
      .set('Authorization', `Bearer ${badRoleToken}`)
      .expect(403);

    expect(logs.map((l) => [l.status, l.resultOrigin, l.preUpstreamOutcome])).toEqual([
      [404, 'gateway', 'route_not_found'],
      [401, 'gateway', 'auth_failed'],
      [403, 'gateway', 'forbidden'],
    ]);
  });

  it('preserves Cache-Control: no-store for Bulk correlation reconciliation and rejects disallowed redirects', async () => {
    const token = signed.human({ roles: ['GESTOR_COMERCIAL'] });
    const correlationId = randomUUID();
    await request(app.getHttpServer())
      .get(`/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect('Cache-Control', 'no-store');

    providerHandler = (_req, res) => {
      res.writeHead(302, { location: 'https://evil.example.test/' });
      res.end();
    };
    await request(app.getHttpServer())
      .get('/api/v1/productos/administracion')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    expect(logs.at(-1)).toMatchObject({
      status: 503,
      resultOrigin: 'gateway',
    });
  });

  it('streams CSV exports without applying the JSON buffer limit and handles early 413', async () => {
    const token = signed.human({ roles: ['GESTOR_COMERCIAL'] });
    providerHandler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="auditoria.csv"',
      });
      res.end('sku,precio\nSKU-1,10.50\n');
    };
    const csvRes = await request(app.getHttpServer())
      .get('/api/v1/auditoria-precios/exportar')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect('Content-Disposition', 'attachment; filename="auditoria.csv"');
    expect(csvRes.text).toContain('SKU-1,10.50');
    expect(logs.at(-1)).toMatchObject({
      operationId: 'exportarAuditoriaPrecios',
      status: 200,
      resultOrigin: 'provider',
    });
  });
});
