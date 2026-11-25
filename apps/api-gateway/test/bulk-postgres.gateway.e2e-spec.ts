import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { Phase1Postgres } from './support/phase1-postgres.js';
import { createSignedIdentity } from './support/signed-identity.js';

const enabled = process.env.G6_BULK_GATEWAY_POSTGRES_E2E === '1';
const run = enabled ? describe : describe.skip;
const issuer = 'https://isolated.test/issuer';

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No local port available for Bulk');
  }
  await new Promise<void>((done, reject) =>
    server.close((err) => (err ? reject(err) : done())),
  );
  return address.port;
}

async function waitForHealth(child: ChildProcess, origin: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('bulk-svc terminó antes de /health');
    }
    try {
      const res = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(500),
      });
      await res.body?.cancel();
      if (res.status === 200) return;
    } catch {
      // esperando readiness
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('bulk-svc no alcanzó /health en 30s');
}

async function stopProcess(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([
    exited,
    new Promise<void>((done) => setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 5000)),
  ]);
}

/**
 * GW-T03 (AUD-P0-08): Integración real Gateway -> bulk-svc -> PostgreSQL descartable.
 * Sin G6_BULK_GATEWAY_POSTGRES_E2E=1 el caso queda omitido (nunca PASS).
 */
run('Gateway -> Bulk real -> PostgreSQL descartable (GW-T03)', () => {
  let postgres: Phase1Postgres;
  let bulkProcess: ChildProcess | undefined;
  let app: INestApplication | undefined;
  let jwksServer: Server | undefined;
  let signed: ReturnType<typeof createSignedIdentity>;

  beforeAll(async () => {
    postgres = await Phase1Postgres.start('bulk-gw-e2e');
    await postgres.migrate('bulk');

    const bulkPort = await unusedPort();
    const bulkOrigin = `http://127.0.0.1:${bulkPort}`;

    const baseSettings: GatewaySettings = {
      securityMode: 'G7_AUTHENTICATED',
      upstreams: { 'bulk-svc': bulkOrigin },
      timeoutMs: 10000,
      maxBytes: 1024 * 1024,
      publicOperations: [],
      demoNoAuthEnabled: false,
      g5H5Enabled: false,
    };
    signed = createSignedIdentity(baseSettings);

    jwksServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: signed.jwks }));
    });
    jwksServer.listen(0, '127.0.0.1');
    await once(jwksServer, 'listening');
    const jwksAddress = jwksServer.address();
    if (!jwksAddress || typeof jwksAddress === 'string') {
      throw new Error('No JWKS port');
    }

    const bulkEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(bulkPort),
      NODE_ENV: 'test',
      DATABASE_URL: postgres.databaseUrl,
      AUTH_ISSUER: issuer,
      AUTH_JWKS_URL: `http://127.0.0.1:${jwksAddress.port}/jwks.json`,
      G6_SECURITY_MODE: 'G7_AUTHENTICATED',
    };
    bulkProcess = spawn(
      process.execPath,
      [resolve(process.cwd(), 'dist/apps/bulk-svc/main.js')],
      { env: bulkEnv, stdio: 'pipe' },
    );
    await waitForHealth(bulkProcess, bulkOrigin);

    const module = await Test.createTestingModule({
      imports: [ApiGatewayModule],
    })
      .overrideProvider(GATEWAY_SETTINGS)
      .useValue(baseSettings)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    await app.listen(0, '127.0.0.1');
  }, 90000);

  afterAll(async () => {
    await app?.close();
    await stopProcess(bulkProcess);
    jwksServer?.closeAllConnections();
    if (jwksServer) {
      await new Promise<void>((done) => jwksServer!.close(() => done()));
    }
    await postgres?.stop();
  });

  it('creates a real import, returns 200 + Cache-Control: no-store for owner, 404 for other actor, and performs pure read', async () => {
    const ownerActorId = randomUUID();
    const otherActorId = randomUUID();
    const correlationId = randomUUID();
    const idempotencyKey = randomUUID();
    const ownerToken = signed.human({
      sub: ownerActorId,
      roles: ['GESTOR_COMERCIAL'],
      iss: issuer,
    });
    const otherToken = signed.human({
      sub: otherActorId,
      roles: ['GESTOR_COMERCIAL'],
      iss: issuer,
    });

    const csvPayload = Buffer.from(
      'sku,nombre,categoriaCodigo,marcaCodigo,precioBase,moneda\nGW-BULK-001,Producto E2E,CAT-1,MAR-1,10.00,PEN\n',
      'utf8',
    );
    const importRes = await request(app!.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Correlation-Id', correlationId)
      .attach('archivo', csvPayload, 'importacion.csv')
      .expect(202);

    const batchId = importRes.body?.batchId;
    expect(typeof batchId).toBe('string');

    const ownerRead1 = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(ownerRead1.headers['cache-control']).toBe('no-store');
    expect(ownerRead1.body.batchId).toBe(batchId);

    await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    // Confirmar lectura pura: mismo batchId, sin duplicación
    const ownerRead2 = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(ownerRead2.body.batchId).toBe(batchId);
  });
});
