import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const requestId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const runIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;

function parseUtcTimestamp(value) {
  const time = Date.parse(value);
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString() !==
      value.replace(/(?<=\d\d:\d\d:\d\d)Z$/, '.000Z')
  ) {
    throw new Error('INVALID_UTC_TIMESTAMP');
  }
  return time;
}

function indexRecords(
  rows,
  { runId, windowStart, windowEnd, allowedValues, field },
) {
  if (!Array.isArray(rows)) throw new Error('INVALID_TRACE_INPUT');
  const indexed = new Map();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      throw new Error('INVALID_TRACE_METADATA');
    }
    if (typeof row.run_id !== 'string' || !runIdPattern.test(row.run_id)) {
      throw new Error('INVALID_TRACE_METADATA');
    }
    if (row.run_id !== runId) {
      throw new Error('RUN_ID_MISMATCH');
    }
    const observedAt = parseUtcTimestamp(row.observed_utc);
    if (observedAt < windowStart || observedAt > windowEnd) {
      throw new Error('TIMESTAMP_OUTSIDE_WINDOW');
    }
    if (
      typeof row.request_id !== 'string' ||
      !requestId.test(row.request_id) ||
      indexed.has(row.request_id) ||
      (field && !allowedValues.includes(row[field]))
    ) {
      throw new Error('INVALID_OR_DUPLICATE_REQUEST');
    }
    indexed.set(row.request_id, row);
  }
  return indexed;
}

export function verifyRateLimit(input) {
  if (typeof input !== 'object' || input === null) {
    throw new Error('INVALID_RUN_METADATA');
  }
  const {
    run_id,
    start_utc,
    end_utc,
    source_sha,
    environment,
    policy_hash,
    complete_capture,
  } = input;
  if (
    typeof run_id !== 'string' ||
    !runIdPattern.test(run_id) ||
    !/^[0-9a-f]{40}$/.test(source_sha ?? '') ||
    !['synthetic', 'isolated', 'azure'].includes(environment) ||
    !(
      policy_hash === 'not_available' ||
      /^[0-9a-f]{64}$/.test(policy_hash ?? '')
    )
  ) {
    throw new Error('INVALID_RUN_METADATA');
  }

  const windowStart = parseUtcTimestamp(start_utc);
  const windowEnd = parseUtcTimestamp(end_utc);
  if (windowEnd <= windowStart) {
    throw new Error('INVALID_OBSERVATION_WINDOW');
  }

  const scope = { runId: run_id, windowStart, windowEnd };
  const offered = indexRecords(input.offered, scope);
  const apim = indexRecords(input.apim, {
    ...scope,
    allowedValues: ['accepted', 'rate_limited'],
    field: 'decision',
  });
  const gateway = indexRecords(input.gateway, scope);
  const provider = indexRecords(input.provider, scope);
  const direct = indexRecords(input.direct, {
    ...scope,
    allowedValues: ['denied', 'allowed'],
    field: 'result',
  });
  const accepted = [...apim.values()].filter(
    (row) => row.decision === 'accepted',
  );
  const rejected = [...apim.values()].filter(
    (row) => row.decision === 'rate_limited',
  );
  const denied = [...direct.values()].filter((row) => row.result === 'denied');

  if (rejected.some((row) => row.status !== 429))
    throw new Error('INVALID_RATE_LIMIT_STATUS');

  const unauthorizedArrival = (traffic) =>
    [...traffic.keys()].some((id) => {
      if (direct.has(id) || apim.get(id)?.decision === 'rate_limited')
        return true;
      return complete_capture === true && !apim.has(id);
    });
  const violations = [];
  if (unauthorizedArrival(gateway))
    violations.push('UNEXPECTED_GATEWAY_ARRIVAL');
  if (unauthorizedArrival(provider))
    violations.push('UNEXPECTED_PROVIDER_ARRIVAL');
  if ([...direct.keys()].some((id) => apim.has(id) || offered.has(id))) {
    violations.push('DIRECT_REQUEST_REUSED_API_ID');
  }
  if (direct.size !== denied.length) violations.push('DIRECT_ACCESS_ALLOWED');
  if ([...apim.keys()].some((id) => !offered.has(id)))
    violations.push('UNTRACKED_EDGE_REQUEST');

  const missing = [];
  if (complete_capture !== true)
    missing.push('UNCONFIRMED_TELEMETRY_COMPLETENESS');
  if (environment === 'azure' && policy_hash === 'not_available')
    missing.push('MISSING_POLICY_HASH');
  if (accepted.length === 0 || rejected.length === 0 || denied.length === 0) {
    missing.push('MISSING_CONTROL_GROUP');
  }
  if (
    offered.size !== apim.size ||
    accepted.some(
      ({ request_id }) => !gateway.has(request_id) || !provider.has(request_id),
    )
  ) {
    missing.push('INCOMPLETE_REQUEST_CORRELATION');
  }

  return {
    case_id: 'RL-05',
    run_id,
    start_utc,
    end_utc,
    window_ms: windowEnd - windowStart,
    source_sha,
    environment,
    policy_hash,
    execution_result: violations.length
      ? 'FAIL'
      : missing.length
        ? 'INCONCLUSIVE'
        : 'PASS',
    requests_offered: offered.size,
    apim_accepted: accepted.length,
    apim_rejected_429: rejected.length,
    gateway_received: gateway.size,
    provider_received: provider.size,
    direct_denied: denied.length,
    violations,
    missing,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = verifyRateLimit(
      JSON.parse(await readFile(process.argv[2], 'utf8')),
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 }[
      result.execution_result
    ];
  } catch (error) {
    console.error(
      'RL-05: ' +
        (error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'INVALID_INPUT'),
    );
    process.exitCode = 1;
  }
}
