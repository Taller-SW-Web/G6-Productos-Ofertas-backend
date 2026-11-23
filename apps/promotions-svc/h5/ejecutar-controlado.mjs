import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ejecutarMatriz } from './ejecutar-matriz.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, 'ejecutar-integracion.mjs');
const scenarios = JSON.parse(await readFile(resolve(here, 'escenarios.json'), 'utf8'));
const mutatingStages = new Set(['reserve', 'coupon', 'confirm', 'cancel']);
const manualWindowCases = new Set(['G5-H5-12', 'G5-H5-17', 'G5-H5-18', 'G5-H5-19']);
const requiresWindow = (id, scenario) => mutatingStages.has(scenario.stage) || manualWindowCases.has(id);
const isHttpsEvidence = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};
const fail = (code) => { throw new Error(code); };

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

function runStage(stage, plan, state) {
  return spawnSync(process.execPath, [runner, stage, plan, state], {
    encoding: 'utf8',
    timeout: 420_000,
    env: process.env,
  });
}

function checkMutationAuthorization(id, fixture, plan, scenario) {
  if (!requiresWindow(id, scenario)) return;
  if (fixture.execute !== true || process.env.G5_H5_MUTATIONS !== 'integration-only')
    fail('MUTATION_NOT_AUTHORIZED_' + id);
  if (!isHttpsEvidence(fixture.window_approval_ref) || !isHttpsEvidence(fixture.fixture_authorization_ref))
    fail('WINDOW_AND_FIXTURE_AUTHORIZATION_REQUIRED_' + id);
  if (scenario.requires_g5_signature && !plan.g5_evidence)
    fail('SIGNED_G5_EVIDENCE_REQUIRED_' + id);
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
    const lines = String(run.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
    try { row.evidence = lines.map((line) => JSON.parse(line)); }
    catch { row.technical_status = 'FAIL'; row.reason = 'PREFLIGHT_EVIDENCE_INVALID'; continue; }
    const allowed = row.evidence.every((event) =>
      event.event !== 'http' || event.method === 'GET' ||
      (event.method === 'POST' && event.route === '/cupones/validar'),
    );
    if (run.status !== 0 || !allowed) {
      row.technical_status = 'FAIL';
      row.reason = 'PREFLIGHT_FAILED_OR_MUTATING_ROUTE';
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
    checkMutationAuthorization(id, fixture, plan, scenario);
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
