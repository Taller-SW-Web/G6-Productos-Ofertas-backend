import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { assertSafeEvidenceText } from '../apps/catalog-svc/test/h5/evidence-security.mjs';

const suites = {
  int01: { config: 'vitest.h5-int01.config.ts', suite: 'INT01_CONTRACT', expected: 16 },
  perf01: { config: 'vitest.h5-perf01.config.ts', suite: 'PERF01_ORACLE', expected: 21 },
};
const selected = suites[process.argv[2]];
if (!selected) throw new Error('H5_VITEST_SUITE_INVALID: use int01 or perf01');
const summaryPath = resolve('apps/catalog-svc/test/h5/reports', `${process.argv[2]}.json`);
await mkdir(dirname(summaryPath), { recursive: true });
try { await unlink(summaryPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
const child = spawn(process.execPath, [
  'node_modules/vitest/vitest.mjs', 'run', '--config', selected.config,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  env: { ...process.env, G6_H5_VITEST_SUMMARY: summaryPath },
});
let capturedBytes = 0;
child.stdout.on('data', chunk => { capturedBytes += chunk.length; });
child.stderr.on('data', chunk => { capturedBytes += chunk.length; });
const exitCode = await new Promise((resolvePromise, reject) => {
  child.once('error', reject);
  child.once('close', resolvePromise);
});
let summary;
let summarySha256;
try {
  const bytes = await readFile(summaryPath);
  const content = bytes.toString('utf8');
  assertSafeEvidenceText(content);
  summary = JSON.parse(content);
  summarySha256 = createHash('sha256').update(bytes).digest('hex');
} catch {
  summary = null;
}
const expectedValid = summary?.suite === selected.suite && summary?.total === selected.expected && summary?.passed === selected.expected && summary?.failed === 0 && summary?.skipped === 0 && summary?.pending === 0 && summary?.status === 'PASS';
if (!expectedValid || exitCode !== 0) {
  process.stdout.write(`H5 ${selected.suite} ${summary?.status === 'NOT_RUN' ? 'NOT_RUN' : 'FAIL'}: expected=${selected.expected}; observed=${summary?.total ?? 0}; skipped=${summary?.skipped ?? 0}; runner_exit=${exitCode}; captured_bytes=${capturedBytes}.\n`);
  process.exit(1);
}
const sourceSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout.trim();
const artifactPaths = [
  relative(process.cwd(), summaryPath),
  'apps/catalog-svc/test/fixtures/h5/manifest.json',
  'apps/catalog-svc/test/fixtures/h5/manifest.sha256',
  ...(process.argv[2] === 'int01' ? ['apps/catalog-svc/test/h5/int01-scenarios.json'] : []),
];
const artifacts = await Promise.all(artifactPaths.map(async path => {
  const bytes = await readFile(path);
  return { path: path.replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const manifestBytes = await readFile('apps/catalog-svc/test/fixtures/h5/manifest.json');
const datasetSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const summaryArtifact = artifacts.find(item => item.path.endsWith(`/${process.argv[2]}.json`));
const npmVersionResult = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm --version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  : spawnSync('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const npmVersion = npmVersionResult.status === 0 ? (npmVersionResult.stdout ?? '').trim() || 'UNAVAILABLE' : 'UNAVAILABLE';
const vitestVersion = JSON.parse(await readFile('node_modules/vitest/package.json', 'utf8')).version;
const manifest = {
  schema_version: 1,
  case_id: process.argv[2] === 'int01' ? 'INT-01' : 'PERF-01',
  task_id: process.argv[2] === 'int01' ? 'POM-A01' : 'POM-A03',
  h5_criterion: process.argv[2] === 'int01' ? 'H5-02' : 'H5-03',
  repository: 'Taller-SW-Web/G6-Productos-Ofertas-backend',
  repo: 'Taller-SW-Web/G6-Productos-Ofertas-backend',
  owner: 'Poma',
  source_sha: sourceSha,
  docs_sha: 'c9e1e5c217616d28229fccf5315fb97a1ae061a9',
  timestamp_utc: new Date().toISOString(),
  environment: { platform: process.platform, architecture: process.arch, node: process.version, ci: process.env.CI === 'true' },
  config_version: 'h5-vitest-evidence-v2',
  dataset_seed: 20261123,
  dataset_checksum: datasetSha256,
  configuration: {
    suite: selected.suite,
    dataset_seed: 20261123,
    dataset_sha256: datasetSha256,
    providers_started: [],
    providers_queried: [],
    providers_participating: [],
    simulated_providers: process.argv[2] === 'int01' ? ['synthetic contract replay only'] : [],
  },
  tool_versions: { node: process.version, npm: npmVersion, vitest: vitestVersion },
  versions: { node: process.version, npm: npmVersion, vitest: vitestVersion },
  test_command: `node scripts/run-h5-vitest.mjs ${process.argv[2]}`,
  command: `node scripts/run-h5-vitest.mjs ${process.argv[2]}`,
  artifact_uri: summaryArtifact?.path ?? null,
  sha256_artifact: summarySha256,
  evidence_level: 'L0',
  status: summary.status,
  expected: { assertions: selected.expected, l1_provider_execution: 'NOT_RUN' },
  observed: { assertions: summary.total, passed: summary.passed, failed: summary.failed, skipped: summary.skipped, pending: summary.pending },
  individual_cases: summary.cases,
  negative_tests: summary.cases.filter(item => /401|403|404|409|503|NEGATIVE|ABSENT|MISSING|INVALID|DENIED|FAILED/.test(item.scenario_id)).map(item => ({ scenario_id: item.scenario_id, status: item.status })),
  limitations: process.argv[2] === 'int01'
    ? ['L0 responses are synthetic and do not prove participation of Catalog, Pricing or Inventory.', 'Real L1 remains independently blocked by its listed integration prerequisites.']
    : ['k6 module inspection and HTTP measurement were not executed by this Vitest oracle suite.', 'No Azure, APIM, shared Supabase or operational services were contacted.'],
  artifacts,
};
const evidenceBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const evidenceText = evidenceBytes.toString('utf8');
assertSafeEvidenceText(evidenceText);
const evidencePath = resolve('apps/catalog-svc/test/h5/reports', `evidence-manifest-${process.argv[2]}.json`);
await writeFile(evidencePath, evidenceBytes);
const evidenceSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
const evidenceIndex = {
  schema_version: 1,
  artifact: `evidence-manifest-${process.argv[2]}.json`,
  sha256: evidenceSha256,
  sha256_artifact: evidenceSha256,
  source_sha: sourceSha,
  docs_sha: manifest.docs_sha,
  case_id: manifest.case_id,
  task_id: manifest.task_id,
  h5_criterion: manifest.h5_criterion,
  evidence_level: 'L0',
  status: manifest.status,
};
const indexBytes = Buffer.from(`${JSON.stringify(evidenceIndex, null, 2)}\n`, 'utf8');
assertSafeEvidenceText(indexBytes.toString('utf8'));
await writeFile(`${evidencePath}.index.json`, indexBytes);
process.stdout.write(`H5 ${selected.suite} PASS: tests=${summary.total}; evidence_sha256=${evidenceSha256}; captured_bytes=${capturedBytes}.\n`);
