#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { assertLiveAllowed, request, redactUrl } from './common.mjs';

const args = new Set(process.argv.slice(2));
if (args.has('--dry-run') || !args.has('--run')) {
  process.stdout.write(`${JSON.stringify({ schema: 'h5-http-harness/v1', execution_result: 'NOT_RUN', implementation_state: 'DONE_LOCAL', message: 'Dry run; no requests sent', required: ['H5_LIVE_APPROVED=true', 'H5_TEST_IDENTITY=true', 'H5_DESTINATION_ALLOWLIST', 'APIM_EDGE_URL', 'H5_INT07_SCENARIOS_JSON'] })}\n`);
  process.exit(0);
}
const target = process.env.APIM_EDGE_URL;
if (!target) throw new Error('APIM_EDGE_URL is required');
const scenarioFile = resolve(process.env.H5_INT07_SCENARIOS_JSON ?? '');
const scenarios = JSON.parse(readFileSync(scenarioFile, 'utf8'));
if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.length > 40) throw new Error('Scenario file must contain 1..40 cases');
const results = [];
for (const scenario of scenarios) {
  if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(scenario.method)) throw new Error('Invalid scenario method');
  const path = process.env[scenario.path_env];
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`BLOCKED_CONTRACT: ${scenario.path_env} must be a contractual relative route`);
  if (scenario.mutating === true && process.env.H5_DISCARDABLE_DATASET !== 'true') throw new Error('BLOCKED_DATASET: mutating scenario needs discardable dataset');
  const token = scenario.identity_env ? process.env[scenario.identity_env] : undefined;
  if (scenario.identity_env && !token) throw new Error(`BLOCKED_IDENTITY: ${scenario.identity_env} not supplied`);
  const targetEnv = scenario.target_env ?? 'APIM_EDGE_URL';
  const targetUrl = process.env[targetEnv];
  if (!targetUrl) throw new Error(`BLOCKED_TARGET: ${targetEnv} not supplied`);
  const base = assertLiveAllowed(targetUrl, targetEnv);
  const origin = scenario.origin_env ? process.env[scenario.origin_env] : undefined;
  if (scenario.origin_env && !origin) throw new Error(`BLOCKED_CORS_ORIGIN: ${scenario.origin_env} not supplied`);
  let body;
  if (scenario.body_env) {
    if (process.env.H5_DISCARDABLE_DATASET !== 'true') throw new Error('BLOCKED_DATASET: body-bearing scenario requires a disposable dataset');
    const rawBodyPath = process.env[scenario.body_env];
    if (!rawBodyPath || isAbsolute(rawBodyPath) || rawBodyPath.split(/[\\/]/).includes('..')) throw new Error(`BLOCKED_BODY_PATH: ${scenario.body_env} must be a relative path without traversal`);
    const resolvedBody = realpathSync(resolve(process.cwd(), rawBodyPath));
    const bodyRelative = relative(realpathSync(process.cwd()), resolvedBody);
    if (bodyRelative === '..' || bodyRelative.startsWith(`..${sep}`) || isAbsolute(bodyRelative)) throw new Error('BLOCKED_BODY_PATH: resolved body escaped the current workspace');
    const stat = lstatSync(resolvedBody);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('BLOCKED_BODY_FILE: scenario body must be a regular file up to 1 MiB');
    body = readFileSync(resolvedBody);
  }
  const idempotencyKey = scenario.idempotency_key_env ? process.env[scenario.idempotency_key_env] : undefined;
  if (scenario.idempotency_key_env && !idempotencyKey) throw new Error(`BLOCKED_IDEMPOTENCY_KEY: ${scenario.idempotency_key_env} not supplied`);
  const correlationId = randomUUID();
  const headers = { 'X-Correlation-Id': correlationId, ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(body ? { 'Content-Type': scenario.content_type ?? 'application/json' } : {}) };
  if (scenario.headers && Object.keys(scenario.headers).some((key) => /authorization|cookie|host/i.test(key))) throw new Error('Scenario headers cannot override sensitive routing/auth headers');
  const url = new URL(path, base);
  let response;
  try { response = await request(url, { method: scenario.method, headers, ...(body ? { body } : {}) }); }
  catch (error) {
    results.push({ case_id: scenario.case_id, expected_status: scenario.expected_status, observed: { status: null, transport_denied: true, error_name: error?.name ?? 'NetworkError' }, passed: scenario.expected_network_denied === true, request_uri: redactUrl(url.href) });
    continue;
  }
  const allowOrigin = response.headers.get('access-control-allow-origin');
  const corsPass = scenario.cors === 'must_reflect_origin' ? allowOrigin === origin : scenario.cors === 'must_not_reflect_origin' ? allowOrigin !== origin : true;
  const locationPresent = response.headers.has('location');
  const retryAfter = response.headers.get('retry-after');
  const correlationMatches = response.headers.get('x-correlation-id') === correlationId;
  const headersPass = (!scenario.require_location || locationPresent) && (!scenario.require_retry_after || Boolean(retryAfter)) && (!scenario.require_correlation_echo || correlationMatches);
  const actual = { status: response.status, correlation_id_matches_request: correlationMatches, location_present: locationPresent, retry_after_present: retryAfter !== null, retry_after_seconds: retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null, allow_origin_present: allowOrigin !== null, allow_origin_matches_request: allowOrigin !== null && allowOrigin === origin, allow_origin_wildcard: allowOrigin === '*' };
  results.push({ case_id: scenario.case_id, expected_status: scenario.expected_status, observed: actual, passed: response.status === scenario.expected_status && corsPass && headersPass, request_uri: redactUrl(url.href), cors_passed: corsPass, required_headers_passed: headersPass, upstream_call_verified: false });
  await response.body?.cancel();
}
process.stdout.write(`${JSON.stringify({ schema: 'h5-http-harness-result/v1', execution_result: results.every((x) => x.passed) ? 'INCONCLUSIVE' : 'FAIL', case_assertions_matched: results.filter((x) => x.passed).length, evidence_level: 'L1_OR_L2_REQUIRES_ENVIRONMENT_REVIEW', destination: redactUrl(process.env.APIM_EDGE_URL), cases: results, notes: ['No response bodies or credentials recorded', 'A 202 is admission only; durable completion requires polling separately', 'No request is retried after timeout', 'Upstream no-call assertions require real correlated telemetry', 'Status matches alone are not an APIM certification PASS'] }, null, 2)}\n`);
if (results.some((x) => !x.passed)) process.exitCode = 1;
