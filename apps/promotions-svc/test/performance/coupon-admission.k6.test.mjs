import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const server = createServer(async (req, res) => {
    const reply = (status, body, headers) => {
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
    const summary = join(directory, 'k6-summary.json');
    await writeFile(
      dataset,
      JSON.stringify([
        {
          body: operation,
          conflict_coupon_code: conflictCode,
          expected_terminal: 'COMPLETED',
        },
      ]),
    );
    const scenarioFile = fileURLToPath(
      new URL('./coupon-admission.k6.js', import.meta.url),
    );
    await execute(
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
          PERF04_SUMMARY_PATH: summary,
        },
        timeout: 60_000,
      },
    );
    assert.deepEqual(calls, ['admit', 'replay', 'conflict', 'poll']);
    const report = JSON.parse(await readFile(summary, 'utf8'));
    assert.equal(report.case_id, 'PERF-04');
    assert.equal(report.profile, 'fixture');
    assert.equal(report.execution_kind, 'SYNTHETIC_LOOPBACK_CONTRACT_CHECK');
    assert.equal(report.evidence_level, 'L0_SYNTHETIC_LOOPBACK_FIXTURE');
    assert.equal(report.certification_status, 'NOT_CERTIFIED');
    assert.equal(report.is_release_measurement, false);
    assert.deepEqual(report.validates, [
      'admission_202',
      'idempotent_replay_200',
      'idempotency_conflict_409',
      'terminal_status_polling',
    ]);
    assert.deepEqual(report.does_not_certify, [
      'release_throughput',
      'release_p95_latency',
      'performance_certification',
    ]);
    assert.equal(report.thresholds_coordination.owner, 'Vera');
    assert.equal(report.thresholds_coordination.status, 'SIN_UMBRAL_APROBADO');

    for (const name of [
      'intents',
      'admitted',
      'replays',
      'expected_conflicts',
      'terminal',
    ]) {
      assert.equal(report.contract_counters['perf04_' + name], 1);
    }
    assert.equal(report.contract_counters.perf04_server_errors, 0);
    assert.equal(report.contract_counters.perf04_unexpected_rate, 0);

    assert.equal(
      report.synthetic_timings_ms.scope,
      'synthetic_loopback_only_not_release_p95_or_throughput',
    );
    for (const name of ['admission_202_ms', 'time_to_completed_ms']) {
      const timing = report.synthetic_timings_ms['perf04_' + name];
      assert.equal(timing.count, 1);
      assert.ok(Number.isFinite(timing.p95));
    }
    assert.ok(
      report.synthetic_timings_ms.perf04_time_to_completed_ms.p95 >= 2000,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
