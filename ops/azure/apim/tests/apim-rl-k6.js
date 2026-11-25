// Script k6 parametrizado para RL-01..RL-06 y APIM-T05 (sin ejecución automática).
// Uso autorizado:
// k6 run -e APIM_RL_AUTHORIZED=1 -e APIM_BASE_URL=https://<host>/api/v1 \
//   -e APIM_JWT_M2M_A=<jwtM2mA> -e APIM_JWT_M2M_B=<jwtM2mB> \
//   -e APIM_JWT_HUMAN_QUOTA=<jwtHuman> -e APIM_JWT_HUMAN_CONCURRENCY=<jwtHumanConc> \
//   -e APIM_RL_EXPORT_ID=<uuidExportValido> \
//   -e APIM_LAB_BURST_CALLS=5 -e APIM_LAB_BURST_WINDOW_SEC=10 \
//   -e APIM_LAB_QUOTA_CALLS=60 -e APIM_LAB_QUOTA_BURST_CALLS=10 -e APIM_LAB_QUOTA_BURST_WINDOW_SEC=10 \
//   -e APIM_LAB_CONCURRENCY_MAX=2 -e APIM_LAB_EXPENSIVE_BURST_CALLS=5 \
//   -e APIM_REGION=chilecentral -e APIM_SKU=Developer -e APIM_REVISION=1 -e APIM_POLICY_HASH=<sha> \
//   ops/azure/apim/tests/apim-rl-k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

if (__ENV.APIM_RL_AUTHORIZED !== '1' || !__ENV.APIM_BASE_URL) {
  throw new Error('APIM_RL_AUTHORIZED=1 y APIM_BASE_URL son obligatorios');
}
for (const envName of [
  'APIM_JWT_M2M_A',
  'APIM_JWT_M2M_B',
  'APIM_JWT_HUMAN_QUOTA',
  'APIM_JWT_HUMAN_CONCURRENCY',
]) {
  if (!__ENV[envName]) {
    throw new Error(`${envName} es obligatorio para separar identidades por escenario`);
  }
}

const labBurstCalls = Number(__ENV.APIM_LAB_BURST_CALLS || '0');
const labBurstWindowSec = Number(__ENV.APIM_LAB_BURST_WINDOW_SEC || '0');
const labQuotaCalls = Number(__ENV.APIM_LAB_QUOTA_CALLS || '0');
const labQuotaBurstCalls = Number(__ENV.APIM_LAB_QUOTA_BURST_CALLS || '0');
const labQuotaBurstWindowSec = Number(__ENV.APIM_LAB_QUOTA_BURST_WINDOW_SEC || '0');
const labConcurrencyMax = Number(__ENV.APIM_LAB_CONCURRENCY_MAX || '0');
const labExpensiveBurstCalls = Number(__ENV.APIM_LAB_EXPENSIVE_BURST_CALLS || '0');
if (
  !labBurstCalls ||
  !labBurstWindowSec ||
  !labQuotaCalls ||
  !labQuotaBurstCalls ||
  !labQuotaBurstWindowSec ||
  !labConcurrencyMax ||
  !labExpensiveBurstCalls
) {
  throw new Error(
    'APIM_LAB_BURST_CALLS, APIM_LAB_BURST_WINDOW_SEC, APIM_LAB_QUOTA_CALLS, APIM_LAB_QUOTA_BURST_CALLS, APIM_LAB_QUOTA_BURST_WINDOW_SEC, APIM_LAB_CONCURRENCY_MAX y APIM_LAB_EXPENSIVE_BURST_CALLS son obligatorios',
  );
}
if (labConcurrencyMax + 1 >= labExpensiveBurstCalls) {
  throw new Error(
    'APIM_LAB_EXPENSIVE_BURST_CALLS debe ser mayor que APIM_LAB_CONCURRENCY_MAX + 1 para aislar limit-concurrency de rate-limit-by-key',
  );
}

const manifest = JSON.parse(open('../openapi/operation-security.json'));
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
const expensivePath =
  (__ENV.APIM_RL_EXPENSIVE_PATH || '').trim() ||
  (exportId ? `/auditoria-precios/exportaciones/${exportId}/archivo` : '');

if (!expensivePath || /\{[^}]+\}/.test(expensivePath)) {
  throw new Error(
    'RL-05 requiere ruta resuelta real (APIM_RL_EXPORT_ID o APIM_RL_EXPENSIVE_PATH sin placeholders sin resolver)',
  );
}
const matchedExpensiveOp = manifest.operations.find(
  (op) => op.method === 'GET' && matchesTemplatePath(expensivePath, op.path),
);
if (!matchedExpensiveOp) {
  throw new Error(`RL-05 ruta ${expensivePath} no corresponde a ninguna operación GET del manifiesto APIM`);
}
if (!CONCURRENCY_PROFILES[matchedExpensiveOp.rateProfile]) {
  throw new Error(
    `RL-05 operación ${matchedExpensiveOp.operationId} tiene rateProfile=${matchedExpensiveOp.rateProfile} sin concurrencia habilitada`,
  );
}

const burstRatePerSec = Math.max(labBurstCalls * 3, 15);
const quotaSafeRate = Math.max(1, labQuotaBurstCalls - 1);
const quotaIterations = labQuotaCalls + 5;
const quotaDurationSec = Math.ceil((quotaIterations / quotaSafeRate) * labQuotaBurstWindowSec) + 5;
const concurrencyVus = Math.min(labConcurrencyMax + 2, labExpensiveBurstCalls - 1);
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

export const options = {
  scenarios: {
    rl01_rl02_burst_client_a: {
      executor: 'constant-arrival-rate',
      rate: burstRatePerSec,
      timeUnit: '1s',
      duration: '6s',
      preAllocatedVUs: 12,
      exec: 'burstClientA',
    },
    rl03_recovery_after_window: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 3,
      startTime: `${recoveryStartSec}s`,
      exec: 'recoveryClientA',
    },
    rl04_quota_exhaustion: {
      executor: 'constant-arrival-rate',
      rate: quotaSafeRate,
      timeUnit: `${labQuotaBurstWindowSec}s`,
      duration: `${quotaDurationSec}s`,
      preAllocatedVUs: 4,
      startTime: `${recoveryStartSec + 6}s`,
      exec: 'quotaHumanClient',
    },
    rl05_concurrency_expensive: {
      executor: 'per-vu-iterations',
      vus: concurrencyVus,
      iterations: 1,
      startTime: `${recoveryStartSec + quotaDurationSec + 10}s`,
      exec: 'concurrencyExpensive',
    },
    rl06_isolated_client_b: {
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
    const body = String(res.body || '').toLowerCase();
    if (res.headers['Retry-After'] || body.includes('quota')) {
      quota403.add(1);
    }
  }
  check(res, {
    'RL-04 quota returns 200 or quota-exhausted 403 (never burst 429 or authz 403)': (r) =>
      !isAuthzRejection(r) && r.status !== 429 && (r.status === 200 || r.status === 403),
  });
}

export function concurrencyExpensive() {
  const res = http.get(`${baseUrl}${expensivePath}`, {
    headers: { Authorization: `Bearer ${tokenHumanConcurrency}` },
  });
  if (isAuthzRejection(res)) {
    authzFalsePositive.add(1);
    concurrencyUnexpectedStatus.add(1);
  } else if (res.status === 404 || res.status === 403 || res.status === 401) {
    concurrencyUnexpectedStatus.add(1);
  } else if (res.status === 429) {
    concurrency429.add(1);
  }
  check(res, {
    'RL-05 limit-concurrency isolated returns 200 or 429 (never 401/403/404)': (r) =>
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
    'RL-06 client B isolated (strict 200)': (r) => r.status === 200,
  });
  sleep(0.25);
}

export function handleSummary(data) {
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

  const verified =
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

  return {
    stdout: JSON.stringify(
      {
        verificationStatus: verified ? 'VERIFIED' : 'NOT_VERIFIED',
        metadata: {
          region: __ENV.APIM_REGION || 'UNSET',
          sku: __ENV.APIM_SKU || 'UNSET',
          revision: __ENV.APIM_REVISION || 'UNSET',
          policyHash: __ENV.APIM_POLICY_HASH || 'UNSET',
          rl05OperationId: matchedExpensiveOp.operationId,
          rl05RateProfile: matchedExpensiveOp.rateProfile,
          rl05ResolvedPath: expensivePath,
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
