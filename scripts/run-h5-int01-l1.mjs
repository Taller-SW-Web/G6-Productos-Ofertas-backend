import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertSafeEvidenceText } from '../apps/catalog-svc/test/h5/evidence-security.mjs';

const reportPath = resolve('test-results/h5/int01-l1-summary.json');
const innerPath = resolve('test-results/h5/int01-l1-local-inner.json');
const docsSha = 'c9e1e5c217616d28229fccf5315fb97a1ae061a9';
const scenarioIds = [
  'INT01-PRODUCTO-INACTIVO', 'INT01-VARIANTE-DESACTIVADA', 'INT01-SKU-NO-VENDIBLE',
  'INT01-CATEGORIA-INVALIDA', 'INT01-MARCA-INVALIDA', 'INT01-VERSION-SKU-CAMBIADO',
  'INT01-CATALOG-AUTH-SUBCASE',
];
const expectedTests = scenarioIds.length + (process.env.CATALOG_REAL_FRONTEND_ROOT ? 1 : 0);
const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
  encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
});
const source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const sourceSha = source.status === 0 ? source.stdout.trim() : null;
await mkdir(dirname(reportPath), { recursive: true });
try { await unlink(innerPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }

let inner = null;
let runnerExit = null;
let capturedBytes = 0;
let blocker = null;
if (process.env.G6_H5_INT01_CATALOG_L1 !== '1') {
  blocker = 'EXPLICIT_LOCAL_L1_OPT_IN_REQUIRED';
} else if (docker.status !== 0) {
  blocker = 'DOCKER_DAEMON_UNAVAILABLE_FOR_DISPOSABLE_POSTGRES';
} else {
  const child = spawn(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.h5-int01-l1.config.ts', '--maxWorkers=1',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    env: { ...process.env, G6_H5_INT01_CATALOG_L1: '1', G6_H5_INT01_L1_SUMMARY_PATH: innerPath },
  });
  child.stdout.on('data', chunk => { capturedBytes += chunk.length; });
  child.stderr.on('data', chunk => { capturedBytes += chunk.length; });
  runnerExit = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', resolvePromise);
  });
  try {
    const bytes = await readFile(innerPath);
    const text = bytes.toString('utf8');
    assertSafeEvidenceText(text);
    inner = JSON.parse(text);
  } catch { blocker = runnerExit === 0 ? 'LOCAL_L1_REPORT_MISSING' : 'LOCAL_L1_HARNESS_INITIALIZATION_FAILED'; }
}

const actual = new Map((inner?.cases ?? []).map(item => [item.scenario_id, item]));
const cases = scenarioIds.map(id => {
  const result = actual.get(id);
  const status = result?.status === 'PASS' ? 'PASS'
    : result?.status === 'FAIL' ? 'FAIL'
      : 'BLOCKED_DEPENDENCY';
  return {
    scenario_id: id,
    status,
    execution: result?.execution ?? 'NOT_EXECUTED',
    evidence_level: result?.evidence_level ?? 'L1',
    providers_started: result?.providers_started ?? [],
    providers_queried: result?.providers_queried ?? [],
    providers_participating: result?.providers_participating ?? [],
    simulated_providers: result?.simulated_providers ?? [],
    identity_authorization: result?.identity_authorization ?? 'NOT_RUN',
    blockers: status === 'BLOCKED_DEPENDENCY' ? [blocker ?? (inner ? 'LOCAL_SETUP_FAILED_OR_CASE_SKIPPED' : 'SCENARIO_CASE_NOT_EXECUTED')] : [],
    owner: id.includes('CATEGORIA') || id.includes('MARCA') ? ['Poma/Catalog', 'López/Taxonomy fixture'] : ['Poma/Catalog'],
    command: '$env:G6_H5_INT01_CATALOG_L1="1"; npm run test:e2e -- apps/catalog-svc/test/h5/int01-local-catalog.e2e-spec.ts --maxWorkers=1',
  };
});
const relatedFrontendCase = process.env.CATALOG_REAL_FRONTEND_ROOT
  ? actual.get('INT08-L1-INDEPENDENT-BROWSER') ?? null
  : null;
const relatedFrontendStatus = !process.env.CATALOG_REAL_FRONTEND_ROOT ? null
  : relatedFrontendCase?.status === 'PASS' ? 'PASS'
    : relatedFrontendCase?.status === 'FAIL' ? 'FAIL' : 'BLOCKED_DEPENDENCY';
let relatedFrontendArtifact = null;
if (process.env.CATALOG_REAL_FRONTEND_ROOT) {
  try {
    const bytes = await readFile(resolve(process.env.CATALOG_REAL_FRONTEND_ROOT, 'test-results/h5/int08-l1-summary.json'));
    assertSafeEvidenceText(bytes.toString('utf8'));
    relatedFrontendArtifact = {
      path: 'frontend:test-results/h5/int08-l1-summary.json',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch { /* Missing evidence remains explicit below. */ }
}

const l0Path = 'apps/catalog-svc/test/h5/reports/int01.json';
let l0 = { status: 'NOT_RUN', artifact: null, sha256: null };
try {
  const bytes = await readFile(resolve(l0Path));
  const summary = JSON.parse(bytes.toString('utf8'));
  l0 = {
    status: summary.suite === 'INT01_CONTRACT' && summary.total === 35 && summary.passed === 35 && summary.failed === 0 && summary.skipped === 0 ? 'PASS' : 'NOT_RUN',
    artifact: l0Path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
} catch { /* L0 remains explicitly NOT_RUN */ }

const passed = cases.filter(item => item.status === 'PASS').length;
const failed = cases.filter(item => item.status === 'FAIL').length + (relatedFrontendStatus === 'FAIL' ? 1 : 0);
const blocked = cases.filter(item => item.status === 'BLOCKED_DEPENDENCY').length + (relatedFrontendStatus === 'BLOCKED_DEPENDENCY' ? 1 : 0);
const status = failed > 0 ? 'FAIL' : blocked > 0 ? passed > 0 ? 'PARTIAL_B' : 'BLOCKED_DEPENDENCY' : 'DONE_B';
const report = {
  schema_version: 1,
  case_id: 'INT-01-L1-CATALOG-SUBCASES',
  task_id: 'POM-A01',
  h5_criterion: 'H5-02',
  repository: 'Taller-SW-Web/G6-Productos-Ofertas-backend',
  owner: 'Poma',
  source_sha: sourceSha,
  docs_sha: docsSha,
  timestamp_utc: new Date().toISOString(),
  config_version: 'int01-local-catalog-postgres-v1',
  tool_versions: { node: process.version, vitest: JSON.parse(await readFile('node_modules/vitest/package.json', 'utf8')).version, postgres_container: 'postgres:17-alpine' },
  command: 'node scripts/run-h5-int01-l1.mjs',
  suite: 'INT01_LOCAL_CATALOG_L1',
  status,
  discovered: expectedTests,
  executed: cases.filter(item => item.execution === 'EXECUTED').length + (relatedFrontendCase?.status === 'PASS' || relatedFrontendCase?.status === 'FAIL' ? 1 : 0),
  passed,
  failed,
  blocked,
  skipped: cases.filter(item => item.execution === 'NOT_EXECUTED').length,
  l0,
  cases,
  related_frontend_case: relatedFrontendCase ? {
    scenario_id: 'INT08-L1-INDEPENDENT-BROWSER',
    status: relatedFrontendStatus,
    execution: relatedFrontendCase.execution,
    evidence_level: 'L1_BROWSER_GATEWAY_CATALOG_POSTGRES',
    providers_started: relatedFrontendCase.providers_started,
    providers_queried: relatedFrontendCase.providers_queried,
    providers_participating: relatedFrontendCase.providers_participating,
    simulated_providers: relatedFrontendCase.simulated_providers,
    blockers: relatedFrontendStatus === 'BLOCKED_DEPENDENCY' ? ['FRONTEND_L1_RESULT_MISSING_OR_NOT_EXECUTED'] : [],
    artifact: relatedFrontendArtifact,
  } : null,
  integration_mode: inner?.integration_mode ?? 'not started; local capability probes only; no external calls',
  runner_exit_code: runnerExit,
  captured_subprocess_bytes: capturedBytes,
  no_shared_services: true,
  artifact: 'test-results/h5/int01-l1-local-inner.json',
  limitations: ['These Catalog-only subcases do not prove the full Catalog-Pricing-Inventory preparation journey.', 'The authentication probe is a Catalog subcase; full INT01 identity authorization remains blocked until every provider identity is exercised.'],
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
assertSafeEvidenceText(serialized);
await writeFile(reportPath, serialized, 'utf8');
const reportSha = createHash('sha256').update(Buffer.from(serialized, 'utf8')).digest('hex');
const index = { schema_version: 1, artifact: 'test-results/h5/int01-l1-summary.json', sha256: reportSha, case_id: report.case_id, task_id: report.task_id, h5_criterion: report.h5_criterion, source_sha: sourceSha, docs_sha: docsSha, status };
const indexText = `${JSON.stringify(index, null, 2)}\n`;
assertSafeEvidenceText(indexText);
await writeFile(`${reportPath}.index.json`, indexText, 'utf8');

const preflight = spawnSync(process.execPath, ['scripts/run-h5-int01-preflight.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });
if (preflight.status === 0) process.stdout.write(preflight.stdout.trim() + '\n');
else process.stdout.write('INT01 preflight generation failed; raw child diagnostics were suppressed.\n');
process.stdout.write(`INT01 L1 local ${status}: discovered=${report.discovered}; executed=${report.executed}; passed=${passed}; failed=${failed}; blocked=${blocked}; frontend_l1=${relatedFrontendStatus ?? 'NOT_REQUESTED'}; evidence_sha256=${reportSha}.\n`);
if (failed > 0 || preflight.status !== 0) process.exit(1);
if (blocked > 0) process.exit(2);
