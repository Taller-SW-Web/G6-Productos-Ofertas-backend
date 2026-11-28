import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const utc = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const [, , frontendSha, docsSha, k6Path, selection] = process.argv;

if (![backendSha, frontendSha, docsSha].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')) ||
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
  const output = await new Promise<string>((complete, reject) => {
    const child = spawn(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', [
      '-NoProfile', '-File', join(root, 'bin/ejecutar-demo.ps1'), '-Config', configPath,
      '-Dataset', datasetPath, '-K6Path', resolve(k6Path), '-Negative401',
    ], {
      env: { ...inherited, G6_K6_TARGET: target, G6_K6_TEST_TOKEN: token },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0 || stdout.includes(target) || stdout.includes(token)) {
        const safeReason = /^(?:PREFLIGHT|EVIDENCIA)_[A-Z0-9_]+$/m.exec(stderr)?.[0];
        reject(new Error(safeReason ?? ('K6_NEST_FALLO_' + code + (/\bFAIL\b/.test(stdout) ? '_HTTP_O_UMBRAL' : ''))));
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
    const manifest: { mandatory_groups: Record<string, unknown> } = JSON.parse(manifestText);
    const { threshold_plus_one_sku: available, available_zero_sku: unavailable, unregistered_sku: unknown } =
      manifest.mandatory_groups;
    if (typeof available !== 'string' || typeof unavailable !== 'string' || typeof unknown !== 'string') {
      throw new Error('FIXTURE_INVENTORY_GRUPOS_INVALIDOS');
    }
    db.commercialRoutes = [{
      id: 'k6-marketplace', channel_id: channel, mode: 'ENVIO_DOMICILIO',
      fulfillment_ref: 'LIMA', location_id: locationId, active: true,
    }];
    const existing = db.stockBalance.find((row) => row.location_id === locationId);
    if (!existing) throw new Error('FIXTURE_INVENTORY_INCOMPATIBLE');
    db.stockBalance.push(
      { ...existing, sku_id: available },
      { ...existing, sku_id: unavailable, on_hand: 0, reserved: 0, blocked: 0, available: 0 },
    );
    const module = await Test.createTestingModule({ imports: [InventorySvcModule] })
      .overrideProvider(InventoryWorkersService).useValue({}).compile();
    module.get(DatabaseService).setCustomService(db);
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    const before = JSON.stringify(db.stockBalance);
    await measure(app, createCryptographicJwt({
      clientId: 'modulo-marketplace', scope: 'inventario:disponibilidad:leer',
    }), { inventory: { items: [
      { sku: available, status: 'DISPONIBLE' }, { sku: unavailable, status: 'AGOTADO' },
      { sku: unknown, status: 'INDETERMINADO' },
    ] } }, 'NEST_INVENTARIO_CONTROLADO');
    if (JSON.stringify(db.stockBalance) !== before || db.reservations.length !== 0) {
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
