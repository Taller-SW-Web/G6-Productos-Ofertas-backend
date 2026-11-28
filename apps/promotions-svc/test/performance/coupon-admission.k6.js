// PERF-04 k6 scenario for POST /api/v1/cupones/consumos.
// Loopback fixture mode (PERF04_PROFILE=fixture with PERF04_SYNTHETIC_FIXTURE=1)
// validates ONLY the HTTP contract flow (admission 202, idempotent replay 200,
// idempotency conflict 409, and terminal status polling) against a local double.
// It is NOT release throughput, NOT release p95 latency, and NOT performance certification.
//
// Certification requires measurements against an authorized environment and a
// controlled pre-seeded dataset with PostgreSQL/Outbox reconciliation and N01 scope.
//
// Common runner & thresholds coordination (owner: Vera):
// - Current backend status: SIN_UMBRAL_APROBADO (scripts/performance/summarize-selection.mjs).
// - Integration point for Vera's common k6 runner:
//   env vars PERF04_ORIGIN, PERF04_TEST_TOKEN, PERF04_SYNTHETIC_DATASET,
//   PERF04_PROFILE, PERF04_SUMMARY_PATH; options.thresholds (release p95/RPS
//   thresholds remain deferred to Vera's approval); and handleSummary JSON output.

import { check, fail, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import execution from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const profiles = { smoke: [1, '60s'], small: [5, '3m'], medium: [20, '5m'] };
const syntheticFixture =
  __ENV.PERF04_PROFILE === 'fixture' && __ENV.PERF04_SYNTHETIC_FIXTURE === '1';
if (syntheticFixture && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(__ENV.PERF04_ORIGIN ?? '')) {
  throw new Error('PERF04_SYNTHETIC_FIXTURE_REQUIRES_LOOPBACK');
}
const activeProfile = syntheticFixture
  ? 'fixture'
  : __ENV.PERF04_PROFILE || 'smoke';
const profile = profiles[__ENV.PERF04_PROFILE || 'smoke'];
const base = __ENV.PERF04_ORIGIN;
const token = __ENV.PERF04_TEST_TOKEN;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
if (
  (!profile && !syntheticFixture) ||
  !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(base || '') ||
  !token ||
  !__ENV.PERF04_SYNTHETIC_DATASET
) {
  throw new Error(
    'PERF-04 requires a loopback lab, synthetic test token and pre-seeded synthetic dataset',
  );
}

const intents = new SharedArray('synthetic coupon intents', () => {
  const records = JSON.parse(open(__ENV.PERF04_SYNTHETIC_DATASET));
  if (!Array.isArray(records) || records.length === 0)
    throw new Error('Empty PERF-04 dataset');
  const keys = new Set();
  const orders = new Set();
  for (const { body, conflict_coupon_code, expected_terminal } of records) {
    if (
      !uuid.test(body?.operation_id || '') ||
      !uuid.test(body?.reservation_id || '') ||
      !/^PERF04-[a-zA-Z0-9-]+$/.test(body?.order_id || '') ||
      body.order_id !== body.commercial_snapshot_ref ||
      !conflict_coupon_code ||
      conflict_coupon_code === body.coupon_code ||
      !['COMPLETED', 'REJECTED'].includes(expected_terminal) ||
      keys.has(body.operation_id.toLowerCase()) ||
      orders.has(body.order_id)
    ) {
      throw new Error('Invalid or duplicate PERF-04 intent');
    }
    keys.add(body.operation_id.toLowerCase());
    orders.add(body.order_id);
  }
  return records;
});

// Only contract/integrity gates are defined here. Release latency/throughput
// thresholds remain under Vera's coordination (SIN_UMBRAL_APROBADO).
export const options = {
  ...(syntheticFixture ? { rps: 2 } : {}),
  scenarios: {
    perf04: syntheticFixture
      ? {
          executor: 'shared-iterations',
          vus: 1,
          iterations: 1,
          maxDuration: '45s',
        }
      : {
          executor: 'constant-vus',
          vus: profile[0],
          duration: profile[1],
          gracefulStop: '40s',
        },
  },
  thresholds: {
    perf04_unexpected: ['rate<0.01'],
    perf04_intents: ['count>0'],
    perf04_admitted: ['count>0'],
    perf04_terminal: ['count>0'],
  },
  summaryTrendStats: ['count', 'avg', 'p(50)', 'p(95)', 'p(99)'],
};

const attempted = new Counter('perf04_intents');
const admitted = new Counter('perf04_admitted');
const replayed = new Counter('perf04_replays');
const conflicts = new Counter('perf04_expected_conflicts');
const serverErrors = new Counter('perf04_server_errors');
const terminals = new Counter('perf04_terminal');
const admission = new Trend('perf04_admission_202_ms', true);
const completion = new Trend('perf04_time_to_completed_ms', true);
const unexpected = new Rate('perf04_unexpected');
const commandUrl = base + '/api/v1/cupones/consumos';
const headers = {
  Authorization: 'Bearer ' + token,
  'Content-Type': 'application/json',
};

function readSnapshot(response, body) {
  try {
    const payload = response.json();
    if (
      payload?.operation_id === body.operation_id &&
      payload?.order_id === body.order_id
    )
      return payload;
  } catch {
    return null;
  }
  return null;
}

function post(body, expected, phase) {
  const response = http.post(commandUrl, JSON.stringify(body), {
    headers: { ...headers, 'Idempotency-Key': body.operation_id },
    tags: { name: 'POST /api/v1/cupones/consumos', phase },
    redirects: 0,
    timeout: '8s',
    responseCallback: http.expectedStatuses(expected),
  });
  if (response.status >= 500) serverErrors.add(1, { phase });
  return response;
}

function runIntent(intent) {
  const { body } = intent;
  const start = Date.now();
  const readPath =
    '/api/v1/cupones/operaciones/' +
    body.operation_id +
    '?order_id=' +
    encodeURIComponent(body.order_id);
  const first = post(body, 202, 'admission');
  if (
    first.status !== 202 ||
    readSnapshot(first, body)?.status !== 'ACCEPTED' ||
    first.headers['Location'] !== readPath ||
    first.headers['Retry-After'] !== '2'
  )
    return false;
  admitted.add(1);
  admission.add(first.timings.duration);

  const replay = post(body, 200, 'replay');
  if (replay.status !== 200 || !readSnapshot(replay, body)) return false;
  replayed.add(1);

  const conflict = post(
    { ...body, coupon_code: intent.conflict_coupon_code },
    409,
    'conflict',
  );
  try {
    if (
      conflict.status !== 409 ||
      conflict.json('code') !== 'IDEMPOTENCY_CONFLICT'
    )
      return false;
  } catch {
    return false;
  }
  conflicts.add(1);

  const deadline = start + 30_000;
  while (Date.now() + 2_000 < deadline) {
    sleep(2);
    const observation = http.get(base + readPath, {
      headers,
      redirects: 0,
      timeout: Math.min(8_000, deadline - Date.now()),
      tags: {
        name: 'GET /api/v1/cupones/operaciones/{operationId}',
        phase: 'polling',
      },
    });
    if (observation.status >= 500) serverErrors.add(1, { phase: 'polling' });
    const snapshot = readSnapshot(observation, body);
    if (observation.status !== 200 || !snapshot) return false;
    if (['COMPLETED', 'REJECTED'].includes(snapshot.status)) {
      terminals.add(1, { outcome: snapshot.status });
      if (snapshot.status === 'COMPLETED') completion.add(Date.now() - start);
      return snapshot.status === intent.expected_terminal;
    }
    if (!['ACCEPTED', 'PROCESSING'].includes(snapshot.status)) return false;
  }
  return false;
}

export default function () {
  const intent = intents[execution.scenario.iterationInTest];
  if (!intent) {
    unexpected.add(true);
    fail('PERF-04 dataset exhausted');
  }
  attempted.add(1);
  const ok = runIntent(intent);
  unexpected.add(!ok);
  check(ok, {
    'admission, replay, conflict and terminal match contract': (value) => value,
  });
}

function trendValues(metric) {
  const values = metric?.values ?? {};
  return {
    count: values.count ?? 0,
    avg: values.avg ?? null,
    p50: values['p(50)'] ?? null,
    p95: values['p(95)'] ?? null,
    p99: values['p(99)'] ?? null,
  };
}

export function handleSummary(data) {
  const metrics = data?.metrics ?? {};
  const report = {
    schema_version: 1,
    case_id: 'PERF-04',
    profile: activeProfile,
    execution_kind: syntheticFixture
      ? 'SYNTHETIC_LOOPBACK_CONTRACT_CHECK'
      : 'UNADJUDICATED_LOOPBACK_RUN',
    evidence_level: syntheticFixture
      ? 'L0_SYNTHETIC_LOOPBACK_FIXTURE'
      : 'PENDING_COMMON_RUNNER_ADJUDICATION',
    certification_status: 'NOT_CERTIFIED',
    is_release_measurement: false,
    validates: [
      'admission_202',
      'idempotent_replay_200',
      'idempotency_conflict_409',
      'terminal_status_polling',
    ],
    does_not_certify: [
      'release_throughput',
      'release_p95_latency',
      'performance_certification',
    ],
    certification_requirements:
      'Authorized environment, controlled pre-seeded dataset, baseline/candidate repetitions, PostgreSQL/Outbox reconciliation, N01 release scope, and Vera common runner + approved thresholds.',
    thresholds_coordination: {
      owner: 'Vera',
      status: 'SIN_UMBRAL_APROBADO',
      integration_point:
        'apps/promotions-svc/test/performance/coupon-admission.k6.js (env contract, options.thresholds, handleSummary)',
    },
    contract_counters: {
      perf04_intents: metrics.perf04_intents?.values?.count ?? 0,
      perf04_admitted: metrics.perf04_admitted?.values?.count ?? 0,
      perf04_replays: metrics.perf04_replays?.values?.count ?? 0,
      perf04_expected_conflicts:
        metrics.perf04_expected_conflicts?.values?.count ?? 0,
      perf04_server_errors: metrics.perf04_server_errors?.values?.count ?? 0,
      perf04_terminal: metrics.perf04_terminal?.values?.count ?? 0,
      perf04_unexpected_rate: metrics.perf04_unexpected?.values?.rate ?? 0,
    },
    synthetic_timings_ms: {
      scope: 'synthetic_loopback_only_not_release_p95_or_throughput',
      perf04_admission_202_ms: trendValues(metrics.perf04_admission_202_ms),
      perf04_time_to_completed_ms: trendValues(
        metrics.perf04_time_to_completed_ms,
      ),
    },
    raw_k6_http_requests: metrics.http_reqs?.values ?? null,
    raw_k6_http_request_duration_ms: trendValues(metrics.http_req_duration),
    configured_vus: data?.metrics?.vus?.values?.value ?? 1,
    runtime_duration_ms: data?.state?.testRunDurationMs ?? null,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = __ENV.PERF04_SUMMARY_PATH;
  return outputPath
    ? { [outputPath]: serialized, stdout: serialized }
    : { stdout: serialized };
}
