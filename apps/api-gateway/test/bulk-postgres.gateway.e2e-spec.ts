import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
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
  'atributos_variante',
  'imagen_url',
  'stock_inicial',
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
    'https://example.test/product.png',
    '0',
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

async function waitForHealth(
  child: ChildProcess,
  origin: string,
): Promise<void> {
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

run('Gateway -> Bulk real -> PostgreSQL descartable (GW-T03)', () => {
  const containerName = `g6-gw-bulk-pg-${process.pid}-${randomUUID().slice(0, 8)}`;
  const databaseName = 'bulk_gw_e2e';
  const adminPassword = randomBytes(18).toString('base64url');
  const appPassword = randomBytes(18).toString('base64url');
  const storageKey =
    process.env.BULK_RETRY_INTEGRATION_STORAGE_SERVICE_ROLE_KEY ||
    'bulk-storage-test-only-key';
  const storageBucket = process.env.BULK_RETRY_INTEGRATION_STORAGE_URL
    ? 'bulk-retry-integration'
    : 'bulk-gw-e2e-private';
  const storedObjects = new Map<string, Buffer>();

  let containerCreated = false;
  let adminPool: Pool | undefined;
  let bulkProcess: ChildProcess | undefined;
  let app: INestApplication | undefined;
  let jwksServer: Server | undefined;
  let storageServer: Server | undefined;
  let signed: ReturnType<typeof createSignedIdentity>;

  const actorA = randomUUID();
  const actorB = randomUUID();
  const correlationA = randomUUID();
  let batchIdA = '';

  function tokenFor(
    sub: string,
    overrides: Record<string, unknown> = {},
  ): string {
    return signed.token({
      tipo: 'acceso',
      sub,
      roles: ['GESTOR_COMERCIAL'],
      iss: issuer,
      ...overrides,
    });
  }

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
      let dbUrl = process.env.BULK_RETRY_INTEGRATION_BULK_DATABASE_URL;
      if (!dbUrl) {
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
        dbUrl = `postgresql://bulk_fixture_app:${appPassword}@127.0.0.1:${pgPort}/${databaseName}?sslmode=disable`;
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
      } else {
        adminPool = new Pool({ connectionString: dbUrl, max: 2 });
      }

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

      let storageUrl = process.env.BULK_RETRY_INTEGRATION_STORAGE_URL;
      if (!storageUrl) {
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
              res.end(
                JSON.stringify({ Key: `${storageBucket}/${objectName}` }),
              );
              return;
            }
            if (req.method === 'GET') {
              const existing = storedObjects.get(objectName);
              if (!existing) {
                res.writeHead(404).end();
                return;
              }
              res.writeHead(200, {
                'content-type': 'application/octet-stream',
              });
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
        storageUrl = `http://127.0.0.1:${storageAddress.port}`;
      }

      const bulkEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(bulkPort),
        NODE_ENV: 'test',
        DATABASE_URL: dbUrl,
        BULK_AMQP_ENABLED: 'false',
        GATEWAY_DEMO_NO_AUTH_ENABLED: 'false',
        BULK_CORRELATION_RECONCILIATION_ENABLED: 'true',
        G7_JWT_ISSUER: issuer,
        G7_JWT_JWKS_URL: `http://127.0.0.1:${jwksAddress.port}/jwks.json`,
        BULK_STORAGE_BUCKET: storageBucket,
        SUPABASE_SERVICE_ROLE_KEY: storageKey,
        SUPABASE_URL: storageUrl,
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

      // Crear el lote persistido real de A una sola vez antes de las 7 aserciones
      const importRes = await request(app.getHttpServer())
        .post('/api/v1/carga-masiva/productos/importaciones')
        .set('Authorization', `Bearer ${tokenFor(actorA)}`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Correlation-Id', correlationA)
        .field('template_version', '2')
        .attach('archivo', createValidBulkV2Csv(), {
          filename: 'importacion.csv',
          contentType: 'text/csv',
        });
      expect(importRes.status, JSON.stringify(importRes.body)).toBe(202);
      batchIdA = importRes.body?.batch_id;
      expect(typeof batchIdA).toBe('string');
    } catch (error) {
      await cleanupDisposableResources();
      throw error;
    }
  }, 90_000);

  afterAll(async () => {
    await cleanupDisposableResources();
  });

  it('autentica a A, concilia su lote persistido y conserva no-store sin mutaciones', async () => {
    const ownerToken = tokenFor(actorA);
    const beforeCount = await adminPool!.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM bulk.batch_jobs WHERE owner_sub = $1 AND correlation_id = $2',
      [actorA.toLowerCase(), correlationA.toLowerCase()],
    );
    expect(beforeCount.rows[0]?.total).toBe(1);

    const res = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationA}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.batch_id).toBe(batchIdA);

    const afterCount = await adminPool!.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM bulk.batch_jobs WHERE owner_sub = $1 AND correlation_id = $2',
      [actorA.toLowerCase(), correlationA.toLowerCase()],
    );
    expect(afterCount.rows[0]?.total).toBe(1);
  });

  it('oculta el lote de A a B con 404 y sin datos privados', async () => {
    const res = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationA}`,
      )
      .set('Authorization', `Bearer ${tokenFor(actorB)}`)
      .expect(404);
    expect(JSON.stringify(res.body)).not.toContain(batchIdA);
    expect(JSON.stringify(res.body)).not.toContain(actorA);
  });

  it('devuelve 404 para correlación inexistente y 400 para UUID inválido', async () => {
    const ownerToken = tokenFor(actorA);
    await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${randomUUID()}`,
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
    await request(app!.getHttpServer())
      .get(
        '/api/v1/carga-masiva/productos/importaciones/por-correlacion/no-es-uuid',
      )
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
  });

  it('rechaza ausencia de JWT y JWT humano sin rol con 401/403 sin filtrar datos', async () => {
    const noJwt = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationA}`,
      )
      .expect(401);
    expect(JSON.stringify(noJwt.body)).not.toContain(batchIdA);

    const noRole = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationA}`,
      )
      .set(
        'Authorization',
        `Bearer ${tokenFor(actorA, { roles: ['CONSULTA'] })}`,
      )
      .expect(403);
    expect(JSON.stringify(noRole.body)).not.toContain(batchIdA);
  });

  it('rechaza JWT mal formado, firma inválida, expirado, issuer y audience incorrectos', async () => {
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: signed.key.kid, typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: actorA,
        tipo: 'acceso',
        roles: ['GESTOR_COMERCIAL'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        jti: randomUUID(),
      }),
    ).toString('base64url');
    const invalidSig = `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), otherKey.privateKey).toString('base64url')}`;

    const badTokens = [
      'malformed.jwt',
      invalidSig,
      tokenFor(actorA, { exp: Math.floor(Date.now() / 1000) - 60 }),
      tokenFor(actorA, { iss: 'https://wrong-issuer.test' }),
      // Para servicio (M2M) con audience incorrecta también debe rechazarse
      signed.token({ aud: ['wrong-audience'], scope: 'carga-masiva:leer' }),
    ];

    for (const bad of badTokens) {
      const res = await request(app!.getHttpServer())
        .get(
          `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationA}`,
        )
        .set('Authorization', `Bearer ${bad}`);
      expect([401, 403]).toContain(res.status);
    }
  });

  it('bloquea retry y reporte de un lote ajeno sin cambiar persistencia', async () => {
    const tokenB = tokenFor(actorB);
    const beforeRow = await adminPool!.query<{ status: string }>(
      'SELECT status::text AS status FROM bulk.batch_jobs WHERE batch_id = $1',
      [batchIdA],
    );

    await request(app!.getHttpServer())
      .post(`/api/v1/carga-masiva/productos/importaciones/${batchIdA}/reanudar`)
      .set('Authorization', `Bearer ${tokenB}`)
      .set('Idempotency-Key', randomUUID())
      .expect(404);

    await request(app!.getHttpServer())
      .get(`/api/v1/carga-masiva/productos/importaciones/${batchIdA}/reporte`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);

    const afterRow = await adminPool!.query<{ status: string }>(
      'SELECT status::text AS status FROM bulk.batch_jobs WHERE batch_id = $1',
      [batchIdA],
    );
    expect(afterRow.rows[0]?.status).toBe(beforeRow.rows[0]?.status);
  });

  it('devuelve 503 no-store cuando el proveedor real se detiene', async () => {
    const currentBulk = bulkProcess;
    bulkProcess = undefined;
    await stopProcess(currentBulk);

    const res = await request(app!.getHttpServer())
      .get(
        `/api/v1/carga-masiva/productos/importaciones/por-correlacion/${correlationA}`,
      )
      .set('Authorization', `Bearer ${tokenFor(actorA)}`)
      .expect(503);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
