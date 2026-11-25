import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { assertSafeEvidenceText } from '../apps/catalog-svc/test/h5/evidence-security.mjs';
import { adjudicatePerf01Evidence } from '../apps/catalog-svc/test/performance/h5/perf01-evidence-state.mjs';
import { startCatalogPaginationFixtureServer } from '../apps/catalog-svc/test/performance/h5/catalog-pagination.fixture-server.h5.mjs';

const scriptPath = resolve('apps/catalog-svc/test/performance/h5/catalog-pagination.k6.js');
const manifestPath = resolve('apps/catalog-svc/test/fixtures/h5/manifest.json');
const checksumPath = resolve('apps/catalog-svc/test/fixtures/h5/manifest.sha256');
const outputPath = resolve('test-results/h5/perf01-k6-loopback-smoke.json');
const docsSha = 'c9e1e5c217616d28229fccf5315fb97a1ae061a9';
const durationMs = 5_000;
const sourceSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout.trim();
const manifestBytes = await readFile(manifestPath);
const datasetSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const manifestChecksum = (await readFile(checksumPath, 'utf8')).trim();
if (!/^[0-9a-f]{40}$/i.test(sourceSha) || manifestChecksum !== `${datasetSha256}  manifest.json`) throw new Error('PERF01_SMOKE_SOURCE_OR_FIXTURE_INVALID');

const safeEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
safeEnv.K6_NO_USAGE_REPORT = 'true';
const runSyncSafe = (args) => spawnSync('k6', args, { encoding: 'utf8', windowsHide: true, env: safeEnv, maxBuffer: 2 * 1024 * 1024 });
const tempDirectory = await mkdtemp(resolve(tmpdir(), 'poma-h5-k6-'));
const archivePath = resolve(tempDirectory, 'catalog-pagination.tar');
const summaryPath = resolve(tempDirectory, 'k6-summary.json');
let fixture;
let result;
let outputTail = '';
let outputText = '';
let outputBytes = 0;
let startedAt = 0;
let timedOut = false;

const envArgs = (baseUrl, token) => [
  '-e', `BASE_URL=${baseUrl}`,
  '-e', `SYNTHETIC_JWT=${token}`,
  '-e', `SOURCE_SHA=${sourceSha}`,
  '-e', 'SEED=20261123',
  '-e', 'CHANNEL=MARKETPLACE',
  '-e', 'VU=1',
  '-e', 'DURATION=5s',
  '-e', 'H5_SYNTHETIC_SMOKE=1',
  '-e', 'REPETITION=1',
  '-e', `MANIFEST_SHA256=${datasetSha256}`,
];
const runK6 = (args, env) => new Promise((resolvePromise, reject) => {
  const child = spawn('k6', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
  const capture = chunk => {
    outputBytes += chunk.length;
    outputTail = `${outputTail}${chunk.toString('utf8')}`.slice(-16_384);
    if (outputText.length < 1_000_000) outputText += chunk.toString('utf8').slice(0, 1_000_000 - outputText.length);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    try { child.kill('SIGTERM'); } catch { /* Process already exited. */ }
  }, 120_000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); resolvePromise(code); });
});

try {
  const version = runSyncSafe(['version']);
  if (version.status !== 0 || !/v1\.8\.3/.test(version.stdout)) throw new Error('PERF01_K6_VERSION_UNAVAILABLE');
  fixture = await startCatalogPaginationFixtureServer();
  const k6Config = envArgs(fixture.baseUrl, fixture.authorization);
  const inspected = runSyncSafe(['inspect', ...k6Config, scriptPath]);
  if (inspected.status !== 0) throw new Error('PERF01_K6_INSPECT_FAILED');
  const archived = runSyncSafe(['archive', '--vus', '1', '--duration', '1s', ...k6Config, '-O', archivePath, scriptPath]);
  if (archived.status !== 0) throw new Error('PERF01_K6_ARCHIVE_FAILED');
  const archivedBytes = await readFile(archivePath);
  if (archivedBytes.length < 64) throw new Error('PERF01_K6_ARCHIVE_EMPTY');

  startedAt = Date.now();
  const runArgs = [
    'run', '--include-system-env-vars=false', '--rps', '5',
    ...envArgs(fixture.baseUrl, fixture.authorization.replace(/^Bearer /, '')),
    '-e', `H5_PERF01_EVIDENCE_PATH=${summaryPath}`,
    scriptPath,
  ];
  const processExitCode = await runK6(runArgs, safeEnv);
  const elapsedMs = Date.now() - startedAt;
  let k6Summary;
  try { k6Summary = JSON.parse(await readFile(summaryPath, 'utf8')); } catch { k6Summary = null; }
  if (!k6Summary) {
    const summaryText = outputText.match(/\{\s*"schema_version"\s*:[\s\S]*?\n\}/)?.[0];
    try { k6Summary = summaryText ? JSON.parse(summaryText) : null; } catch { k6Summary = null; }
  }
  const preflightPassed = outputTail.includes('H5_PERF01_PREFLIGHT_PASS');
  const postflightPassed = outputTail.includes('H5_PERF01_POSTFLIGHT_PASS');
  const snapshotPreflightSha = /H5_PERF01_SNAPSHOT_PREFLIGHT_([a-f0-9]{64})/.exec(outputText)?.[1] ?? null;
  const snapshotPostflightSha = /H5_PERF01_SNAPSHOT_POSTFLIGHT_([a-f0-9]{64})/.exec(outputText)?.[1] ?? null;
  const iterations = Number(k6Summary?.runtime_iterations ?? 0);
  const responses2xx = Number(k6Summary?.status_2xx ?? 0);
  const unexpectedErrorRate = Number(k6Summary?.unexpected_error_rate);
  const runtimeFailures = Number(k6Summary?.runtime_failures ?? (processExitCode === 0 ? 0 : 1));
  const executionComplete = !timedOut && elapsedMs >= durationMs - 500 && iterations > 0;
  const outcome = adjudicatePerf01Evidence({ preflightPassed, postflightPassed, executionComplete, processExitCode, runtimeFailures, iterations, unexpectedErrorRate, responses2xx }, { syntheticSmoke: true });
  result = {
    schema_version: 1,
    case_id: 'PERF-01',
    task_id: 'POM-A03',
    h5_criterion: 'H5-03',
    repository: 'Taller-SW-Web/G6-Productos-Ofertas-backend',
    owner: 'Poma',
    source_sha: sourceSha,
    docs_sha: docsSha,
    timestamp_utc: new Date().toISOString(),
    config_version: 'h5-k6-loopback-smoke-v1',
    dataset_seed: 20261123,
    dataset_checksum: datasetSha256,
    tool_versions: { k6: version.stdout.trim().split(/\r?\n/)[0], node: process.version },
    environment: { platform: process.platform, architecture: process.arch, network_scope: '127.0.0.1 synthetic fixture only' },
    profile: { vus: 1, duration_seconds: 5, max_rps: 5, repetition: 1 },
    execution: { process_exit_code: processExitCode, elapsed_ms: elapsedMs, iterations, responses_2xx: responses2xx, unexpected_error_rate: Number.isFinite(unexpectedErrorRate) ? unexpectedErrorRate : null, runtime_failures: runtimeFailures },
    integrity: { preflight_passed: preflightPassed, postflight_passed: postflightPassed, execution_complete: executionComplete, snapshot_preflight_sha256: snapshotPreflightSha, snapshot_postflight_sha256: snapshotPostflightSha },
    evidence_level: 'L0_SYNTHETIC_SMOKE',
    status: outcome.status,
    measurement_status: 'NOT_MEASURED_REAL_CATALOG',
    reasons: outcome.reasons,
    artifacts: [
      { path: relative(process.cwd(), scriptPath).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(scriptPath)).digest('hex') },
      { path: 'catalog-pagination.tar', sha256: createHash('sha256').update(archivedBytes).digest('hex'), bytes: archivedBytes.length },
    ],
    captured_subprocess_bytes: outputBytes,
  };
  const reportBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
  assertSafeEvidenceText(reportBytes.toString('utf8'));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, reportBytes);
  const evidenceIndex = { artifact: 'perf01-k6-loopback-smoke.json', sha256: createHash('sha256').update(reportBytes).digest('hex'), source_sha: sourceSha, docs_sha: docsSha, status: outcome.status, measurement_status: result.measurement_status };
  const indexBytes = Buffer.from(`${JSON.stringify(evidenceIndex, null, 2)}\n`, 'utf8');
  assertSafeEvidenceText(indexBytes.toString('utf8'));
  await writeFile(`${outputPath}.index.json`, indexBytes);
  process.stdout.write(`PERF-01 k6 loopback smoke ${outcome.status}: preflight=${preflightPassed}; postflight=${postflightPassed}; snapshot_match=${snapshotPreflightSha !== null && snapshotPreflightSha === snapshotPostflightSha}; iterations=${iterations}; measured_real=false.\n`);
  if (outcome.status !== 'PASS_SYNTHETIC_SMOKE') process.exitCode = 1;
} catch {
  process.stdout.write('PERF-01 k6 loopback smoke FAIL: PREFLIGHT_OR_RUNTIME_FAILURE.\n');
  process.exitCode = 1;
} finally {
  try { await fixture?.close(); } catch { process.exitCode = 1; }
  await rm(tempDirectory, { recursive: true, force: true });
}
