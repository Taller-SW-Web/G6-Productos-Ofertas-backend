import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRateLimit } from './verify-rate-limit.mjs';

const request = (id) => ({
  request_id: '11111111-1111-4111-8111-00000000000' + id,
});
const fixture = () => ({
  source_sha: 'a'.repeat(40),
  environment: 'synthetic',
  policy_hash: 'not_available',
  complete_capture: true,
  offered: [request(1), request(2)],
  apim: [
    { ...request(1), decision: 'accepted', status: 200 },
    { ...request(2), decision: 'rate_limited', status: 429 },
  ],
  gateway: [request(1)],
  provider: [request(1)],
  direct: [{ ...request(3), result: 'denied' }],
});

test('correlates the accepted control and the blocked groups across both downstream logs', () => {
  const result = verifyRateLimit(fixture());
  assert.equal(result.execution_result, 'PASS');
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

test('equal counts still fail if a rejected ID reached the Gateway', () => {
  const input = fixture();
  input.gateway = [request(2)];
  assert.deepEqual(verifyRateLimit(input).violations, [
    'UNEXPECTED_GATEWAY_ARRIVAL',
  ]);
});

test('detects direct arrival at the provider and successful direct access', () => {
  const input = fixture();
  input.direct[0].result = 'allowed';
  input.provider.push(request(3));
  assert.equal(verifyRateLimit(input).execution_result, 'FAIL');
  assert.deepEqual(verifyRateLimit(input).violations, [
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

test('rejects mismatched 429 and duplicate IDs', () => {
  const input = fixture();
  input.apim[1].status = 403;
  assert.throws(() => verifyRateLimit(input), /INVALID_RATE_LIMIT_STATUS/);
  input.gateway.push(request(1));
  assert.throws(() => verifyRateLimit(input), /INVALID_OR_DUPLICATE_REQUEST/);
});
