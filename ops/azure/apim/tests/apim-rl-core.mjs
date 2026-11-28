const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseHttpUrl(value) {
  if (typeof value !== 'string' || /[\\\s]/.test(value)) return null;
  const match = /^(https?):\/\/([^/?#]+)(?:\/[^?#]*)?$/i.exec(value);
  if (!match || match[2].includes('@')) return null;
  const protocol = `${match[1].toLowerCase()}:`;
  const authority = match[2];
  let hostname;
  let port = '';
  if (authority.startsWith('[')) {
    const ipv6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(authority);
    if (!ipv6) return null;
    hostname = ipv6[1].toLowerCase();
    port = ipv6[2] ?? '';
  } else {
    const host = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
    if (!host || !/^[a-z0-9.-]+$/i.test(host[1])) return null;
    hostname = host[1].toLowerCase();
    port = host[2] ?? '';
  }
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  if ((protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443')) port = '';
  const normalizedHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  const host = `${normalizedHost}${port ? `:${Number(port)}` : ''}`;
  return { protocol, host, hostname, origin: `${protocol}//${host}` };
}

export function headerValue(headers, name) {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  if (!entry) return undefined;
  return Array.isArray(entry[1]) ? entry[1][0] : entry[1];
}

export function parseRetryAfter(value, nowMs = Date.now(), maxSeconds = 3600) {
  if (typeof value !== 'string' || value.trim() === '') return { valid: false, reason: 'missing' };
  const input = value.trim();
  let seconds;
  if (/^\d{1,6}$/.test(input)) {
    seconds = Number(input);
  } else if (HTTP_DATE.test(input)) {
    const target = Date.parse(input);
    if (!Number.isFinite(target)) return { valid: false, reason: 'format' };
    seconds = Math.max(0, Math.ceil((target - nowMs) / 1000));
  } else {
    return { valid: false, reason: 'format' };
  }
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > maxSeconds) {
    return { valid: false, reason: 'limit' };
  }
  return { valid: true, seconds };
}

function problemCode(body) {
  if (typeof body !== 'string' || body.length === 0) return '';
  try {
    const parsed = JSON.parse(body);
    return String(parsed.code ?? parsed.errorCode ?? '').toUpperCase();
  } catch {
    return '';
  }
}

export function classifyHttpResponse(status, body, headers, policy = {}) {
  if (status === 200) return 'admitted';
  if (status === 429) return policy.rateLimitEnabled === true ? 'rate_limited' : 'unexpected_429';
  if (status === 401) return 'authentication_invalid';
  if (status === 403) {
    const code = problemCode(body);
    if (code === 'TOKEN_INVALIDO' || code === 'SCOPE_INSUFICIENTE') return 'authorization_insufficient';
    const allowed = Array.isArray(policy.quotaErrorCodes) ? policy.quotaErrorCodes : [];
    if (policy.quotaEnabled === true && allowed.includes(code)) return 'quota_exhausted';
    return 'unexpected_403';
  }
  if (status >= 500 && status <= 599) return 'unexpected_5xx';
  if (status === 0) return 'connection_error';
  return 'unexpected_http';
}

export function matchesTemplatePath(actualPath, templatePath) {
  const actual = actualPath.split('/').filter(Boolean);
  const template = templatePath.split('/').filter(Boolean);
  if (actual.length !== template.length) return false;
  return template.every((part, index) =>
    part.startsWith('{') && part.endsWith('}') ? actual[index].length > 0 : part === actual[index],
  );
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

export function validateEffectiveOperation({ baseUrl, manifest, parameters, expected, remote = false }) {
  const url = parseHttpUrl(baseUrl);
  assert(url, 'PREFLIGHT_ORIGEN_INVALIDO');
  assert(url.origin === expected.origin, 'PREFLIGHT_HOST_NO_AUTORIZADO');
  assert(remote ? url.protocol === 'https:' : url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname),
    'PREFLIGHT_HOST_NO_AUTORIZADO');
  assert(manifest?.publicationMode === 'effective' && manifest.effectivePublication?.authorized === true,
    'PREFLIGHT_MANIFEST_NO_EFECTIVO');
  assert(!remote || manifest.fixtureType !== 'LOCAL_SIMULATION', 'PREFLIGHT_MANIFEST_DE_SIMULACION');
  assert(manifest.operationSetSha256 === expected.operationSetSha256, 'PREFLIGHT_OPERATION_SET_HASH');
  assert(manifest.filteredOpenApiCanonicalSha256 === expected.filteredOpenApiSha256, 'PREFLIGHT_OPENAPI_HASH');
  assert(parameters?.expectedOperationSetSha256 === manifest.operationSetSha256 &&
    parameters?.expectedFilteredOpenApiSha256 === manifest.filteredOpenApiCanonicalSha256,
  'PREFLIGHT_PARAMETROS_NO_COINCIDEN');
  assert(parameters?.deploymentRevision === expected.revision, 'PREFLIGHT_REVISION_NO_COINCIDE');
  assert(parameters?.policyHash === expected.policyHash, 'PREFLIGHT_POLICY_HASH_NO_COINCIDE');
  const published = new Set(manifest.effectivePublication.publishedOperationIds ?? []);
  const excluded = new Set([
    ...(manifest.privateOperationIds ?? []),
    ...(manifest.excludedUncontractedLegacyOperationIds ?? []),
  ]);
  const matches = (manifest.operations ?? []).filter((operation) => operation.operationId === expected.operationId);
  assert(matches.length === 1, 'PREFLIGHT_OPERACION_AMBIGUA_O_AUSENTE');
  const operation = matches[0];
  assert(operation.method === expected.method && operation.path && matchesTemplatePath(expected.path, operation.path),
    'PREFLIGHT_RUTA_METODO_NO_COINCIDE');
  assert(!/[{}]/.test(expected.path) && expected.path.startsWith('/'), 'PREFLIGHT_RUTA_NO_CONCRETA');
  assert(operation.environmentEnabled === true && published.has(operation.operationId) && !excluded.has(operation.operationId),
    'PREFLIGHT_OPERACION_NO_PUBLICADA');
  assert(operation.rateProfile === expected.rateProfile, 'PREFLIGHT_RATE_PROFILE_NO_COINCIDE');
  const profile = parameters.rateProfiles?.[operation.rateProfile];
  assert(profile && Number.isSafeInteger(profile.burstCalls) && profile.burstCalls > 0 &&
    Number.isSafeInteger(profile.burstWindowSeconds) && profile.burstWindowSeconds > 0,
  'PREFLIGHT_RATE_PROFILE_EFECTIVO_AUSENTE');
  assert(profile.burstCalls === expected.burstCalls && profile.burstWindowSeconds === expected.burstWindowSeconds,
    'PREFLIGHT_LIMITE_EFECTIVO_NO_COINCIDE');
  const scenario = expected.scenario ?? 'demo-rate-limit';
  if (scenario === 'cuota') {
    assert(Number.isSafeInteger(profile.quotaCalls) && profile.quotaCalls > 0 &&
      Number.isSafeInteger(profile.quotaWindowSeconds) && profile.quotaWindowSeconds > 0 &&
      profile.quotaCalls === expected.quotaCalls && profile.quotaWindowSeconds === expected.quotaWindowSeconds,
    'PREFLIGHT_CUOTA_EFECTIVA_NO_COINCIDE');
    assert(typeof profile.quotaErrorCode === 'string' && profile.quotaErrorCode === expected.quotaErrorCode &&
      /^[A-Z][A-Z0-9_]{2,63}$/.test(profile.quotaErrorCode),
    'PREFLIGHT_CODIGO_CUOTA_NO_RESPALDADO');
    const requestRateNeeded = (profile.quotaCalls + 1) / profile.quotaWindowSeconds;
    assert(expected.maxRequests === profile.quotaCalls + 1 && expected.maxRequests <= expected.maxAuthorizedRequests,
      'PREFLIGHT_PRESUPUESTO_SOLICITUDES_INVALIDO');
    assert(expected.maxConcurrency === 1 && expected.maxConcurrency <= expected.authorizedConcurrency,
      'PREFLIGHT_CONCURRENCIA_NO_AUTORIZADA');
    assert(expected.maxRps >= requestRateNeeded &&
      expected.maxRps * profile.burstWindowSeconds < profile.burstCalls &&
      expected.maxRps <= expected.authorizedRps,
    'PREFLIGHT_RPS_CUOTA_NO_AUTORIZADOS');
    assert(expected.maxDurationSeconds >= profile.quotaWindowSeconds + 4 &&
      expected.maxDurationSeconds <= expected.authorizedDurationSeconds,
    'PREFLIGHT_DURACION_CUOTA_NO_AUTORIZADA');
  } else if (scenario === 'concurrencia') {
    assert(Number.isSafeInteger(profile.maxConcurrency) && profile.maxConcurrency > 0 &&
      profile.maxConcurrency === expected.policyConcurrencyLimit &&
      expected.concurrencyCalls === profile.maxConcurrency + 1 &&
      profile.burstCalls >= expected.concurrencyCalls,
    'PREFLIGHT_CONCURRENCIA_EFECTIVA_NO_COINCIDE');
    assert(expected.maxRequests === expected.concurrencyCalls && expected.maxRequests <= expected.maxAuthorizedRequests,
      'PREFLIGHT_PRESUPUESTO_SOLICITUDES_INVALIDO');
    assert(expected.maxConcurrency === expected.concurrencyCalls &&
      expected.maxConcurrency <= expected.authorizedConcurrency,
    'PREFLIGHT_CONCURRENCIA_NO_AUTORIZADA');
    assert(expected.maxRps >= expected.concurrencyCalls && expected.maxRps <= expected.authorizedRps,
      'PREFLIGHT_RPS_NO_AUTORIZADOS');
    assert(expected.maxDurationSeconds > 3 && expected.maxDurationSeconds <= expected.authorizedDurationSeconds,
      'PREFLIGHT_DURACION_NO_AUTORIZADA');
  } else {
    const requiredRequests = expected.requiredRequests ?? expected.burstCalls + 2;
    assert(expected.maxRequests === requiredRequests && expected.maxRequests <= expected.maxAuthorizedRequests,
      'PREFLIGHT_PRESUPUESTO_SOLICITUDES_INVALIDO');
    assert(Number.isSafeInteger(expected.maxConcurrency) && expected.maxConcurrency >= expected.burstCalls &&
      expected.maxConcurrency <= expected.authorizedConcurrency,
    'PREFLIGHT_CONCURRENCIA_NO_AUTORIZADA');
    assert(expected.maxRps >= expected.burstCalls && expected.maxRps <= expected.authorizedRps,
      'PREFLIGHT_RPS_NO_AUTORIZADOS');
    assert(expected.maxDurationSeconds > expected.maxRetryAfterSeconds + 3 &&
      expected.maxDurationSeconds <= expected.authorizedDurationSeconds,
    'PREFLIGHT_DURACION_NO_AUTORIZADA');
  }
  const requiredVus = scenario === 'concurrencia' ? expected.concurrencyCalls : 1;
  assert(expected.maxVus === requiredVus && expected.maxVus <= expected.authorizedVus,
    'PREFLIGHT_VUS_NO_AUTORIZADOS');
  return { url, operation, profile };
}
