import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, isNull } from 'drizzle-orm';
import { BulkSvcModule } from '../src/bulk-svc.module.js';
import { BulkProblemFilter } from '../src/http/bulk-problem.filter.js';
import { BulkReadinessService } from '../src/health/bulk-readiness.service.js';
import { BulkPersistenceRepository } from '../src/persistence/bulk.repository.js';
import { bulkSchema, outbox as bulkOutbox } from '../src/persistence/bulk.schema.js';
import { BULK_EXPORT_SOURCE, type BulkExportSource } from '../src/export/bulk-export-source.js';
import { BULK_TEMPLATE_HEADERS } from '../src/domain/bulk-template-v2.js';
import { ApiGatewayModule } from '../../api-gateway/src/api-gateway.module.js';
import {
  GATEWAY_SETTINGS,
  type GatewaySettings,
} from '../../api-gateway/src/routing/gateway-settings.js';
import { createSignedIdentity } from '../../api-gateway/test/support/signed-identity.js';
import { Database, type PostgresSettings } from '../../catalog-svc/src/database.js';
import { CatalogTransactionManager } from '../../catalog-svc/src/catalog-transaction.js';
import { CatalogMutationService } from '../../catalog-svc/src/catalog-mutation.service.js';
import { PostgresCatalogWriteRepository } from '../../catalog-svc/src/postgres-catalog-write.repository.js';
import { CatalogBulkService, CatalogBulkIdentity } from '../../catalog-svc/src/catalog-bulk.service.js';
import { CatalogTokenVerifier } from '../../catalog-svc/src/catalog-auth.js';
import { CatalogIdentityAcquisitionError } from '../../catalog-svc/src/catalog-pricing-identity.js';
import { CatalogBulkContentClient, CatalogBulkContentIdentity } from '../../catalog-svc/src/catalog-bulk-content.js';
import { outbox as catalogOutbox, products } from '../../catalog-svc/src/catalog.schema.js';
import type { CatalogEnvelope } from '../../catalog-svc/src/catalog-messages.js';

const frontend = process.env.BULK_REAL_FRONTEND_ROOT;
const bulkDatabaseUrl = process.env.BULK_RETRY_INTEGRATION_BULK_DATABASE_URL;
const catalogDatabaseUrl = process.env.BULK_RETRY_INTEGRATION_CATALOG_DATABASE_URL;
const storageUrl = process.env.BULK_RETRY_INTEGRATION_STORAGE_URL;
const storageServiceKey = process.env.BULK_RETRY_INTEGRATION_STORAGE_SERVICE_ROLE_KEY;
const enabled = Boolean(
  frontend && bulkDatabaseUrl && catalogDatabaseUrl && storageUrl && storageServiceKey,
);

const ownerASub = '00000000-0000-4000-8000-000000000050';
const ownerBSub = '00000000-0000-4000-8000-000000000051';
const issuer = 'bulk-browser-real';
const originalEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function restoreEnv(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function buildCiManifest(backendSha: string, docsSha: string) {
  const releaseId = 'bulk-h5-browser-ci-e2e';
  const manifest = {
    schemaVersion: 2,
    approvalStatus: 'APPROVED',
    releaseId,
    openApiVersion: '0.7.0-rc.3',
    asyncApiVersion: '0.7.0-rc.3',
    docsSha,
    backendSha,
    reconciliation: {
      operation: 'GET /api/v1/carga-masiva/productos/importaciones/por-correlacion/{correlationId}',
      authenticatedIntegrationEvidenceSha256: createHash('sha256').update(`reconciliation:${backendSha}`).digest('hex'),
    },
    replay: {
      concurrentIdempotency: true,
      evidenceSha256: createHash('sha256').update(`replay:${backendSha}`).digest('hex'),
    },
    catalogRetry: {
      catalogConsumerSha: backendSha,
      protocol: 'BULK_RETRY_V1',
      domains: ['CATALOGO'],
      v4v2EvidenceSha256: createHash('sha256').update(`catalog-retry:${backendSha}`).digest('hex'),
    },
  };
  const manifestJson = JSON.stringify(manifest);
  const manifestSha256 = createHash('sha256').update(manifestJson).digest('hex');
  return { manifestJson, releaseId, manifestSha256 };
}

describe.skipIf(!enabled)(
  'Browser HTTP real local: PostgreSQL 17 + Storage + Gateway + Bulk + Catalog + Vite + Chromium',
  () => {
    let directory = '';
    let pool: Pool | undefined;
    let catalogDatabase: Database | undefined;
    let bulkApp: INestApplication | undefined;
    let gatewayApp: INestApplication | undefined;
    let jwksServer: Server | undefined;
    let browserProxy: Server | undefined;
    let relayActive = false;
    let relayLoop: Promise<void> | undefined;
    let gatewayOrigin = '';

    beforeAll(async () => {
      if (!frontend || !isAbsolute(frontend)) {
        throw new Error('BULK_REAL_FRONTEND_ROOT debe apuntar al checkout Frontend absoluto.');
      }
      directory = mkdtempSync(join(tmpdir(), 'bulk-browser-real-'));
      const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const docsSha = process.env.BULK_REAL_DOCS_SHA ?? backendSha;

      setEnv('NODE_ENV', 'test');
      setEnv('DATABASE_URL', bulkDatabaseUrl!);
      setEnv('G6_SECURITY_MODE', 'G7_AUTHENTICATED');
      setEnv('G7_JWT_ISSUER', issuer);
      setEnv('BULK_STORAGE_BUCKET', 'bulk-retry-integration');
      setEnv('SUPABASE_URL', storageUrl!);
      setEnv('SUPABASE_SERVICE_ROLE_KEY', storageServiceKey!);
      setEnv('BULK_CATALOG_V3_ENABLED', 'true');
      setEnv('BULK_CATALOG_V3_AUTHORIZATION_VERIFIED', 'true');
      setEnv('BULK_RETRY_CATALOG_V1_ENABLED', 'true');
      setEnv('BULK_RETRY_ELIGIBILITY_ENABLED', 'true');
      setEnv('BULK_CORRELATION_RECONCILIATION_ENABLED', 'true');
      setEnv('CATALOG_BULK_RETRY_V1_ENABLED', 'true');
      setEnv('CATALOG_BULK_RESULT_V2_ENABLED', 'true');
      setEnv('BULK_AMQP_ENABLED', 'false');
      if (!originalEnv.has('G7_JWT_JWKS_URL')) {
        originalEnv.set('G7_JWT_JWKS_URL', process.env.G7_JWT_JWKS_URL);
      }
      delete process.env.G7_JWT_JWKS_URL;

      const testSettings: GatewaySettings = {
        upstreams: {},
        timeoutMs: 15_000,
        maxBytes: 10 * 1024 * 1024,
        issuer,
        jwksUrl: '',
        publicOperations: [],
        demoNoAuthEnabled: false,
        readOnlyDemoEnabled: false,
        securityMode: 'G7_AUTHENTICATED',
      };
      const signed = createSignedIdentity(testSettings);
      setEnv('G7_JWT_PUBLIC_KEY', signed.publicKeyPem);
      setEnv('JWT_PUBLIC_KEY', signed.publicKeyPem);

      pool = new Pool({ connectionString: bulkDatabaseUrl, max: 6 });
      const bulkDb = drizzle(pool, { schema: bulkSchema, logger: false });
      const bulkRepository = new BulkPersistenceRepository(bulkDb);

      const catalogUrl = new URL(catalogDatabaseUrl!);
      const catalogSettings: PostgresSettings = {
        pool: {
          host: catalogUrl.hostname,
          port: Number(catalogUrl.port || 5432),
          database: catalogUrl.pathname.slice(1),
          user: decodeURIComponent(catalogUrl.username),
          password: decodeURIComponent(catalogUrl.password),
          ssl: false,
          max: 6,
        },
        expectedRole: decodeURIComponent(catalogUrl.username),
        database: catalogUrl.pathname.slice(1),
        user: decodeURIComponent(catalogUrl.username),
        password: decodeURIComponent(catalogUrl.password),
        mode: 'direct',
      };
      catalogDatabase = new Database(catalogSettings);
      await catalogDatabase.verifyIdentity();

      const transactions = new CatalogTransactionManager(catalogDatabase);
      const seedMutations = new CatalogMutationService(
        transactions,
        new PostgresCatalogWriteRepository(),
        {
          masters: async () => ({ schemaVersion: 1 }),
          attributes: async (_type: string, values: unknown[]) => values,
        } as never,
        {
          resolve: async (_input, id) => ({ slug: `browser-${id}`, moneda: 'PEN' }),
        },
      );
      const retrySkuBase = `BULK-BROWSER-RETRY-${randomUUID().slice(0, 8)}`;
      const retrySeed = await seedMutations.createProduct(
        {
          nombre: 'Browser Retry Seed',
          descripcion: 'Before browser retry',
          categoriaId: 'category-fixture',
          tipoProductoId: 'type-fixture',
          marcaId: 'brand-fixture',
          skuBase: retrySkuBase,
          tieneVariantes: false,
          precioBaseInicial: 25,
          imagenes: [{ url: 'https://example.test/browser-retry-seed' }],
          perfilFisico: { pesoKg: 1.2, dimensionesCm: { largo: 10, ancho: 15, alto: 20 } },
        },
        { authorization: 'Bearer isolated-master-fixture', correlationId: randomUUID() },
      );

      const exportSource: BulkExportSource = {
        catalog: async (_cursor, limit) => {
          const rows = await catalogDatabase!.read((db) => db.select().from(products).limit(limit));
          return {
            items: rows.map((row) => ({
              productId: row.id,
              skuBase: row.sku_base,
              variantSku: null,
              name: row.nombre,
              description: row.descripcion,
              categoryId: row.categoria_id,
              brandId: row.marca_id,
              productTypeId: row.tipo_producto_id,
            })),
            nextCursor: null,
            observedAt: new Date().toISOString(),
            version: '1',
          };
        },
        pricing: async () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString(), version: '1' }),
        inventory: async () => ({ items: [], nextCursor: null, observedAt: new Date().toISOString(), version: '1' }),
      };

      const bulkModule = await Test.createTestingModule({ imports: [BulkSvcModule] })
        .overrideProvider(BULK_EXPORT_SOURCE)
        .useValue(exportSource)
        .overrideProvider(BulkReadinessService)
        .useValue({ probe: async () => ({ ready: true }) })
        .compile();
      bulkApp = bulkModule.createNestApplication({ logger: false });
      bulkApp.useGlobalFilters(new BulkProblemFilter());
      await bulkApp.listen(0, '127.0.0.1');
      const bulkOrigin = await bulkApp.getUrl();
      setEnv('CATALOG_BULK_CONTENTS_URL', bulkOrigin);

      jwksServer = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [signed.key] }));
      });
      jwksServer.listen(0, '127.0.0.1');
      await once(jwksServer, 'listening');
      const jwksAddr = jwksServer.address();
      if (!jwksAddr || typeof jwksAddr === 'string') throw new Error('JWKS loopback sin puerto');

      const gatewaySettings: GatewaySettings = {
        ...testSettings,
        upstreams: { 'bulk-svc': bulkOrigin },
        jwksUrl: `http://127.0.0.1:${jwksAddr.port}/.well-known/jwks.json`,
      };
      const gatewayModule = await Test.createTestingModule({ imports: [ApiGatewayModule] })
        .overrideProvider(GATEWAY_SETTINGS)
        .useValue(gatewaySettings)
        .compile();
      gatewayApp = gatewayModule.createNestApplication({ bodyParser: false, logger: false });
      await gatewayApp.listen(0, '127.0.0.1');
      gatewayOrigin = await gatewayApp.getUrl();

      // Local Catalog consumer + Outbox/Inbox relay loop (no Azure Service Bus)
      const serviceToken = signed.token({
        tipo: 'servicio',
        sub: 'catalog-svc',
        client_id: 'catalog-svc',
        scope: 'carga-masiva:contenidos:leer',
      });
      const contentIdentity = new CatalogBulkContentIdentity(undefined, new CatalogTokenVerifier(undefined));
      vi.spyOn(contentIdentity, 'authorization').mockResolvedValue(`Bearer ${serviceToken}`);
      const contentClient = new CatalogBulkContentClient(contentIdentity);

      let injectedTransientFailure = false;
      const transientIdentity = new CatalogBulkIdentity(undefined, new CatalogTokenVerifier(undefined));
      vi.spyOn(transientIdentity, 'authorization').mockRejectedValue(
        new CatalogIdentityAcquisitionError('Simulated transient Catalog auth outage for browser retry E2E', 503),
      );
      const healthyIdentity = new CatalogBulkIdentity(undefined, new CatalogTokenVerifier(undefined));
      vi.spyOn(healthyIdentity, 'authorization').mockResolvedValue('Bearer isolated-master-fixture');

      const catalogMutations = new CatalogMutationService(
        transactions,
        new PostgresCatalogWriteRepository(),
        {
          masters: async () => ({ schemaVersion: 1 }),
          attributes: async (_type: string, values: unknown[]) => values,
        } as never,
        {
          resolve: async (_input, id) => ({ slug: `browser-${id}`, moneda: 'PEN' }),
        },
      );

      relayActive = true;
      relayLoop = (async () => {
        while (relayActive) {
          try {
            const pending = await bulkDb
              .select()
              .from(bulkOutbox)
              .where(isNull(bulkOutbox.publishedAt))
              .limit(10);
            for (const event of pending) {
              const envelope = event.payload as unknown as CatalogEnvelope;
              const isRetryBatch = JSON.stringify(envelope).includes(retrySkuBase) || event.schemaVersion === 4;
              const shouldFail =
                !injectedTransientFailure &&
                event.schemaVersion === 3 &&
                isRetryBatch;
              // Check content for retrySkuBase if V3
              let useTransientFailure = false;
              if (!injectedTransientFailure && event.schemaVersion === 3) {
                const contentRef = envelope.data?.content_ref as { content_id: string; sha256: string; byte_length: number; content_type: string } | undefined;
                if (contentRef) {
                  const doc = await contentClient.getDocument(contentRef);
                  if (JSON.stringify(doc).includes(retrySkuBase)) {
                    useTransientFailure = true;
                    injectedTransientFailure = true;
                  }
                }
              } else if (shouldFail) {
                useTransientFailure = true;
                injectedTransientFailure = true;
              }
              const consumer = new CatalogBulkService(
                catalogDatabase!,
                catalogMutations,
                useTransientFailure ? transientIdentity : healthyIdentity,
                contentClient as never,
              );
              await consumer.consume(envelope);
              const [resultRow] = await catalogDatabase!.read((db) =>
                db.select().from(catalogOutbox).where(eq(catalogOutbox.causation_id, envelope.message_id)).limit(1),
              );
              if (resultRow) {
                await bulkRepository.recordCatalogBulkResult({
                  messageId: resultRow.message_id,
                  operationId: String(resultRow.operation_id),
                  causationId: String(resultRow.causation_id),
                  eventName: String(resultRow.event_name) as 'catalog.bulk.upsert.completed',
                  correlationId: resultRow.correlation_id,
                  payload: {
                    message_id: resultRow.message_id,
                    schema_version: resultRow.schema_version,
                    occurred_at: resultRow.occurred_at.toISOString(),
                    correlation_id: resultRow.correlation_id,
                    causation_id: resultRow.causation_id,
                    operation_id: resultRow.operation_id,
                    producer: 'catalog-svc',
                    kind: resultRow.kind,
                    name: resultRow.event_name,
                    data: resultRow.payload,
                  },
                });
              }
              await bulkDb
                .update(bulkOutbox)
                .set({ publishedAt: new Date() })
                .where(eq(bulkOutbox.id, event.id));
            }
          } catch (error) {
            console.warn('[bulk-browser-real relay]', error instanceof Error ? error.message : String(error));
          }
          await pause(150);
        }
      })();

      // Prepare CSVs
      const createSku = `BULK-BROWSER-${randomUUID().slice(0, 8)}`;
      const createValues = [
        'ALTA', '', '', createSku, '', 'Producto Navegador Real', 'Creado desde Chromium E2E',
        'category-fixture', 'brand-fixture', 'type-fixture', 'false', '19.90', '[]', '', '', '0',
      ];
      const csvPath = join(directory, 'bulk-browser-real.csv');
      writeFileSync(
        csvPath,
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${createValues.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')}\r\n`,
        'utf8',
      );

      const retryValues = [
        'ACTUALIZACION', retrySeed.product_id, JSON.stringify({ producto: Number(retrySeed.catalog_version), variante: null }),
        retrySkuBase, '', 'Browser Retry Seed', 'Actualizado tras retry V4',
        'category-fixture', 'brand-fixture', 'type-fixture', 'false', '', '[]', '', '', '25.00',
      ];
      const retryCsvPath = join(directory, 'bulk-ambiguous-retry.csv');
      writeFileSync(
        retryCsvPath,
        `${BULK_TEMPLATE_HEADERS.join(',')}\r\n${retryValues.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')}\r\n`,
        'utf8',
      );

      const vitePort = 5200 + Math.floor(Math.random() * 2000);
      const browserPort = 8200 + Math.floor(Math.random() * 2000);
      let importPostCount = 0;
      browserProxy = createServer((req, res) => {
        const isImportPost =
          req.method === 'POST' && req.url?.startsWith('/api/v1/carga-masiva/productos/importaciones');
        if (isImportPost) importPostCount += 1;
        const injectAmbiguous504 = isImportPost && importPostCount === 2;

        const targetOrigin = req.url?.startsWith('/api/v1/') ? gatewayOrigin : `http://127.0.0.1:${vitePort}`;
        const target = new URL(req.url ?? '/', targetOrigin);
        const outgoing = httpRequest(
          target,
          { method: req.method, headers: { ...req.headers, host: target.host } },
          (incoming) => {
            if (injectAmbiguous504) {
              incoming.resume();
              res.destroy();
              return;
            }
            res.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, incoming.headers);
            incoming.pipe(res);
          },
        );
        outgoing.on('error', (error) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(`Local E2E proxy failed: ${error.message}`);
        });
        req.pipe(outgoing);
      });
      browserProxy.listen(browserPort, '127.0.0.1');
      await once(browserProxy, 'listening');

      const browserOrigin = `http://127.0.0.1:${browserPort}`;
      const manifest = buildCiManifest(backendSha, docsSha);
      const ownerAJwt = signed.token({ tipo: 'acceso', sub: ownerASub, roles: ['GESTOR_COMERCIAL'] });
      const ownerBJwt = signed.token({ tipo: 'acceso', sub: ownerBSub, roles: ['GESTOR_COMERCIAL'] });
      const forbiddenJwt = signed.token({ tipo: 'acceso', sub: ownerASub, roles: [] });

      const browser = spawn(
        process.execPath,
        [
          join(frontend, 'node_modules', 'playwright', 'cli.js'),
          'test',
          '--config',
          'tests/bulk-http-real.config.ts',
          'tests/bulk-http-real.spec.ts',
        ],
        {
          cwd: frontend,
          windowsHide: true,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            BULK_REAL_BROWSER_ORIGIN: browserOrigin,
            BULK_REAL_JWT: ownerAJwt,
            BULK_REAL_OWNER_B_JWT: ownerBJwt,
            BULK_REAL_FORBIDDEN_JWT: forbiddenJwt,
            BULK_REAL_CSV_PATH: csvPath,
            BULK_REAL_RETRY_CSV_PATH: retryCsvPath,
            BULK_REAL_MANIFEST_JSON: manifest.manifestJson,
            BULK_REAL_MANIFEST_RELEASE_ID: manifest.releaseId,
            BULK_REAL_MANIFEST_SHA256: manifest.manifestSha256,
            BULK_REAL_VITE_PORT: String(vitePort),
            BULK_REAL_BROWSER_PORT: String(browserPort),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      browser.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      browser.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      const status = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          browser.kill();
          reject(new Error('Chromium Bulk E2E superó el límite de 240 segundos.'));
        }, 240_000);
        browser.once('error', (err) => { clearTimeout(timeout); reject(err); });
        browser.once('exit', (code) => { clearTimeout(timeout); resolve(code ?? 1); });
      });
      if (status !== 0) {
        throw new Error(`Chromium/Gateway/Bulk HTTP real falló (${status}).\n${stdout.slice(-3000)}\n${stderr.slice(-1500)}`);
      }
      console.info(stdout.trim());
    }, 300_000);

    afterAll(async () => {
      relayActive = false;
      await relayLoop?.catch(() => undefined);
      await new Promise<void>((resolve) => browserProxy?.close(() => resolve()) ?? resolve());
      await gatewayApp?.close();
      await bulkApp?.close();
      if (jwksServer?.listening) {
        await new Promise<void>((resolve) => jwksServer!.close(() => resolve()));
      }
      await catalogDatabase?.onModuleDestroy();
      await pool?.end();
      restoreEnv();
      if (directory) {
        const withinTemp = relative(tmpdir(), directory);
        if (withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp)) {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }, 30_000);

    it('completes real browser Bulk E2E through Gateway, Bulk, Catalog, PostgreSQL 17 and local Storage', () => {
      expect(gatewayOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    }, 5_000);
  },
);
