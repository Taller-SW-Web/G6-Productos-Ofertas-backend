import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import { GatewayIdentity } from '../src/routing/gateway-identity.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { createSignedIdentity } from './support/signed-identity.js';

const enabled = process.env.G6_BULK_GATEWAY_POSTGRES_E2E === '1';
const run = enabled ? describe : describe.skip;
const issuer = 'https://isolated.test/issuer';

const BULK_V2_TEMPLATE_HEADERS = [
  'operacion',
  'producto_id',
  'catalog_version',
  'sku_base',
  'sku_variante',
  'nombre',
  'descripcion',
  'categoria_id',
  'marca_id',
  'tipo_producto_id',
  'tiene_variantes',
  'precio_regular',
  'atributos_producto',
  'imagen_url',
  'stock_inicial',
  'precio_oferta',
];

function createValidBulkV2Csv(sku = 'GW-BULK-001'): Buffer {
  const values = [
    'ALTA',
    '',
    '',
    sku,
    '',
    'Producto E2E Gateway',
    'Descripción de prueba',
    'cat-1',
    'marca-1',
    'tipo-1',
    'false',
    '10.50',
    '[]',
    '',
    '0',
    '',
  ];
  return Buffer.from(
    `${BULK_V2_TEMPLATE_HEADERS.join(',')}\r\n${values.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')}\r\n`,
    'utf8',
  );
}

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No local port available');
  }
  await new Promise<void>((done, reject) =>
    server.close((err) => (err ? reject(err) : done())),
  );
  return address.port;
}

function docker(args: string[], input?: string): string {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const code = result.error?.code ?? result.status ?? 'unknown';
    throw new Error(`Docker disposable database command failed (${code}).`);
  }
  return result.stdout.trim();
}

async function waitForPostgresReady(connectionString: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString, max: 1 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('PostgreSQL descartable no quedó disponible a tiempo');
}

async function waitForHealth(child: ChildProcess, origin: string): Promise<void> {
  const deadline = Date.now() + 30_000;
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
  let forceTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((done) => {
        forceTimer = setTimeout(() => {
          child.kill('SIGKILL');
          done();
        }, 5000);
        forceTimer.unref();
      }),
    ]);
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
  }
}

/**
 * GW-T03 (AUD-P0-08 / GW-R2-01..03): Integración real Gateway -> bulk-svc -> PostgreSQL descartable.
 * Sin G6_BULK_GATEWAY_POSTGRES_E2E=1 el caso queda omitido (nunca PASS).
 */
run('Gateway -> Bulk real -> PostgreSQL descartable (GW-T03)', () => {
  const containerName = `g6-gw-bulk-pg-${process.pid}-${randomUUID().slice(0, 8)}`;
  const databaseName = 'bulk_gw_e2e';
  const adminPassword = randomBytes(18).toString('base64url');
  const appPassword = randomBytes(18).toString('base64url');
  const storageKey = 'bulk-storage-test-only-key';
  const storageBucket = 'bulk-gw-e2e-private';
  const storedObjects = new Map<string, Buffer>();

  let containerCreated = false;
  let adminPool: Pool | undefined;
  let bulkProcess: ChildProcess | undefined;
  let app: INestApplication | undefined;
  let jwksServer: Server | undefined;
  let storageServer: Server | undefined;
  let signed: ReturnType<typeof createSignedIdentity>;

  async function closeHttpServer(server?: Server): Promise<void> {
    if (!server) return;
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  async function cleanupDisposableResources(): Promise<void> {
    const currentApp = app;
    app = undefined;
    await currentApp?.close().catch(() => undefined);

    const currentBulk = bulkProcess;
    bulkProcess = undefined;
    await stopProcess(currentBulk).catch(() => undefined);

    const currentPool = adminPool;
    adminPool = undefined;
    await currentPool?.end().catch(() => undefined);

    const currentJwks = jwksServer;
    jwksServer = undefined;
    await closeHttpServer(currentJwks);

    const currentStorage = storageServer;
    storageServer = undefined;
    await closeHttpServer(currentStorage);
    storedObjects.clear();

    if (containerCreated) {
      containerCreated = false;
      spawnSync('docker', ['rm', '-f', containerName], { windowsHide: true });
    }
  }

  beforeAll(async () => {
    try {
      const pgPort = await unusedPort();
      containerCreated = true;
      docker([
        'run',
        '--detach',
        '--name',
        containerName,
        '--publish',
        `127.0.0.1:${pgPort}:5432`,
        '--env',
        `POSTGRES_PASSWORD=${adminPassword}`,
        '--env',
        `POSTGRES_DB=${databaseName}`,
        'postgres:17-alpine',
        '-c',
        'shared_buffers=32MB',
        '-c',
        'max_connections=20',
      ]);

      const adminUrl = `postgresql://postgres:${adminPassword}@127.0.0.1:${pgPort}/${databaseName}?sslmode=disable`;
      const appUrl = `postgresql://bulk_fixture_app:${appPassword}@127.0.0.1:${pgPort}/${databaseName}?sslmode=disable`;
      await waitForPostgresReady(adminUrl);

      const sqlFiles = [
        'apps/bulk-svc/test/fixtures/0001_create_bulk_persistence.sql',
        'apps/bulk-svc/migrations/0002_export_source_snapshot.sql',
        'apps/bulk-svc/migrations/0003_export_claim_lease.sql',
        'apps/bulk-svc/migrations/0004_catalog_claim_check_content.sql',
        'apps/bulk-svc/migrations/0005_actor_ownership.sql',
        'apps/bulk-svc/migrations/0006_owner_correlation_identity.sql',
        'apps/bulk-svc/migrations/0007_bulk_retry_v1.sql',
        'apps/bulk-svc/migrations/0008_h5_outbox_delivery.sql',
      ].map((p) => readFileSync(resolve(process.cwd(), p), 'utf8'));

      docker(
        [
          'exec',
          '-i',
          containerName,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'postgres',
          '-d',
          databaseName,
        ],
        `CREATE ROLE po_bulk_owner NOLOGIN;
CREATE ROLE bulk_fixture_app LOGIN PASSWORD '${appPassword}';
CREATE SCHEMA bulk AUTHORIZATION po_bulk_owner;
SET ROLE po_bulk_owner;
${sqlFiles.join('\n')}
GRANT USAGE ON SCHEMA bulk TO bulk_fixture_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bulk TO bulk_fixture_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA bulk TO bulk_fixture_app;`,
      );
      adminPool = new Pool({ connectionString: adminUrl, max: 2 });

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
        res.end(JSON.stringify({ keys: [signed.key] }));
      });
      jwksServer.listen(0, '127.0.0.1');
      await once(jwksServer, 'listening');
      const jwksAddress = jwksServer.address();
      if (!jwksAddress || typeof jwksAddress === 'string') {
        throw new Error('No JWKS port');
      }

      storageServer = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const segments = url.pathname.split('/').map(decodeURIComponent);
        if (
          req.method === 'GET' &&
          segments[1] === 'storage' &&
          segments[2] === 'v1' &&
          segments[3] === 'bucket' &&
          segments[4] === storageBucket
        ) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: storageBucket, public: false }));
          return;
        }
        if (
          segments[1] === 'storage' &&
          segments[2] === 'v1' &&
          segments[3] === 'object' &&
          segments[4] === storageBucket
        ) {
          const objectName = segments.slice(5).join('/');
          if (req.method === 'POST' || req.method === 'PUT') {
            storedObjects.set(objectName, body);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ Key: `${storageBucket}/${objectName}` }));
            return;
          }
          if (req.method === 'GET') {
            const existing = storedObjects.get(objectName);
            if (!existing) {
              res.writeHead(404).end();
              return;
            }
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(existing);
            return;
          }
        }
        res.writeHead(404).end();
      });
      storageServer.listen(0, '127.0.0.1');
      await once(storageServer, 'listening');
      const storageAddress = storageServer.address();
      if (!storageAddress || typeof storageAddress === 'string') {
        throw new Error('No storage port');
      }

      const bulkEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(bulkPort),
        NODE_ENV: 'test',
        DATABASE_URL: appUrl,
        BULK_AMQP_ENABLED: 'false',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'false',
        BULK_CORRELATION_RECONCILIATION_ENABLED: 'true',
        G7_JWT_ISSUER: issuer,
        G7_JWT_JWKS_URL: `http://127.0.0.1:${jwksAddress.port}/jwks.json`,
        BULK_STORAGE_BUCKET: storageBucket,
        SUPABASE_SERVICE_ROLE_KEY: storageKey,
        SUPABASE_URL: `http://127.0.0.1:${storageAddress.port}`,
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
        .overrideProvider(GatewayIdentity)
        .useValue(signed.identity)
        .compile();
      app = module.createNestApplication({ bodyParser: false });
      await app.listen(0, '127.0.0.1');
    } catch (error) {
      await cleanupDisposableResources();
      throw error;
    }
  }, 90_000);

  afterAll(async () => {
    await cleanupDisposableResources();
  });

  it('creates a real import, returns 200 + Cache-Control: no-store for owner, 404 for other actor, and performs pure read', async () => {
    const ownerActorId = randomUUID();
    const otherActorId = randomUUID();
    const correlationId = randomUUID();
    const idempotencyKey = randomUUID();
    const ownerToken = signed.token({
      tipo: 'acceso',
      sub: ownerActorId,
      roles: ['GESTOR_COMERCIAL'],
      iss: issuer,
    });
    const otherToken = signed.token({
      tipo: 'acceso',
      sub: otherActorId,
      roles: ['GESTOR_COMERCIAL'],
      iss: issuer,
    });

    const csvPayload = createValidBulkV2Csv();
    const importRes = await request(app!.getHttpServer())
      .post('/api/v1/carga-masiva/productos/importaciones')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Correlation-Id', correlationId)
      .attach('archivo', csvPayload, 'importacion.csv')
      .expect(202);

    const batchId = importRes.body?.batch_id;
    expect(typeof batchId).toBe('string');

    const ownerRead1 = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(ownerRead1.headers['cache-control']).toBe('no-store');
    expect(ownerRead1.body.batch_id).toBe(batchId);

    await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    // Confirmar lectura pura: mismo batch_id y exactamente 1 lote en bulk.batch_jobs
    const ownerRead2 = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationId}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(ownerRead2.headers['cache-control']).toBe('no-store');
    expect(ownerRead2.body.batch_id).toBe(batchId);

    const totalResult = await adminPool!.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM bulk.batch_jobs',
    );
    expect(totalResult.rows[0]?.total).toBe(1);

    const exactJob = await adminPool!.query<{
      batch_id: string;
      owner_sub: string;
      correlation_id: string;
    }>(
      'SELECT batch_id::text AS batch_id, owner_sub::text AS owner_sub, correlation_id::text AS correlation_id FROM bulk.batch_jobs WHERE batch_id = $1 AND owner_sub = $2 AND correlation_id = $3',
      [batchId, ownerActorId.toLowerCase(), correlationId.toLowerCase()],
    );
    expect(exactJob.rows).toEqual([
      {
        batch_id: batchId,
        owner_sub: ownerActorId.toLowerCase(),
        correlation_id: correlationId.toLowerCase(),
      },
    ]);
  });
});
