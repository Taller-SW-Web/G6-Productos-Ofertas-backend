import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expectedCommercialProducts } from './catalog-pagination-integrity.mjs';

const [, , k6PathInput, frontendSha, docsSha] = process.argv;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../../');
const scriptPath = resolve(here, 'catalog-pagination.k6.js');
const fixtureModulePath = resolve(here, 'catalog-pagination.fixture-server.h5.mjs');
const datasetPath = resolve(here, '../../fixtures/h5/manifest.json');
const checksumPath = resolve(here, '../../fixtures/h5/manifest.sha256');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compactJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const output = (message) => process.stdout.write(`${message}\n`);

if (!k6PathInput || !/^[a-f0-9]{40}$/i.test(frontendSha ?? '') || !/^[a-f0-9]{40}$/i.test(docsSha ?? '')) {
  throw new Error('USO: node catalog-pagination.k6.local-runner.mjs <k6.exe> <frontend-sha> <docs-sha>');
}
const k6Path = resolve(k6PathInput);
await stat(k6Path);

const manifestBytes = await readFile(datasetPath);
const manifestText = manifestBytes.toString('utf8');
const manifestSha = sha256(manifestBytes);
const manifestChecksum = (await readFile(checksumPath, 'utf8')).trim();
if (manifestChecksum !== `${manifestSha}  manifest.json`) throw new Error('H5_PERF01_MANIFEST_HASH_INVALID');
const manifest = JSON.parse(manifestText);
const channel = 'MARKETPLACE';
const products = expectedCommercialProducts(manifest, channel);
const eligibleDetails = products.filter((product) =>
  product.variants.some((variant) => variant.eligible && variant.state === 'ACTIVA'));
const snapshotRequests = Math.ceil(products.length / manifest.pagination.page_size) + eligibleDetails.length;
const maximumRequests = (1 * 60) + 1 + (2 * snapshotRequests);
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const sourceWorktreeClean = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim() === '';
const runId = randomUUID().replaceAll('-', '');
const runDirectory = join(repoRoot, 'scripts/h5/k6/.local/perf01-canonical', runId);
await mkdir(runDirectory, { recursive: true });

const fixtureModule = await import(pathToFileURL(fixtureModulePath).href);
const server = await fixtureModule.startCatalogPaginationFixtureServer({ manifest });
if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(server.baseUrl)) {
  await server.close();
  throw new Error('H5_PERF01_FIXTURE_NOT_LOOPBACK');
}

const summaryPath = join(runDirectory, 'summary.json');
const k6SummaryPath = join(runDirectory, 'k6-summary.json');
const dashboardPath = join(runDirectory, 'dashboard.html');
const logPath = join(runDirectory, 'execution.log');
const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH)$/i.test(key)));
const environment = {
  ...safeEnvironment,
  BASE_URL: server.baseUrl,
  SYNTHETIC_JWT: server.authorization.replace(/^Bearer\s+/i, ''),
  SOURCE_SHA: sourceSha,
  DOCS_SHA: docsSha,
  VU: '1',
  DURATION: '60s',
  MAX_RPS: '1',
  SEED: String(manifest.seed),
  CHANNEL: channel,
  MANIFEST_SHA256: manifestSha,
  REPETITION: '1',
  H5_PERF01_EVIDENCE_PATH: summaryPath,
  K6_WEB_DASHBOARD: 'true',
  K6_WEB_DASHBOARD_HOST: '127.0.0.1',
  K6_WEB_DASHBOARD_PORT: '-1',
  K6_WEB_DASHBOARD_PERIOD: '1s',
  K6_WEB_DASHBOARD_EXPORT: dashboardPath,
  K6_NO_USAGE_REPORT: 'true',
};

const exactCommand = `node apps/catalog-svc/test/performance/h5/catalog-pagination.k6.local-runner.mjs "${k6Path}" ${frontendSha} ${docsSha}`;

try {
  const run = await new Promise((complete) => {
    execFile(k6Path, [
      'run', '--quiet', '--summary-export', k6SummaryPath, scriptPath,
    ], {
      cwd: repoRoot,
      env: environment,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => complete({ error, stdout, stderr }));
  });
  const combinedOutput = `${run.stdout}\n${run.stderr}`;
  const sanitizedOutput = combinedOutput
    .replaceAll(server.authorization, '<redacted>')
    .replaceAll(server.baseUrl, '<loopback>');
  await writeFile(logPath, sanitizedOutput, 'utf8');
  const k6Report = JSON.parse(await readFile(summaryPath, 'utf8'));
  const k6Summary = JSON.parse(await readFile(k6SummaryPath, 'utf8'));
  const metrics = k6Summary.metrics ?? {};
  const values = (name) => metrics[name]?.values ?? {};
  const preflightHash = /H5_PERF01_SNAPSHOT_PREFLIGHT_([a-f0-9]{64})/.exec(sanitizedOutput)?.[1] ?? null;
  const postflightHash = /H5_PERF01_SNAPSHOT_POSTFLIGHT_([a-f0-9]{64})/.exec(sanitizedOutput)?.[1] ?? null;
  const httpRequests = values('http_reqs');
  const checks = values('checks');
  const failedChecks = [
    ...(run.error || run.error?.code ? [`k6_exit_${run.error?.code ?? 'error'}`] : []),
    ...(!sanitizedOutput.includes('H5_PERF01_PREFLIGHT_PASS') ? ['semantic_preflight_missing'] : []),
    ...(!sanitizedOutput.includes('H5_PERF01_POSTFLIGHT_PASS') ? ['semantic_postflight_missing'] : []),
    ...(!preflightHash || preflightHash !== postflightHash ? ['dataset_integrity'] : []),
    ...(k6Report.status_2xx < 1 ? ['no_successful_reads'] : []),
    ...(k6Report.unexpected_errors > 0 || k6Report.unexpected_error_rate >= 0.01 ? ['unexpected_http_errors'] : []),
    ...((checks.rate ?? 0) < 0.99 ? ['functional_checks'] : []),
    ...(httpRequests.count > maximumRequests ? ['request_budget'] : []),
    ...(!await (async () => { try { await stat(dashboardPath); return true; } catch { return false; } })() ? ['native_dashboard_html'] : []),
  ];
  const status = failedChecks.length === 0 ? 'PASS' : 'FAIL';
  const report = {
    schema_version: 1,
    case_id: 'PERF-01',
    status,
    failed_checks: failedChecks,
    official_h5_03: 'NO_CERTIFICADO',
    scope: 'L1_FIXTURE_SINTETICO',
    environment: 'LOCAL_LOOPBACK_FIXTURE',
    dependency_scope: { service: 'catalog-pagination.fixture-server.h5.mjs', database: false, remote_services: false },
    source_sha: sourceSha,
    source_worktree_clean: sourceWorktreeClean,
    frontend_sha: frontendSha,
    docs_sha: docsSha,
    dataset_sha256: manifestSha,
    dataset_seed: manifest.seed,
    dataset_preflight_sha256: preflightHash,
    dataset_postflight_sha256: postflightHash,
    data_unchanged: Boolean(preflightHash && preflightHash === postflightHash),
    channel,
    profile: '1VU-60s',
    virtual_users: 1,
    duration_seconds: 60,
    max_rps: 1,
    max_requests: maximumRequests,
    requests_offered: httpRequests.count ?? 0,
    actual_http_requests_per_second: httpRequests.rate ?? null,
    rps_2xx: k6Report.rps_2xx,
    http_status_counts: {
      '2xx': k6Report.status_2xx,
      '401': k6Report.responses_401,
      '403': k6Report.responses_403,
      '429': k6Report.responses_429,
      '503': k6Report.responses_503,
      other: k6Report.responses_other_http_errors,
    },
    latency_ms: { p50: k6Report.p50_ms, p95: k6Report.p95_ms, p99: k6Report.p99_ms },
    unexpected_errors: k6Report.unexpected_errors,
    unexpected_error_rate: k6Report.unexpected_error_rate,
    functional_checks: checks,
    snapshot_requests_per_phase: snapshotRequests,
    exact_command: exactCommand,
    k6_metrics: metrics,
  };
  await writeFile(summaryPath, compactJson(report), 'utf8');
  const artifactPaths = [summaryPath, k6SummaryPath, dashboardPath, logPath];
  const artifacts = await Promise.all(artifactPaths.map(async (path) => {
    const bytes = await readFile(path);
    return { file: path.slice(runDirectory.length + 1), bytes: bytes.length, sha256: sha256(bytes) };
  }));
  const indexBytes = compactJson({ schema_version: 1, run_id: runId, status, artifacts });
  const indexPath = join(runDirectory, 'evidence-index.json');
  await writeFile(indexPath, indexBytes, 'utf8');
  const indexSha = sha256(indexBytes);
  await writeFile(join(runDirectory, 'evidence-index.sha256'), `${indexSha}  evidence-index.json\n`, 'ascii');
  output(`PERF-01_CANONICAL=${status} .local/perf01-canonical/${runId}/summary.json`);
  output(`HTTP=${JSON.stringify(report.http_status_counts)} RPS=${report.rps_2xx} p95=${report.latency_ms.p95} ms p99=${report.latency_ms.p99} errors=${report.unexpected_errors}`);
  output(`EVIDENCE_SHA256=${indexSha}`);
  if (status !== 'PASS') process.exitCode = 1;
} finally {
  await server.close();
}
