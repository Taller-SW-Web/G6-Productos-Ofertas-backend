import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ejecutarMatriz } from './ejecutar-matriz.mjs';
import { authorizeMutation, loadMutationAuthorization } from './autorizacion-mutaciones.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, 'ejecutar-integracion.mjs');
const scenarios = JSON.parse(await readFile(resolve(here, 'escenarios.json'), 'utf8'));
const manualWindowCases = new Set(['G5-H5-12', 'G5-H5-17', 'G5-H5-18', 'G5-H5-19']);
const isHttpsEvidence = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};
const fail = (code) => { throw new Error(code); };
const sha = /^[a-f0-9]{40}$/i;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const preflightChecks = {
  availability: { method: 'GET', route: '/inventario/disponibilidad' },
  price: { method: 'GET' },
  coupon: { method: 'POST', route: '/cupones/validar' },
};
const complementaryPreflightServices = new Set([
  'gateway-readiness', 'catalog-readiness', 'pricing-readiness', 'inventory-readiness',
]);

export function validatePreflightEvidence(events, plan) {
  if (!Array.isArray(events) || events.length < 4 || !plan?.scenario ||
      plan.environment !== 'integration' || !sha.test(plan.g5_sha ?? '') ||
      !sha.test(plan.g6_sha ?? '') || !uuid.test(plan.correlation_id ?? '') ||
      typeof plan.order_id !== 'string' || !plan.order_id.trim() ||
      typeof plan.case_id !== 'string' ||
      !scenarios.some((scenario) => scenario.id === plan.case_id)) return false;
  const scenario = plan.scenario;
  const expectedScenario = {
    sku: scenario.sku,
    quantity: scenario.quantity,
    channel_id: scenario.channel_id,
    coupon_code: scenario.coupon_code,
    currency: scenario.currency,
    location_id: scenario.location_id,
  };
  if (typeof scenario.sku !== 'string' || !scenario.sku.trim() ||
      !Number.isSafeInteger(scenario.quantity) || scenario.quantity < 1 ||
      typeof scenario.channel_id !== 'string' || !scenario.channel_id.trim() ||
      typeof scenario.coupon_code !== 'string' || !scenario.coupon_code.trim() ||
      typeof scenario.currency !== 'string' || !scenario.currency.trim() ||
      !uuid.test(scenario.location_id ?? '')) return false;

  const checks = new Map();
  const complements = new Set();
  let terminal;
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        event.environment !== plan.environment || event.g5_sha !== plan.g5_sha ||
        event.g6_sha !== plan.g6_sha || event.order_id !== plan.order_id ||
        event.correlation_id !== plan.correlation_id || event.case_id !== plan.case_id)
      return false;
    if (event.event === 'http') {
      const rule = preflightChecks[event.check];
      if (!rule || checks.has(event.check) || event.status !== 200 ||
          event.method !== rule.method ||
          (rule.route && event.route !== rule.route) ||
          (event.check === 'price' && event.route !== '/precios/skus/' + encodeURIComponent(scenario.sku)) ||
          event.scenario?.sku !== expectedScenario.sku ||
          event.scenario?.quantity !== expectedScenario.quantity ||
          event.scenario?.channel_id !== expectedScenario.channel_id ||
          event.scenario?.coupon_code !== expectedScenario.coupon_code ||
          event.scenario?.currency !== expectedScenario.currency ||
          event.scenario?.location_id !== expectedScenario.location_id ||
          !event.request || typeof event.request !== 'object')
        return false;
      if (event.check === 'availability' &&
          (event.request.skus !== scenario.sku || event.request.location_id !== scenario.location_id)) return false;
      if (event.check === 'price' && event.request.canal !== scenario.channel_id) return false;
      if (event.check === 'coupon' &&
          (event.request.channel_id !== scenario.channel_id || event.request.coupon_code !== scenario.coupon_code ||
           !Array.isArray(event.request.lines) || event.request.lines.length !== 1 ||
           event.request.lines[0].sku !== scenario.sku || event.request.lines[0].quantity !== scenario.quantity)) return false;
      checks.set(event.check, event);
      continue;
    }
    if (event.event === 'read_only_preflight') {
      if (terminal) return false;
      terminal = event;
      continue;
    }
    if (event.event === 'preflight_dependency') {
      if (!complementaryPreflightServices.has(event.service) ||
          complements.has(event.service) || event.status !== 'PASS') return false;
      complements.add(event.service);
      continue;
    }
    return false;
  }
  if (checks.size !== 3 || !['availability', 'price', 'coupon'].every((key) => checks.has(key)) || !terminal)
    return false;
  const available = Number(terminal.available);
  const price = Number(terminal.price);
  const discount = Number(terminal.discount);
  const total = price * scenario.quantity;
  return Number.isFinite(available) && available >= scenario.quantity &&
    Number.isFinite(price) && price > 0 &&
    (scenario.expected_regular_price === undefined || price === Number(scenario.expected_regular_price)) &&
    Number.isFinite(discount) && discount > 0 && discount <= total &&
    terminal.sku === scenario.sku && terminal.currency === scenario.currency &&
    terminal.price_sku === scenario.sku && terminal.price_currency === scenario.currency &&
    terminal.discount_currency === scenario.currency && terminal.eligible === true;
}

function targetOrigin(plan) {
  const gateway = new URL(plan.gateway);
  if (gateway.protocol !== 'https:' || process.env.G5_H5_AUTHORIZED_GATEWAY_ORIGIN !== gateway.origin)
    fail('AUTHORIZED_PRIVATE_GATEWAY_REQUIRED');
  if (!process.env.G5_H5_VENTAS_JWT || /\s/.test(process.env.G5_H5_VENTAS_JWT))
    fail('G7_VENTAS_TOKEN_REQUIRED');
}

async function readManifest(manifestPath) {
  const absolute = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absolute, 'utf8'));
  const root = dirname(absolute);
  const resolved = Object.fromEntries(Object.entries(manifest).map(([id, fixture]) => [id, fixture?.plan ? {
    ...fixture,
    plan: resolve(root, fixture.plan),
    ...(typeof fixture.mutation_authorization === 'string'
      ? { mutation_authorization: resolve(root, fixture.mutation_authorization) }
      : {}),
    ...(fixture.state ? { state: resolve(root, fixture.state) } : {}),
  } : fixture]));
  return { absolute, manifest, resolved };
}

function selectedFixtures(manifest, requested) {
  const ids = requested.length ? requested : scenarios.map(({ id }) => id);
  for (const id of ids)
    if (!scenarios.some((scenario) => scenario.id === id) || !manifest[id]?.plan)
      fail('SELECTED_PLAN_REQUIRED_' + id);
  return ids;
}

function runStage(stage, plan, state, authorizationPath) {
  return spawnSync(process.execPath, [runner, stage, plan, state, ...(authorizationPath ? [authorizationPath, 'true'] : [])], {
    encoding: 'utf8',
    timeout: 420_000,
    env: process.env,
  });
}

async function checkMutationAuthorization(id, fixture, plan, scenario) {
  if (['reserve', 'coupon', 'confirm', 'cancel'].includes(scenario.stage)) {
    if (typeof fixture.mutation_authorization !== 'string')
      fail('MUTATION_AUTHORIZATION_FILE_REQUIRED_' + id);
    const authorization = await loadMutationAuthorization(fixture.mutation_authorization);
    await authorizeMutation({ stage: scenario.stage, plan, authorization, execute: fixture.execute === true });
    return;
  }
  if (manualWindowCases.has(id) && (fixture.execute !== true ||
      !isHttpsEvidence(fixture.window_approval_ref) || !isHttpsEvidence(fixture.fixture_authorization_ref)))
    fail('MUTATION_NOT_AUTHORIZED_' + id);
}

export async function ejecutarPreflight(manifest, ids, outputPath, execute = runStage) {
  const rows = scenarios.map((scenario) => ({
    id: scenario.id,
    stage: scenario.stage,
    technical_status: 'NOT_RUN',
    status: 'BLOCKED',
    reason: 'PREFLIGHT_NOT_RUN',
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const fixture = manifest[id];
    const plan = JSON.parse(await readFile(fixture.plan, 'utf8'));
    targetOrigin(plan);
    if (!scenarioHasPreflight(plan)) fail('AUTHORIZED_PREFLIGHT_FIXTURE_REQUIRED_' + id);
    const run = execute('preflight', fixture.plan, fixture.state ?? `${fixture.plan}.runtime.json`);
    const row = byId.get(id);
    const stdout = String(run.stdout ?? '').trim();
    const lines = stdout ? stdout.split(/\r?\n/) : [];
    try { row.evidence = lines.map((line) => JSON.parse(line)); }
    catch { row.technical_status = 'FAIL'; row.reason = 'PREFLIGHT_EVIDENCE_INVALID'; continue; }
    if (run.status !== 0 || !validatePreflightEvidence(row.evidence, plan)) {
      row.technical_status = 'FAIL';
      row.reason = 'PREFLIGHT_EVIDENCE_INCOMPLETE_INVALID_OR_MUTATING_ROUTE';
      continue;
    }
    row.technical_status = 'PASS';
    row.reason = 'PREFLIGHT_ONLY_NOT_HOMOLOGATION';
  }
  const report = {
    recorded_at: new Date().toISOString(),
    environment: 'integration',
    report_type: 'READ_ONLY_PREFLIGHT',
    results: rows,
  };
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

function scenarioHasPreflight(plan) {
  return plan.environment === 'integration' && plan.scenario &&
    typeof plan.scenario.sku === 'string' && Number.isSafeInteger(plan.scenario.quantity) &&
    typeof plan.scenario.channel_id === 'string' && typeof plan.scenario.coupon_code === 'string' &&
    typeof plan.scenario.currency === 'string' &&
    typeof plan.scenario.location_id === 'string' && typeof plan.customer_ref === 'string';
}

export async function ejecutarBateria(manifest, ids, outputPath, verifyDeployment) {
  for (const id of ids) {
    const scenario = scenarios.find((entry) => entry.id === id);
    const fixture = manifest[id];
    const plan = JSON.parse(await readFile(fixture.plan, 'utf8'));
    targetOrigin(plan);
    await checkMutationAuthorization(id, fixture, plan, scenario);
  }
  const report = await ejecutarMatriz(manifest, ids, runStage, verifyDeployment);
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return report;
}

async function main() {
  const [mode, manifestPath, outputPath, ...requested] = process.argv.slice(2);
  if (!['preflight', 'matrix'].includes(mode) || !manifestPath || !outputPath)
    fail('USO: ejecutar-controlado.mjs <preflight|matrix> manifiesto.json resultado-nuevo.json [G5-H5-NN ...]');
  const { resolved } = await readManifest(manifestPath);
  const ids = mode === 'preflight' && requested.length === 0
    ? scenarios.filter((scenario) => scenario.requires_scenario).map((scenario) => scenario.id)
    : selectedFixtures(resolved, requested);
  const report = mode === 'preflight'
    ? await ejecutarPreflight(resolved, ids, outputPath)
    : await ejecutarBateria(resolved, ids, outputPath);
  const results = report.results.filter((row) => ids.includes(row.id));
  const failed = results.some((row) => row.technical_status === 'FAIL' || row.status === 'FAIL');
  const blocked = results.some((row) => row.status === 'BLOCKED');
  console.log(JSON.stringify({ mode, selected: ids.length, output: resolve(outputPath), technical_failures: results.filter((row) => row.technical_status === 'FAIL').length, blocked: results.filter((row) => row.status === 'BLOCKED').length }));
  process.exitCode = failed ? 1 : blocked ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    const code = /^[A-Z0-9_-]{1,100}$/.test(error?.message ?? '') ? error.message : 'CONTROLLED_RUN_FAILED';
    console.error(JSON.stringify({ status: 'BLOCKED', code }));
    process.exitCode = 2;
  });
