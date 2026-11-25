import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { CatalogGatewayHarness } from '../support/catalog-gateway-harness.js';
import {
  readPostgresSettings,
  type PostgresSettings,
} from '../../src/database.js';

const enabled = process.env.G6_H5_INT01_CATALOG_L1 === '1';
const configuredFrontendRoot = process.env.CATALOG_REAL_FRONTEND_ROOT ?? '';
let frontendRoot = '';
let frontendSourceSha = '';
if (configuredFrontendRoot) {
  let canonicalFrontendRoot: string;
  try {
    canonicalFrontendRoot = realpathSync(resolve(configuredFrontendRoot));
    if (!statSync(canonicalFrontendRoot).isDirectory()) throw new Error();
  } catch {
    throw new Error('H5_INT08_FRONTEND_CHECKOUT_PATH_INVALID');
  }
  const backendRoot = realpathSync(process.cwd());
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      path === '' ||
      (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    );
  };
  if (
    contains(backendRoot, canonicalFrontendRoot) ||
    contains(canonicalFrontendRoot, backendRoot)
  )
    throw new Error('H5_INT08_FRONTEND_CHECKOUT_PATH_OVERLAPS_BACKEND');
  if (process.platform === 'win32' && canonicalFrontendRoot.startsWith('\\\\'))
    throw new Error('H5_INT08_FRONTEND_CHECKOUT_NETWORK_PATH_FORBIDDEN');
  const gitValue = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: canonicalFrontendRoot,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0)
      throw new Error('H5_INT08_FRONTEND_CHECKOUT_GIT_VALIDATION_FAILED');
    return result.stdout.trim();
  };
  let gitRoot: string;
  let remote: string;
  try {
    gitRoot = realpathSync(gitValue(['rev-parse', '--show-toplevel']));
    remote = gitValue(['remote', 'get-url', 'origin']);
    frontendSourceSha = gitValue(['rev-parse', 'HEAD']);
  } catch {
    throw new Error('H5_INT08_FRONTEND_CHECKOUT_GIT_VALIDATION_FAILED');
  }
  const officialRemote =
    /^(?:https:\/\/github\.com\/|http:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)Taller-SW-Web\/G6-Productos-Ofertas-frontend(?:\.git)?$/i.test(
      remote,
    );
  if (
    gitRoot !== canonicalFrontendRoot ||
    !officialRemote ||
    !/^[a-f0-9]{40}$/i.test(frontendSourceSha)
  )
    throw new Error('H5_INT08_FRONTEND_REPOSITORY_OR_SHA_INVALID');
  const requestedSha = process.env.CATALOG_REAL_FRONTEND_SHA;
  if (
    requestedSha &&
    (!/^[a-f0-9]{40}$/i.test(requestedSha) ||
      requestedSha.toLowerCase() !== frontendSourceSha.toLowerCase())
  )
    throw new Error('H5_INT08_FRONTEND_SHA_PIN_MISMATCH');
  if (
    !existsSync(join(canonicalFrontendRoot, 'package.json')) ||
    !existsSync(join(canonicalFrontendRoot, 'scripts', 'run-h5-int08-l1.mjs'))
  )
    throw new Error('H5_INT08_FRONTEND_REQUIRED_FILES_MISSING');
  frontendRoot = canonicalFrontendRoot;
  process.env.CATALOG_REAL_FRONTEND_SHA = frontendSourceSha;
}
const dockerAvailable =
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).status === 0;

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('H5_INT08_LOOPBACK_PORT_ALLOCATION_FAILED'));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

describe.skipIf(!enabled || !dockerAvailable)(
  'INT-01 L1 Catalog + Gateway + PostgreSQL descartable',
  () => {
    const container = `h5-int01-${randomUUID().slice(0, 8)}`;
    let directory = '';
    let certificate = '';
    let settings: PostgresSettings;
    let gateway: CatalogGatewayHarness | undefined;

    const command = (executable: string, args: string[], input?: string) => {
      const result = spawnSync(executable, args, {
        input,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (result.error || result.status !== 0)
        throw new Error('H5_INT01_DISPOSABLE_SETUP_FAILED');
      return result.stdout.trim();
    };

    const sql = (statement: string) =>
      command(
        'docker',
        [
          'exec',
          '-i',
          container,
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
        ],
        statement,
      );

    const createProduct = async (
      suffix: string,
      skuBase: string,
      hasVariants = false,
    ) => {
      const response = await gateway!.call(
        'POST',
        '/productos',
        {
          nombre: `H5 ${suffix}`,
          descripcion: 'Fixture descartable de INT-01',
          categoriaId: 'category-fixture',
          tipoProductoId: 'type-fixture',
          marcaId: 'brand-fixture',
          skuBase,
          tieneVariantes: hasVariants,
          precioBaseInicial: 20,
          imagenes: [{ url: 'https://example.test/h5-int01' }],
          ...(!hasVariants
            ? {
                perfilFisico: {
                  pesoKg: 1,
                  dimensionesCm: { largo: 10, ancho: 20, alto: 30 },
                },
              }
            : {}),
        },
        gateway!.token(),
      );
      expect(response.status).toBe(201);
      return String(response.body.product_id);
    };

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'h5-int01-catalog-'));
      const certDirectory = join(directory, 'certs');
      mkdirSync(certDirectory);
      chmodSync(certDirectory, 0o755);
      certificate = join(certDirectory, 'server.crt');
      const key = join(certDirectory, 'server.key');
      const openssl =
        process.env.G6_TEST_OPENSSL_PATH ??
        (process.platform === 'win32'
          ? join(
              process.env.ProgramFiles ?? 'C:\\Program Files',
              'Git',
              'usr',
              'bin',
              'openssl.exe',
            )
          : 'openssl');
      command(openssl, [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        certificate,
      ]);
      chmodSync(key, 0o644);
      chmodSync(certificate, 0o644);
      command('docker', [
        'run',
        '--detach',
        '--name',
        container,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_PASSWORD=h5-disposable-admin',
        '--volume',
        `${certDirectory}:/certs:ro`,
        '--entrypoint',
        'sh',
        'postgres:17-alpine',
        '-c',
        'cp /certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key',
      ]);
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        const probe = spawnSync(
          'docker',
          ['exec', container, 'pg_isready', '-U', 'postgres'],
          {
            windowsHide: true,
            stdio: 'ignore',
          },
        );
        if (probe.status === 0) {
          ready = true;
          break;
        }
        await pause(1000);
      }
      if (!ready) throw new Error('H5_INT01_DISPOSABLE_POSTGRES_NOT_READY');
      sql(
        `CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD 'h5-disposable-app'; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; SET ROLE po_catalog_owner;\n${readFileSync(resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'), 'utf8')}\n${readFileSync(resolve('apps/catalog-svc/migrations/0002_create_sku_barcodes.sql'), 'utf8')}\n${readFileSync(resolve('apps/catalog-svc/migrations/0003_product_publication_history.sql'), 'utf8')}\n${readFileSync(resolve('apps/catalog-svc/migrations/0004_historical_preparation_requests.sql'), 'utf8')}`,
      );
      const port = command('docker', ['port', container, '5432/tcp'])
        .split(':')
        .at(-1);
      if (!port || !/^\d+$/.test(port))
        throw new Error('H5_INT01_DISPOSABLE_POSTGRES_PORT_INVALID');
      settings = readPostgresSettings({
        NODE_ENV: 'test',
        PGHOST: 'localhost',
        G6_CONNECT_HOST: '127.0.0.1',
        PGPORT: port,
        PGDATABASE: 'postgres',
        PGUSER: 'catalog_app',
        PGPASSWORD: 'h5-disposable-app',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: certificate,
        G6_DATABASE_SCHEMA: 'catalog',
        G6_EXPECTED_ROLE: 'catalog_app',
        G6_CONNECTION_MODE: 'direct',
      });
      gateway = new CatalogGatewayHarness();
      await gateway.start(settings, {}, false, [], false, false);
    }, 180_000);

    afterAll(async () => {
      await gateway?.close();
      spawnSync('docker', ['rm', '--force', container], {
        timeout: 15_000,
        windowsHide: true,
        stdio: 'ignore',
      });
      if (directory) {
        const withinTemp = relative(tmpdir(), directory);
        if (
          !withinTemp ||
          withinTemp.startsWith('..') ||
          isAbsolute(withinTemp)
        )
          throw new Error('H5_INT01_TEMP_CLEANUP_PATH_INVALID');
        rmSync(directory, { recursive: true, force: true });
      }
    }, 30_000);

    it('INT01-PRODUCTO-INACTIVO: Catalog excluye producto inactivo del listado comercial', async () => {
      const sku = `POMA-H5-INACTIVE-${randomUUID()}`;
      const id = await createProduct('inactivo', sku);
      sql(`UPDATE catalog.products SET estado = 'INACTIVO' WHERE id = '${id}'`);
      const response = await gateway!.call(
        'GET',
        '/productos?canal=MARKETPLACE&pagina=1&tamanio=25',
        undefined,
        gateway!.token(),
      );
      expect(response.status).toBe(200);
      expect(
        response.body.items.some(
          (item: Record<string, unknown>) => item.product_id === id,
        ),
      ).toBe(false);
    });

    it('INT01-VARIANTE-DESACTIVADA: estado de variante inactiva se conserva en Catalog', async () => {
      const productId = await createProduct(
        'variante inactiva',
        `POMA-H5-VARIANT-PARENT-${randomUUID()}`,
        true,
      );
      const sku = `POMA-H5-VAR-DISABLED-${randomUUID()}`;
      const created = await gateway!.call(
        'POST',
        `/productos/${productId}/variantes`,
        {
          sku,
          atributosIdentificadores: [
            { caracteristica_id: 'size', nombre: 'Size', valor: 'M' },
          ],
          atributosNoIdentificadores: [],
          imagenUrl: 'https://example.test/h5-int01-variant',
        },
        gateway!.token(),
      );
      expect(created.status).toBe(201);
      sql(
        `UPDATE catalog.variants SET estado = 'INACTIVA' WHERE id = '${created.body.variant_id}'`,
      );
      const response = await gateway!.call(
        'GET',
        `/productos/${productId}/variantes`,
        undefined,
        gateway!.token(),
      );
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variant_id: created.body.variant_id,
            sku,
            status: 'INACTIVA',
          }),
        ]),
      );
    });

    it('INT01-SKU-NO-VENDIBLE: SKU de producto Borrador no aparece como vendible', async () => {
      const sku = 'POMA-H5-NOT-SELLABLE-0007';
      const id = await createProduct('SKU no vendible', sku);
      const response = await gateway!.call(
        'GET',
        '/productos?canal=MARKETPLACE&pagina=1&tamanio=25',
        undefined,
        gateway!.token(),
      );
      expect(response.status).toBe(200);
      expect(
        response.body.items.some(
          (item: Record<string, unknown>) =>
            item.product_id === id || item.sku_base === sku,
        ),
      ).toBe(false);
    });

    it('INT01-CATEGORIA-INVALIDA: Catalog rechaza categoría ausente en Taxonomy fixture', async () => {
      const response = await gateway!.call(
        'POST',
        '/productos',
        {
          nombre: 'H5 categoría inválida',
          descripcion: 'fixture descartable',
          categoriaId: 'category-absent-h5',
          tipoProductoId: 'type-fixture',
          marcaId: 'brand-fixture',
          skuBase: `POMA-H5-BAD-CATEGORY-${randomUUID()}`,
          tieneVariantes: false,
          precioBaseInicial: 20,
        },
        gateway!.token(),
      );
      expect([400, 422]).toContain(response.status);
    });

    it('INT01-MARCA-INVALIDA: Catalog rechaza marca ausente en Taxonomy fixture', async () => {
      const response = await gateway!.call(
        'POST',
        '/productos',
        {
          nombre: 'H5 marca inválida',
          descripcion: 'fixture descartable',
          categoriaId: 'category-fixture',
          tipoProductoId: 'type-fixture',
          marcaId: 'brand-absent-h5',
          skuBase: `POMA-H5-BAD-BRAND-${randomUUID()}`,
          tieneVariantes: false,
          precioBaseInicial: 20,
        },
        gateway!.token(),
      );
      expect([400, 422]).toContain(response.status);
    });

    it('INT01-VERSION-SKU-CAMBIADO: conflicto obsoleto y SKU inmutable se rechazan', async () => {
      const sku = `POMA-H5-VERSION-${randomUUID()}`;
      const productId = await createProduct('version SKU', sku);
      const detail = await gateway!.call(
        'GET',
        `/productos/administracion/${productId}`,
        undefined,
        gateway!.token(),
      );
      expect(detail.status).toBe(200);
      const originalVersion = detail.body.catalogVersion as number;
      const update = await gateway!.call(
        'PATCH',
        `/productos/${productId}`,
        {
          descripcion: 'Primera edición aislada',
          catalogVersion: originalVersion,
        },
        gateway!.token(),
      );
      expect(update.status).toBe(200);
      const stale = await gateway!.call(
        'PATCH',
        `/productos/${productId}`,
        {
          descripcion: 'Escritura obsoleta',
          catalogVersion: originalVersion,
        },
        gateway!.token(),
      );
      expect(stale.status).toBe(409);
      const skuChange = await gateway!.call(
        'PATCH',
        `/productos/${productId}`,
        {
          skuBase: `${sku}-CHANGED`,
          catalogVersion: update.body.catalogVersion,
        },
        gateway!.token(),
      );
      expect(skuChange.status).toBe(409);
      const after = await gateway!.call(
        'GET',
        `/productos/administracion/${productId}`,
        undefined,
        gateway!.token(),
      );
      expect(after.body.skuBase).toBe(sku);
    });

    it('INT01-CATALOG-AUTH-SUBCASE: scope ausente, identidad ausente y recurso ausente se clasifican', async () => {
      const absent = await gateway!.call(
        'GET',
        '/productos/administracion',
        undefined,
        null,
      );
      const denied = await gateway!.call(
        'GET',
        '/productos/administracion',
        undefined,
        gateway!.token({ roles: [] }),
      );
      const missing = await gateway!.call(
        'GET',
        `/productos/administracion/${randomUUID()}`,
        undefined,
        gateway!.token(),
      );
      expect([401, 403]).toContain(absent.status);
      expect(denied.status).toBe(403);
      expect(missing.status).toBe(404);
    });

    if (frontendRoot) {
      it('INT08-L1-INDEPENDENT-BROWSER: Playwright valida autenticación real contra el Gateway local aislado', async () => {
        const currentFrontendSha = spawnSync('git', ['rev-parse', 'HEAD'], {
          cwd: frontendRoot,
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        expect(currentFrontendSha.status).toBe(0);
        expect(currentFrontendSha.stdout.trim()).toBe(frontendSourceSha);
        const port = await availableLoopbackPort();
        const origin = `http://127.0.0.1:${port}`;
        const summaryPath = join(
          frontendRoot,
          'test-results',
          'h5',
          'int08-l1-summary.json',
        );
        const inheritedKeys = [
          'PATH',
          'SystemRoot',
          'WINDIR',
          'TEMP',
          'TMP',
          'USERPROFILE',
          'ProgramFiles',
          'PLAYWRIGHT_BROWSERS_PATH',
        ];
        const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
          inheritedKeys
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]!]),
        );
        Object.assign(childEnv, {
          CATALOG_REAL_BROWSER_ORIGIN: origin,
          CATALOG_REAL_GATEWAY_ORIGIN: gateway!.gatewayOrigin,
          CATALOG_REAL_VITE_PORT: String(port),
          CATALOG_REAL_BROWSER_PORT: String(port),
          CATALOG_REAL_JWT: gateway!.token(),
          CATALOG_REAL_FORBIDDEN_JWT: gateway!.token({ roles: [] }),
          CATALOG_REAL_CORRELATION_ID: gateway!.correlation,
          G6_H5_INT08_ISOLATED_HARNESS: '1',
          G6_H5_EVIDENCE_SUMMARY_PATH: 'test-results/h5/int08-l1-summary.json',
          CATALOG_REAL_FRONTEND_SHA: frontendSourceSha,
        });
        const child = spawn(process.execPath, ['scripts/run-h5-int08-l1.mjs'], {
          cwd: frontendRoot,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
        let capturedBytes = 0;
        child.stdout.on('data', (chunk) => {
          capturedBytes += chunk.length;
        });
        child.stderr.on('data', (chunk) => {
          capturedBytes += chunk.length;
        });
        const timer = setTimeout(() => {
          if (process.platform === 'win32' && child.pid)
            spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
          else child.kill('SIGTERM');
        }, 120_000);
        let exitCode: number | null;
        try {
          exitCode = await new Promise((resolveExit, reject) => {
            child.once('error', reject);
            child.once('close', resolveExit);
          });
        } finally {
          clearTimeout(timer);
        }
        expect(capturedBytes).toBeGreaterThan(0);
        const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
          status: string;
          executed: number;
          passed: number;
          failed: number;
          cases: Array<{
            scenario_id: string;
            status: string;
            execution: string;
          }>;
        };
        const independentCases = summary.cases.filter(
          (item) =>
            item.scenario_id.startsWith('INT08-L1-') &&
            item.scenario_id !== 'INT08-L1-INTEGRAL',
        );
        expect(independentCases).toHaveLength(4);
        expect(
          independentCases.every(
            (item) => item.status === 'PASS' && item.execution === 'EXECUTED',
          ),
        ).toBe(true);
        expect(
          summary.cases.find((item) => item.scenario_id === 'INT08-L1-INTEGRAL')
            ?.status,
        ).toBe('BLOCKED_DEPENDENCY');
        expect(summary).toMatchObject({
          status: 'PARTIAL_B',
          executed: 4,
          passed: 4,
          failed: 0,
        });
        expect(exitCode).toBe(2);
      }, 150_000);
    }
  },
);
