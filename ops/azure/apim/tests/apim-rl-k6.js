// Script k6 parametrizado para RL-01..RL-06 y APIM-T05 (sin ejecución automática).
// Uso autorizado:
// k6 run -e APIM_RL_AUTHORIZED=1 -e APIM_BASE_URL=https://<host>/api/v1 \
//   -e APIM_JWT_CLIENT_A=<jwtA> -e APIM_JWT_CLIENT_B=<jwtB> \
//   -e APIM_REGION=chilecentral -e APIM_SKU=Developer -e APIM_REVISION=1 -e APIM_POLICY_HASH=<sha> \
//   ops/azure/apim/tests/apim-rl-k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

if (__ENV.APIM_RL_AUTHORIZED !== '1' || !__ENV.APIM_BASE_URL) {
  throw new Error('APIM_RL_AUTHORIZED=1 y APIM_BASE_URL son obligatorios');
}
if (!__ENV.APIM_JWT_CLIENT_A || !__ENV.APIM_JWT_CLIENT_B) {
  throw new Error('APIM_JWT_CLIENT_A y APIM_JWT_CLIENT_B autenticados son obligatorios');
}

const burst429 = new Counter('apim_rl_burst_429');
const burstRetryAfter = new Counter('apim_rl_burst_retry_after');
const quotaExhausted403 = new Counter('apim_rl_quota_403');
const clientBIsolated200 = new Counter('apim_rl_client_b_200');
const concurrencyRejected = new Counter('apim_rl_concurrency_rejected');

export const options = {
  scenarios: {
    rl01_rl02_burst_client_a: {
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '1s',
      duration: '12s',
      preAllocatedVUs: 10,
      exec: 'burstClientA',
    },
    rl03_recovery_after_window: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 3,
      startTime: '23s',
      exec: 'recoveryClientA',
    },
    rl05_concurrency_expensive: {
      executor: 'shared-iterations',
      vus: 6,
      iterations: 12,
      startTime: '28s',
      exec: 'concurrencyExpensive',
    },
    rl06_isolated_client_b: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '12s',
      preAllocatedVUs: 4,
      exec: 'isolatedClientB',
    },
  },
  thresholds: {
    apim_rl_burst_429: ['count>0'],
    apim_rl_burst_retry_after: ['count>0'],
    apim_rl_client_b_200: ['count>0'],
    'http_req_failed{scenario:rl06_isolated_client_b}': ['rate==0'],
  },
};

const baseUrl = __ENV.APIM_BASE_URL;
const tokenA = __ENV.APIM_JWT_CLIENT_A;
const tokenB = __ENV.APIM_JWT_CLIENT_B;
const protectedPath = __ENV.APIM_RL_PATH || '/productos';
const expensivePath = __ENV.APIM_RL_EXPENSIVE_PATH || '/auditoria-precios/exportar';

export function burstClientA() {
  const res = http.get(`${baseUrl}${protectedPath}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (res.status === 429) {
    burst429.add(1);
    if (res.headers['Retry-After']) burstRetryAfter.add(1);
  } else if (res.status === 403) {
    quotaExhausted403.add(1);
  }
  check(res, {
    'RL-01/RL-02 burst produces 200 or 429 with Retry-After': (r) =>
      r.status === 200 || (r.status === 429 && Boolean(r.headers['Retry-After'])),
  });
}

export function recoveryClientA() {
  const res = http.get(`${baseUrl}${protectedPath}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  check(res, {
    'RL-03 recovery after window returns 200': (r) => r.status === 200,
  });
  sleep(1);
}

export function concurrencyExpensive() {
  const res = http.get(`${baseUrl}${expensivePath}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (res.status === 429 || res.status === 503) {
    concurrencyRejected.add(1);
  }
  check(res, {
    'RL-05 concurrency returns 200 or 429': (r) => r.status === 200 || r.status === 429,
  });
}

export function isolatedClientB() {
  const res = http.get(`${baseUrl}${protectedPath}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  if (res.status === 200) clientBIsolated200.add(1);
  check(res, {
    'RL-06 client B isolated (strict 200)': (r) => r.status === 200,
  });
  sleep(0.25);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        metadata: {
          region: __ENV.APIM_REGION || 'UNSET',
          sku: __ENV.APIM_SKU || 'UNSET',
          revision: __ENV.APIM_REVISION || 'UNSET',
          policyHash: __ENV.APIM_POLICY_HASH || 'UNSET',
        },
        metrics: {
          duration: data.metrics?.http_req_duration?.values || {},
          requests: data.metrics?.http_reqs?.values || {},
          failed: data.metrics?.http_req_failed?.values || {},
          burst429: data.metrics?.apim_rl_burst_429?.values || {},
          quota403: data.metrics?.apim_rl_quota_403?.values || {},
        },
      },
      null,
      2,
    ),
  };
}
