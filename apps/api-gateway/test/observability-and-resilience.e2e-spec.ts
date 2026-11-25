import { createServer, request as httpRequest, type Server } from 'node:http';
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
  let gatewayPort: number;
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
    const gwAddress = app.getHttpServer().address();
    if (!gwAddress || typeof gwAddress === 'string') {
      throw new Error('No gateway port');
    }
    gatewayPort = gwAddress.port;
  });

  beforeEach(() => {
    logs = [];
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
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'internal_session=secret',
      });
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

  it('logs structured correlation and outcome without leaking tokens, cookies, or private URLs', async () => {
    const token = signed.human({ roles: ['GESTOR_COMERCIAL'] });
    const correlationId = randomUUID();

    const res = await request(app.getHttpServer())
      .get('/api/v1/productos/administracion')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', correlationId)
      .set('Cookie', 'session=super-secret-cookie')
      .expect(200)
      .expect('X-Correlation-Id', correlationId);

    expect(res.headers['set-cookie']).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      service: 'api-gateway',
      event: 'gateway_request',
      operationId: 'listarProductosAdministracion',
      method: 'GET',
      owner: 'catalog-svc',
      status: 200,
      transportState: 'completed',
      correlationId,
      resultOrigin: 'provider',
      failureOrigin: null,
      upstreamReached: true,
      preUpstreamOutcome: null,
    });
    expect(typeof logs[0].durationMs).toBe('number');
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('super-secret-cookie');
    expect(serialized).not.toContain('127.0.0.1');
  });

  it('validates positive, generated, invalid, and duplicate X-Correlation-Id headers', async () => {
    const token = signed.human({ roles: ['GESTOR_COMERCIAL'] });

    const generated = await request(app.getHttpServer())
      .get('/api/v1/productos/administracion')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(generated.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    await request(app.getHttpServer())
      .get('/api/v1/productos/administracion')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', 'not-a-uuid')
      .expect(400);

    const dupRes = await new Promise<number>((resolveStatus, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gatewayPort,
          method: 'GET',
          path: '/api/v1/productos/administracion',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Correlation-Id': [randomUUID(), randomUUID()],
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolveStatus(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(dupRes).toBe(400);
  });

  it('logs pre-upstream rejections for unknown routes, 401, and 403 without reaching upstream', async () => {
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

    expect(
      logs.map((l) => [
        l.status,
        l.resultOrigin,
        l.upstreamReached,
        l.preUpstreamOutcome,
      ]),
    ).toEqual([
      [404, 'gateway', false, 'route_not_found'],
      [401, 'gateway', false, 'auth_failed'],
      [403, 'gateway', false, 'forbidden'],
    ]);
  });

  it('handles multipart early 413, upstream 503, timeout, and client abort cleanly', async () => {
    const token = signed.human({ roles: ['GESTOR_COMERCIAL'] });

    // Early 413 multipart
    providerHandler = (_req, res) => {
      res.writeHead(413, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ code: 'ARCHIVO_EXCEDE_LIMITE' }));
    };
    const early413 = await request(app.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .attach('archivo', Buffer.alloc(64 * 1024, 'a'), 'grande.csv')
      .expect(413);
    expect(early413.body.code).toBe('ARCHIVO_EXCEDE_LIMITE');
    expect(logs.at(-1)).toMatchObject({
      status: 413,
      resultOrigin: 'provider',
      failureOrigin: 'provider',
      transportState: 'rejected',
      upstreamReached: true,
    });

    // Upstream 503
    providerHandler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ code: 'SERVICIO_NO_DISPONIBLE' }));
    };
    await request(app.getHttpServer())
      .get('/api/v1/productos/administracion')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    expect(logs.at(-1)).toMatchObject({
      status: 503,
      resultOrigin: 'provider',
      failureOrigin: 'provider',
      upstreamReached: true,
    });

    // Timeout (> 250ms)
    providerHandler = async (_req, res) => {
      await new Promise((r) => setTimeout(r, 400));
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    };
    await request(app.getHttpServer())
      .get('/api/v1/productos/administracion')
      .set('Authorization', `Bearer ${token}`)
      .expect(503);
    expect(logs.at(-1)).toMatchObject({
      status: 503,
      resultOrigin: 'gateway',
      failureOrigin: 'gateway',
      transportState: 'aborted',
      upstreamReached: true,
    });

    // Client abort
    providerHandler = async (_req, res) => {
      await new Promise((r) => setTimeout(r, 120));
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    };
    await new Promise<void>((resolveAbort) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: gatewayPort,
        method: 'GET',
        path: '/api/v1/productos/administracion',
        headers: { Authorization: `Bearer ${token}` },
      });
      req.on('error', () => resolveAbort());
      req.end();
      setTimeout(() => req.destroy(), 30);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.at(-1)?.transportState).toBe('aborted');
  });

  it('preserves Cache-Control: no-store for Bulk correlation and rejects disallowed redirects', async () => {
    const token = signed.human({ roles: ['GESTOR_COMERCIAL'] });
    const correlationId = randomUUID();
    await request(app.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
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
      failureOrigin: 'gateway',
    });
  });

  it('streams CSV exports and preserves committed 200 status in logs if stream fails mid-transfer', async () => {
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
      transportState: 'completed',
      resultOrigin: 'provider',
      failureOrigin: null,
    });

    // Error after stream headers (200) already committed
    providerHandler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="roto.csv"',
      });
      res.write('sku,precio\n');
      res.destroy(new Error('upstream reset'));
    };
    await new Promise<void>((resolveStream) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: gatewayPort,
          method: 'GET',
          path: '/api/v1/auditoria-precios/exportar',
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          res.on('error', () => resolveStream());
          res.on('aborted', () => resolveStream());
          res.on('end', () => resolveStream());
        },
      );
      req.on('error', () => resolveStream());
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.at(-1)).toMatchObject({
      operationId: 'exportarAuditoriaPrecios',
      status: 200,
      failureOrigin: 'gateway',
      upstreamReached: true,
    });
    expect(['failed', 'aborted']).toContain(logs.at(-1)?.transportState);
  });
});
