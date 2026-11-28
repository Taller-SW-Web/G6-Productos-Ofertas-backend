import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('PERF-04 loopback fixture validates admission, replay, conflict and polling without claiming certification', async () => {
  const testToken = 'synthetic-perf04-only';
  const directory = await mkdtemp(join(tmpdir(), 'g6-perf04-'));
  const operation = {
    operation_id: '66666666-6666-4666-8666-666666666666',
    order_id: 'PERF04-FIXTURE-001',
    commercial_snapshot_ref: 'PERF04-FIXTURE-001',
    reservation_id: '22222222-2222-4222-8222-222222222222',
    coupon_code: 'PERF04-FIXTURE',
    channel_id: 'MARKETPLACE',
    effective_at: '2026-11-24T12:00:00Z',
  };
  const readPath =
    '/api/v1/cupones/operaciones/' +
    operation.operation_id +
    '?order_id=' +
    operation.order_id;
  const conflictCode = 'PERF04-OTHER';
  const calls = [];
  const statuses = [];
  const evidenceDirectory = join(
    process.cwd(),
    'scripts/h5/k6/.local/perf04-fixture',
    randomUUID().replaceAll('-', ''),
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const k6SummaryPath = join(evidenceDirectory, 'k6-summary.json');
  const dashboardPath = join(evidenceDirectory, 'dashboard.html');
  const outputPath = join(evidenceDirectory, 'k6-output.log');
  const server = createServer(async (req, res) => {
    const reply = (status, body, headers) => {
      statuses.push(status);
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const snapshot = (status) => ({
      status,
      operation_id: operation.operation_id,
      order_id: operation.order_id,
    });
    if (req.headers.authorization !== 'Bearer ' + testToken)
      return reply(401, {});
    if (req.method === 'GET' && req.url === readPath && calls.length === 3) {
      calls.push('poll');
      return reply(200, snapshot('COMPLETED'));
    }
    if (
      req.method !== 'POST' ||
      req.url !== '/api/v1/cupones/consumos' ||
      req.headers['idempotency-key'] !== operation.operation_id
    )
      return reply(400, {});
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (calls.length === 0) {
        assert.deepEqual(body, operation);
        calls.push('admit');
        return reply(202, snapshot('ACCEPTED'), {
          Location: readPath,
          'Retry-After': '2',
        });
      }
      if (calls.length === 1) {
        assert.deepEqual(body, operation);
        calls.push('replay');
        return reply(200, snapshot('PROCESSING'));
      }
      assert.equal(calls.length, 2);
      assert.deepEqual(body, { ...operation, coupon_code: conflictCode });
      calls.push('conflict');
      return reply(409, { code: 'IDEMPOTENCY_CONFLICT' });
    } catch {
      return reply(400, {});
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const dataset = join(directory, 'intents.json');
    const datasetBytes = JSON.stringify([
      {
        body: operation,
        conflict_coupon_code: conflictCode,
        expected_terminal: 'COMPLETED',
      },
    ]);
    await writeFile(
      dataset,
      datasetBytes,
    );
    const scenarioFile = fileURLToPath(
      new URL('./coupon-admission.k6.js', import.meta.url),
    );
    const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    const startedAt = Date.now();
    const k6Output = await execute(
      process.env.G6_K6_BIN || 'k6',
      ['run', '--quiet', scenarioFile],
      {
        env: {
          ...process.env,
          PERF04_PROFILE: 'fixture',
          PERF04_SYNTHETIC_FIXTURE: '1',
          PERF04_ORIGIN: 'http://127.0.0.1:' + server.address().port,
          PERF04_TEST_TOKEN: testToken,
          PERF04_SYNTHETIC_DATASET: dataset,
          PERF04_SUMMARY_PATH: k6SummaryPath,
          K6_WEB_DASHBOARD: 'true',
          K6_WEB_DASHBOARD_HOST: '127.0.0.1',
          K6_WEB_DASHBOARD_PORT: '-1',
          K6_WEB_DASHBOARD_PERIOD: '1s',
          K6_WEB_DASHBOARD_EXPORT: dashboardPath,
          K6_NO_USAGE_REPORT: 'true',
        },
        timeout: 60_000,
      },
    );
    const runtimeDurationSeconds = (Date.now() - startedAt) / 1000;
    const k6Summary = JSON.parse(await readFile(k6SummaryPath, 'utf8'));
    assert.deepEqual(calls, ['admit', 'replay', 'conflict', 'poll']);
    assert.deepEqual(statuses, [202, 200, 409, 200]);
    assert.equal(k6Summary.case_id, 'PERF-04');
    assert.equal(k6Summary.profile, 'fixture');
    assert.equal(k6Summary.execution_kind, 'SYNTHETIC_LOOPBACK_CONTRACT_CHECK');
    assert.equal(k6Summary.evidence_level, 'L0_SYNTHETIC_LOOPBACK_FIXTURE');
    assert.equal(k6Summary.certification_status, 'NOT_CERTIFIED');
    assert.equal(k6Summary.is_release_measurement, false);
    assert.deepEqual(k6Summary.validates, [
      'admission_202',
      'idempotent_replay_200',
      'idempotency_conflict_409',
      'terminal_status_polling',
    ]);
    assert.deepEqual(k6Summary.does_not_certify, [
      'release_throughput',
      'release_p95_latency',
      'performance_certification',
    ]);
    assert.equal(k6Summary.thresholds_coordination.owner, 'Vera');
    assert.equal(k6Summary.thresholds_coordination.status, 'SIN_UMBRAL_APROBADO');

    for (const name of [
      'intents',
      'admitted',
      'replays',
      'expected_conflicts',
      'terminal',
    ]) {
      assert.equal(k6Summary.contract_counters['perf04_' + name], 1);
    }
    assert.equal(k6Summary.contract_counters.perf04_server_errors, 0);
    assert.equal(k6Summary.contract_counters.perf04_unexpected_rate, 0);

    assert.equal(k6Summary.synthetic_timings_ms.scope,
      'synthetic_loopback_only_not_release_p95_or_throughput',
    );
    for (const name of ['admission_202_ms', 'time_to_completed_ms']) {
      const timing = k6Summary.synthetic_timings_ms['perf04_' + name];
      assert.equal(timing.count, 1);
      assert.ok(Number.isFinite(timing.p95));
    }
    assert.ok(
      k6Summary.synthetic_timings_ms.perf04_time_to_completed_ms.p95 >= 2000,
    );

    const k6OutputText = (k6Output.stdout + '\n' + k6Output.stderr)
      .replaceAll(testToken, '<redacted>')
      .replaceAll('http://127.0.0.1:' + server.address().port, '<loopback>');
    assert.ok(!k6OutputText.includes(testToken));
    await writeFile(outputPath, k6OutputText, 'utf8');
    const report = {
      schema_version: 1,
      case_id: 'PERF-04',
      profile: 'fixture-single-intent',
      status: 'PASS',
      certification_status: 'NOT_CERTIFIED',
      scope: 'L0_SYNTHETIC_LOOPBACK_FIXTURE',
      execution_kind: 'SYNTHETIC_LOOPBACK_CONTRACT_CHECK',
      dependency_scope: { service: 'HTTP fixture', persistence: 'none', outbox_reconciliation: 'not_exercised' },
      backend_sha: backendSha,
      dataset_sha256: createHash('sha256').update(datasetBytes).digest('hex'),
      virtual_users: 1,
      duration_seconds: runtimeDurationSeconds,
      max_duration_seconds: 45,
      max_requests: 17,
      max_rps: 2,
      requests_offered: statuses.length,
      requests_per_second: statuses.length / runtimeDurationSeconds,
      http_status_counts: { '200': 2, '202': 1, '409': 1 },
      unexpected_errors: k6Summary.contract_counters.perf04_server_errors,
      latency_ms: k6Summary.raw_k6_http_request_duration_ms,
      admission_ms: k6Summary.synthetic_timings_ms.perf04_admission_202_ms,
      time_to_terminal_ms: k6Summary.synthetic_timings_ms.perf04_time_to_completed_ms,
      scenario_results: k6Summary.contract_counters,
      is_release_measurement: false,
      exact_command: 'node --test apps/promotions-svc/test/performance/coupon-admission.k6.test.mjs',
      k6_summary: k6Summary,
    };
    const summaryPath = join(evidenceDirectory, 'summary.json');
    const summaryBytes = JSON.stringify(report, null, 2) + '\n';
    assert.ok(!summaryBytes.includes(testToken));
    assert.ok(!summaryBytes.includes('http://127.0.0.1:'));
    await writeFile(summaryPath, summaryBytes, 'utf8');
    const artifactPaths = [summaryPath, k6SummaryPath, dashboardPath, outputPath];
    for (const path of artifactPaths) assert.ok((await readFile(path)).length > 0);
    const artifacts = await Promise.all(artifactPaths.map(async (path) => {
      const bytes = await readFile(path);
      return {
        file: path.slice(evidenceDirectory.length + 1),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }));
    const index = {
      schema_version: 1,
      profile: report.profile,
      status: report.status,
      artifacts,
    };
    const indexPath = join(evidenceDirectory, 'evidence-index.json');
    const indexBytes = JSON.stringify(index, null, 2) + '\n';
    await writeFile(indexPath, indexBytes, 'utf8');
    const indexHash = createHash('sha256').update(indexBytes).digest('hex');
    await writeFile(join(evidenceDirectory, 'evidence-index.sha256'), `${indexHash}  evidence-index.json\n`, 'ascii');
    assert.equal(indexHash, createHash('sha256').update(await readFile(indexPath)).digest('hex'));
    process.stdout.write(`PERF04_FIXTURE_EVIDENCE=${evidenceDirectory}\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
