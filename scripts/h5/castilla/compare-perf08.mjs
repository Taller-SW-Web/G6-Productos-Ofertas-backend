#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { assertLiveAllowed, request, redactUrl } from './common.mjs';

const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map((p) => [
    `p${p}_ms`, Number((sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p / 100) - 1)] ?? NaN).toFixed(2)),
  ]));
};
const quantile = (values) => percentiles(values);
if (process.argv.includes('--fixture')) {
  const fixtureServers = [8, 2].map((delay, index) => createServer((incoming, response) => setTimeout(() => {
    const edge = index === 0;
    const status = incoming.url === '/rate-limit' ? (edge ? 429 : 200) : incoming.url === '/status-diff' ? (edge ? 500 : 200) : 200;
    if (status === 429) response.setHeader('Retry-After', '1');
    response.writeHead(status).end('fixture');
  }, delay)));
  const addresses = [];
  try {
    for (const server of fixtureServers) {
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      addresses.push(`http://127.0.0.1:${server.address().port}/`);
    }
    const results = {};
    for (const [path, scenario] of [['/normal', 'latency'], ['/rate-limit', '429-detection'], ['/status-diff', 'status-difference']]) {
      const pair = {};
      for (const [name, address] of [['edge-fixture', addresses[0]], ['control-fixture', addresses[1]]]) {
      const durations = [];
      for (let index = 0; index < 20; index += 1) {
        const started = performance.now(); const response = await fetch(`${address}${path}`, { redirect: 'manual' });
        durations.push({ elapsed: performance.now() - started, status: response.status, retry_after: response.headers.get('retry-after') }); await response.arrayBuffer();
      }
      pair[name] = { ...quantile(durations.map((x) => x.elapsed)), requests: durations.length, statuses: Object.fromEntries([...new Set(durations.map((x) => x.status))].map((status) => [status, durations.filter((x) => x.status === status).length])), retry_after_observed: durations.some((x) => Boolean(x.retry_after)) };
      }
      results[scenario] = pair;
    }
    process.stdout.write(`${JSON.stringify({ schema: 'h5-perf08-fixture-result/v1', execution_result: 'PASS_FIXTURE_ONLY', evidence_level: 'L1_FIXTURE', targets: ['127.0.0.1', '127.0.0.1'], results, detects_latency_shift: results.latency['edge-fixture'].p50_ms > results.latency['control-fixture'].p50_ms, detects_429: results['429-detection']['edge-fixture'].statuses['429'] === 20, detects_status_change: results['status-difference']['edge-fixture'].statuses['500'] === 20, apim_overhead_claim: false, note: 'Two equivalent temporary local HTTP servers validate comparison mechanics only.' }, null, 2)}\n`);
  } finally { for (const server of fixtureServers) server.close(); }
  process.exit(0);
}
if (!process.argv.includes('--run')) {
  process.stdout.write(`${JSON.stringify({ schema: 'h5-perf08/v1', execution_result: 'NOT_RUN_REAL_APIM', implementation_state: 'DONE_LOCAL', profiles: [{ vus: 1, seconds: 60 }, { vus: 5, seconds: 180 }, { vus: 20, seconds: 300 }], repetitions: 3, comparison: 'paired edge/control; no APIM claim from local fixtures', required: ['H5_PERF08_CONFIG', 'APIM_EDGE_URL', 'PRIVATE_CONTROL_URL', 'H5_LIVE_APPROVED=true', 'H5_LOAD_APPROVED=true', 'H5_PRIVATE_CONTROL_AUTHORIZED=true', 'H5_TEST_IDENTITY=true'] })}\n`);
  process.exit(0);
}
const configPath = resolve(process.env.H5_PERF08_CONFIG ?? '');
if (process.env.H5_LOAD_APPROVED !== 'true') throw new Error('BLOCKED_LOAD_APPROVAL: performance load/cost approval is required');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const edge = assertLiveAllowed(process.env.APIM_EDGE_URL ?? '', 'APIM_EDGE_URL');
const control = assertLiveAllowed(process.env.PRIVATE_CONTROL_URL ?? '', 'PRIVATE_CONTROL_URL');
const requiredKeys = ['backend_sha', 'image_digest', 'docs_sha', 'apim_revision', 'policy_sha256', 'region', 'dataset_sha256', 'route', 'identity_profile', 'same_service_config'];
if (requiredKeys.some((key) => typeof config[key] !== 'string' || !config[key])) throw new Error(`BLOCKED_COMPARABILITY: required metadata missing (${requiredKeys.join(', ')})`);
if (config.same_service_config !== 'verified' || config.apim_revision === 'mock' || config.backend_sha.length !== 40 || !/^[a-f0-9]{64}$/.test(config.dataset_sha256) || !/^[a-f0-9]{64}$/.test(config.policy_sha256)) throw new Error('BLOCKED_COMPARABILITY: environment cannot support an APIM comparison');
if (!config.route.startsWith('/') || config.method !== 'GET') throw new Error('Only a reviewed contractual GET route is accepted by this measurement client');
const token = process.env[config.identity_env];
if (!token) throw new Error('BLOCKED_IDENTITY: test identity token not supplied');
const targets = [{ name: 'edge', base: edge }, { name: 'control', base: control }];
const profiles = [{ vus: 1, seconds: 60 }, { vus: 5, seconds: 180 }, { vus: 20, seconds: 300 }];
const measurements = [];
async function sample(target, vus, seconds) {
  const durations = []; const statuses = [];
  const deadline = performance.now() + seconds * 1000;
  let next = 0;
  const workers = Array.from({ length: vus }, async () => {
    while (performance.now() < deadline) {
      const index = next++;
      const start = performance.now();
      const response = await request(new URL(config.route, target.base), { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': `perf08-${target.name}-${vus}-${index}` } });
      durations.push(performance.now() - start); statuses.push(response.status); await response.body?.cancel();
    }
  });
  const started = performance.now(); await Promise.all(workers); const elapsedSeconds = (performance.now() - started) / 1000;
  return { ...quantile(durations), requests: next, rps: Number((next / elapsedSeconds).toFixed(3)), elapsed_seconds: Number(elapsedSeconds.toFixed(2)), status_counts: Object.fromEntries([...new Set(statuses)].map((status) => [status, statuses.filter((x) => x === status).length])), errors: statuses.filter((x) => x >= 500).length, latency_samples: durations.length };
}
for (const profile of profiles) {
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const pair = {};
    for (const target of targets) {
      const warmup = await sample(target, profile.vus, 5);
      const measured = await sample(target, profile.vus, profile.seconds);
      pair[target.name] = { warmup, measured };
    }
    measurements.push({ profile, repetition, pair });
  }
}
const completeTelemetry = config.cpu_ram_telemetry === 'available' && config.gateway_upstream_counts === 'available';
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
const aggregates = profiles.map((profile) => ({ profile, targets: Object.fromEntries(targets.map((target) => {
  const samples = measurements.filter((entry) => entry.profile.vus === profile.vus).map((entry) => entry.pair[target.name].measured);
  return [target.name, { median_p50_ms: median(samples.map((x) => x.p50_ms)), median_p95_ms: median(samples.map((x) => x.p95_ms)), median_p99_ms: median(samples.map((x) => x.p99_ms)), median_rps: median(samples.map((x) => x.rps)), total_429: samples.reduce((sum, x) => sum + Number(x.status_counts[429] ?? 0), 0), total_403: samples.reduce((sum, x) => sum + Number(x.status_counts[403] ?? 0), 0), unexpected_5xx: samples.reduce((sum, x) => sum + x.errors, 0) }];
})) }));
process.stdout.write(`${JSON.stringify({ schema: 'h5-perf08-result/v1', execution_result: 'INCONCLUSIVE', evidence_level: 'L2_REQUIRES_REVIEW', comparison_claim: 'APIM_OVERHEAD_ONLY_IF_ROUTE_AND_ENVIRONMENT_EQUIVALENCE_PROVEN', subjects: { backend_sha: config.backend_sha, image_digest: config.image_digest, docs_sha: config.docs_sha, apim_revision: config.apim_revision, policy_sha256: config.policy_sha256, region: config.region, dataset_sha256: config.dataset_sha256, identity_profile: config.identity_profile }, targets: { edge: redactUrl(edge.href), control: redactUrl(control.href) }, measurements, paired_medians: aggregates, missing: [...(completeTelemetry ? [] : ['CPU/RAM and Gateway upstream telemetry']), ...(config.comparability_evidence_uri ? [] : ['documented control equivalence resource/evidence'])], conclusion: 'INCONCLUSIVE until telemetry, evidence and reviewed release manifest are attached; this harness cannot certify APIM by itself.' }, null, 2)}\n`);
