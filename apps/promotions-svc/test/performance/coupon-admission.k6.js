import { check, fail, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import execution from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const profiles = { smoke: [1, '60s'], small: [5, '3m'], medium: [20, '5m'] };
const syntheticFixture =
  __ENV.PERF04_PROFILE === 'fixture' && __ENV.PERF04_SYNTHETIC_FIXTURE === '1';
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

export const options = {
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
