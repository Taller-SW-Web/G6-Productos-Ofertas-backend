import http from 'k6/http';
import crypto from 'k6/crypto';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const admitted = new Counter('bulk_post_admitted');
const terminal = new Counter('bulk_terminal_completed');
const failedRows = new Counter('bulk_failed_rows');
const expectedBurst429 = new Counter('bulk_expected_burst_429');
const expectedQuota403 = new Counter('bulk_expected_quota_403');
const ambiguous = new Counter('bulk_ambiguous_admission');
const unexpected = new Rate('bulk_unexpected_errors');
const postLatency = new Trend('bulk_post_admission_ms', true);
const terminalLatency = new Trend('bulk_terminal_duration_ms', true);
const rowsPerSecond = new Trend('bulk_rows_per_second', true);

function stageFor(profile) {
  if (profile === '1vu-60s') return [{ duration: '60s', target: 1 }];
  if (profile === '5vu-3m') return [{ duration: '3m', target: 5 }];
  if (profile === '20vu-5m') return [{ duration: '5m', target: 20 }];
  throw new Error('H5_PERF_PROFILE must be 1vu-60s, 5vu-3m, or 20vu-5m');
}
const validUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? '');

export const options = {
  stages: stageFor(__ENV.H5_PERF_PROFILE),
  thresholds: {},
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};
const datasetTemplate = open(__ENV.H5_DATASET_PATH);

export function setup() {
  const url = __ENV.H5_BULK_API_URL;
  const token = __ENV.H5_BULK_BEARER;
  const runId = __ENV.H5_RUN_ID;
  const allow = (__ENV.H5_DESTINATION_ALLOWLIST ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (__ENV.H5_LIVE_APPROVED !== 'true' || __ENV.H5_LOAD_APPROVED !== 'true' || __ENV.H5_TEST_IDENTITY !== 'true' || __ENV.H5_DISCARDABLE_DATASET !== 'true' || __ENV.H5_DATASET_RESTORED !== 'true') throw new Error('Blocked: approval, load/cost approval, test identity, discardable target and restored dataset are required');
  if (!url || !token || !validUuid(runId)) throw new Error('Blocked: URL, bearer and UUID H5_RUN_ID are required');
  const target = new URL(url);
  if (target.username || target.password || target.search || target.hash) throw new Error('Blocked: destination URL cannot contain credentials, query or fragment');
  if (target.protocol !== 'https:' || !allow.some((entry) => entry === target.origin)) throw new Error('Blocked: exact HTTPS origin is not allowlisted');
  if (!__ENV.H5_DATASET_PATH || !__ENV.H5_DATASET_SHA256 || !/^[a-f0-9]{64}$/.test(__ENV.H5_DATASET_SHA256)) throw new Error('Blocked: dataset path and verified SHA-256 are required');
  if (crypto.sha256(datasetTemplate, 'hex') !== __ENV.H5_DATASET_SHA256) throw new Error('Blocked: dataset bytes do not match declared SHA-256');
  if (!datasetTemplate.includes('{{VU0000}}') && __ENV.H5_DATASET_REPEAT_SAFE !== 'true') throw new Error('Blocked: repeated imports require unique VU/iteration placeholders or an explicitly safe pre-existing dataset');
  return { runId, datasetSha256: __ENV.H5_DATASET_SHA256, startedAt: new Date().toISOString() };
}

function deterministicUuid(seed) {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) state = Math.imul(state ^ seed.charCodeAt(index), 16777619) >>> 0;
  let hex = '';
  for (let index = 0; index < 32; index += 1) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; hex += (state >>> 0).toString(16).padStart(8, '0'); }
  hex = hex.slice(0, 32).split(''); hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16); hex = hex.join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export default function (data) {
  const start = Date.now();
  const correlationId = deterministicUuid(`${data.runId}:${__VU}:${__ITER}`);
  const csv = datasetTemplate.replaceAll('{{VU0000}}', String(__VU).padStart(6, '0')).replaceAll('{{ITER000000}}', String(__ITER).padStart(10, '0'));
  const file = http.file(csv, 'bulk-h5.csv', 'text/csv');
  const response = http.post(__ENV.H5_BULK_API_URL, { template_version: '2', archivo: file }, { headers: { Authorization: `Bearer ${__ENV.H5_BULK_BEARER}`, 'X-Correlation-Id': correlationId }, tags: { case_id: 'PERF-07', phase: 'admission' }, timeout: __ENV.H5_TIMEOUT ?? '10s' });
  postLatency.add(response.timings.duration);
  const accepted = response.status === 202;
  admitted.add(accepted ? 1 : 0);
  let snapshot = null;
  if (accepted) {
    const body = response.json();
    const admissionContract = body?.status === 'QUEUED' && body?.correlation_id === correlationId && typeof body?.batch_id === 'string';
    check(body, { '202 admission body matches contract': () => admissionContract });
    let pollUrl = `${__ENV.H5_BULK_API_URL.replace(/\/$/, '')}/${body.batch_id}`;
    const deadline = Date.now() + Number(__ENV.H5_POLL_TIMEOUT_MS ?? 120000);
    do {
      const poll = http.get(pollUrl, { headers: { Authorization: `Bearer ${__ENV.H5_BULK_BEARER}`, 'X-Correlation-Id': correlationId }, tags: { case_id: 'PERF-07', phase: 'polling' } });
      if (poll.status !== 200) { unexpected.add(1); break; }
      snapshot = poll.json();
      if (['COMPLETED', 'FAILED', 'PARTIAL'].includes(snapshot?.status)) break;
      sleep(0.5);
    } while (Date.now() < deadline);
    const ended = ['COMPLETED', 'FAILED', 'PARTIAL'].includes(snapshot?.status);
    if (ended) {
      const elapsed = Date.now() - start;
      const rowCount = Number(snapshot.total_rows ?? 0);
      const errors = Number(snapshot.failed_rows ?? 0);
      terminalLatency.add(elapsed);
      failedRows.add(errors);
      rowsPerSecond.add(elapsed > 0 ? rowCount * 1000 / elapsed : NaN);
      terminal.add(snapshot.status === 'COMPLETED' ? 1 : 0);
      unexpected.add(snapshot.status === 'COMPLETED' && errors === 0 ? 0 : 1);
    } else unexpected.add(1);
  } else if (response.status === 0) {
    ambiguous.add(1);
    if (__ENV.BULK_CORRELATION_RECONCILIATION_ENABLED === 'true') {
      const lookupUrl = `${__ENV.H5_BULK_API_URL.replace(/\/importaciones\/?$/, '')}/importaciones/por-correlacion/${correlationId}`;
      const lookup = http.get(lookupUrl, { headers: { Authorization: `Bearer ${__ENV.H5_BULK_BEARER}`, 'X-Correlation-Id': correlationId }, tags: { case_id: 'PERF-07', phase: 'ambiguous-reconciliation' } });
      check(lookup, { 'ambiguous POST reconciled without resubmission': (res) => [200, 404].includes(res.status) });
    }
    unexpected.add(1);
  } else if (response.status === 429) {
    expectedBurst429.add(1); unexpected.add(__ENV.H5_RATE_LIMIT_EXPECTED === 'true' ? 0 : 1);
  } else if (response.status === 403) {
    expectedQuota403.add(1); unexpected.add(__ENV.H5_RATE_LIMIT_EXPECTED === 'true' ? 0 : 1);
  } else unexpected.add(1);
  check(response, { 'POST admitted with 202': (res) => res.status === 202 });
  // Intentionally no POST retry after timeout: only correlation reconciliation is allowed.
}

export function handleSummary(data) {
  const safe = { schema: 'h5-perf07-result/v1', execution_result: 'NOT_CERTIFIED', evidence_level: 'L1_REQUIRES_REVIEW', profile: __ENV.H5_PERF_PROFILE, dataset_sha256: __ENV.H5_DATASET_SHA256, run_id: __ENV.H5_RUN_ID, summary: data.metrics, notes: ['202 is admission, not completion', 'CPU/RAM require runner and service telemetry attachments', 'No credential values are included', 'POSTs are never automatically retried'] };
  return __ENV.H5_SUMMARY_PATH ? { [__ENV.H5_SUMMARY_PATH]: JSON.stringify(safe, null, 2) } : { stdout: JSON.stringify(safe) };
}
