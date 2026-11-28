import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { spawnSync, execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CommercialPrices,
  PRICING_CATALOG_CONTEXT,
} from '../../../../apps/pricing-svc/src/http/commercial-prices.js';
import {
  PRICING_CONFIG,
  validateEnvironment,
} from '../../../../apps/pricing-svc/src/config/environment.js';
import { PricingReadController } from '../../../../apps/pricing-svc/src/http/pricing-read.controller.js';
import { PricingReadGuard } from '../../../../apps/pricing-svc/src/http/pricing-read.guard.js';
import { PricingReads } from '../../../../apps/pricing-svc/src/http/pricing-reads.js';
import { PricingRepository } from '../../../../apps/pricing-svc/src/persistence/pricing.repository.js';
import { SignedUser } from '../../../../apps/pricing-svc/test/signed-user.js';
import { InventorySvcModule } from '../../../../apps/inventory-svc/src/inventory-svc.module.js';
import { InventoryAuthGuard } from '../../../../apps/inventory-svc/src/auth/inventory-auth.guard.js';
import { DatabaseService } from '../../../../apps/inventory-svc/src/database/database.service.js';
import { ProblemDetailsFilter } from '../../../../apps/inventory-svc/src/errors/problem-details.filter.js';
import { InventoryWorkersService } from '../../../../apps/inventory-svc/src/workers/inventory-workers.service.js';
import { InMemoryDatabaseMock } from '../../../../apps/inventory-svc/test/in-memory-database.mock.js';
import {
  createCryptographicJwt, TEST_ISSUER, TEST_PUBLIC_KEY,
} from '../../../../apps/inventory-svc/test/crypto-test-token.helper.js';

const root = resolve('scripts/h5/k6');
const channel = 'MARKETPLACE';
const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const utc = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const [, , frontendSha, docsSha, k6Path, selection] = process.argv;
const powershellCandidates = process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'];
const powershell = powershellCandidates.find((executable) => {
  const probe = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  return !probe.error && probe.status === 0;
});

if (!powershell || ![backendSha, frontendSha, docsSha].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')) ||
    !k6Path || !['PERF-02', 'PERF-03'].includes(selection)) {
  throw new Error('USO: <frontend-sha> <docs-sha> <binario-k6> <PERF-02|PERF-03>');
}

async function measure(app: INestApplication, token: string, dataset: object, revision: string) {
  await app.listen(0, '127.0.0.1');
  const target = await app.getUrl();
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(target)) throw new Error('LISTENER_NO_LOOPBACK');
  const local = join(root, '.local');
  await mkdir(local, { recursive: true });
  const inputs = await mkdtemp(join(local, 'nest-'));
  const datasetPath = join(inputs, 'dataset.json');
  const configPath = join(inputs, 'config.json');
  const serialized = JSON.stringify(dataset);
  await writeFile(datasetPath, serialized);
  await writeFile(configPath, JSON.stringify({
    environment: 'LOCAL_SERVICE', case_id: selection, channel,
    profiles: ['demo-smoke'], max_rps: 2,
    window_start_utc: utc(Date.now() - 10_000), window_end_utc: utc(Date.now() + 180_000),
    approval_ref: 'NEST_LOOPBACK', revision, backend_sha: backendSha,
    frontend_sha: frontendSha, docs_sha: docsSha, dataset_sha256: hash(serialized),
    allow_negative_401: true,
  }));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/i.test(key)),
  );
  const executionPolicy = process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : [];
  const output = await new Promise<string>((complete, reject) => {
    execFile(powershell!, [
      '-NoProfile', ...executionPolicy, '-File', join(root, 'bin/ejecutar-demo.ps1'), '-Config', configPath,
      '-Dataset', datasetPath, '-K6Path', resolve(k6Path!), '-Negative401',
    ], {
      env: { ...inherited, G6_K6_TARGET: target, G6_K6_TEST_TOKEN: token },
      windowsHide: true, timeout: 95_000, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error || stdout.includes(target) || stdout.includes(token)) {
        const safeReason = /^(?:PREFLIGHT|EVIDENCIA)_[A-Z0-9_]+$/m.exec(stderr)?.[0];
        reject(new Error(safeReason ?? ('K6_NEST_FALLO_' + (error?.code ?? 'OUTPUT_INVALIDO') + (/\bFAIL\b/.test(stdout) ? '_HTTP_O_UMBRAL' : ''))));
      } else complete(stdout);
    });
  });
  const summaryPath = /\.local\/[a-f0-9]{32}\/summary\.json/.exec(output)?.[0];
  if (!summaryPath) throw new Error('EVIDENCIA_NEST_AUSENTE');
  const path = join(root, summaryPath);
  const raw = await readFile(path, 'utf8');
  const result = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (result.status !== 'PASS' || result.scope !== 'L1_NEST_FIXTURES' ||
      result.metrics.negative_401 !== 1 || raw.includes(target) || raw.includes(token)) {
    throw new Error('EVIDENCIA_NEST_INVALIDA');
  }
  process.stdout.write(output);
}

async function measureInventoryAvailability(
  k6Path: string,
  baseUrl: string,
  token: string,
  channelId: 'MARKETPLACE' | 'RETAIL',
  manifestPath: string,
  manifestSha: string,
  fixtureLocationCount: number,
  database: InMemoryDatabaseMock,
) {
  const runId = randomUUID().replaceAll('-', '');
  const directory = join(root, '.local', 'perf03-combined', runId);
  await mkdir(directory, { recursive: true });
  const summaryPath = join(directory, 'k6-summary.json');
  const dashboardPath = join(directory, 'dashboard.html');
  const outputPath = join(directory, 'k6-output.log');
  const scriptPath = resolve('scripts/h5/performance/inventory-availability.k6.js');
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/i.test(key)),
  );
  const startedAt = Date.now();
  const stateSnapshot = () => JSON.stringify({
    stockBalance: database.stockBalance,
    reservations: database.reservations,
    reservationLines: database.reservationLines,
    outbox: database.outbox,
    kardex: database.kardex,
  });
  const stateBefore = stateSnapshot();
  const environment = {
    ...inherited,
    BASE_URL: baseUrl,
    AUTH_TOKEN: token,
    CHANNEL: channelId,
    PROFILE: '1VU-60s',
    VU: '1',
    DURATION: '60s',
    REPETITION: '1',
    DATASET_MANIFEST: manifestPath,
    MANIFEST_SHA256: manifestSha,
    H5_SYNTHETIC_SMOKE: '1',
    MAX_RPS: '2',
    FULFILLMENT_MODE: channelId === 'RETAIL' ? 'RETIRO_TIENDA' : 'ENVIO_DOMICILIO',
    PERF03_SUMMARY_PATH: summaryPath,
    K6_WEB_DASHBOARD: 'true',
    K6_WEB_DASHBOARD_HOST: '127.0.0.1',
    K6_WEB_DASHBOARD_PORT: '-1',
    K6_WEB_DASHBOARD_PERIOD: '1s',
    K6_WEB_DASHBOARD_EXPORT: dashboardPath,
    K6_NO_USAGE_REPORT: 'true',
  };
  const output = await new Promise<string>((complete, reject) => {
    execFile(resolve(k6Path), ['run', '--quiet', scriptPath], {
      env: environment,
      windowsHide: true,
      timeout: 95_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const combined = `${stdout}\n${stderr}`;
      if (error) {
        const safeDiagnostic = combined
          .replaceAll(token, '<redacted>')
          .replaceAll(baseUrl, '<loopback>')
          .split(/\r?\n/).filter(Boolean).slice(-3).join(' ')
          .replace(/[^A-Za-z0-9_ ]/g, ' ').replace(/\s+/g, ' ').toUpperCase();
        reject(new Error(`PERF03_INVENTORY_COMBINED_K6_${error.code ?? 'ERROR'}_${safeDiagnostic}`));
      } else complete(combined);
    });
  });
  const safeOutput = output.replaceAll(token, '<redacted>').replaceAll(baseUrl, '<loopback>');
  await writeFile(outputPath, safeOutput, 'utf8');
  const k6Report = JSON.parse(await readFile(summaryPath, 'utf8'));
  const metrics = k6Report.metrics ?? {};
  const metricCount = (name: string) => metrics[name]?.values?.count ?? 0;
  const unexpectedRate = metrics.h5_perf03_unexpected_error_rate?.values?.rate ?? null;
  const requestMetric = metrics.http_reqs?.values ?? {};
  const fixtureGroups = k6Report.fixture_group_request_counts ?? {};
  const stockStateUnchanged = stateSnapshot() === stateBefore;
  const failedChecks = [
    ...(k6Report.execution_scope !== 'L1_NEST_FIXTURES_LOOPBACK' ? ['scope'] : []),
    ...(metricCount('h5_perf03_get_2xx_responses') < 1 ? ['get_2xx'] : []),
    ...(metricCount('h5_perf03_verify_2xx_responses') < 1 ? ['verify_2xx'] : []),
    ...(unexpectedRate === null || unexpectedRate >= 0.01 ? ['unexpected_error_rate'] : []),
    ...(!Number.isFinite(metrics.h5_perf03_availability_duration_ms?.values?.['p(95)']) ? ['get_p95'] : []),
    ...(!Number.isFinite(metrics.h5_perf03_verify_duration_ms?.values?.['p(95)']) ? ['verify_p95'] : []),
    ...(requestMetric.count > 120 ? ['request_count_limit'] : []),
    ...(requestMetric.rate > 2 ? ['rps_limit'] : []),
    ...(['available', 'low_stock', 'exhausted', 'unregistered', 'non_sellable']
      .filter((group) => !Number.isSafeInteger(fixtureGroups[group]) || fixtureGroups[group] < 1)
      .map((group) => `fixture_group_${group}`)),
    ...(fixtureLocationCount < 2 ? ['multiple_location_fixture'] : []),
    ...(!stockStateUnchanged ? ['inventory_state_mutated'] : []),
  ];
  const runStatus = failedChecks.length === 0 ? 'PASS' : 'FAIL';
  const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const exactCommand = [
    'node node_modules/typescript/bin/tsc --project scripts/h5/k6/tests/tsconfig.local.json --noEmit false',
    `node scripts/h5/k6/.local/build/scripts/h5/k6/tests/servicios-locales.js ${frontendSha} ${docsSha} "${resolve(k6Path!)}" PERF-03`,
  ].join(' && ');
  const report = {
    schema_version: 1,
    case_id: 'PERF-03',
    scenario: 'GET disponibilidad comercial + POST verificar cantidad (read-only)',
    status: runStatus,
    failed_checks: failedChecks,
    official_h5_03: 'NO_CERTIFICADO',
    scope: 'L1_NEST_FIXTURES_LOOPBACK',
    dependency_scope: { service: 'InventorySvcModule', persistence: 'InMemoryDatabaseMock', workers: 'stubbed', postgresql: false },
    backend_sha: backendSha,
    dataset_sha256: manifestSha,
    channel: channelId,
    profile: '1VU-60s',
    virtual_users: 1,
    duration_seconds: 60,
    max_rps: 2,
    synthetic_target_rps: k6Report.synthetic_target_rps ?? 1.9,
    max_requests: 120,
    requests_offered: requestMetric.count ?? null,
    actual_requests_per_second: requestMetric.rate ?? null,
    unexpected_error_rate: unexpectedRate,
    http_status_counts: {
      '2xx_get': metricCount('h5_perf03_get_2xx_responses'),
      '2xx_verify': metricCount('h5_perf03_verify_2xx_responses'),
      '400': metricCount('h5_perf03_bad_request_400_responses'),
      '401_403': metricCount('h5_perf03_auth_rejected_responses'),
      '404': metricCount('h5_perf03_not_found_404_responses'),
      '422': metricCount('h5_perf03_unprocessable_422_responses'),
      '429': metricCount('h5_perf03_rate_limited_429_responses'),
      '503': metricCount('h5_perf03_unavailable_503_responses'),
      '5xx': metricCount('h5_perf03_server_5xx_responses'),
    },
    latency_ms: {
      get_p50: metrics.h5_perf03_availability_duration_ms?.values?.med ?? null,
      get_p95: metrics.h5_perf03_availability_duration_ms?.values?.['p(95)'] ?? null,
      get_p99: metrics.h5_perf03_availability_duration_ms?.values?.['p(99)'] ?? null,
      verify_p50: metrics.h5_perf03_verify_duration_ms?.values?.med ?? null,
      verify_p95: metrics.h5_perf03_verify_duration_ms?.values?.['p(95)'] ?? null,
      verify_p99: metrics.h5_perf03_verify_duration_ms?.values?.['p(99)'] ?? null,
    },
    fixture_groups: ['SKU disponible', 'stock bajo', 'agotado', 'inexistente', 'no vendible'],
    fixture_group_request_counts: fixtureGroups,
    fixture_location_count: fixtureLocationCount,
    stock_state_unchanged: stockStateUnchanged,
    reservation_rows_after: database.reservations.length,
    reservation_lines_after: database.reservationLines.length,
    outbox_rows_after: database.outbox.length,
    kardex_rows_after: database.kardex.length,
    runtime_duration_seconds: k6Report.runtime_duration_ms ? k6Report.runtime_duration_ms / 1000 : (Date.now() - startedAt) / 1000,
    exact_command: exactCommand,
    metrics,
  };
  const finalSummaryPath = join(directory, 'summary.json');
  await writeFile(finalSummaryPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  const artifactPaths = [finalSummaryPath, summaryPath, dashboardPath, outputPath];
  const artifacts = await Promise.all(artifactPaths.map(async (path) => {
    const bytes = await readFile(path);
    return { file: path.slice(directory.length + 1), bytes: bytes.length, sha256: hash(bytes) };
  }));
  const indexBytes = JSON.stringify({ schema_version: 1, run_id: runId, status: runStatus, artifacts }, null, 2) + '\n';
  const indexPath = join(directory, 'evidence-index.json');
  await writeFile(indexPath, indexBytes, 'utf8');
  const indexSha = hash(indexBytes);
  await writeFile(join(directory, 'evidence-index.sha256'), `${indexSha}  evidence-index.json\n`, 'ascii');
  process.stdout.write(`PERF03_COMBINED_${channelId}=${runStatus} .local/perf03-combined/${runId}/evidence-index.json SHA-256=${indexSha}\n`);
  if (runStatus !== 'PASS') throw new Error(`PERF03_INVENTORY_COMBINED_${failedChecks.join('_')}`);
}

async function pricing() {
  const identity = new SignedUser();
  const skus = ['K6-PRICING-BASE', 'K6-PRICING-OFERTA'];
  let app: INestApplication | undefined;
  await identity.start();
  try {
    const repository: Pick<PricingRepository, 'readCandidates'> = {
      async readCandidates(productId, sku) {
        return [{
          target: { productId, sku: null }, channelId: null, priceVersion: 1n,
          validities: [{
            id: 'k6-validity', priceId: 'k6-price', precioRegular: '49.90',
            precioOferta: sku.endsWith('OFERTA') ? '39.90' : null, currency: 'PEN',
            motivoCambio: 'Fixture local', usuarioId: null, validFrom: new Date(0),
            validUntil: null, priceVersion: 1n, isCancelled: false,
            createdAt: new Date(0), updatedAt: new Date(0),
          }],
        }];
      },
    };
    const module = await Test.createTestingModule({
      controllers: [PricingReadController],
      providers: [
        CommercialPrices, PricingReadGuard,
        { provide: PricingReads, useValue: {} },
        { provide: PricingRepository, useValue: repository },
        { provide: PRICING_CATALOG_CONTEXT, useValue: {
          resolve: async (sku: string) => skus.includes(sku)
            ? { sku, productId: 'k6-product', isVariant: false, active: true, eligible: true } : null,
        } },
        { provide: PRICING_CONFIG, useValue: validateEnvironment({
          NODE_ENV: 'test', PORT: '3002', G6_SECURITY_MODE: 'G7_AUTHENTICATED',
          DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
          AUTH_ISSUER: identity.issuer, AUTH_JWKS_URL: identity.issuer + '/jwks',
        }) },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await measure(app, identity.token({
      tipo: 'servicio', sub: 'modulo-marketplace', aud: 'api-productos', scope: 'precios:leer',
    }), { pricing: { skus } }, 'NEST_PRICING_CONTROLADO');
  } finally {
    await app?.close();
    await identity.stop();
  }
}

async function inventory() {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', G6_SECURITY_MODE: 'G7_AUTHENTICATED',
    INVENTORY_PUBLIC_OPERATION_IDS: '', INVENTORY_DEMO_NO_AUTH_ENABLED: 'false',
    G7_JWT_ISSUER: TEST_ISSUER, G7_JWT_JWKS_URL: undefined, RABBITMQ_URL: undefined,
    DATABASE_URL: undefined, MESSAGING_PROVIDER: undefined,
  };
  for (const key of Object.keys(process.env)) {
    if (/^(PG[A-Z_]+|(?:INVENTORY_|AZURE_)?SERVICE_BUS_.*|ASB_.*)$/i.test(key)) env[key] = undefined;
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  let app: INestApplication | undefined;
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    InventoryAuthGuard.setTrustedPublicKey(TEST_PUBLIC_KEY);
    const db = new InMemoryDatabaseMock();
    const locationId = '9129b578-631e-1735-8427-b683fb524380';
    // Reusa los grupos canónicos de PERF-03; esta suite adapta solo el subconjunto GET.
    const fixtureRoot = resolve('scripts/h5/fixtures/inventory/out');
    const manifestText = await readFile(join(fixtureRoot, 'manifest.json'), 'utf8');
    const checksum = (await readFile(join(fixtureRoot, 'manifest.sha256'), 'utf8')).trim();
    if (checksum !== hash(manifestText) + '  manifest.json') throw new Error('FIXTURE_INVENTORY_HASH_INVALIDO');
    const manifest: {
      mandatory_groups: Record<string, unknown>;
      channels: Array<{ channel_id: string; mode: string; location_id: string }>;
    } = JSON.parse(manifestText);
    const groups = manifest.mandatory_groups;
    const available = groups.threshold_plus_one_sku;
    const lowStock = groups.exact_threshold_sku;
    const unavailable = groups.available_zero_sku;
    const unknown = groups.unregistered_sku;
    const nonSellable = groups.deactivated_catalog_sku;
    if (typeof available !== 'string' || typeof lowStock !== 'string' || typeof unavailable !== 'string' ||
        typeof unknown !== 'string' || typeof nonSellable !== 'string') {
      throw new Error('FIXTURE_INVENTORY_GRUPOS_INVALIDOS');
    }
    const marketplaceLocation = manifest.channels.find((entry) => entry.channel_id === 'MARKETPLACE');
    const retailLocation = manifest.channels.find((entry) => entry.channel_id === 'RETAIL');
    if (!marketplaceLocation || !retailLocation) throw new Error('FIXTURE_INVENTORY_RUTAS_INVALIDAS');
    for (const [index, location] of [marketplaceLocation, retailLocation].entries()) {
      if (!db.locations.some((row) => row.id === location.location_id)) {
        db.locations.push({
          id: location.location_id,
          code: index === 0 ? 'K6-MARKETPLACE' : 'K6-RETAIL',
          name: index === 0 ? 'Fixture Marketplace' : 'Fixture Retail',
          type: index === 0 ? 'ALMACEN_CENTRAL' : 'TIENDA',
          active: true,
        });
      }
    }
    db.commercialRoutes = [
      { id: 'k6-marketplace', channel_id: 'MARKETPLACE', mode: 'ENVIO_DOMICILIO',
        fulfillment_ref: 'LIMA', location_id: marketplaceLocation.location_id, active: true },
      { id: 'k6-retail', channel_id: 'RETAIL', mode: 'RETIRO_TIENDA',
        fulfillment_ref: 'TIENDA', location_id: retailLocation.location_id, active: true },
    ];
    const selectedSkus = new Set([available, lowStock, unavailable, nonSellable]);
    const csvPath = join(fixtureRoot, 'inventory-fixture.csv');
    const csvLines = (await readFile(csvPath, 'utf8')).trim().split(/\r?\n/).slice(1);
    for (const line of csvLines) {
      const [sku, locationId, onHandText, reservedText, blockedText] = line.split(',');
      if (!selectedSkus.has(sku)) continue;
      const onHand = Number(onHandText);
      const reserved = Number(reservedText);
      const blocked = Number(blockedText);
      db.stockBalance.push({
        sku_id: sku,
        location_id: locationId,
        on_hand: onHand,
        reserved,
        blocked,
        available: Math.max(0, onHand - reserved - blocked),
        stock_version: 1,
      });
    }
    db.skuLifecycle.push({
      sku_id: nonSellable,
      product_id: 'PERF03-DEACTIVATED-FIXTURE',
      sku_version: 1,
      active: false,
      changed_at: new Date(0).toISOString(),
    });
    const module = await Test.createTestingModule({ imports: [InventorySvcModule] })
      .overrideProvider(InventoryWorkersService).useValue({}).compile();
    module.get(DatabaseService).setCustomService(db);
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    const before = JSON.stringify(db.stockBalance);
    await measure(app, createCryptographicJwt({
      clientId: 'modulo-marketplace', scope: 'inventario:disponibilidad:leer',
    }), { inventory: { items: [
      { sku: available, status: 'DISPONIBLE' }, { sku: lowStock, status: 'STOCK_BAJO' },
      { sku: unavailable, status: 'AGOTADO' }, { sku: unknown, status: 'INDETERMINADO' },
      { sku: nonSellable, status: 'INDETERMINADO' },
    ] } }, 'NEST_INVENTARIO_CONTROLADO');
    const target = await app.getUrl();
    const retailToken = createCryptographicJwt({
      clientId: 'modulo-retail', scope: 'inventario:disponibilidad:leer',
    });
    const fixtureLocationCount = new Set([marketplaceLocation.location_id, retailLocation.location_id]).size;
    await measureInventoryAvailability(k6Path!, target, createCryptographicJwt({
      clientId: 'modulo-marketplace', scope: 'inventario:disponibilidad:leer',
    }), 'MARKETPLACE', join(fixtureRoot, 'manifest.json'), hash(manifestText), fixtureLocationCount, db);
    await measureInventoryAvailability(k6Path!, target, retailToken, 'RETAIL', join(fixtureRoot, 'manifest.json'), hash(manifestText), fixtureLocationCount, db);
    if (JSON.stringify(db.stockBalance) !== before || db.reservations.length !== 0 ||
        db.reservationLines.length !== 0 || db.outbox.length !== 0 || db.kardex.length !== 0) {
      throw new Error('INVENTORY_CARGA_DE_LECTURA_MODIFICO_ESTADO');
    }
  } finally {
    await app?.close();
    InventoryAuthGuard.setTrustedPublicKey(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

try {
  if (selection === 'PERF-02') await pricing();
  else await inventory();
} catch (error) {
  const reason = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SERVICIO_NEST_LOCAL_NO_COMPLETADO';
  process.stderr.write(reason + '\n');
  process.exitCode = 1;
}
