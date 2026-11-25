#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { assertLiveAllowed, request, redactUrl } from './common.mjs';

if (process.argv.includes('--fixture')) {
  const counts = new Map();
  const server = createServer((incoming, response) => {
    const key = `${incoming.url}:${incoming.headers.authorization ?? 'anonymous'}`;
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
    const isQuota = incoming.url === '/quota';
    const limited = count > (isQuota ? 5 : 3);
    response.setHeader('Retry-After', '1'); response.writeHead(limited ? (isQuota ? 403 : 429) : 200).end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const rows = [];
    for (const [path, limit] of [['/burst', 8], ['/quota', 8]]) {
      for (const identity of ['fixture-a', 'fixture-b']) {
        const count = identity === 'fixture-a' ? limit : 2;
        for (let index = 0; index < count; index += 1) {
          const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${identity}`, 'X-Correlation-Id': randomUUID() }, redirect: 'manual' });
          rows.push({ scenario: path === '/burst' ? 'RL-01-burst' : 'RL-02-quota-window', identity, status: response.status, retry_after: response.headers.get('retry-after') });
        }
      }
    }
    process.stdout.write(`${JSON.stringify({ schema: 'h5-rate-fixture-result/v1', execution_result: 'PASS_FIXTURE_ONLY', evidence_level: 'L1_FIXTURE', rows, isolated_identity_counts: true, upstream_side_effects: false, apim_claim: false, note: 'Synthetic in-process proxy returns burst 429 and quota 403; this does not model Azure SKU semantics.' }, null, 2)}\n`);
  } finally { server.close(); }
  process.exit(0);
}

const live = process.argv.includes('--run');
if (!live) {
  process.stdout.write(`${JSON.stringify({ schema: 'h5-rate-harness/v1', execution_result: 'NOT_RUN_REAL_APIM', implementation_state: 'DONE_LOCAL', scenarios: ['RL-01 burst (429)', 'RL-02 cumulative windows (429 burst and 403 quota kept separate)', 'RL-04 two authenticated identities'], gates: ['H5_LIVE_APPROVED=true', 'H5_TEST_IDENTITY=true', 'H5_DESTINATION_ALLOWLIST', 'two G7 test JWT envs', 'upstream telemetry evidence'] })}\n`);
  process.exit(0);
}
const endpoint = process.env.APIM_EDGE_URL;
if (!endpoint) throw new Error('APIM_EDGE_URL is required');
const base = assertLiveAllowed(endpoint, 'APIM_EDGE_URL');
if (process.env.H5_UPSTREAM_TELEMETRY_APPROVED !== 'true') throw new Error('BLOCKED_TELEMETRY: rejected-request upstream telemetry is not available');
if (process.env.H5_LOAD_APPROVED !== 'true') throw new Error('BLOCKED_LOAD_APPROVAL: request-rate/cost approval is required');
const route = process.env.H5_RATE_ROUTE;
if (!route?.startsWith('/')) throw new Error('H5_RATE_ROUTE must be a contractual relative route');
const identities = [process.env.H5_RATE_JWT_A, process.env.H5_RATE_JWT_B];
if (identities.some((x) => !x)) throw new Error('BLOCKED_IDENTITY: two authorized test identity tokens are required');
const offered = Number(process.env.H5_RATE_REQUESTS ?? 40);
const burstSize = Number(process.env.H5_RATE_BURST_SIZE ?? 10);
if (!Number.isInteger(offered) || offered < 2 || offered > 500 || !Number.isInteger(burstSize) || burstSize < 1 || burstSize > offered) throw new Error('Rate profile out of safe bounds (2..500 offered)');
const results = [];
const requests = Array.from({ length: offered }, (_, index) => ({ identity: index < burstSize ? 0 : 1 }));
const batchSize = Math.min(burstSize, offered);
for (let offset = 0; offset < requests.length; offset += batchSize) {
  const batch = requests.slice(offset, offset + batchSize);
  const batchResults = await Promise.all(batch.map(async ({ identity }) => {
    const url = new URL(route, base);
    const response = await request(url, { method: 'GET', headers: { Authorization: `Bearer ${identities[identity]}`, 'X-Correlation-Id': randomUUID() } });
    const result = { identity: identity === 0 ? 'test-a' : 'test-b', status: response.status, retry_after: response.headers.get('retry-after'), correlation_id: response.headers.get('x-correlation-id') };
    await response.body?.cancel(); return result;
  }));
  results.push(...batchResults);
  if (offset + batchSize < requests.length) await new Promise((done) => setTimeout(done, Number(process.env.H5_RATE_INTER_BATCH_MS ?? 1000)));
}
const summary = {
  schema: 'h5-rate-harness-result/v1', execution_result: 'INCONCLUSIVE', destination: redactUrl(base.href), offered: results.length,
  accepted_2xx: results.filter((x) => x.status >= 200 && x.status < 300).length,
  burst_429: results.filter((x) => x.status === 429).length,
  quota_403: results.filter((x) => x.status === 403).length,
  other_status: results.filter((x) => !((x.status >= 200 && x.status < 300) || x.status === 429 || x.status === 403)).length,
  by_identity: Object.fromEntries(['test-a','test-b'].map((name) => [name, results.filter((x) => x.identity === name).length])),
  upstream_rejected_count_verified: false, expected_statuses: [200, 401, 403, 404, 429], results,
  note: 'Harness counts outcomes; policy guarantees, distinct identity keys and upstream non-invocation require reviewed APIM configuration and correlated telemetry.'
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
