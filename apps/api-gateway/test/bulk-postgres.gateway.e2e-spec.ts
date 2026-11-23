import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkSvcModule } from '../../bulk-svc/src/bulk-svc.module.js';
import { BulkProblemFilter } from '../../bulk-svc/src/http/bulk-problem.filter.js';
import { ApiGatewayModule } from '../src/api-gateway.module.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../src/routing/gateway-settings.js';
import { Phase1Postgres } from './support/phase1-postgres.js';
import { createSignedIdentity } from './support/signed-identity.js';

const ownerA = '9d75c591-82d3-4e0a-a221-0a1db54ebf1c';
const ownerB = '8d75c591-82d3-4e0a-a221-0a1db54ebf1c';
const issuer = 'https://isolated.test/issuer';
const correlationId = '457e89be-36e7-49db-b8c1-24f319fa6ef4';
const basePath = '/api/v1/carga-masiva/productos/importaciones/por-correlacion';
const originalEnvironment = new Map<string, string | undefined>();

function setTestEnvironment(name: string, value: string): void {
  if (!originalEnvironment.has(name))
    originalEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}

function restoreEnvironment(): void {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe('Gateway → Bulk real → PostgreSQL 17 descartable (conciliación por correlación)', () => {
  let postgres: Phase1Postgres;
  let bulk: INestApplication | undefined;
  let gateway: INestApplication | undefined;
  let jwksServer: ReturnType<typeof createServer> | undefined;
  let signed: ReturnType<typeof createSignedIdentity>;
  let gatewaySettings: GatewaySettings;
  let bulkOrigin = '';
  let gatewayOrigin = '';
  let batchId = '';

  const token = (sub: string, roles: string[] = ['GESTOR_COMERCIAL']) =>
    signed.token({ tipo: 'acceso', sub, roles });
  const requestCorrelation = (correlation = correlationId) =>
    request(gatewayOrigin).get(`${basePath}/${correlation}`);
  const persistenceSnapshot = () =>
    postgres.sql(
      `SELECT jsonb_build_object(
        'batch', COALESCE((
          SELECT to_jsonb(batch)
          FROM bulk.batch_jobs AS batch
          WHERE batch.batch_id = '${batchId}'
        ), 'null'::jsonb),
        'manifests', COALESCE((
          SELECT jsonb_agg(to_jsonb(manifest) ORDER BY manifest.id)
          FROM bulk.file_manifests AS manifest
          WHERE manifest.id IN (
            SELECT batch.input_file_id
            FROM bulk.batch_jobs AS batch
            WHERE batch.batch_id = '${batchId}'
            UNION
            SELECT batch.report_file_id
            FROM bulk.batch_jobs AS batch
            WHERE batch.batch_id = '${batchId}' AND batch.report_file_id IS NOT NULL
          )
        ), '[]'::jsonb),
        'rows', COALESCE((
          SELECT jsonb_agg(to_jsonb(batch_row) ORDER BY batch_row.id)
          FROM bulk.batch_rows AS batch_row
          JOIN bulk.batch_jobs AS batch ON batch.id = batch_row.batch_job_id
          WHERE batch.batch_id = '${batchId}'
        ), '[]'::jsonb),
        'steps', COALESCE((
          SELECT jsonb_agg(to_jsonb(step) ORDER BY step.id)
          FROM bulk.row_domain_steps AS step
          JOIN bulk.batch_rows AS batch_row ON batch_row.id = step.batch_row_id
          JOIN bulk.batch_jobs AS batch ON batch.id = batch_row.batch_job_id
          WHERE batch.batch_id = '${batchId}'
        ), '[]'::jsonb),
        'outbox', COALESCE((
          SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
          FROM bulk.outbox AS event
          WHERE event.correlation_id = '${correlationId}'
        ), '[]'::jsonb),
        'inbox', COALESCE((
          SELECT jsonb_agg(to_jsonb(receipt) ORDER BY receipt.id)
          FROM bulk.inbox AS receipt
          WHERE receipt.correlation_id = '${correlationId}'
        ), '[]'::jsonb)
      )::text;`,
    );

  beforeAll(async () => {
    try {
      postgres = new Phase1Postgres();
      await postgres.start();
      const postgresVersion = postgres.sql('SHOW server_version_num;');
      if (!postgresVersion.startsWith('17'))
        throw new Error(
          `El harness Bulk requiere PostgreSQL 17; obtuvo ${postgresVersion}`,
        );
      console.info(
        `[bulk-gateway-e2e] SHA=${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()} PostgreSQL=${postgresVersion} BULK_CORRELATION_RECONCILIATION_ENABLED=test-only`,
      );
      const fixture = (path: string) => readFileSync(path, 'utf8');
      postgres.sql(`
        CREATE ROLE po_bulk_owner NOLOGIN;
        CREATE ROLE bulk_gateway_e2e LOGIN PASSWORD '${postgres.password}';
        CREATE SCHEMA bulk AUTHORIZATION po_bulk_owner;
        SET ROLE po_bulk_owner;
        ${fixture('apps/bulk-svc/test/fixtures/0001_create_bulk_persistence.sql')}
        ${fixture('apps/bulk-svc/migrations/0002_export_source_snapshot.sql')}
        ${fixture('apps/bulk-svc/migrations/0003_export_claim_lease.sql')}
        ${fixture('apps/bulk-svc/migrations/0005_actor_ownership.sql')}
        ${fixture('apps/bulk-svc/migrations/0006_owner_correlation_identity.sql')}
        ${fixture('apps/bulk-svc/migrations/0007_bulk_retry_v1.sql')}
        RESET ROLE;
        GRANT USAGE ON SCHEMA bulk TO bulk_gateway_e2e;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA bulk TO bulk_gateway_e2e;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA bulk TO bulk_gateway_e2e;
      `);

      const databaseUrl = `postgresql://bulk_gateway_e2e:${encodeURIComponent(postgres.password)}@127.0.0.1:${postgres.port}/postgres?sslmode=disable`;
      setTestEnvironment('NODE_ENV', 'test');
      setTestEnvironment('DATABASE_URL', databaseUrl);
      setTestEnvironment('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
      setTestEnvironment('G7_JWT_ISSUER', issuer);
      setTestEnvironment('BULK_CORRELATION_RECONCILIATION_ENABLED', 'true');
      setTestEnvironment('BULK_AMQP_ENABLED', 'false');
      if (!originalEnvironment.has('G7_JWT_JWKS_URL'))
        originalEnvironment.set('G7_JWT_JWKS_URL', process.env.G7_JWT_JWKS_URL);
      delete process.env.G7_JWT_JWKS_URL;
      const testSettings: GatewaySettings = {
        upstreams: {},
        timeoutMs: 5000,
        maxBytes: 1024 * 1024,
        issuer,
        jwksUrl: '',
        publicOperations: [],
        demoNoAuthEnabled: false,
        readOnlyDemoEnabled: false,
        securityMode: 'G7_AUTHENTICATED',
      };
      signed = createSignedIdentity(testSettings);
      setTestEnvironment('G7_JWT_PUBLIC_KEY', signed.publicKeyPem);
      setTestEnvironment('JWT_PUBLIC_KEY', signed.publicKeyPem);

      const bulkModule = await Test.createTestingModule({
        imports: [BulkSvcModule],
      }).compile();
      bulk = bulkModule.createNestApplication({ logger: false });
      bulk.useGlobalFilters(new BulkProblemFilter());
      await bulk.listen(0, '127.0.0.1');
      bulkOrigin = await bulk.getUrl();

      jwksServer = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ keys: [signed.key] }));
      });
      jwksServer.listen(0, '127.0.0.1');
      await once(jwksServer, 'listening');
      const address = jwksServer.address();
      if (!address || typeof address === 'string')
        throw new Error('JWKS loopback sin puerto');
      gatewaySettings = {
        ...testSettings,
        upstreams: { 'bulk-svc': bulkOrigin },
        jwksUrl: `http://127.0.0.1:${address.port}/.well-known/jwks.json`,
      };
      const gatewayModule = await Test.createTestingModule({
        imports: [ApiGatewayModule],
      })
        .overrideProvider(GATEWAY_SETTINGS)
        .useValue(gatewaySettings)
        .compile();
      gateway = gatewayModule.createNestApplication({
        bodyParser: false,
        logger: false,
      });
      await gateway.listen(0, '127.0.0.1');
      gatewayOrigin = await gateway.getUrl();
      // Close the local JWKS only after the first authenticated Gateway call; the
      // Gateway's verifier caches its successful key lookup for the test window.

      const manifestId = randomUUID();
      batchId = randomUUID();
      postgres.sql(`
        INSERT INTO bulk.file_manifests (id, role, format, content_ref)
        VALUES ('${manifestId}', 'ENTRADA_IMPORTACION', 'CSV', 'fixture://gateway-bulk/input.csv');
        INSERT INTO bulk.batch_jobs (batch_id, owner_sub, input_file_id, template_version, correlation_id)
        VALUES ('${batchId}', '${ownerA}', '${manifestId}', 2, '${correlationId}');
      `);
    } catch (error) {
      await gateway?.close();
      await bulk?.close();
      if (jwksServer?.listening)
        await new Promise<void>((resolve, reject) =>
          jwksServer!.close((error) => (error ? reject(error) : resolve())),
        );
      restoreEnvironment();
      await postgres?.close();
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    await gateway?.close();
    await bulk?.close();
    if (jwksServer?.listening)
      await new Promise<void>((resolve, reject) =>
        jwksServer!.close((error) => (error ? reject(error) : resolve())),
      );
    restoreEnvironment();
    await postgres?.close();
  }, 30_000);

  it('autentica a A, concilia su lote persistido y conserva no-store sin mutaciones', async () => {
    const before = persistenceSnapshot();
    const response = await requestCorrelation()
      .set('Authorization', `Bearer ${token(ownerA)}`)
      .expect(200);
    expect(response.body).toEqual({
      batch_id: batchId,
      correlation_id: correlationId,
      status: 'QUEUED',
      template_version: 2,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    const after = persistenceSnapshot();
    expect(after).toBe(before);
  });

  it('oculta el lote de A a B con 404 y sin datos privados', async () => {
    const before = persistenceSnapshot();
    const response = await requestCorrelation()
      .set('Authorization', `Bearer ${token(ownerB)}`)
      .expect(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain(batchId);
    expect(JSON.stringify(response.body)).not.toContain(correlationId);
    expect(persistenceSnapshot()).toBe(before);
  });

  it('devuelve 404 para correlación inexistente y 400 para UUID inválido', async () => {
    const before = persistenceSnapshot();
    const missing = await requestCorrelation(randomUUID())
      .set('Authorization', `Bearer ${token(ownerA)}`)
      .expect(404);
    const invalid = await requestCorrelation('no-es-uuid')
      .set('Authorization', `Bearer ${token(ownerA)}`)
      .expect(400);
    for (const response of [missing, invalid]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(response.body)).not.toContain(batchId);
      expect(JSON.stringify(response.body)).not.toContain(correlationId);
    }
    expect(persistenceSnapshot()).toBe(before);
  });

  it('rechaza ausencia de JWT y JWT humano sin rol con 401/403 sin filtrar datos', async () => {
    const before = persistenceSnapshot();
    const unauthenticated = await requestCorrelation().expect(401);
    const unauthorized = await requestCorrelation()
      .set('Authorization', `Bearer ${token(ownerA, ['CLIENTE'])}`)
      .expect(403);
    for (const response of [unauthenticated, unauthorized]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(response.body)).not.toContain(batchId);
      expect(JSON.stringify(response.body)).not.toContain(correlationId);
    }
    expect(persistenceSnapshot()).toBe(before);
  });

  it('devuelve 503 no-store cuando el proveedor real se detiene', async () => {
    await bulk?.close();
    bulk = undefined;
    const response = await requestCorrelation()
      .set('Authorization', `Bearer ${token(ownerA)}`)
      .expect(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain(batchId);
    expect(JSON.stringify(response.body)).not.toContain(correlationId);
  });
});
