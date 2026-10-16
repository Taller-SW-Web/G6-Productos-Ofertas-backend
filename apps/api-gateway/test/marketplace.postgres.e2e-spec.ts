import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
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
import { GatewayReadiness } from '../src/routing/gateway-readiness.js';
import { createSignedIdentity } from './support/signed-identity.js';
import { marketplaceRuntime } from './support/marketplace-runtime.js';

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No local test port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function start(
  service: 'taxonomy' | 'catalog',
  port: number,
): Promise<ChildProcess> {
  const runtime = marketplaceRuntime(service, process.env);
  const child = spawn(
    process.execPath,
    ['--env-file=' + runtime.envFile, runtime.entrypoint],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [service.toUpperCase() + '_SVC_PORT']: String(port),
      },
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error('Service startup failed (details suppressed)');
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/health', {
          signal: AbortSignal.timeout(500),
        });
        await response.body?.cancel();
        if (response.status === 200) return child;
      } catch {
        /* Still starting; bounded wait below. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Service startup timed out');
  } catch (error) {
    await stop(child);
    throw error;
  }
}
async function stop(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

describe.skipIf(process.env.G6_HTTP_POSTGRES_INTEGRATION !== '1')(
  'Marketplace Gateway → real compiled services → PostgreSQL (partial)',
  () => {
    let taxonomy: ChildProcess | undefined;
    let catalog: ChildProcess | undefined;
    let app: INestApplication;
    let signed: ReturnType<typeof createSignedIdentity>;
    beforeAll(async () => {
      const taxonomyPort = await unusedPort(),
        catalogPort = await unusedPort();
      taxonomy = await start('taxonomy', taxonomyPort);
      catalog = await start('catalog', catalogPort);
      const settings = readGatewaySettings({
        GATEWAY_TAXONOMY_SVC_URL: 'http://127.0.0.1:' + taxonomyPort,
        GATEWAY_CATALOG_SVC_URL: 'http://127.0.0.1:' + catalogPort,
        GATEWAY_TIMEOUT_MS: '10000',
      });
      // Solo sustituye la fuente de claves por el issuer aislado firmado.
      // Se conservan verificador RS256, guards, scopes, audiencia y allowlists.
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
    }, 50000);
    afterAll(async () => {
      await app?.close();
      await stop(catalog);
      await stop(taxonomy);
    });
    it('forwards categories and brands from real Taxonomy PostgreSQL', async () => {
      for (const [path, key] of [
        ['categorias', 'categories'],
        ['marcas', 'brands'],
      ]) {
        const correlation = randomUUID();
        const response = await request(app.getHttpServer())
          .get('/api/v1/' + path)
          .set('authorization', 'Bearer ' + signed.token())
          .set('X-Correlation-Id', correlation)
          .expect(200);
        expect(response.headers['x-correlation-id'] === correlation).toBe(true);
        const rows: Record<string, unknown>[] = response.body[key];
        expect(
          Array.isArray(rows) && rows.every((r) => r.status === 'ACTIVA'),
        ).toBe(true);
      }
    }, 30000);
    it('preserves the specific commercial eligibility block in both real Catalog routes', async () => {
      for (const path of [
        '/api/v1/productos?canal=MARKETPLACE&q=zapatillas',
        '/api/v1/productos/por-slug/missing?canal=MARKETPLACE',
      ]) {
        const response = await request(app.getHttpServer())
          .get(path)
          .set('authorization', 'Bearer ' + signed.token())
          .expect(503);
        expect(response.body.code === 'SERVICIO_NO_DISPONIBLE').toBe(true);
      }
    });
    it('rejects signed authentication/authorization negatives on all three GETs', async () => {
      for (const path of [
        '/api/v1/categorias',
        '/api/v1/productos?canal=MARKETPLACE',
        '/api/v1/productos/por-slug/missing?canal=MARKETPLACE',
      ]) {
        await request(app.getHttpServer()).get(path).expect(401);
        for (const [claims, status] of [
          [{ exp: 1 }, 401],
          [{ aud: ['wrong-audience'] }, 401],
          [{ scope: 'wrong-scope' }, 403],
          [{ sub: 'unlisted-client' }, 403],
        ] as const) {
          const response = await request(app.getHttpServer())
            .get(path)
            .set('authorization', 'Bearer ' + signed.token(claims))
            .expect(status);
          expect(
            response.body.code ===
              (status === 401 ? 'TOKEN_INVALIDO' : 'SCOPE_INSUFICIENTE'),
          ).toBe(true);
        }
      }
    });
    it('does not infer dependency readiness from liveness', async () => {
      const result = await app.get(GatewayReadiness).check();
      expect(
        result.status === 'not_ready' && result.coverage === 'partial',
      ).toBe(true);
      await stop(taxonomy);
      taxonomy = undefined;
      const response = await request(app.getHttpServer())
        .get('/api/v1/categorias')
        .set('authorization', 'Bearer ' + signed.token())
        .expect(503);
      expect(response.body.code === 'SERVICIO_NO_DISPONIBLE').toBe(true);
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  },
);
