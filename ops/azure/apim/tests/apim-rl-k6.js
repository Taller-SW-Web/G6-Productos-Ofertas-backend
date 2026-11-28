// Script k6 para Demo 4 y perfiles RL independientes. Invocarlo mediante
// scripts/h5/k6/bin/ejecutar-rate-limit.ps1: el permiso remoto requiere la
// verificación de las firmas Infra/G7. No pasar credenciales como argumentos k6.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { sha256 } from 'k6/crypto';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  classifyHttpResponse,
  headerValue,
  parseHttpUrl,
  parseRetryAfter,
  validateEffectiveOperation,
} from './apim-rl-core.mjs';
import { revisionMatches } from '../../../../scripts/h5/k6/scripts/contratos.js';

const profile = __ENV.APIM_RL_PROFILE || 'completo';
const INDEPENDENT_PROFILES = ['demo-rate-limit', 'aislamiento', 'cuota', 'concurrencia'];
const independent = INDEPENDENT_PROFILES.includes(profile);
if (profile !== 'completo' && !independent) throw new Error('PREFLIGHT_PERFIL_NO_ADMITIDO');

if (independent) {
  for (const envName of [
    'APIM_BASE_URL', 'APIM_EFFECTIVE_MANIFEST_PATH', 'APIM_EFFECTIVE_PARAMETERS_PATH',
    'APIM_EFFECTIVE_POLICY_PATH', 'APIM_OPERATION_SET_SHA256', 'APIM_FILTERED_OPENAPI_SHA256',
    'APIM_POLICY_HASH', 'APIM_REVISION', 'APIM_RL_MODE', 'APIM_RL_OPERATION_ID',
    'APIM_RL_OPERATION_PATH', 'APIM_RL_RATE_PROFILE', 'APIM_RL_IDENTITY', 'APIM_RL_TEST_TOKEN',
    'APIM_RL_MAX_REQUESTS', 'APIM_RL_MAX_CONCURRENCY', 'APIM_RL_MAX_RPS',
    'APIM_RL_VUS',
    'APIM_RL_MAX_DURATION_SECONDS', 'APIM_RL_MAX_RETRY_AFTER_SECONDS', 'APIM_RL_REVISION_HEADER',
    'APIM_RL_RUN_ID',
  ]) {
    if (!__ENV[envName]) throw new Error(`${envName} es obligatorio para ${profile}`);
  }
  if (profile === 'aislamiento' && (!__ENV.APIM_RL_TEST_TOKEN_B || !__ENV.APIM_RL_IDENTITY_B)) {
    throw new Error('APIM_RL_TEST_TOKEN_B y APIM_RL_IDENTITY_B son obligatorios para aislamiento');
  }
  if (__ENV.APIM_RL_MODE === 'remote') {
    if (!/^[a-f0-9]{64}$/.test(__ENV.APIM_RL_VERIFIED_PERMIT_SHA256 || '')) {
      throw new Error('PREFLIGHT_PERMISO_FIRMADO_NO_VERIFICADO');
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(__ENV.APIM_RL_IDENTITY || '') ||
        !__ENV.APIM_RL_EXPECTED_REVISION || __ENV.APIM_RL_EXPECTED_REVISION !== __ENV.APIM_REVISION) {
      throw new Error('PREFLIGHT_IDENTIDAD_O_REVISION_FIRMADA_AUSENTE');
    }
  } else if (__ENV.APIM_RL_MODE !== 'local' || __ENV.APIM_RL_LOCAL_SIMULATION !== '1') {
    throw new Error('PREFLIGHT_MODO_LOCAL_NO_EXPLICITO');
  }
} else if (__ENV.APIM_RL_MODE !== 'local' || __ENV.APIM_RL_LOCAL_SIMULATION !== '1' || !__ENV.APIM_BASE_URL) {
  throw new Error('PREFLIGHT_COMPLETO_SOLO_LOCAL_SIN_PERMISO_DE_PERFIL');
}

if (!independent) for (const envName of [
  'APIM_EFFECTIVE_MANIFEST_PATH',
  'APIM_EFFECTIVE_PARAMETERS_PATH',
  'APIM_OPERATION_SET_SHA256',
  'APIM_FILTERED_OPENAPI_SHA256',
  'APIM_POLICY_HASH',
  'APIM_REVISION',
  'APIM_JWT_M2M_A',
  'APIM_JWT_M2M_B',
  'APIM_JWT_HUMAN_QUOTA',
  'APIM_JWT_HUMAN_CONCURRENCY',
]) {
  if (!__ENV[envName]) {
    throw new Error(`${envName} es obligatorio`);
  }
}

const labBurstCalls = Number(__ENV.APIM_LAB_BURST_CALLS || '0');
const labBurstWindowSec = Number(__ENV.APIM_LAB_BURST_WINDOW_SEC || '0');
const labQuotaCalls = Number(__ENV.APIM_LAB_QUOTA_CALLS || '0');
const labQuotaBurstCalls = Number(__ENV.APIM_LAB_QUOTA_BURST_CALLS || '0');
const labQuotaBurstWindowSec = Number(__ENV.APIM_LAB_QUOTA_BURST_WINDOW_SEC || '0');
const labConcurrencyMax = Number(__ENV.APIM_LAB_CONCURRENCY_MAX || '0');
const labExpensiveBurstCalls = Number(__ENV.APIM_LAB_EXPENSIVE_BURST_CALLS || '0');
if (!independent && (
  !labBurstCalls ||
  !labBurstWindowSec ||
  !labQuotaCalls ||
  !labQuotaBurstCalls ||
  !labQuotaBurstWindowSec ||
  !labConcurrencyMax ||
  !labExpensiveBurstCalls
)) {
  throw new Error(
    'APIM_LAB_BURST_CALLS, APIM_LAB_BURST_WINDOW_SEC, APIM_LAB_QUOTA_CALLS, APIM_LAB_QUOTA_BURST_CALLS, APIM_LAB_QUOTA_BURST_WINDOW_SEC, APIM_LAB_CONCURRENCY_MAX y APIM_LAB_EXPENSIVE_BURST_CALLS son obligatorios',
  );
}
if (!independent && labConcurrencyMax + 1 >= labExpensiveBurstCalls) {
  throw new Error(
    'APIM_LAB_EXPENSIVE_BURST_CALLS debe ser mayor que APIM_LAB_CONCURRENCY_MAX + 1 para aislar limit-concurrency de rate-limit-by-key',
  );
}

// R7-03 & R9 Corrección 5: exigir manifiesto efectivo y parámetros reales del deployment
const manifest = JSON.parse(open(__ENV.APIM_EFFECTIVE_MANIFEST_PATH));
const effectiveParameters = JSON.parse(open(__ENV.APIM_EFFECTIVE_PARAMETERS_PATH));
if (manifest.publicationMode !== 'effective' || manifest.effectivePublication?.authorized !== true) {
  throw new Error(
    'Manifiesto rechazado: k6 requiere publicationMode="effective" y effectivePublication.authorized=true',
  );
}
if (manifest.operationSetSha256 !== __ENV.APIM_OPERATION_SET_SHA256) {
  throw new Error('operationSetSha256 del manifiesto efectivo no coincide con APIM_OPERATION_SET_SHA256');
}
if (manifest.filteredOpenApiCanonicalSha256 !== __ENV.APIM_FILTERED_OPENAPI_SHA256) {
  throw new Error('filteredOpenApiCanonicalSha256 del manifiesto efectivo no coincide con APIM_FILTERED_OPENAPI_SHA256');
}
if (
  effectiveParameters.expectedOperationSetSha256 !== manifest.operationSetSha256 ||
  effectiveParameters.expectedFilteredOpenApiSha256 !== manifest.filteredOpenApiCanonicalSha256
) {
  throw new Error('Parámetros efectivos del deployment no coinciden con los SHA del manifiesto efectivo');
}

let independentContext = null;
let policyText = '';
if (independent) {
  policyText = open(__ENV.APIM_EFFECTIVE_POLICY_PATH);
  const computedPolicyHash = sha256(policyText, 'hex');
  if (!/^[a-f0-9]{64}$/.test(__ENV.APIM_POLICY_HASH) || computedPolicyHash !== __ENV.APIM_POLICY_HASH) {
    throw new Error('PREFLIGHT_HASH_POLITICA_EFECTIVA_INVALIDO');
  }
  if (effectiveParameters.policyHash !== computedPolicyHash || effectiveParameters.deploymentRevision !== __ENV.APIM_REVISION) {
    throw new Error('PREFLIGHT_REVISION_O_POLITICA_EFECTIVA_NO_COINCIDE');
  }
  const expected = {
    origin: parseHttpUrl(__ENV.APIM_BASE_URL)?.origin,
    operationSetSha256: __ENV.APIM_OPERATION_SET_SHA256,
    filteredOpenApiSha256: __ENV.APIM_FILTERED_OPENAPI_SHA256,
    revision: __ENV.APIM_REVISION,
    policyHash: computedPolicyHash,
    operationId: __ENV.APIM_RL_OPERATION_ID,
    method: 'GET',
    path: __ENV.APIM_RL_OPERATION_PATH,
    rateProfile: __ENV.APIM_RL_RATE_PROFILE,
    profile,
    scenario: profile,
    burstCalls: Number(__ENV.APIM_RL_BURST_CALLS || __ENV.APIM_RL_MAX_REQUESTS - 2),
    burstWindowSeconds: Number(__ENV.APIM_RL_BURST_WINDOW_SECONDS || '0'),
    maxRequests: Number(__ENV.APIM_RL_MAX_REQUESTS),
    maxAuthorizedRequests: Number(__ENV.APIM_RL_AUTHORIZED_MAX_REQUESTS || __ENV.APIM_RL_MAX_REQUESTS),
    requiredRequests: profile === 'cuota'
      ? Number(__ENV.APIM_RL_QUOTA_CALLS) + 1
      : profile === 'concurrencia'
        ? Number(__ENV.APIM_RL_CONCURRENCY_CALLS)
        : Number(__ENV.APIM_RL_BURST_CALLS || __ENV.APIM_RL_MAX_REQUESTS - 2) + (profile === 'aislamiento' ? 3 : 2),
    maxConcurrency: Number(__ENV.APIM_RL_MAX_CONCURRENCY),
    authorizedConcurrency: Number(__ENV.APIM_RL_AUTHORIZED_CONCURRENCY || __ENV.APIM_RL_MAX_CONCURRENCY),
    maxVus: Number(__ENV.APIM_RL_VUS || '1'),
    authorizedVus: Number(__ENV.APIM_RL_AUTHORIZED_VUS || __ENV.APIM_RL_VUS || '1'),
    maxRps: Number(__ENV.APIM_RL_MAX_RPS),
    authorizedRps: Number(__ENV.APIM_RL_AUTHORIZED_RPS || __ENV.APIM_RL_MAX_RPS),
    maxDurationSeconds: Number(__ENV.APIM_RL_MAX_DURATION_SECONDS),
    maxRetryAfterSeconds: Number(__ENV.APIM_RL_MAX_RETRY_AFTER_SECONDS),
    authorizedDurationSeconds: Number(__ENV.APIM_RL_AUTHORIZED_DURATION_SECONDS || __ENV.APIM_RL_MAX_DURATION_SECONDS),
    quotaCalls: Number(__ENV.APIM_RL_QUOTA_CALLS || '0'),
    quotaWindowSeconds: Number(__ENV.APIM_RL_QUOTA_WINDOW_SECONDS || '0'),
    quotaErrorCode: __ENV.APIM_RL_QUOTA_ERROR_CODE || '',
    policyConcurrencyLimit: Number(__ENV.APIM_RL_POLICY_CONCURRENCY_LIMIT || '0'),
    concurrencyCalls: Number(__ENV.APIM_RL_CONCURRENCY_CALLS || '0'),
  };
  const validated = validateEffectiveOperation({
    baseUrl: __ENV.APIM_BASE_URL,
    manifest,
    parameters: effectiveParameters,
    expected,
    remote: __ENV.APIM_RL_MODE === 'remote',
  });
  const rateLimitRule = new RegExp(`<rate-limit-by-key\\b[^>]*calls=[\"']${expected.burstCalls}[\"'][^>]*renewal-period=[\"']${expected.burstWindowSeconds}[\"']`);
  if (!rateLimitRule.test(policyText)) throw new Error('PREFLIGHT_POLITICA_SIN_RATE_LIMIT_EFECTIVO');
  if (__ENV.APIM_RL_MODE === 'remote' && !/^x-[a-z0-9-]{1,62}$/.test(__ENV.APIM_RL_REVISION_HEADER)) {
    throw new Error('PREFLIGHT_CABECERA_DE_REVISION_INVALIDA');
  }
  independentContext = {
    expected,
    operation: validated.operation,
    effectiveRateProfile: validated.profile,
    baseUrl: `${__ENV.APIM_BASE_URL.replace(/\/$/, '')}${expected.path}`,
    token: __ENV.APIM_RL_TEST_TOKEN,
    identity: __ENV.APIM_RL_IDENTITY,
    tokenB: __ENV.APIM_RL_TEST_TOKEN_B,
    identityB: __ENV.APIM_RL_IDENTITY_B,
    revisionHeader: __ENV.APIM_RL_REVISION_HEADER,
    expectedRevision: __ENV.APIM_REVISION,
    retryAfterMaximum: expected.maxRetryAfterSeconds,
    quotaCalls: expected.quotaCalls,
    quotaWindowSeconds: expected.quotaWindowSeconds,
    quotaErrorCode: expected.quotaErrorCode,
    policyConcurrencyLimit: expected.policyConcurrencyLimit,
    concurrencyCalls: expected.concurrencyCalls,
    runId: __ENV.APIM_RL_RUN_ID,
    maximumDurationSeconds: expected.maxDurationSeconds,
  };
}

const CONCURRENCY_PROFILES = {
  expensive_export: true,
  multipart_import: true,
  g5_protected: true,
};

function matchesTemplatePath(actualPath, templatePath) {
  const actualParts = actualPath.split('/').filter(Boolean);
  const templateParts = templatePath.split('/').filter(Boolean);
  if (actualParts.length !== templateParts.length) return false;
  return templateParts.every((part, i) =>
    part.startsWith('{') && part.endsWith('}') ? actualParts[i].length > 0 : part === actualParts[i],
  );
}

const exportId = (__ENV.APIM_RL_EXPORT_ID || '').trim();
if (!independent && !exportId) {
  throw new Error('RL-05 requiere APIM_RL_EXPORT_ID de fixture autorizado');
}
const expensivePath = exportId ? `/auditoria-precios/exportaciones/${exportId}/archivo` : '';
if (/\{[^}]+\}/.test(expensivePath)) {
  throw new Error('RL-05 ruta contiene placeholders sin resolver');
}

const publishedSet = new Set(manifest.effectivePublication.publishedOperationIds || []);
const excludedSet = new Set([
  ...(manifest.privateOperationIds || []),
  ...(manifest.excludedUncontractedLegacyOperationIds || []),
]);
const matchedExpensiveOp = independent ? null : manifest.operations.find(
  (op) => op.method === 'GET' && matchesTemplatePath(expensivePath, op.path),
);
if (!independent && !matchedExpensiveOp) {
  throw new Error(`RL-05 ruta ${expensivePath} no corresponde al manifiesto efectivo`);
}
if (!independent && (!publishedSet.has(matchedExpensiveOp.operationId) || matchedExpensiveOp.environmentEnabled !== true)) {
  throw new Error(`RL-05 operación ${matchedExpensiveOp.operationId} no está habilitada en el ambiente`);
}
if (!independent && excludedSet.has(matchedExpensiveOp.operationId)) {
  throw new Error(`RL-05 operación ${matchedExpensiveOp.operationId} pertenece a rutas excluidas`);
}
const effectiveRateProfile = independent ? null : effectiveParameters.rateProfiles?.[matchedExpensiveOp.rateProfile];
if (!independent && (!effectiveRateProfile || !(effectiveRateProfile.maxConcurrency > 0))) {
  throw new Error(
    `RL-05 perfil efectivo ${matchedExpensiveOp.rateProfile} ausente o sin maxConcurrency > 0 en APIM_EFFECTIVE_PARAMETERS_PATH`,
  );
}
if (!independent && (
  effectiveRateProfile.maxConcurrency !== labConcurrencyMax ||
  effectiveRateProfile.burstCalls !== labExpensiveBurstCalls
)) {
  throw new Error(
    `RL-05 valores k6 no coinciden con perfil efectivo (${matchedExpensiveOp.rateProfile}) del deployment`,
  );
}

const burstRatePerSec = Math.max(1, Math.ceil(labBurstCalls / Math.max(labBurstWindowSec, 1)));
const quotaSafeRate = Math.max(1, Math.min(labQuotaBurstCalls - 1, burstRatePerSec));
const quotaIterations = labQuotaCalls + 5;
const quotaDurationSec = Math.ceil((quotaIterations / quotaSafeRate) * labQuotaBurstWindowSec) + 5;
const concurrencyVus = Math.min(labConcurrencyMax + 2, labExpensiveBurstCalls - 1);
// Retained for the legacy local-only "completo" profile. Demo 4's supported
// independent profile waits on the Retry-After value actually returned.
const recoveryStartSec = labBurstWindowSec + 4;

const burst429 = new Counter('apim_rl_burst_429');
const burstRetryAfter = new Counter('apim_rl_burst_retry_after');
const quota403 = new Counter('apim_rl_quota_403');
const quotaBurstCollision = new Counter('apim_rl_quota_burst_collision');
const concurrency429 = new Counter('apim_rl_concurrency_429');
const concurrencyUnexpectedStatus = new Counter('apim_rl_concurrency_unexpected_status');
const recovery200 = new Counter('apim_rl_recovery_200');
const clientB200 = new Counter('apim_rl_client_b_200');
const clientBFailed = new Rate('apim_rl_client_b_failed');
const authzFalsePositive = new Counter('apim_rl_authz_false_positive');
const demoOffered = new Counter('apim_rl_demo_offered');
const demoAdmitted = new Counter('apim_rl_demo_admitted');
const demoRejected = new Counter('apim_rl_demo_rejected');
const demo429 = new Counter('apim_rl_demo_http_429');
const demoUnexpected = new Counter('apim_rl_demo_unexpected');
const demoUnexpectedRate = new Rate('apim_rl_demo_unexpected_rate');
const demoRetryAfter = new Trend('apim_rl_demo_retry_after_seconds');
const demoWait = new Trend('apim_rl_demo_retry_wait_seconds');
const demoRecovery = new Trend('apim_rl_demo_recovery_seconds');
const demoBlockEpoch = new Trend('apim_rl_demo_block_epoch_seconds');
const demoNormalEpoch = new Trend('apim_rl_demo_normal_epoch_seconds');
const demoBurstEpoch = new Trend('apim_rl_demo_burst_epoch_seconds');
const demoRecoveryEpoch = new Trend('apim_rl_demo_recovery_epoch_seconds');
const demoRecovery200 = new Counter('apim_rl_demo_recovery_200');
const demoNormal200 = new Counter('apim_rl_demo_normal_200');
const demoRetryAfterMissing = new Counter('apim_rl_demo_retry_after_missing_or_invalid');
const demoNoRequestsDuringWait = new Counter('apim_rl_demo_no_requests_during_wait');
const demoRevisionMismatch = new Counter('apim_rl_demo_revision_mismatch');
const demoPrimaryPass = new Rate('apim_rl_demo_primary_pass');
const demoIsolationPass = new Rate('apim_rl_demo_isolation_pass');
const demoIsolationB200 = new Counter('apim_rl_demo_isolation_b_200');
const demoQuotaExpected = new Counter('apim_rl_demo_quota_expected_403');
const demoQuotaPass = new Rate('apim_rl_demo_quota_pass');
const demoConcurrency429 = new Counter('apim_rl_demo_concurrency_429');
const demoConcurrencyUnexpected = new Counter('apim_rl_demo_concurrency_unexpected');
const demoConcurrencyEpoch = new Trend('apim_rl_demo_concurrency_epoch_seconds');
const demoStatus200 = new Counter('apim_rl_demo_status_200');
const demoStatus401 = new Counter('apim_rl_demo_status_401');
const demoStatus403 = new Counter('apim_rl_demo_status_403');
const demoStatus429 = new Counter('apim_rl_demo_status_429');
const demoStatus5xx = new Counter('apim_rl_demo_status_5xx');
const demoStatusConnectionError = new Counter('apim_rl_demo_status_connection_error');
const demoStatusOther = new Counter('apim_rl_demo_status_other');
const demoRejectedCorrelation = new Counter('apim_rl_demo_rejected_correlation_id');
const demoAdmittedCorrelation = new Counter('apim_rl_demo_admitted_correlation_id');
const demoOfferedNormal = new Counter('apim_rl_demo_offered_normal');
const demoOfferedBurst = new Counter('apim_rl_demo_offered_burst');
const demoOfferedRecovery = new Counter('apim_rl_demo_offered_recovery');
const demoOfferedClientB = new Counter('apim_rl_demo_offered_consumer_b');
let observedRevisionMismatches = 0;
let observedCorrelationMismatches = 0;
let observedUnexpectedResponses = 0;

const legacyOptions = {
  scenarios: {
    rl01_rl02_burst_client_a: {
      executor: 'constant-arrival-rate',
      rate: burstRatePerSec,
      timeUnit: '1s',
      duration: '6s',
      preAllocatedVUs: 12,
      exec: 'burstClientA',
    },
    rl03_legacy_recovery_sequence: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 3,
      startTime: `${recoveryStartSec}s`,
      exec: 'recoveryClientA',
    },
    quota_exhaustion: {
      executor: 'constant-arrival-rate',
      rate: quotaSafeRate,
      timeUnit: `${labQuotaBurstWindowSec}s`,
      duration: `${quotaDurationSec}s`,
      preAllocatedVUs: 4,
      startTime: `${recoveryStartSec + 6}s`,
      exec: 'quotaHumanClient',
    },
    rl06_concurrency_expensive: {
      executor: 'per-vu-iterations',
      vus: concurrencyVus,
      iterations: 1,
      startTime: `${recoveryStartSec + quotaDurationSec + 10}s`,
      exec: 'concurrencyExpensive',
    },
    rl04_isolated_client_b: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 4,
      exec: 'isolatedClientB',
    },
  },
  thresholds: {
    apim_rl_burst_429: ['count>0'],
    apim_rl_burst_retry_after: ['count>0'],
    apim_rl_recovery_200: ['count>0'],
    apim_rl_quota_403: ['count>0'],
    apim_rl_quota_burst_collision: ['count==0'],
    apim_rl_concurrency_429: ['count>0'],
    apim_rl_concurrency_unexpected_status: ['count==0'],
    apim_rl_client_b_200: ['count>0'],
    apim_rl_client_b_failed: ['rate==0'],
    apim_rl_authz_false_positive: ['count==0'],
    checks: ['rate==1'],
  },
};

const baseUrl = __ENV.APIM_BASE_URL;
const tokenM2mA = __ENV.APIM_JWT_M2M_A;
const tokenM2mB = __ENV.APIM_JWT_M2M_B;
const tokenHumanQuota = __ENV.APIM_JWT_HUMAN_QUOTA;
const tokenHumanConcurrency = __ENV.APIM_JWT_HUMAN_CONCURRENCY;
const burstPath = __ENV.APIM_RL_M2M_PATH || '/productos';
const quotaPath = __ENV.APIM_RL_QUOTA_PATH || '/productos/administracion';

function isAuthzRejection(res) {
  const body = String(res.body || '');
  return (
    res.status === 401 ||
    (res.status === 403 &&
      (body.includes('SCOPE_INSUFICIENTE') || body.includes('TOKEN_INVALIDO')))
  );
}

export function burstClientA() {
  const res = http.get(`${baseUrl}${burstPath}`, {
    headers: { Authorization: `Bearer ${tokenM2mA}` },
  });
  if (isAuthzRejection(res)) authzFalsePositive.add(1);
  if (res.status === 429) {
    burst429.add(1);
    if (res.headers['Retry-After']) burstRetryAfter.add(1);
  }
  check(res, {
    'RL-01/RL-02 burst produces 200 or 429 with Retry-After': (r) =>
      r.status === 200 || (r.status === 429 && Boolean(r.headers['Retry-After'])),
  });
}

export function recoveryClientA() {
  const res = http.get(`${baseUrl}${burstPath}`, {
    headers: { Authorization: `Bearer ${tokenM2mA}` },
  });
  if (isAuthzRejection(res)) authzFalsePositive.add(1);
  if (res.status === 200) recovery200.add(1);
  check(res, {
    'RL-03 recovery same identity/op after window returns 200': (r) => r.status === 200,
  });
  sleep(1);
}

export function quotaHumanClient() {
  const res = http.get(`${baseUrl}${quotaPath}`, {
    headers: { Authorization: `Bearer ${tokenHumanQuota}` },
  });
  if (isAuthzRejection(res)) {
    authzFalsePositive.add(1);
  } else if (res.status === 429) {
    quotaBurstCollision.add(1);
  } else if (res.status === 403) {
    const category = classifyHttpResponse(res.status, String(res.body || ''), res.headers, {
      quotaEnabled: Boolean(__ENV.APIM_RL_QUOTA_ERROR_CODE),
      quotaErrorCodes: __ENV.APIM_RL_QUOTA_ERROR_CODE ? [__ENV.APIM_RL_QUOTA_ERROR_CODE] : [],
    });
    if (category === 'quota_exhausted') quota403.add(1);
    else quotaBurstCollision.add(1);
  }
  check(res, {
    'quota uses the exact policy code or returns expected 200 (generic 403 is not quota)': (r) => {
      const category = classifyHttpResponse(r.status, String(r.body || ''), r.headers, {
        quotaEnabled: Boolean(__ENV.APIM_RL_QUOTA_ERROR_CODE),
        quotaErrorCodes: __ENV.APIM_RL_QUOTA_ERROR_CODE ? [__ENV.APIM_RL_QUOTA_ERROR_CODE] : [],
      });
      return category === 'admitted' || category === 'quota_exhausted';
    },
  });
}

export function concurrencyExpensive() {
  const res = http.get(`${baseUrl}${expensivePath}`, {
    headers: { Authorization: `Bearer ${tokenHumanConcurrency}` },
  });
  if (isAuthzRejection(res)) {
    authzFalsePositive.add(1);
    concurrencyUnexpectedStatus.add(1);
  } else if (res.status === 404 || res.status === 403 || res.status === 401 || res.status >= 500) {
    concurrencyUnexpectedStatus.add(1);
  } else if (res.status === 429) {
    concurrency429.add(1);
  }
  check(res, {
    'RL-06 concurrency limit returns 200 or 429 (idempotency is separately evaluated)': (r) =>
      r.status === 200 || r.status === 429,
  });
}

export function isolatedClientB() {
  const res = http.get(`${baseUrl}${burstPath}`, {
    headers: { Authorization: `Bearer ${tokenM2mB}` },
  });
  const ok = res.status === 200;
  if (ok) clientB200.add(1);
  clientBFailed.add(!ok);
  check(res, {
    'RL-04 client B isolated (strict 200)': (r) => r.status === 200,
  });
  sleep(0.25);
}

export function handleSummary(data) {
  if (independent) {
    const metric = (name) => data.metrics?.[name]?.values ?? null;
    const count = (name) => metric(name)?.count ?? 0;
    const rate = (name) => metric(name)?.rate ?? null;
    const concurrencySummary = profile === 'concurrencia' ? {
      requests_offered: count('apim_rl_demo_offered'),
      requests_admitted: count('apim_rl_demo_admitted'),
      requests_rejected_429: count('apim_rl_demo_concurrency_429'),
      unexpected_responses: count('apim_rl_demo_concurrency_unexpected'),
      max_concurrency_authorized: independentContext.policyConcurrencyLimit,
      request_budget: independentContext.expected.maxRequests,
      vus_authorized: independentContext.expected.maxVus,
      requests_per_second_authorized: independentContext.expected.maxRps,
      first_request_epoch_seconds: metric('apim_rl_demo_concurrency_epoch_seconds')?.min ?? null,
      last_request_epoch_seconds: metric('apim_rl_demo_concurrency_epoch_seconds')?.max ?? null,
    } : null;
    const demoEvent = profile === 'concurrencia' ? {
      profile,
      run_id: __ENV.APIM_RL_RUN_ID,
      status: concurrencySummary.requests_offered === concurrencySummary.request_budget &&
        concurrencySummary.requests_admitted <= concurrencySummary.max_concurrency_authorized &&
        concurrencySummary.requests_rejected_429 > 0 && concurrencySummary.unexpected_responses === 0 &&
        count('dropped_iterations') === 0 ? 'PASS' : 'FAIL',
      scope: __ENV.APIM_RL_MODE === 'local' ? 'L1_LOCAL_POLICY_SIMULATION' : 'L2_STAGING_APIM',
      requirements: {
        'RL-06': 'INCONCLUSIVE_IDEMPOTENCIA_NO_VERIFICADA',
        concurrency_observation: concurrencySummary.requests_rejected_429 > 0 ? 'PASS' : 'FAIL',
        'RL-05': 'INCONCLUSIVE_TELEMETRIA_REQUERIDA',
      },
      timeline_epoch_seconds: {
        first_request: concurrencySummary.first_request_epoch_seconds,
        last_request: concurrencySummary.last_request_epoch_seconds,
      },
      result: concurrencySummary,
    } : null;
    const demoPass = profile === 'aislamiento'
      ? rate('apim_rl_demo_isolation_pass') === 1
      : profile === 'cuota'
        ? rate('apim_rl_demo_quota_pass') === 1
        : profile === 'concurrencia'
          ? demoEvent.status === 'PASS'
          : rate('apim_rl_demo_primary_pass') === 1;
    const summary = {
      schema_version: 1,
      case_id: profile === 'demo-rate-limit' ? 'RL-01-RL-03' : profile === 'aislamiento' ? 'RL-04' : profile === 'concurrencia' ? 'RL-06' : 'APIM-QUOTA',
      execution_result: demoPass ? 'PASS' : 'FAIL',
      overall_certification: 'INCONCLUSIVE',
      scope: __ENV.APIM_RL_MODE === 'local' ? 'L1_LOCAL_POLICY_SIMULATION' : 'L2_STAGING_APIM',
      assessment: {
        'RL-01': ['demo-rate-limit', 'aislamiento'].includes(profile)
          ? demoEvent?.requirements?.['RL-01'] ?? 'NOT_RUN' : 'NOT_RUN',
        'RL-02': ['demo-rate-limit', 'aislamiento'].includes(profile)
          ? demoEvent?.requirements?.['RL-02'] ?? 'NOT_RUN' : 'NOT_RUN',
        'RL-03': ['demo-rate-limit', 'aislamiento'].includes(profile)
          ? demoEvent?.requirements?.['RL-03'] ?? 'NOT_RUN' : 'NOT_RUN',
        'RL-04': profile === 'aislamiento' && count('apim_rl_demo_isolation_b_200') === 1 ? 'PASS' : 'NOT_RUN',
        'RL-05': 'INCONCLUSIVE_TELEMETRIA_APIM_GATEWAY_BACKEND_REQUERIDA',
        'RL-06': profile === 'concurrencia' ? 'INCONCLUSIVE_IDEMPOTENCIA_NO_VERIFICADA' : 'NOT_RUN_IDEMPOTENCIA_NO_VERIFICADA',
      },
      metadata: {
        profile,
        backend_sha: __ENV.APIM_RL_BACKEND_SHA || null,
        source_worktree_clean: __ENV.APIM_RL_SOURCE_WORKTREE_CLEAN === 'true',
        run_id: __ENV.APIM_RL_RUN_ID,
        mode: __ENV.APIM_RL_MODE,
        operation_id: __ENV.APIM_RL_OPERATION_ID,
        method: 'GET',
        path: __ENV.APIM_RL_OPERATION_PATH,
        revision: __ENV.APIM_REVISION,
        policy_sha256: __ENV.APIM_POLICY_HASH,
        effective_manifest_sha256: __ENV.APIM_EFFECTIVE_MANIFEST_SHA256 || null,
        effective_parameters_sha256: __ENV.APIM_EFFECTIVE_PARAMETERS_SHA256 || null,
        verified_permit_sha256: __ENV.APIM_RL_VERIFIED_PERMIT_SHA256 || null,
        request_limit: Number(__ENV.APIM_RL_MAX_REQUESTS),
        rps_limit: Number(__ENV.APIM_RL_MAX_RPS),
        vus_limit: independentContext.expected.maxVus,
        duration_limit_seconds: Number(__ENV.APIM_RL_MAX_DURATION_SECONDS),
      },
      metrics: {
        offered: metric('apim_rl_demo_offered'),
        admitted: metric('apim_rl_demo_admitted'),
        rejected: metric('apim_rl_demo_rejected'),
        quota_expected_403: metric('apim_rl_demo_quota_expected_403'),
        concurrency_429: metric('apim_rl_demo_concurrency_429'),
        status_200: metric('apim_rl_demo_status_200'),
        status_401: metric('apim_rl_demo_status_401'),
        status_403: metric('apim_rl_demo_status_403'),
        status_429: metric('apim_rl_demo_status_429'),
        status_5xx: metric('apim_rl_demo_status_5xx'),
        connection_error: metric('apim_rl_demo_status_connection_error'),
        unexpected: metric('apim_rl_demo_unexpected'),
        unexpected_rate: metric('apim_rl_demo_unexpected_rate'),
        retry_after_seconds: metric('apim_rl_demo_retry_after_seconds'),
        actual_wait_seconds: metric('apim_rl_demo_retry_wait_seconds'),
        recovery_seconds: metric('apim_rl_demo_recovery_seconds'),
        recovery_200: metric('apim_rl_demo_recovery_200'),
        raw_k6_http_req_duration: metric('http_req_duration'),
        raw_k6_http_reqs: metric('http_reqs'),
        raw_k6_http_req_failed: metric('http_req_failed'),
        vus: metric('vus'),
        checks: metric('checks'),
        dropped_iterations: metric('dropped_iterations'),
      },
      demo_event: demoEvent,
    };
    const serialized = JSON.stringify(summary, null, 2);
    const summaryPath = __ENV.APIM_RL_SUMMARY_PATH;
    return summaryPath ? { [summaryPath]: serialized, stdout: serialized } : { stdout: serialized };
  }

  const burstCount = data.metrics?.apim_rl_burst_429?.values?.count || 0;
  const burstRetryAfterCount = data.metrics?.apim_rl_burst_retry_after?.values?.count || 0;
  const recoveryCount = data.metrics?.apim_rl_recovery_200?.values?.count || 0;
  const quotaCount = data.metrics?.apim_rl_quota_403?.values?.count || 0;
  const concCount = data.metrics?.apim_rl_concurrency_429?.values?.count || 0;
  const concUnexpected = data.metrics?.apim_rl_concurrency_unexpected_status?.values?.count || 0;
  const quotaCollision = data.metrics?.apim_rl_quota_burst_collision?.values?.count || 0;
  const authzFp = data.metrics?.apim_rl_authz_false_positive?.values?.count || 0;
  const clientBCount = data.metrics?.apim_rl_client_b_200?.values?.count || 0;
  const clientBFailRate = data.metrics?.apim_rl_client_b_failed?.values?.rate ?? 1;
  const checksRate = data.metrics?.checks?.values?.rate ?? 0;

  const suitePassed =
    burstCount > 0 &&
    burstRetryAfterCount > 0 &&
    recoveryCount > 0 &&
    quotaCount > 0 &&
    concCount > 0 &&
    concUnexpected === 0 &&
    quotaCollision === 0 &&
    authzFp === 0 &&
    clientBCount > 0 &&
    clientBFailRate === 0 &&
    checksRate === 1;

  const rl01 = burstCount > 0 ? 'PASS' : 'FAIL';
  const rl02 = burstCount > 0 && Boolean(effectiveRateProfile) ? 'PASS' : 'FAIL';
  const rl03 = 'INCONCLUSIVE_RECUPERACION_NO_USA_RETRY_AFTER_OBSERVADO';
  const rl04 = 'INCONCLUSIVE_CLIENTE_B_NO_SE_EVALUA_DURANTE_BLOQUEO_A';
  const rl05 = 'INCONCLUSIVE_TELEMETRIA_APIM_GATEWAY_BACKEND_REQUERIDA';
  const rl06 = concCount > 0 ? 'INCONCLUSIVE_IDEMPOTENCIA_NO_VERIFICADA' : 'FAIL';

  return {
    stdout: JSON.stringify(
      {
        verificationStatus: suitePassed ? 'INCONCLUSIVE' : 'FAIL',
        executionStatus: suitePassed ? 'PASS' : 'FAIL',
        overallCertification: 'INCONCLUSIVE',
        requirements: { 'RL-01': rl01, 'RL-02': rl02, 'RL-03': rl03, 'RL-04': rl04, 'RL-05': rl05, 'RL-06': rl06 },
        extensions: { quota403: quotaCount > 0 ? 'PASS' : 'NOT_RUN', quotaBurstCollision: quotaCollision },
        metadata: {
          region: __ENV.APIM_REGION || 'UNSET',
          sku: __ENV.APIM_SKU || 'UNSET',
          revision: __ENV.APIM_REVISION || 'UNSET',
          policyHash: __ENV.APIM_POLICY_HASH || 'UNSET',
          operationSetSha256: manifest.operationSetSha256,
          filteredOpenApiCanonicalSha256: manifest.filteredOpenApiCanonicalSha256,
          rl06OperationId: matchedExpensiveOp.operationId,
          rl06RateProfile: matchedExpensiveOp.rateProfile,
          rl06ResolvedPath: expensivePath,
          labProfile: {
            burstCalls: labBurstCalls,
            burstWindowSec: labBurstWindowSec,
            quotaCalls: labQuotaCalls,
            quotaBurstCalls: labQuotaBurstCalls,
            quotaBurstWindowSec: labQuotaBurstWindowSec,
            concurrencyMax: labConcurrencyMax,
            expensiveBurstCalls: labExpensiveBurstCalls,
          },
        },
        causes: {
          burst_rate_limit_by_key_429: burstCount,
          burst_retry_after: burstRetryAfterCount,
          recovery_200: recoveryCount,
          quota_by_key_403: quotaCount,
          quota_burst_collision_429: quotaCollision,
          limit_concurrency_429: concCount,
          concurrency_unexpected_status: concUnexpected,
          authz_false_positive: authzFp,
          client_b_200: clientBCount,
        },
        metrics: {
          checksRate,
          duration: data.metrics?.http_req_duration?.values || {},
          requests: data.metrics?.http_reqs?.values || {},
          failed: data.metrics?.http_req_failed?.values || {},
          burst429: data.metrics?.apim_rl_burst_429?.values || {},
          burstRetryAfter: data.metrics?.apim_rl_burst_retry_after?.values || {},
          recovery200: data.metrics?.apim_rl_recovery_200?.values || {},
          quota403: data.metrics?.apim_rl_quota_403?.values || {},
          concurrency429: data.metrics?.apim_rl_concurrency_429?.values || {},
          clientB200: data.metrics?.apim_rl_client_b_200?.values || {},
          clientBFailed: data.metrics?.apim_rl_client_b_failed?.values || {},
          authzFalsePositive: data.metrics?.apim_rl_authz_false_positive?.values || {},
        },
      },
      null,
      2,
    ),
  };
}

const independentOptions = {
  summaryTrendStats: ['min', 'avg', 'med', 'max', 'p(95)', 'p(99)'],
  // Bound per-host fan-out by the independently authorized concurrency.
  batch: independentContext?.expected.maxConcurrency ?? 1,
  batchPerHost: independentContext?.expected.maxConcurrency ?? 1,
  scenarios: {
    [profile]: profile === 'concurrencia' ? {
      // A fixed one-shot fan-out keeps the offered request budget exact while
      // placing the authorized calls in flight together for limit-concurrency.
      executor: 'per-vu-iterations',
      vus: independentContext?.expected.maxVus ?? 1,
      iterations: 1,
      maxDuration: `${independentContext?.maximumDurationSeconds ?? 90}s`,
      exec: 'concurrencyIteration',
    } : {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${independentContext?.maximumDurationSeconds ?? 90}s`,
      exec: profile === 'aislamiento' ? 'isolationRateLimit' :
        profile === 'cuota' ? 'quotaOnly' : 'demoRateLimit',
    },
  },
  thresholds: profile === 'aislamiento'
    ? { apim_rl_demo_isolation_pass: ['rate==1'] }
    : profile === 'cuota'
      ? { apim_rl_demo_quota_expected_403: ['count>0'], apim_rl_demo_unexpected: ['count==0'] }
      : profile === 'concurrencia'
        ? { apim_rl_demo_concurrency_429: ['count>0'], apim_rl_demo_concurrency_unexpected: ['count==0'], dropped_iterations: ['count==0'] }
        : { apim_rl_demo_primary_pass: ['rate==1'] },
};

export const options = independent ? independentOptions : legacyOptions;

function metricCounter(name, count) {
  const Metric = Counter;
  return new Metric(name).add(count);
}

function makeCorrelationId(sequence) {
  const compact = String(independentContext.runId).replace(/-/g, '').toLowerCase();
  const suffix = Number(sequence).toString(16).padStart(12, '0');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-4${compact.slice(13, 16)}-a${compact.slice(17, 20)}-${suffix}`;
}

function observeIndependentResponse(response, phase, correlationId) {
  const status = response?.status ?? 0;
  const body = String(response?.body ?? '');
  const headers = response?.headers ?? {};
  const category = classifyHttpResponse(status, body, headers, {
    rateLimitEnabled: true,
    quotaEnabled: profile === 'cuota',
    quotaErrorCodes: profile === 'cuota' ? [independentContext.quotaErrorCode] : [],
  });
  if (status === 200) demoStatus200.add(1);
  else if (status === 401) demoStatus401.add(1);
  else if (status === 403) demoStatus403.add(1);
  else if (status === 429) demoStatus429.add(1);
  else if (status >= 500 && status <= 599) demoStatus5xx.add(1);
  else if (status === 0) demoStatusConnectionError.add(1);
  else demoStatusOther.add(1);
  if (category === 'admitted') {
    demoAdmitted.add(1);
    demoAdmittedCorrelation.add(1, { correlation_id: correlationId });
  } else if (category === 'rate_limited') {
    demoRejected.add(1);
    demo429.add(1);
    demoRejectedCorrelation.add(1, { correlation_id: correlationId });
    if (profile === 'concurrencia') demoConcurrency429.add(1);
  } else if (category === 'quota_exhausted') {
    demoRejected.add(1);
    demoQuotaExpected.add(1);
  }
  const responseCorrelationId = headerValue(headers, 'x-correlation-id');
  const revisionOk = revisionMatches(headers, independentContext.revisionHeader, independentContext.expectedRevision);
  const correlationOk = !responseCorrelationId || responseCorrelationId === correlationId;
  const expectedCategory = category === 'admitted' ||
    (category === 'rate_limited' && profile !== 'cuota') ||
    (category === 'quota_exhausted' && profile === 'cuota');
  const responseUnexpected = !expectedCategory || !correlationOk ||
    (status === 200 && !revisionOk);
  if (status === 200 && !revisionOk) {
    demoRevisionMismatch.add(1);
    observedRevisionMismatches += 1;
  }
  if (!correlationOk) observedCorrelationMismatches += 1;
  if (responseUnexpected) {
    demoUnexpected.add(1);
    if (profile === 'concurrencia') demoConcurrencyUnexpected.add(1);
    observedUnexpectedResponses += 1;
  }
  demoUnexpectedRate.add(responseUnexpected);
  check(response ?? { status: 0, headers: {} }, {
    [`${phase} HTTP classification is understood`]: () => !responseUnexpected,
    [`${phase} correlation response matches request when returned`]: () => correlationOk,
    [`${phase} deployed revision matches on admission`]: () => status !== 200 || revisionOk,
  });
  return { status, category, headers, body, responseCorrelationId };
}

function sendIndependentRead(phase, sequence, token = independentContext.token) {
  const correlationId = makeCorrelationId(sequence);
  demoOffered.add(1);
  if (phase === 'normal') demoOfferedNormal.add(1);
  if (phase === 'recovery') demoOfferedRecovery.add(1);
  if (phase === 'consumer_b') demoOfferedClientB.add(1);
  const response = http.get(independentContext.baseUrl, {
    headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': correlationId },
    redirects: 0,
    tags: { apim_rl_profile: profile, phase },
  });
  return {
    correlationId,
    timing_ms: response?.timings?.duration ?? null,
    ...observeIndependentResponse(response, phase, correlationId),
  };
}

function requestBatch(phase, count, sequenceStart, token = independentContext.token) {
  const requests = Array.from({ length: count }, (_, index) => {
    const correlationId = makeCorrelationId(sequenceStart + index);
    return {
      method: 'GET',
      url: independentContext.baseUrl,
      params: {
        headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': correlationId },
        redirects: 0,
        tags: { apim_rl_profile: profile, phase },
      },
      correlationId,
    };
  });
  demoOffered.add(count);
  if (phase === 'burst') demoOfferedBurst.add(count);
  return http.batch(requests.map(({ method, url, params }) => [method, url, null, params]))
    .map((response, index) => ({
      correlationId: requests[index].correlationId,
      timing_ms: response?.timings?.duration ?? null,
      ...observeIndependentResponse(response, phase, requests[index].correlationId),
    }));
}

function executeQuotaProfile() {
  const started = Date.now();
  let accepted = 0;
  let quotaRejected = 0;
  let unexpected = 0;
  const results = [];
  const interval = independentContext.quotaWindowSeconds / (independentContext.quotaCalls + 1);
  for (let index = 1; index <= independentContext.quotaCalls + 1; index += 1) {
    const result = sendIndependentRead('quota', index);
    results.push({ status: result.status, category: result.category, correlation_id: result.correlationId });
    if (index <= independentContext.quotaCalls && result.category === 'admitted') accepted += 1;
    else if (index === independentContext.quotaCalls + 1 && result.category === 'quota_exhausted') quotaRejected += 1;
    else unexpected += 1;
    if (index <= independentContext.quotaCalls) sleep(interval);
  }
  // Preserve native-dashboard export duration; this idle delay adds no client traffic.
  sleep(3);
  const elapsed = (Date.now() - started) / 1000;
  const passed = accepted === independentContext.quotaCalls && quotaRejected === 1 && unexpected === 0 &&
    elapsed <= independentContext.maximumDurationSeconds;
  const event = {
    profile,
    run_id: independentContext.runId,
    status: passed ? 'PASS' : 'FAIL',
    scope: __ENV.APIM_RL_MODE === 'local' ? 'L1_LOCAL_POLICY_SIMULATION' : 'L2_STAGING_APIM',
    requirements: { quota: passed ? 'PASS' : 'FAIL', 'RL-05': 'INCONCLUSIVE_TELEMETRIA_REQUERIDA', 'RL-06': 'NOT_RUN' },
    timeline_epoch_seconds: { started: started / 1000, completed: Date.now() / 1000 },
    result: {
      requests_offered: independentContext.expected.maxRequests,
      request_budget: independentContext.expected.maxRequests,
      requests_admitted: accepted,
      requests_rejected: quotaRejected,
      expected_http_403_code: independentContext.quotaErrorCode,
      quota_calls: independentContext.quotaCalls,
      quota_window_seconds: independentContext.quotaWindowSeconds,
      actual_duration_seconds: elapsed,
      unexpected_responses: unexpected,
      sequence: results,
    },
  };
  console.log(`APIM_RL_EVENT_JSON=${JSON.stringify(event)}`);
  return event;
}

function executeMainRateLimit({ testIsolation = false } = {}) {
  const started = Date.now();
  const timeline = { normal_epoch_seconds: started / 1000 };
  demoNormalEpoch.add(started / 1000);
  const normalStartedAt = Date.now();
  const normal = sendIndependentRead('normal', 1);
  if (normal.status === 200) demoNormal200.add(1);

  const burstAt = Date.now();
  timeline.burst_epoch_seconds = burstAt / 1000;
  demoBurstEpoch.add(burstAt / 1000);
  const burstResults = requestBatch('burst', independentContext.expected.burstCalls, 2);
  const burstCompletedAt = Date.now();
  const burstDurationSeconds = (burstCompletedAt - burstAt) / 1000;
  const normalToBurstSeconds = (burstCompletedAt - normalStartedAt) / 1000;
  const withinEffectiveWindow = normalToBurstSeconds <= independentContext.expected.burstWindowSeconds;
  const rejected = burstResults.filter((result) => result.category === 'rate_limited');
  const firstRejected = rejected[0];
  const blockAt = firstRejected ? Date.now() : null;
  if (firstRejected) {
    timeline.block_observed_epoch_seconds = blockAt / 1000;
    demoBlockEpoch.add(blockAt / 1000);
  }
  const retryValue = firstRejected ? headerValue(firstRejected.headers, 'retry-after') : undefined;
  const retry = parseRetryAfter(retryValue, Date.now(), independentContext.retryAfterMaximum);
  if (firstRejected && retry.valid) demoRetryAfter.add(retry.seconds);
  else demoRetryAfterMissing.add(1);

  let bResult = null;
  if (testIsolation && firstRejected) {
    bResult = sendIndependentRead('consumer_b', independentContext.expected.burstCalls + 2, independentContext.tokenB);
    if (bResult.status === 200) demoIsolationB200.add(1);
  }

  let waitSeconds = 0;
  let retryWaitStartedAt = null;
  let recovery = null;
  let recoveryElapsed = 0;
  let requestCountDuringWait = 0;
  if (firstRejected && retry.valid) {
    const blockObservedAt = Date.now();
    const waitStartedAt = Date.now();
    retryWaitStartedAt = waitStartedAt;
    timeline.retry_wait_started_epoch_seconds = waitStartedAt / 1000;
    sleep(retry.seconds);
    waitSeconds = (Date.now() - waitStartedAt) / 1000;
    demoWait.add(waitSeconds);
    // The single VU executes this sequence serially; no request is scheduled during sleep.
    if (requestCountDuringWait === 0) demoNoRequestsDuringWait.add(1);
    timeline.recovery_epoch_seconds = Date.now() / 1000;
    demoRecoveryEpoch.add(timeline.recovery_epoch_seconds);
    const recoveryStartedAt = Date.now();
    recovery = sendIndependentRead('recovery', independentContext.expected.burstCalls + (testIsolation ? 3 : 2));
    recoveryElapsed = (Date.now() - blockObservedAt) / 1000;
    demoRecovery.add(recoveryElapsed);
    if (recovery.status === 200) demoRecovery200.add(1);
  }

  // Da al dashboard nativo tiempo para exportar el HTML; no añade tráfico.
  sleep(3);

  const maxRequests = independentContext.expected.maxRequests;
  const offered = 1 + independentContext.expected.burstCalls + 1 + (testIsolation && bResult ? 1 : 0);
  const exactBudget = offered === maxRequests;
  const instantaneousBurstPassed = rejected.length > 0 &&
    burstDurationSeconds <= independentContext.expected.burstWindowSeconds;
  const accumulatedWindowPassed = normal.status === 200 && rejected.length > 0 && withinEffectiveWindow;
  const primaryPass = normal.status === 200 && rejected.length > 0 && retry.valid &&
    waitSeconds + 0.05 >= retry.seconds && requestCountDuringWait === 0 &&
    recovery?.status === 200 && offered === maxRequests && observedRevisionMismatches === 0 &&
    observedCorrelationMismatches === 0 && observedUnexpectedResponses === 0;

  const result = {
    profile,
    run_id: independentContext.runId,
    status: primaryPass ? 'PASS' : 'FAIL',
    scope: __ENV.APIM_RL_MODE === 'local' ? 'L1_LOCAL_POLICY_SIMULATION' : 'L2_STAGING_APIM',
    requirements: {
      'RL-01': instantaneousBurstPassed ? 'PASS' : rejected.length > 0 ? 'INCONCLUSIVE_BURST_EXCEEDED_WINDOW' : 'FAIL',
      'RL-02': accumulatedWindowPassed ? 'PASS' : rejected.length > 0 && !withinEffectiveWindow
        ? 'INCONCLUSIVE_SEQUENCE_EXCEEDED_WINDOW' : 'FAIL',
      'RL-03': retry.valid && recovery?.status === 200 ? 'PASS' : 'FAIL',
      'RL-04': testIsolation ? (bResult?.status === 200 ? 'PASS' : 'FAIL') : 'NOT_RUN',
      'RL-05': 'INCONCLUSIVE_TELEMETRIA_REQUERIDA',
      'RL-06': 'NOT_RUN',
    },
    timeline_epoch_seconds: timeline,
    result: {
      requests_offered: offered,
      request_budget: maxRequests,
      request_budget_exact: exactBudget,
      admitted_before_block: 1 + burstResults.filter((result) => result.status === 200).length,
      rejected_429: rejected.length,
      burst_duration_seconds: burstDurationSeconds,
      normal_to_last_burst_seconds: normalToBurstSeconds,
      effective_burst_window_seconds: independentContext.expected.burstWindowSeconds,
      normal_and_burst_within_effective_window: withinEffectiveWindow,
      burst_sequence: [normal, ...burstResults].map((response, index) => ({
        phase: index === 0 ? 'normal' : 'burst',
        status: response.status,
        classification: response.category,
        correlation_id: response.correlationId,
      })),
      retry_after_header: retryValue ?? null,
      retry_after_seconds: retry.valid ? retry.seconds : null,
      actual_wait_seconds: waitSeconds,
      retry_wait_started_epoch_seconds: retryWaitStartedAt ? retryWaitStartedAt / 1000 : null,
      client_requests_during_wait: requestCountDuringWait,
      recovery_status: recovery?.status ?? null,
      recovery_seconds: recoveryElapsed,
      recovery_response_latency_ms: recovery?.timing_ms ?? null,
      consumer_b_status: bResult?.status ?? null,
      rejected_correlation_ids: rejected.map((result) => result.correlationId),
      admitted_correlation_ids: [normal.correlationId, ...burstResults.filter((result) => result.status === 200).map((result) => result.correlationId), ...(recovery?.status === 200 ? [recovery.correlationId] : [])],
      revision: independentContext.expectedRevision,
      operation_id: independentContext.operation.operationId,
      method: independentContext.operation.method,
      path: independentContext.expected.path,
      policy_hash: __ENV.APIM_POLICY_HASH,
      manifest_sha256: __ENV.APIM_EFFECTIVE_MANIFEST_SHA256 || null,
      parameters_sha256: __ENV.APIM_EFFECTIVE_PARAMETERS_SHA256 || null,
      permit_sha256: __ENV.APIM_RL_VERIFIED_PERMIT_SHA256 || null,
    },
  };
  console.log(`APIM_RL_EVENT_JSON=${JSON.stringify(result)}`);
  return result;
}

export function demoRateLimit() {
  const result = executeMainRateLimit();
  demoPrimaryPass.add(result.status === 'PASS');
}

export function isolationRateLimit() {
  const result = executeMainRateLimit({ testIsolation: true });
  demoIsolationPass.add(result.status === 'PASS' && result.requirements['RL-04'] === 'PASS');
}

export function quotaOnly() {
  const result = executeQuotaProfile();
  demoQuotaPass.add(result.status === 'PASS');
}

export function concurrencyOnly() {
  return concurrencyIteration();
}

export function concurrencyIteration() {
  demoConcurrencyEpoch.add(Date.now() / 1000);
  sendIndependentRead('concurrency', Number(__VU) * 100000 + Number(__ITER));
  // Keep each authorized VU occupied after the arrival window; no extra request is generated.
  sleep(3);
}
