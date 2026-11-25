import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRateLimit } from './verify-rate-limit.mjs';

const RUN_ID = 'rl05-run-001';
const utc = (seconds) =>
  new Date(Date.UTC(2026, 10, 25, 18, 0, seconds)).toISOString();

const request = (id, second = 5, runId = RUN_ID) => ({
  request_id: '11111111-1111-4111-8111-00000000000' + id,
  run_id: runId,
  observed_utc: utc(second),
});

const fixture = () => ({
  run_id: RUN_ID,
  start_utc: utc(0),
  end_utc: utc(60),
  source_sha: 'a'.repeat(40),
  environment: 'synthetic',
  policy_hash: 'not_available',
  complete_capture: true,
  offered: [request(1, 5), request(2, 6)],
  apim: [
    { ...request(1, 5), decision: 'accepted', status: 200 },
    { ...request(2, 6), decision: 'rate_limited', status: 429 },
  ],
  gateway: [request(1, 5)],
  provider: [request(1, 5)],
  direct: [{ ...request(3, 10), result: 'denied' }],
});

test('correlates the accepted control and the blocked groups across all three layers within the same run and window', () => {
  const result = verifyRateLimit(fixture());
  assert.equal(result.execution_result, 'PASS');
  assert.equal(result.run_id, RUN_ID);
  assert.equal(result.window_ms, 60_000);
  assert.deepEqual(
    [
      result.requests_offered,
      result.apim_accepted,
      result.apim_rejected_429,
      result.gateway_received,
      result.provider_received,
    ],
    [2, 1, 1, 1, 1],
  );
});

test('equal counts still fail if a rejected 429 ID reached the Gateway or provider', () => {
  const gatewayLeak = fixture();
  gatewayLeak.gateway = [request(2, 6)];
  assert.deepEqual(verifyRateLimit(gatewayLeak).violations, [
    'UNEXPECTED_GATEWAY_ARRIVAL',
  ]);

  const providerLeak = fixture();
  providerLeak.provider = [request(2, 6)];
  assert.deepEqual(verifyRateLimit(providerLeak).violations, [
    'UNEXPECTED_PROVIDER_ARRIVAL',
  ]);
});

test('detects direct arrival at the provider and successful direct access', () => {
  const input = fixture();
  input.direct[0].result = 'allowed';
  input.provider.push(request(3, 10));
  const report = verifyRateLimit(input);
  assert.equal(report.execution_result, 'FAIL');
  assert.deepEqual(report.violations, [
    'UNEXPECTED_PROVIDER_ARRIVAL',
    'DIRECT_ACCESS_ALLOWED',
  ]);
});

test('incomplete capture or missing positive controls is inconclusive', () => {
  const input = fixture();
  input.complete_capture = false;
  input.provider = [];
  input.environment = 'azure';
  const report = verifyRateLimit(input);
  assert.equal(report.execution_result, 'INCONCLUSIVE');
  assert.deepEqual(report.missing, [
    'UNCONFIRMED_TELEMETRY_COMPLETENESS',
    'MISSING_POLICY_HASH',
    'INCOMPLETE_REQUEST_CORRELATION',
  ]);
});

test('rejects traces from a different run_id across APIM, Gateway and provider', () => {
  for (const layer of ['offered', 'apim', 'gateway', 'provider', 'direct']) {
    const input = fixture();
    input[layer][0].run_id = 'rl05-other-run';
    assert.throws(() => verifyRateLimit(input), /RUN_ID_MISMATCH/);
  }
});

test('rejects traces with timestamps outside the explicit observation window', () => {
  for (const layer of ['offered', 'apim', 'gateway', 'provider', 'direct']) {
    const before = fixture();
    before[layer][0].observed_utc = utc(-1);
    assert.throws(() => verifyRateLimit(before), /TIMESTAMP_OUTSIDE_WINDOW/);

    const after = fixture();
    after[layer][0].observed_utc = utc(61);
    assert.throws(() => verifyRateLimit(after), /TIMESTAMP_OUTSIDE_WINDOW/);
  }
});

test('rejects missing or invalid run, window or trace metadata', () => {
  const missingRunId = fixture();
  delete missingRunId.run_id;
  assert.throws(() => verifyRateLimit(missingRunId), /INVALID_RUN_METADATA/);

  const invalidRunId = fixture();
  invalidRunId.run_id = 'bad run id!';
  assert.throws(() => verifyRateLimit(invalidRunId), /INVALID_RUN_METADATA/);

  const missingWindowStart = fixture();
  delete missingWindowStart.start_utc;
  assert.throws(
    () => verifyRateLimit(missingWindowStart),
    /INVALID_UTC_TIMESTAMP/,
  );

  const nonUtcWindow = fixture();
  nonUtcWindow.end_utc = '2026-11-25T18:01:00-05:00';
  assert.throws(() => verifyRateLimit(nonUtcWindow), /INVALID_UTC_TIMESTAMP/);

  const invertedWindow = fixture();
  invertedWindow.end_utc = invertedWindow.start_utc;
  assert.throws(
    () => verifyRateLimit(invertedWindow),
    /INVALID_OBSERVATION_WINDOW/,
  );

  const missingTraceRunId = fixture();
  delete missingTraceRunId.gateway[0].run_id;
  assert.throws(
    () => verifyRateLimit(missingTraceRunId),
    /INVALID_TRACE_METADATA/,
  );

  const missingTraceTimestamp = fixture();
  delete missingTraceTimestamp.provider[0].observed_utc;
  assert.throws(
    () => verifyRateLimit(missingTraceTimestamp),
    /INVALID_UTC_TIMESTAMP/,
  );
});

test('rejects mismatched 429 and duplicate IDs', () => {
  const input = fixture();
  input.apim[1].status = 403;
  assert.throws(() => verifyRateLimit(input), /INVALID_RATE_LIMIT_STATUS/);
  input.gateway.push(request(1, 5));
  assert.throws(() => verifyRateLimit(input), /INVALID_OR_DUPLICATE_REQUEST/);
});
