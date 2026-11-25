const secretPatterns = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/i,
  /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]/i,
  /\b(bearer|password|passwd|client_secret|access_token|refresh_token|connectionstring|connection_string|dsn)\s*[:= ]/i,
  /["'](?:token|secret|authorization|cookie|password|dsn|connectionString|endpoint|url|headers|stack|errorMessage|email|personalData)["']\s*:/i,
  /\b(postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/)/i,
  /\bhttps?:\/\/[^\s"'<>]+/i,
  /\bbase64(?:-encoded)?\s*[:=]\s*[A-Za-z0-9+/]{8,}={0,2}/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

export function assertSafeEvidenceText(text) {
  if (typeof text !== 'string') throw new TypeError('EVIDENCE_TEXT_REQUIRED');
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    throw new Error('EVIDENCE_REJECTED:SECRET_OR_PERSONAL_DATA');
  }
  return true;
}

const allowedFields = new Set([
  'schema_version',
  'scenario_id',
  'status',
  'state',
  'result_category',
  'evidence_level',
  'attempts',
  'duration_ms',
  'http_status',
  'provider_ids',
  'providers_started',
  'providers_queried',
  'providers_participating',
  'simulated_providers',
  'sha256',
]);

export function allowEvidenceFields(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('EVIDENCE_RECORD_REQUIRED');
  }
  const output = {};
  for (const [key, value] of Object.entries(record)) {
    if (!allowedFields.has(key)) continue;
    const encoded = JSON.stringify(value);
    assertSafeEvidenceText(encoded);
    output[key] = value;
  }
  return output;
}
