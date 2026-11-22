import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { CatalogGatewayHarness } from './support/catalog-gateway-harness.js';
import { readPostgresSettings, type PostgresSettings } from '../src/database.js';

const frontend = process.env.CATALOG_REAL_FRONTEND_ROOT;
const enabled = Boolean(frontend);

describe.skipIf(!enabled)('Browser HTTP real local: PostgreSQL 17 + Catalog + Gateway + Vite + Chromium', () => {
  const container = `catalog-browser-${randomUUID().slice(0, 8)}`;
  let directory = '';
  let cert = '';
  let settings: PostgresSettings;
  let gateway: CatalogGatewayHarness | undefined;

  const command = (name: string, args: string[], input?: string) => {
    const result = spawnSync(name, args, { input, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (result.status !== 0) throw new Error(`${name} failed (${result.status}): ${result.stderr?.slice(-1500) ?? result.error?.message ?? 'no process diagnostics'}`);
    return result.stdout.trim();
  };
  const openssl = process.env.G6_TEST_OPENSSL_PATH ?? (process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe') : 'openssl');
  const sql = (script: string) => command('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], script);

  beforeAll(async () => {
    if (!frontend || !isAbsolute(frontend)) throw new Error('CATALOG_REAL_FRONTEND_ROOT debe apuntar al checkout Frontend absoluto.');
    directory = mkdtempSync(join(tmpdir(), 'catalog-browser-real-'));
    const certDirectory = join(directory, 'certs');
    mkdirSync(certDirectory);
    chmodSync(certDirectory, 0o755);
    cert = join(certDirectory, 'server.crt');
    const key = join(certDirectory, 'server.key');
    command(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert]);
    chmodSync(key, 0o644);
    chmodSync(cert, 0o644);
    command('docker', ['run', '--detach', '--name', container, '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD=isolated-admin-password', '--volume', `${certDirectory}:/certs:ro`, '--entrypoint', 'sh', 'postgres:17-alpine', '-c', 'cp /certs/server.key /tmp/server.key; chown postgres:postgres /tmp/server.key; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/tmp/server.key']);
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { windowsHide: true, stdio: 'ignore' }).status === 0) { ready = true; break; }
      await pause(1000);
    }
    if (!ready) throw new Error('PostgreSQL 17 descartable no quedó listo.');
    sql(`CREATE ROLE po_catalog_owner NOLOGIN; CREATE ROLE catalog_app LOGIN PASSWORD 'isolated-runtime-password'; CREATE SCHEMA catalog AUTHORIZATION po_catalog_owner; SET ROLE po_catalog_owner;\n${readFileSync(resolve('apps/catalog-svc/test/fixtures/0001_create_catalog.sql'), 'utf8')}\n${readFileSync(resolve('apps/catalog-svc/migrations/0002_create_sku_barcodes.sql'), 'utf8')}\n${readFileSync(resolve('apps/catalog-svc/migrations/0003_product_publication_history.sql'), 'utf8')}\n${readFileSync(resolve('apps/catalog-svc/migrations/0004_historical_preparation_requests.sql'), 'utf8')}`);
    const port = command('docker', ['port', container, '5432/tcp']).split(':').at(-1);
    if (!port || !/^\d+$/.test(port)) throw new Error('PostgreSQL no quedó publicado en un puerto local válido.');
    settings = readPostgresSettings({ NODE_ENV: 'test', PGHOST: 'localhost', G6_CONNECT_HOST: '127.0.0.1', PGPORT: port, PGDATABASE: 'postgres', PGUSER: 'catalog_app', PGPASSWORD: 'isolated-runtime-password', PGSSLMODE: 'verify-full', PGSSLROOTCERT: cert, G6_DATABASE_SCHEMA: 'catalog', G6_EXPECTED_ROLE: 'catalog_app', G6_CONNECTION_MODE: 'direct' });
    gateway = new CatalogGatewayHarness();
    await gateway.start(settings, {}, false, [], false, true);
    const directRead = await gateway.call('GET', '/productos/administracion', undefined, gateway.token(), true);
    if (directRead.status !== 200) throw new Error(`Catalog local admin GET preflight failed (${directRead.status}): ${JSON.stringify(directRead.body)}`);
    const browserJwt = gateway.token();
    const gatewayRead = await gateway.call('GET', '/productos/administracion', undefined, browserJwt);
    if (gatewayRead.status !== 200) throw new Error(`Gateway local admin GET preflight failed (${gatewayRead.status}): ${JSON.stringify(gatewayRead.body)}`);
    const gatewayPagedRead = await gateway.call('GET', '/productos/administracion?pagina=1&tamanio=10', undefined, browserJwt);
    if (gatewayPagedRead.status !== 200) throw new Error(`Gateway local paginated admin GET preflight failed (${gatewayPagedRead.status}): ${JSON.stringify(gatewayPagedRead.body)}`);
    const directBrowserIdentity = await gateway.call('GET', '/productos/administracion', undefined, browserJwt, true);
    if (directBrowserIdentity.status !== 200) throw new Error(`Catalog rejected browser E2E identity (${directBrowserIdentity.status}): ${JSON.stringify(directBrowserIdentity.body)}`);
    const writePreflight = await gateway.call('POST', '/productos', { nombre: 'Gateway E2E write preflight', descripcion: 'Disposable PostgreSQL', categoriaId: 'category-fixture', tipoProductoId: 'type-fixture', marcaId: 'brand-fixture', skuBase: `E2E-PREFLIGHT-${randomUUID()}`, tieneVariantes: false, precioBaseInicial: 20, imagenes: [{ url: 'https://example.test/catalog-e2e' }], perfilFisico: { pesoKg: 1, dimensionesCm: { largo: 10, ancho: 20, alto: 30 } } }, browserJwt);
    if (writePreflight.status !== 201) throw new Error(`Gateway/PostgreSQL local write preflight failed (${writePreflight.status}): ${JSON.stringify(writePreflight.body)}`);
    const writtenId = String(writePreflight.body.product_id);
    const adminDetail = await gateway.call('GET', `/productos/administracion/${writtenId}`, undefined, browserJwt);
    if (adminDetail.status !== 200 || adminDetail.body.productId !== writtenId) throw new Error(`Gateway local administrative detail failed (${adminDetail.status}): ${JSON.stringify(adminDetail.body)}`);
    const updated = await gateway.call('PATCH', `/productos/${writtenId}`, { descripcion: 'Disposable PostgreSQL updated', catalogVersion: adminDetail.body.catalogVersion }, browserJwt);
    if (updated.status !== 200) throw new Error(`Gateway local PATCH failed (${updated.status}): ${JSON.stringify(updated.body)}`);
    const variantProductWrite = await gateway.call('POST', '/productos', {
      nombre: 'Gateway E2E variant product', descripcion: 'Variant fixture for Chromium',
      categoriaId: 'category-fixture', tipoProductoId: 'type-fixture', marcaId: 'brand-fixture',
      skuBase: `E2E-VARIANT-GROUP-${randomUUID()}`, tieneVariantes: true, precioBaseInicial: 20,
      imagenes: [{ url: 'https://example.test/catalog-e2e-variant' }],
    }, browserJwt);
    if (variantProductWrite.status !== 201) throw new Error(`Gateway/PostgreSQL variant product write failed (${variantProductWrite.status}): ${JSON.stringify(variantProductWrite.body)}`);
    const variantProductId = String(variantProductWrite.body.product_id);
    const variantSku = `E2E-VARIANT-${randomUUID()}`;
    const variantWrite = await gateway.call('POST', `/productos/${variantProductId}/variantes`, {
      sku: variantSku, atributosIdentificadores: [], atributosNoIdentificadores: [],
      imagenUrl: 'https://example.test/catalog-e2e-variant-sku',
    }, browserJwt);
    if (variantWrite.status !== 201) throw new Error(`Gateway/PostgreSQL variant write failed (${variantWrite.status}): ${JSON.stringify(variantWrite.body)}`);
    const variantId = String(variantWrite.body.variant_id);
    gateway.taxonomyFailuresRemaining = 3;
    const unauthenticated = await gateway.call('GET', '/productos/administracion', undefined, null);
    if (![401, 403].includes(unauthenticated.status)) throw new Error(`Gateway accepted an unauthenticated administrative read (${unauthenticated.status}).`);
    const forbidden = await gateway.call('GET', '/productos/administracion', undefined, gateway.token({ roles: [] }));
    if (forbidden.status !== 403) throw new Error(`Gateway did not reject a roleless administrative identity (${forbidden.status}).`);
    const missing = await gateway.call('GET', `/productos/administracion/${randomUUID()}`, undefined, browserJwt);
    if (missing.status !== 404) throw new Error(`Gateway did not return 404 for an absent administrative product (${missing.status}).`);
    gateway.taxonomyFailuresRemaining = 3;
    const browser = spawnSync(process.execPath, [join(frontend, 'node_modules', 'playwright', 'cli.js'), 'test', '--config', 'tests/catalog-http-real.config.ts', 'tests/catalog-http-real.spec.ts'], {
      cwd: frontend,
      encoding: 'utf8',
      timeout: 180_000,
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'test', CATALOG_REAL_GATEWAY_ORIGIN: gateway.gatewayOrigin, CATALOG_REAL_JWT: browserJwt, CATALOG_REAL_FORBIDDEN_JWT: gateway.token({ roles: [] }), CATALOG_REAL_PRODUCT_ID: writtenId, CATALOG_REAL_VARIANT_PRODUCT_ID: variantProductId, CATALOG_REAL_VARIANT_ID: variantId, CATALOG_REAL_VARIANT_SKU: variantSku, CATALOG_REAL_CORRELATION_ID: gateway.correlation, CATALOG_REAL_VITE_PORT: String(5200 + Math.floor(Math.random() * 3000)) },
    });
    if (browser.status !== 0) throw new Error(`Chromium/Gateway/Catalog HTTP real falló (${browser.status}).\n${browser.stdout.slice(-3000)}\n${browser.stderr.slice(-1500)}`);
    console.info(browser.stdout.trim());
  }, 300_000);

  afterAll(async () => {
    await gateway?.close();
    spawnSync('docker', ['rm', '--force', container], { timeout: 20_000, windowsHide: true, stdio: 'ignore' });
    if (directory) {
      const withinTemp = relative(tmpdir(), directory);
      if (withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp)) rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs authenticated real browser reads, UI PATCH, variants, authorization failures, 503 retry and reload', () => {
    expect(gateway?.gatewayOrigin).toBeDefined();
    expect(new URL(gateway!.gatewayOrigin).hostname).toBe('127.0.0.1');
  }, 1);
});
